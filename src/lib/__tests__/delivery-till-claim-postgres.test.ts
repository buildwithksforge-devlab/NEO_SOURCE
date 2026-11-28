import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { expect, it } from "vitest";

it("saves one Till claim, exposes it to scoped Finance and leaves payment pending on retry", async () => {
  const db = new PGlite();
  try {
    await db.exec(`
      CREATE SCHEMA auth;
      CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql AS
        $$ SELECT nullif(current_setting('test.uid',true),'')::uuid $$;
      CREATE FUNCTION my_customer_id() RETURNS uuid LANGUAGE sql AS $$ SELECT auth.uid() $$;
      CREATE FUNCTION current_org_id() RETURNS uuid LANGUAGE sql AS
        $$ SELECT '00000000-0000-4000-8000-000000000001'::uuid $$;
      CREATE FUNCTION is_org_admin_for(uuid) RETURNS boolean LANGUAGE sql AS $$ SELECT false $$;
      CREATE FUNCTION has_permission(VARIADIC text[]) RETURNS boolean LANGUAGE sql AS
        $$ SELECT current_setting('test.finance',true) = 'on' $$;
      CREATE FUNCTION neo_branch_in_scope(uuid) RETURNS boolean LANGUAGE sql AS
        $$ SELECT $1 = '00000000-0000-4000-8000-000000000002'::uuid $$;
      CREATE TABLE delivery_orders(id uuid PRIMARY KEY, customer_id uuid, organization_id uuid, branch_id uuid,
        order_number text, grand_total numeric, currency text, payment_method text, payment_status text, order_status text);
      CREATE FUNCTION customer_owns_delivery(uuid) RETURNS boolean LANGUAGE sql AS
        $$ SELECT EXISTS(SELECT FROM delivery_orders WHERE id=$1 AND customer_id=auth.uid()) $$;
      CREATE TABLE delivery_mpesa_till_claims(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid,
        branch_id uuid, delivery_order_id uuid, receipt_code text, submitted_by uuid, submitted_at timestamptz DEFAULT now(),
        status text DEFAULT 'submitted', UNIQUE(organization_id, receipt_code));
      INSERT INTO delivery_orders VALUES
        ('00000000-0000-4000-8000-000000000004','00000000-0000-4000-8000-000000000003',current_org_id(),
        '00000000-0000-4000-8000-000000000002','DEL-TEST',1250,'KES','mpesa','pending','confirmed');
    `);
    const migration = readFileSync("supabase/migrations/20261106230000_delivery_mpesa_claims_scoped_install.sql", "utf8");
    await db.exec(migration.slice(migration.indexOf("CREATE FUNCTION public.neo_delivery_mpesa_till_claim_submit("),
      migration.indexOf("-- Private evidence checker")));
    const submit = async () => (await db.query<{ claim: { claim_id: string } }>(`
      SELECT neo_delivery_mpesa_till_claim_submit('00000000-0000-4000-8000-000000000004','ABC1234567') AS claim
    `)).rows[0]?.claim ?? (() => { throw new Error("Till claim submit returned no row"); })();
    const queue = () => db.query("SELECT neo_delivery_mpesa_till_claim_queue() AS claims");

    await expect(submit()).rejects.toThrow(/Authentication required/);
    await db.exec("SET test.uid='00000000-0000-4000-8000-000000000005'");
    await expect(submit()).resolves.toMatchObject({ ok: false, reason: "order_not_found" });
    await db.exec("SET test.uid='00000000-0000-4000-8000-000000000003'");
    const saved = await submit();
    expect(saved).toMatchObject({ ok: true, status: "submitted", payment_verified: false });
    await expect(submit()).resolves.toMatchObject({ already_submitted: true, claim_id: saved.claim_id });
    await expect(queue()).rejects.toThrow(/Finance payment review permission required/);
    await db.exec("SET test.uid='00000000-0000-4000-8000-000000000005'; SET test.finance='on'");
    expect((await queue()).rows).toMatchObject([{ claims: [{ claim_id: saved.claim_id, order_number: "DEL-TEST", payment_status: "pending" }] }]);
    expect((await db.query("SELECT payment_status FROM delivery_orders")).rows).toEqual([{ payment_status: "pending" }]);
  } finally {
    await db.close();
  }
}, 60_000);
