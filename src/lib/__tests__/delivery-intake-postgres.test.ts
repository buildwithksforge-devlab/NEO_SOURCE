import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

describe("assisted delivery retry PostgreSQL boundary", () => {
  let db: PGlite;
  const org = "00000000-0000-0000-0000-000000000001";
  const branch = "00000000-0000-0000-0000-000000000002";
  const migration = readFileSync(
    "supabase/migrations/20261106090200_delivery_intake_retry_identity.sql",
    "utf8",
  );
  beforeAll(async () => {
    db = new PGlite();
    // Stub only the existing intake primitive; the new wrapper, index, grants
    // and transactions execute as written in the versioned migration.
    await db.exec(`CREATE ROLE anon; CREATE ROLE authenticated;
      CREATE TABLE branches(id uuid,organization_id uuid);
      INSERT INTO branches VALUES ('${branch}','${org}');
      CREATE TABLE delivery_orders(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),organization_id uuid,branch_id uuid,
        pos_order_id uuid,customer_id uuid,order_number text,delivery_fee numeric,grand_total numeric,
        estimated_prep_minutes int,order_status text);
      CREATE TABLE intake_audit(id uuid);
      CREATE FUNCTION current_org_id() RETURNS uuid LANGUAGE sql AS $$ SELECT '${org}'::uuid $$;
      CREATE FUNCTION neo_branch_in_scope(uuid) RETURNS boolean LANGUAGE sql AS $$ SELECT coalesce(current_setting('neo.scope',true),'yes') <> 'no' $$;
      CREATE FUNCTION neo_assert_capability(text,text,text) RETURNS void LANGUAGE plpgsql AS $$ BEGIN
        IF coalesce(current_setting('neo.permission',true),'yes')='no' THEN RAISE EXCEPTION 'Permission denied'; END IF; END $$;
      CREATE FUNCTION neo_delivery_staff_place_order(_branch uuid,_contact_name text,_contact_phone text,_items jsonb,
        _fulfilment text,_zone uuid,_address jsonb,_payment_method text,_notes text) RETURNS jsonb LANGUAGE plpgsql AS $$
      DECLARE v_id uuid;
      BEGIN
        INSERT INTO delivery_orders(organization_id,branch_id,order_number,grand_total,order_status)
          VALUES (current_org_id(),_branch,'D-TEST',500,'confirmed') RETURNING id INTO v_id;
        INSERT INTO intake_audit VALUES(v_id);
        IF _contact_name='fail' THEN RAISE EXCEPTION 'Controlled intake failure'; END IF;
        RETURN jsonb_build_object('delivery_order_id',v_id,'order_number','D-TEST');
      END $$;
      ${migration}`);
  }, 60000);
  afterAll(async () => {
    await db?.close();
  });
  async function intake(key: string, name = "Test") {
    return (
      await db.query<{ result: Record<string, unknown> }>(
        "SELECT neo_delivery_staff_place_order_once($1,$2,$3,'0700','[]'::jsonb,'pickup') AS result",
        [key, branch, name],
      )
    ).rows[0]!.result;
  }
  it("returns one intake and one audit for repeated submission", async () => {
    const first = await intake("retry-1");
    const retry = await intake("retry-1");
    expect(retry["delivery_order_id"]).toBe(first["delivery_order_id"]);
    expect(retry["idempotent"]).toBe(true);
    const rows = await db.query<{ count: number }>(
      "SELECT count(*)::int AS count FROM intake_audit WHERE id=$1",
      [first["delivery_order_id"]],
    );
    expect(rows.rows[0]!.count).toBe(1);
  });
  it("allows a fresh business identity for a genuinely new order", async () => {
    expect((await intake("fresh-1"))["delivery_order_id"]).not.toBe(
      (await intake("fresh-2"))["delivery_order_id"],
    );
  });
  it("rejects a retry identity reused for changed business input", async () => {
    await intake("mismatch-1");
    await expect(intake("mismatch-1", "Changed")).rejects.toThrow("different order");
  });
  it("rolls back order and audit together when the underlying intake fails", async () => {
    const before = (
      await db.query<{ count: number }>("SELECT count(*)::int AS count FROM intake_audit")
    ).rows[0]!.count;
    await expect(intake("failure-1", "fail")).rejects.toThrow("Controlled intake failure");
    expect(
      (await db.query<{ count: number }>("SELECT count(*)::int AS count FROM intake_audit"))
        .rows[0]!.count,
    ).toBe(before);
    expect((await intake("failure-1"))["idempotent"]).toBe(false);
  });
  it.each(["neo.permission", "neo.scope"])(
    "checks %s before returning an existing intake",
    async (setting) => {
      await intake(`deny-${setting}`);
      await db.query("SELECT set_config($1,'no',false)", [setting]);
      try {
        await expect(intake(`deny-${setting}`)).rejects.toThrow(
          /Permission denied|outside your access scope/,
        );
      } finally {
        await db.query("SELECT set_config($1,'yes',false)", [setting]);
      }
    },
  );
  it("rejects a property outside the signed-in workspace", async () => {
    await expect(
      db.query(
        "SELECT neo_delivery_staff_place_order_once('cross-org',$1,'Test','0700','[]'::jsonb,'pickup')",
        [org],
      ),
    ).rejects.toThrow("Property not found");
  });
  it("enforces database uniqueness independently of the caller", async () => {
    await intake("unique-1");
    await expect(
      db.query(
        "INSERT INTO delivery_orders(organization_id,branch_id,intake_idempotency_key) VALUES($1,$2,'unique-1')",
        [org, branch],
      ),
    ).rejects.toThrow(/unique/);
  });
  it("requires a nonempty bounded retry identity", async () => {
    await expect(intake(" ")).rejects.toThrow("identity");
    await expect(intake("x".repeat(201))).rejects.toThrow("identity");
  });
  it("keeps anonymous execution denied", async () => {
    const signature =
      "public.neo_delivery_staff_place_order_once(text,uuid,text,text,jsonb,text,uuid,jsonb,text,text)";
    const result = await db.query<{ anon: boolean; authenticated: boolean }>(
      "SELECT has_function_privilege('anon',$1,'EXECUTE') AS anon,has_function_privilege('authenticated',$1,'EXECUTE') AS authenticated",
      [signature],
    );
    expect(result.rows[0]).toEqual({ anon: false, authenticated: true });
  });
});
