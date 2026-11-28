import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";
import { expect, it } from "vitest";

it("projects saved Delivery and POS receipts only for the owning guest and property", async () => {
  const db = new PGlite();
  const org = "10000000-0000-4000-8000-000000000001";
  const branch = "10000000-0000-4000-8000-000000000002";
  const customer = "10000000-0000-4000-8000-000000000003";
  const order = "10000000-0000-4000-8000-000000000004";
  const pos = "10000000-0000-4000-8000-000000000005";
  const other = "10000000-0000-4000-8000-000000000006";
  const read = async () => (await db.query<{ receipt: string | null }>(
    "SELECT neo_guest_order_tracking($1, 'D-1')->>'receipt_number' AS receipt", [org],
  )).rows[0]?.receipt;
  try {
    await db.exec(`
      CREATE ROLE authenticated;
      CREATE ROLE anon;
      CREATE FUNCTION my_customer_id() RETURNS uuid LANGUAGE sql AS
        $$ SELECT current_setting('neo.test_customer')::uuid $$;
      CREATE TABLE delivery_orders (
        id uuid, organization_id uuid, branch_id uuid, customer_id uuid, pos_order_id uuid,
        rider_id uuid, order_number text, fulfilment_type text, order_status text, kitchen_status text,
        dispatch_status text, payment_status text, payment_method text, subtotal numeric, tax_total numeric,
        service_charge_total numeric, discount_total numeric, delivery_fee numeric, grand_total numeric,
        currency text, created_at timestamptz, estimated_delivery_at timestamptz, delivered_at timestamptz,
        cancelled_at timestamptz
      );
      CREATE TABLE rider_profiles (id uuid, display_name text, vehicle_type text, availability_status text);
      CREATE TABLE kitchen_tickets (order_id uuid, status text);
      CREATE TABLE pos_order_items (order_id uuid, item_name text, quantity numeric, line_total numeric, status text, created_at timestamptz);
      CREATE TABLE delivery_order_status_history (delivery_order_id uuid, new_status text, status_kind text, created_at timestamptz);
      CREATE TABLE payments (
        id uuid DEFAULT gen_random_uuid(), organization_id uuid, branch_id uuid, customer_id uuid,
        source_module text, source_record_id uuid, status text, receipt_number text,
        paid_at timestamptz DEFAULT now(), created_at timestamptz DEFAULT now()
      );
      CREATE TABLE pos_payments (
        id uuid DEFAULT gen_random_uuid(), organization_id uuid, branch_id uuid, order_id uuid,
        status text, receipt_number text, paid_at timestamptz DEFAULT now(), created_at timestamptz DEFAULT now()
      );
      SET neo.test_customer = '${customer}';
      INSERT INTO delivery_orders (id, organization_id, branch_id, customer_id, pos_order_id, order_number, payment_status)
      VALUES ('${order}', '${org}', '${branch}', '${customer}', '${pos}', 'D-1', 'paid');
      INSERT INTO pos_payments (organization_id, branch_id, order_id, status, receipt_number)
      VALUES ('${org}', '${branch}', '${pos}', 'confirmed', 'POS-1');
      INSERT INTO payments (organization_id, branch_id, customer_id, source_module, source_record_id, status, receipt_number)
      VALUES
        ('${org}', '${other}', '${customer}', 'delivery', '${order}', 'confirmed', 'WRONG-BRANCH'),
        ('${org}', '${branch}', '${other}', 'delivery', '${order}', 'confirmed', 'WRONG-CUSTOMER'),
        ('${org}', '${branch}', '${customer}', 'delivery', '${order}', 'pending', 'NOT-CONFIRMED');
    `);
    const migrationPath = "supabase/migrations/";
    const baseline = readFileSync(migrationPath + "20260922174127_2f041c85-a9db-433e-b576-a2e6b5bef1f3.sql", "utf8");
    await db.exec(baseline.split("CREATE OR REPLACE FUNCTION public.neo_guest_order_cancel")[0]!);
    await db.exec("REVOKE EXECUTE ON FUNCTION neo_guest_order_tracking(uuid,text) FROM PUBLIC; GRANT EXECUTE ON FUNCTION neo_guest_order_tracking(uuid,text) TO authenticated");
    const verify = readFileSync("supabase/repair/2026-11-22/guest-delivery-receipt-verification.sql", "utf8");
    expect((await db.query(verify)).rows[0]).toMatchObject({ receipt_projection_installed: false });
    const migration = readFileSync(migrationPath + "20261122140000_guest_delivery_receipt_projection.sql", "utf8");
    await db.exec(migration);
    await db.exec(migration);
    expect((await db.query(verify)).rows[0]).toEqual({
      routine_exists: true,
      customer_check_present: true,
      receipt_projection_installed: true,
      authenticated_can_execute: true,
      anonymous_can_execute: false,
    });
    expect(await read()).toBe("POS-1");
    await db.exec(`
      INSERT INTO payments (organization_id, branch_id, customer_id, source_module, source_record_id, status, receipt_number)
      VALUES ('${org}', '${branch}', '${customer}', 'delivery', '${order}', 'confirmed', 'DELIVERY-1');
    `);
    expect(await read()).toBe("DELIVERY-1");
    await db.exec(`SET neo.test_customer = '${other}'`);
    expect(await read()).toBeNull();
    await db.exec(`SET neo.test_customer = '${customer}'; UPDATE delivery_orders SET payment_status = 'pending'`);
    expect(await read()).toBeNull();
  } finally {
    await db.close();
  }
}, 15_000);
