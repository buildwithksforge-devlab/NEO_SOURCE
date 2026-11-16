import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const org = id(1),
  branch = id(2),
  supplier = id(3),
  order = id(4),
  invoice = id(5),
  stock = id(6);
const source = readFileSync(
  "supabase/migrations/20261115020000_supplier_matching_quantity_parity.sql",
  "utf8",
);
const original = source.match(
  /CREATE OR REPLACE FUNCTION public\.proc_three_way_match\([\s\S]*?\$function\$\s*;/,
)![0];
const migration = readFileSync(
  "supabase/migrations/20261116231500_supplier_purchase_approval_guard.sql",
  "utf8",
);
describe("actual supplier three-way matcher and approved-purchase guard", () => {
  let db: PGlite;
  beforeAll(async () => {
    db = new PGlite();
    await db.exec(`CREATE SCHEMA auth; CREATE ROLE authenticated;
      CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql AS $$ SELECT '${id(10)}'::uuid $$;
      CREATE FUNCTION current_org_id() RETURNS uuid LANGUAGE sql AS $$ SELECT '${org}'::uuid $$;
      CREATE FUNCTION is_active_staff() RETURNS boolean LANGUAGE sql AS $$ SELECT true $$;
      CREATE FUNCTION has_permission(text,text) RETURNS boolean LANGUAGE sql AS $$ SELECT true $$;
      CREATE FUNCTION neo_assert_capability(text,text,text) RETURNS void LANGUAGE plpgsql AS $$ BEGIN END $$;
      CREATE FUNCTION neo_branch_in_scope(uuid) RETURNS boolean LANGUAGE sql AS $$ SELECT $1='${branch}'::uuid $$;
      CREATE FUNCTION neo_fact_currency(uuid,uuid) RETURNS text LANGUAGE sql AS $$ SELECT 'KES' $$;
      CREATE TABLE procurement_matching_policies(match_mode text,quantity_tolerance_pct numeric,price_tolerance_pct numeric,price_tolerance_amount numeric);
      INSERT INTO procurement_matching_policies VALUES('three-way',0,0,0);
      CREATE FUNCTION neo_matching_policy(uuid,uuid) RETURNS procurement_matching_policies LANGUAGE sql AS $$ SELECT * FROM procurement_matching_policies LIMIT 1 $$;
      CREATE FUNCTION neo_ap_sync_match_amounts(uuid) RETURNS void LANGUAGE plpgsql AS $$ BEGIN END $$;
      CREATE TABLE supplier_invoices(id uuid,organization_id uuid,branch_id uuid,supplier_id uuid,order_id uuid,invoice_number text,status text,amount numeric,tax_amount numeric,match_status text);
      CREATE TABLE supplier_invoice_lines(id uuid,supplier_invoice_id uuid,organization_id uuid,stock_item_id uuid,description text,quantity numeric,unit_price numeric,net_amount numeric,tax_amount numeric,total_amount numeric);
      CREATE TABLE purchase_orders(id uuid,organization_id uuid,branch_id uuid,supplier_id uuid,currency text,status text,order_number text);
      CREATE TABLE purchase_order_lines(order_id uuid,stock_item_id uuid,description text,quantity numeric,accepted_quantity numeric,received_quantity numeric,unit_price numeric);
      CREATE TABLE stock_items(id uuid,name text);
      CREATE TABLE supplier_invoice_discrepancies(organization_id uuid,supplier_invoice_id uuid,order_id uuid,stock_item_id uuid,kind text,severity text,detail text,actual_value numeric,expected_value numeric,variance numeric,resolved boolean DEFAULT false);
    `);
    await db.exec(original);
    await db.exec("GRANT EXECUTE ON FUNCTION proc_three_way_match(uuid) TO authenticated");
    await db.exec(migration);
  }, 30_000);
  afterAll(async () => {
    await db?.close();
  });
  beforeEach(async () => {
    await db.exec(`TRUNCATE supplier_invoices,supplier_invoice_lines,purchase_orders,purchase_order_lines,stock_items,supplier_invoice_discrepancies;
      UPDATE procurement_matching_policies SET match_mode='three-way';
      INSERT INTO purchase_orders VALUES('${order}','${org}','${branch}','${supplier}','KES','approved','LPO-1');
      INSERT INTO purchase_order_lines VALUES('${order}','${stock}','Water',10,8,10,50);
      INSERT INTO stock_items VALUES('${stock}','Water');
      INSERT INTO supplier_invoices VALUES('${invoice}','${org}','${branch}','${supplier}','${order}','INV-1','received',400,0,'pending');
      INSERT INTO supplier_invoice_lines VALUES('${id(7)}','${invoice}','${org}','${stock}','Water',8,50,400,0,400);`);
  });
  async function match() {
    return (
      await db.query<{ result: { match_status: string; critical: number } }>(
        `SELECT proc_three_way_match('${invoice}') result`,
      )
    ).rows[0]!.result;
  }
  async function invoiceQuantity(quantity: number) {
    await db.exec(
      `UPDATE supplier_invoice_lines SET quantity=${quantity},net_amount=${quantity * 50},total_amount=${quantity * 50}; UPDATE supplier_invoices SET amount=${quantity * 50}`,
    );
  }
  it("matches eight accepted units with a warning for the two-unit shortage", async () => {
    expect(await match()).toMatchObject({ match_status: "review", critical: 0 });
  });
  it("holds rejected stock rather than paying for all ten physically delivered units", async () => {
    await invoiceQuantity(10);
    expect(await match()).toMatchObject({ match_status: "held", critical: 1 });
  });
  it.each(["draft", "pending_approval", "pending-approval", "rejected", "cancelled", "voided"])(
    "refuses purchase status %s before matching",
    async (status) => {
      await db.query("UPDATE purchase_orders SET status=$1", [status]);
      await expect(match()).rejects.toThrow(/must be approved/);
      expect((await db.query("SELECT match_status FROM supplier_invoices")).rows[0]).toEqual({
        match_status: "pending",
      });
    },
  );
  it("keeps completed-order invoices possible after receiving", async () => {
    await db.exec("UPDATE purchase_orders SET status='closed'");
    expect((await match()).critical).toBe(0);
  });
  it("aggregates duplicate lines before comparing claimable quantity", async () => {
    await db.exec(
      `INSERT INTO supplier_invoice_lines VALUES('${id(11)}','${invoice}','${org}','${stock}','Water',1,50,50,0,50); UPDATE supplier_invoices SET amount=450`,
    );
    expect((await match()).match_status).toBe("held");
  });
  it("deducts earlier invoices from the eight accepted units", async () => {
    await db.exec(`INSERT INTO supplier_invoices VALUES('${id(12)}','${org}','${branch}','${supplier}','${order}','INV-OLD','approved',100,0,'matched');
      INSERT INTO supplier_invoice_lines VALUES('${id(13)}','${id(12)}','${org}','${stock}','Water',2,50,100,0,100);`);
    expect((await match()).match_status).toBe("held");
  });
  it("retains configured two-way matching for an approved order", async () => {
    await db.exec("UPDATE procurement_matching_policies SET match_mode='two-way'");
    await invoiceQuantity(10);
    expect((await match()).match_status).toBe("matched");
  });
  it("allows the remaining accepted quantity after the first partial invoice", async () => {
    await invoiceQuantity(6);
    await db.exec(`UPDATE purchase_orders SET status='partially-invoiced';
      INSERT INTO supplier_invoices VALUES('${id(12)}','${org}','${branch}','${supplier}','${order}','INV-OLD','approved',100,0,'matched');
      INSERT INTO supplier_invoice_lines VALUES('${id(13)}','${id(12)}','${org}','${stock}','Water',2,50,100,0,100);`);
    expect((await match()).critical).toBe(0);
  });
  it("rejects a purchase from another property", async () => {
    await db.exec(`UPDATE purchase_orders SET branch_id='${id(20)}'`);
    await expect(match()).rejects.toThrow(/scope, supplier or currency/);
  });
  it("rejects header-line money disagreement", async () => {
    await db.exec("UPDATE supplier_invoices SET amount=401");
    await expect(match()).rejects.toThrow(/does not agree/);
  });
  it("reapplies without changing grants or invoice rows", async () => {
    await db.exec(migration);
    expect((await db.query("SELECT match_status FROM supplier_invoices")).rows[0]).toEqual({
      match_status: "pending",
    });
    expect(
      (
        await db.query(
          "SELECT has_function_privilege('authenticated','proc_three_way_match(uuid)','EXECUTE') allowed",
        )
      ).rows[0],
    ).toEqual({ allowed: true });
  });
  it("refuses an unknown installed matcher", async () => {
    await db.exec(
      "CREATE OR REPLACE FUNCTION proc_three_way_match(_invoice uuid) RETURNS jsonb LANGUAGE sql AS $$ SELECT '{}'::jsonb $$",
    );
    await expect(db.exec(migration)).rejects.toThrow(/differs from reviewed source/);
    await db.exec("ROLLBACK");
  });
});
