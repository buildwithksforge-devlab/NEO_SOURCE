import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, expect, it } from "vitest";

const uuid = (suffix: number) => `00000000-0000-4000-8000-${String(suffix).padStart(12, "0")}`;
const org = uuid(1);
const owner = uuid(2);
const other = uuid(3);
let db: PGlite;

beforeAll(async () => {
  db = new PGlite();
  await db.exec(`
    CREATE FUNCTION my_customer_id() RETURNS uuid LANGUAGE sql AS
      $$ SELECT nullif(current_setting('test.customer', true),'')::uuid $$;
    CREATE TABLE delivery_orders(id uuid PRIMARY KEY, organization_id uuid, customer_id uuid, order_number text,
      order_status text, payment_status text, dispatch_status text, kitchen_status text, pos_order_id uuid,
      cancelled_at timestamptz, cancellation_reason text, UNIQUE(organization_id, order_number));
    CREATE TABLE station_tickets(order_id uuid, status text);
    CREATE TABLE pos_orders(id uuid PRIMARY KEY, status text);
    CREATE TABLE delivery_order_status_history(organization_id uuid, delivery_order_id uuid, status_kind text,
      previous_status text, new_status text, source text, reason text);
    INSERT INTO delivery_orders (id, organization_id, customer_id, order_number, order_status, payment_status, pos_order_id)
    VALUES ('${uuid(4)}','${org}','${owner}','OWN','confirmed','pending','${uuid(5)}'),
      ('${uuid(6)}','${org}','${owner}','PAID','confirmed','paid','${uuid(7)}'),
      ('${uuid(8)}','${org}','${owner}','STARTED','confirmed','pending','${uuid(9)}');
    INSERT INTO pos_orders VALUES ('${uuid(5)}','open'), ('${uuid(7)}','open'), ('${uuid(9)}','open');
    INSERT INTO station_tickets VALUES ('${uuid(5)}','queued'), ('${uuid(7)}','queued'), ('${uuid(9)}','preparing');
  `);
  const migration = readFileSync("supabase/migrations/20260924150000_cross_entry_guest_rider_guards.sql", "utf8");
  const start = migration.indexOf("CREATE OR REPLACE FUNCTION public.neo_guest_order_cancel(");
  const end = migration.indexOf("CREATE OR REPLACE FUNCTION public.delivery_rider_advance(", start);
  await db.exec(migration.slice(start, end));
}, 60000);

afterAll(async () => db?.close());

it("cancels the owner's unpaid order once and keeps someone else's, paid and started orders intact", async () => {
  const cancel = async (reference: string) => (await db.query(
    "SELECT neo_guest_order_cancel($1,$2,'Test cancellation') AS result", [org, reference],
  )).rows[0];
  await expect(cancel("OWN")).resolves.toEqual({ result: { ok: false, reason: "not_signed_in" } });
  await db.query("SELECT set_config('test.customer',$1,false)", [other]);
  await expect(cancel("OWN")).resolves.toEqual({ result: { ok: false, reason: "unknown_order" } });
  await db.query("SELECT set_config('test.customer',$1,false)", [owner]);
  for (const reference of ["PAID", "STARTED"]) {
    await expect(cancel(reference)).resolves.toEqual({ result: { ok: false, reason: "already_started" } });
  }
  await expect(cancel("OWN")).resolves.toEqual({ result: { ok: true, order_number: "OWN" } });
  await expect(cancel("OWN")).resolves.toEqual({ result: { ok: true, already_cancelled: true } });
  expect((await db.query("SELECT order_number,order_status,kitchen_status FROM delivery_orders ORDER BY order_number")).rows)
    .toEqual([
      { order_number: "OWN", order_status: "cancelled", kitchen_status: "cancelled" },
      { order_number: "PAID", order_status: "confirmed", kitchen_status: null },
      { order_number: "STARTED", order_status: "confirmed", kitchen_status: null },
    ]);
  expect((await db.query("SELECT status FROM pos_orders ORDER BY id")).rows)
    .toEqual([{ status: "cancelled" }, { status: "open" }, { status: "open" }]);
  expect((await db.query("SELECT status FROM station_tickets ORDER BY order_id")).rows)
    .toEqual([{ status: "cancelled" }, { status: "queued" }, { status: "preparing" }]);
  expect((await db.query("SELECT source,new_status,reason FROM delivery_order_status_history")).rows)
    .toEqual([{ source: "customer", new_status: "cancelled", reason: "Test cancellation" }]);
});
