import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, expect, it } from "vitest";

const id = (value: number) => `00000000-0000-4000-8000-${String(value).padStart(12, "0")}`;
const [org, branch, actor, invoice, otherInvoice, otherBranch, customer] = [1, 2, 3, 4, 5, 6, 7].map(id);
const migration = readFileSync("supabase/migrations/20261122041000_ar_receipt_settlement_integrity.sql", "utf8");
let db: PGlite;

beforeAll(async () => {
  db = new PGlite();
  await db.exec(`
    CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role; CREATE SCHEMA auth;
    CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql AS $$ SELECT '${actor}'::uuid $$;
    CREATE FUNCTION current_org_id() RETURNS uuid LANGUAGE sql AS $$ SELECT '${org}'::uuid $$;
    CREATE FUNCTION is_org_admin() RETURNS boolean LANGUAGE sql AS $$ SELECT false $$;
    CREATE FUNCTION has_permission(text,text) RETURNS boolean LANGUAGE sql AS $$ SELECT true $$;
    CREATE FUNCTION neo_branch_in_scope(uuid) RETURNS boolean LANGUAGE sql AS $$ SELECT $1 = '${branch}'::uuid $$;
    CREATE FUNCTION neo_assert_financial_account(uuid,uuid,uuid) RETURNS uuid LANGUAGE sql AS $$ SELECT $3 $$;
    CREATE FUNCTION pos_resolve_open_shift(uuid) RETURNS uuid LANGUAGE sql AS $$ SELECT null::uuid $$;
    CREATE FUNCTION next_document_number(text) RETURNS text LANGUAGE sql AS $$ SELECT 'R-1'::text $$;
    CREATE FUNCTION neo_gl_account_code(uuid,text,uuid) RETURNS text LANGUAGE sql AS $$ SELECT '1010'::text $$;
    CREATE FUNCTION neo_finance_ensure_account(uuid,text,text,text,text) RETURNS void LANGUAGE plpgsql AS $$ BEGIN END; $$;
    CREATE TABLE invoices (id uuid PRIMARY KEY, organization_id uuid, branch_id uuid, customer_id uuid,
      currency text, status text, total numeric, amount_paid numeric, balance numeric, invoice_number text, updated_at timestamptz);
    CREATE TABLE payments (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid, branch_id uuid,
      receipt_number text, customer_id uuid, amount numeric, currency text, method text, external_reference text, paid_at timestamptz,
      status text, received_by uuid, notes text, source_module text, source_record_id uuid, idempotency_key text,
      shift_id uuid, destination_account_id uuid, posted_journal_id uuid, updated_at timestamptz, UNIQUE(organization_id,idempotency_key));
    CREATE TABLE journal_entries (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid, source_document_id uuid,
      lines jsonb, created_at timestamptz DEFAULT now());
    CREATE FUNCTION neo_gl_post(uuid,uuid,text,text,uuid,text,date,text,text,jsonb,uuid) RETURNS jsonb LANGUAGE plpgsql AS $$
      DECLARE result uuid;
      BEGIN
        IF current_setting('test.fail_journal', true) = 'on' THEN RETURN '{}'::jsonb; END IF;
        INSERT INTO journal_entries (organization_id, source_document_id, lines) VALUES ($1,$5,$10) RETURNING id INTO result;
        RETURN jsonb_build_object('journal_id',result);
      END $$;
    CREATE TABLE audit_logs (organization_id uuid, user_id uuid, user_name text, action text,
      module text, record_id text, new_value jsonb, reason text);
    INSERT INTO invoices (id,organization_id,branch_id,customer_id,currency,status,total,amount_paid,balance,invoice_number)
    VALUES ('${invoice}','${org}','${branch}','${customer}','USD','issued',100,0,100,'INV-1'),
      ('${otherInvoice}','${org}','${otherBranch}','${customer}','USD','issued',100,0,100,'INV-2');
  `);
  await db.exec(readFileSync("supabase/migrations/20260921073325_50507baf-ba3e-4fe1-b637-f3478f8206e0.sql", "utf8"));
  await db.exec(migration);
  await db.exec(migration);
}, 60000);

afterAll(async () => db?.close());

async function receipt(invoiceId = invoice, amount: string | number = 100, reference = "BANK-1", attempt = "retry-1") {
  const { rows } = await db.query<{ result: Record<string, unknown> }>(
    "SELECT neo_ar_record_customer_payment($1,$2,'bank-transfer',$3,'2026-11-22',NULL,NULL,$4,NULL) AS result",
    [invoiceId, amount, reference, attempt],
  );
  return rows[0]!.result;
}

it("rolls back a missing journal, permits an exact retry after full settlement and rejects mismatched money", async () => {
  await db.exec("SET test.fail_journal = 'on'");
  await expect(receipt()).rejects.toThrow(/journal could not be confirmed/);
  expect((await db.query("SELECT balance::int FROM invoices WHERE id=$1", [invoice])).rows).toEqual([{ balance: 100 }]);
  await db.exec("SET test.fail_journal = 'off'");
  const saved = await receipt();
  expect(saved).toMatchObject({ invoice_status: "paid", receipt_number: "R-1", journal_id: expect.any(String) });
  await expect(receipt()).resolves.toMatchObject({ ...saved, duplicate_prevented: true });
  await expect(receipt(invoice, 100, "BANK-1", "new-session")).resolves.toMatchObject({ ...saved, duplicate_prevented: true });
  await expect(receipt(invoice, 99)).rejects.toMatchObject({ code: "23514" });
  await expect(receipt(invoice, 100, "OTHER")).rejects.toMatchObject({ code: "23514" });
  await expect(receipt(invoice, "NaN")).rejects.toMatchObject({ code: "22023" });
  await expect(receipt(otherInvoice)).rejects.toMatchObject({ code: "42501" });
  expect((await db.query("SELECT count(*)::int FROM payments")).rows).toEqual([{ count: 1 }]);
  expect((await db.query("SELECT lines FROM journal_entries")).rows).toEqual([{ lines: [
    { code: "1010", debit: 100, description: "Money received" },
    { code: "1060", credit: 100, description: "Customer debt settled" },
  ] }]);
});
