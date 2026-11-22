import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";

const org = "00000000-0000-4000-8000-000000000001";
const branch = "00000000-0000-4000-8000-000000000002";
const actor = "00000000-0000-4000-8000-000000000003";
const group = "00000000-0000-4000-8000-000000000004";
const otherBranch = "00000000-0000-4000-8000-000000000005";
const sql = readFileSync("supabase/migrations/20261122032500_group_master_deposit_integrity.sql", "utf8");
const preflight = readFileSync("supabase/repair/2026-11-22/group-master-deposit-preflight.sql", "utf8");
let db: PGlite;

function original(path: string, name: string) {
  const file = readFileSync(`supabase/migrations/${path}`, "utf8");
  const body = file.slice(file.indexOf(`CREATE OR REPLACE FUNCTION public.${name}(`));
  const start = /\bAS\s+(\$[\w]*\$)/i.exec(body)!;
  const delimiter = start[1]!;
  return body.slice(0, body.indexOf(delimiter, start.index + start[0].length) + delimiter.length) + ";";
}

beforeAll(async () => {
  db = new PGlite();
  await db.exec(`
    CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role; CREATE SCHEMA auth;
    CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql AS $$ SELECT '${actor}'::uuid $$;
    CREATE FUNCTION current_org_id() RETURNS uuid LANGUAGE sql AS $$ SELECT '${org}'::uuid $$;
    CREATE FUNCTION is_org_admin() RETURNS boolean LANGUAGE sql AS $$ SELECT false $$;
    CREATE FUNCTION has_permission(text,text,text DEFAULT NULL) RETURNS boolean LANGUAGE sql AS $$ SELECT current_setting('test.can_edit') = 'yes' $$;
    CREATE FUNCTION neo_branch_in_scope(uuid) RETURNS boolean LANGUAGE sql AS $$ SELECT $1 = '${branch}'::uuid $$;
    CREATE FUNCTION neo_fact_currency(uuid,uuid) RETURNS text LANGUAGE sql AS $$ SELECT 'USD'::text $$;
    CREATE TABLE group_bookings (id uuid PRIMARY KEY, organization_id uuid, branch_id uuid, master_folio_id uuid, corporate_account_id uuid,
      contact_customer_id uuid, billing_instructions text, status text, deposit_paid numeric, updated_at timestamptz);
    CREATE TABLE folios (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid, branch_id uuid, folio_number text,
      folio_type text, group_booking_id uuid, corporate_account_id uuid, customer_id uuid, status text, billing_instructions text, created_by uuid, currency text DEFAULT 'KES');
    CREATE TABLE payments (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid, branch_id uuid, folio_id uuid,
      customer_id uuid, amount numeric, currency text DEFAULT 'KES', method text, external_reference text, status text,
      received_by uuid, source_module text, source_record_id uuid, idempotency_key text, notes text);
    CREATE UNIQUE INDEX payment_attempt_key ON payments(organization_id,idempotency_key) WHERE idempotency_key IS NOT NULL;
    CREATE TABLE group_block_events (organization_id uuid, group_booking_id uuid, event_type text, new_value jsonb, actor_id uuid, reason text);
  `);
  await db.exec(original("20260822043443_f3a7e77b-a12a-4433-93ed-81aca39fbfd2.sql", "pms_group_master_folio"));
  await db.exec(original("20260924153000_front_office_connected_guards.sql", "pms_group_record_deposit"));
  expect((await db.query<{ rollout_status: string }>(preflight)).rows.map((row) => row.rollout_status)).toEqual(["supported baseline", "supported baseline"]);
  await db.exec(sql);
});

beforeEach(async () => {
  await db.exec(`TRUNCATE group_block_events, payments, folios, group_bookings;
    SET test.can_edit = 'yes';
    INSERT INTO group_bookings (id,organization_id,branch_id,status,deposit_paid) VALUES ('${group}','${org}','${branch}','confirmed',0);`);
});
afterAll(async () => db?.close());

async function deposit(amount: number | string = 100, method = "bank-transfer", reference = "RECEIPT-1") {
  return (await db.query<{ result: Record<string, unknown> }>(
    "SELECT pms_group_record_deposit($1,$2,$3,$4) AS result", [group, amount, method, reference],
  )).rows[0]!.result;
}

it("verifies both installed definitions and applies again without granting anonymous access", async () => {
  await db.exec(sql);
  const result = await db.query(preflight);
  expect(result.rows).toHaveLength(2);
  for (const row of result.rows) {
    expect(row).toMatchObject({ rollout_status: "installed", anonymous_execute: false, authenticated_execute: true, service_execute: true });
  }
});

it("links the first deposit to the property-currency master and returns the original payment on a retry", async () => {
  const saved = await deposit();
  expect(saved).toMatchObject({ currency: "USD", duplicate: false, payment_id: expect.any(String), folio_id: expect.any(String) });
  await expect(deposit(100, "BANK-TRANSFER", " RECEIPT-1 ")).resolves.toEqual({ ...saved, duplicate: true });
  expect((await db.query("SELECT currency, amount::int, source_record_id, folio_id FROM payments")).rows).toEqual([
    { currency: "USD", amount: 100, source_record_id: group, folio_id: saved["folio_id"] },
  ]);
  expect((await db.query("SELECT deposit_paid::int AS amount FROM group_bookings")).rows).toEqual([{ amount: 100 }]);
  expect((await db.query("SELECT count(*)::int AS count FROM group_block_events")).rows).toEqual([{ count: 1 }]);
});

it("refuses a changed amount, method or unconfirmed historical payment under an existing reference", async () => {
  await deposit();
  await expect(deposit(101)).rejects.toMatchObject({ code: "23514" });
  await expect(deposit(100, "cash")).rejects.toMatchObject({ code: "23514" });
  await db.exec("UPDATE payments SET status='voided'");
  await expect(deposit()).rejects.toMatchObject({ code: "23514" });
  expect((await db.query("SELECT deposit_paid::int AS amount FROM group_bookings")).rows).toEqual([{ amount: 100 }]);
});

it("refuses cross-property and read-only users, blank references and non-finite amounts without writing a master", async () => {
  await expect(deposit("NaN")).rejects.toMatchObject({ code: "22023" });
  await expect(deposit(100, "cash", " ")).rejects.toMatchObject({ code: "22023" });
  await db.exec("SET test.can_edit = 'no'");
  await expect(deposit()).rejects.toMatchObject({ code: "42501" });
  await db.exec(`SET test.can_edit = 'yes'; UPDATE group_bookings SET branch_id='${otherBranch}';`);
  await expect(deposit()).rejects.toMatchObject({ code: "42501" });
  expect((await db.query("SELECT id FROM folios")).rows).toEqual([]);
});

it("restores the one existing master and lets an exact replay find a deposit after folio closure", async () => {
  const saved = await deposit();
  await db.exec("UPDATE group_bookings SET master_folio_id=NULL");
  await expect(deposit()).resolves.toEqual({ ...saved, duplicate: true });
  await db.exec("UPDATE folios SET status='closed'");
  await expect(deposit()).resolves.toEqual({ ...saved, duplicate: true });
  await expect(deposit(100, "cash", "NEW-RECEIPT")).rejects.toThrow(/closed to new deposits/);
  expect((await db.query("SELECT count(*)::int AS count FROM folios")).rows).toEqual([{ count: 1 }]);
});
