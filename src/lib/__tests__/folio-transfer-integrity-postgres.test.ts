import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, expect, it } from "vitest";

const id = (value: number) => `00000000-0000-4000-8000-${String(value).padStart(12, "0")}`;
const [org, branch, source, master, other, group, reservation, charge, outside] = [1, 2, 3, 4, 5, 6, 7, 8, 9].map(id);
const db = new PGlite();
afterAll(async () => db.close());

it("moves a full charge once to its verified group master and preserves the scoped folio totals", async () => {
  await db.exec(`
    CREATE SCHEMA auth;
    CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql AS $$ SELECT '${source}'::uuid $$;
    CREATE FUNCTION current_org_id() RETURNS uuid LANGUAGE sql AS $$ SELECT '${org}'::uuid $$;
    CREATE FUNCTION has_permission(text,text) RETURNS boolean LANGUAGE sql AS $$ SELECT true $$;
    CREATE FUNCTION neo_branch_in_scope(uuid) RETURNS boolean LANGUAGE sql AS $$ SELECT $1 = '${branch}'::uuid $$;
    CREATE TABLE reservations (id uuid, organization_id uuid, branch_id uuid, group_booking_id uuid);
    CREATE TABLE group_bookings (id uuid, organization_id uuid, branch_id uuid, master_folio_id uuid);
    CREATE TABLE folios (id uuid PRIMARY KEY, organization_id uuid, branch_id uuid, currency text, status text,
      group_booking_id uuid, folio_type text, reservation_id uuid, customer_id uuid, folio_number text, total_charges numeric,
      total_taxes numeric, balance numeric, updated_at timestamptz);
    CREATE TABLE folio_lines (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid, branch_id uuid, folio_id uuid,
      reservation_id uuid, customer_id uuid, line_type text, category text, revenue_centre text, reference text, source_module text,
      source_record_id text, source_record_uuid uuid, idempotency_key text, description text, quantity numeric, unit_price numeric,
      gross_amount numeric, discount_amount numeric,tax_amount numeric,service_charge_amount numeric,net_amount numeric,
      posted_by uuid,actor_id uuid,correlation_id uuid,status text,transferred_from_folio_id uuid,transfer_reason text,reverses_line_id uuid,
      UNIQUE(organization_id,idempotency_key));
    CREATE TABLE audit_logs (organization_id uuid,user_id uuid,user_name text,action text,module text,record_id text,
      previous_value jsonb,new_value jsonb,reason text);
    INSERT INTO reservations VALUES ('${reservation}','${org}','${branch}','${group}');
    INSERT INTO group_bookings VALUES ('${group}','${org}','${branch}','${master}');
    INSERT INTO folios VALUES
      ('${source}','${org}','${branch}','USD','open',NULL,'guest','${reservation}',NULL,'F1',100,16,116,NULL),
      ('${master}','${org}','${branch}','USD','open','${group}','master',NULL,NULL,'F2',0,0,0,NULL),
      ('${other}','${org}','${branch}','USD','open',NULL,'guest',NULL,NULL,'F3',0,0,0,NULL),
      ('${outside}','${org}','${outside}','USD','open',NULL,'guest',NULL,NULL,'F4',0,0,0,NULL);
    INSERT INTO folio_lines (id, organization_id, branch_id, folio_id, line_type, description, quantity, unit_price,
      gross_amount, discount_amount, tax_amount, service_charge_amount, net_amount, status)
    VALUES ('${charge}','${org}','${branch}','${source}','charge','Room',1,100,0,0,16,0,116,'posted');
  `);
  const old = readFileSync("supabase/migrations/20260822042946_3eb4fdab-d666-4c8f-a7f3-a65eaa02d619.sql", "utf8");
  const reverse = readFileSync("supabase/migrations/20260915111852_0b712746-bc13-4708-ae26-6979ffdab2cb.sql", "utf8");
  await db.exec(old.slice(old.indexOf("CREATE OR REPLACE FUNCTION public.folio_transfer_line"), old.indexOf("CREATE OR REPLACE FUNCTION public.folio_reverse_line")));
  await db.exec(reverse.slice(reverse.indexOf("CREATE OR REPLACE FUNCTION public.folio_reverse_line"), reverse.indexOf("CREATE OR REPLACE FUNCTION public.neo_post_pos_order")));
  const migration = readFileSync("supabase/migrations/20261122041100_folio_transfer_integrity.sql", "utf8");
  await db.exec(migration);
  await db.exec(migration);
  const move = (to: string) => db.query("SELECT folio_transfer_line($1,$2,'Send to group bill') AS line", [charge, to]);
  await expect(move(outside)).rejects.toMatchObject({ code: "42501" });
  await db.query("UPDATE group_bookings SET master_folio_id=$1", [other]);
  await expect(move(master)).rejects.toThrow(/verified master folio/);
  await db.query("UPDATE group_bookings SET master_folio_id=$1", [master]);
  const saved = (await move(master)).rows;
  expect((await move(master)).rows).toEqual(saved);
  await expect(move(other)).rejects.toThrow(/active posted charge/);
  expect((await db.query("SELECT folio_number, balance::int, total_taxes::int FROM folios ORDER BY folio_number")).rows).toEqual([
    { folio_number: "F1", balance: 0, total_taxes: 0 }, { folio_number: "F2", balance: 116, total_taxes: 16 },
    { folio_number: "F3", balance: 0, total_taxes: 0 }, { folio_number: "F4", balance: 0, total_taxes: 0 },
  ]);
}, 60000);
