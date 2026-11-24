import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const migration = (name: string) => readFileSync(`supabase/migrations/${name}.sql`, "utf8").replaceAll("\r\n", "\n");
const org = "82f10000-0000-4000-8000-000000000001";
const branch = "82f10000-0000-4000-8000-000000000002";
const vat = "82f10000-0000-4000-8000-000000000003";
const levy = "82f10000-0000-4000-8000-000000000004";
const group = "82f10000-0000-4000-8000-000000000005";
const menu = "82f10000-0000-4000-8000-000000000006";
const order = "82f10000-0000-4000-8000-000000000007";
const item = "82f10000-0000-4000-8000-000000000008";
const journal = "82f10000-0000-4000-8000-000000000009";
const revenue = "82f10000-0000-4000-8000-000000000010";
const cart = "82f10000-0000-4000-8000-000000000011";
const actor = "82f10000-0000-4000-8000-000000000012";
const invoice = "82f10000-0000-4000-8000-000000000013";
const note = "82f10000-0000-4000-8000-000000000014";

function definition(file: string, fn: string) {
  const source = migration(file);
  const start = source.indexOf(`CREATE OR REPLACE FUNCTION public.${fn}(`);
  if (start < 0) throw new Error(`Missing fixture function ${fn}`);
  const body = source.indexOf("AS $function$", start);
  const end = source.indexOf("$function$", body + "AS $function$".length);
  return source.slice(start, end + "$function$".length) + ";";
}

describe("sales tax profiles, documents and ledger", () => {
  let db: PGlite;
  beforeAll(async () => {
    db = new PGlite();
    await db.exec(`
      CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
      CREATE TABLE organizations(id uuid PRIMARY KEY,name text,legal_name text);
      CREATE TABLE organization_settings(organization_id uuid,regional jsonb,contact jsonb,brand jsonb);
      CREATE TABLE chart_of_accounts(id uuid PRIMARY KEY, organization_id uuid, code text, name text,
        category text, active boolean DEFAULT true, postable boolean DEFAULT true, is_header boolean DEFAULT false);
      CREATE TABLE tax_codes(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL,
        branch_id uuid, code text, name text, rate numeric NOT NULL, inclusive boolean, treatment text,
        tax_account_id uuid, active boolean DEFAULT true, effective_from date, effective_to date);
      CREATE TABLE menu_categories(id uuid PRIMARY KEY, organization_id uuid NOT NULL);
      CREATE TABLE menu_items(id uuid PRIMARY KEY, organization_id uuid NOT NULL, branch_id uuid, base_price numeric, category_id uuid,
        name text, tax_rate numeric DEFAULT 16, station_id uuid, availability text DEFAULT 'available',
        available_delivery boolean DEFAULT true,available_takeaway boolean DEFAULT true,available_room_service boolean DEFAULT true);
      CREATE TABLE pos_orders(id uuid PRIMARY KEY, organization_id uuid, branch_id uuid,
        subtotal numeric, discount_total numeric, currency text DEFAULT 'KES', tax_total numeric DEFAULT 18.30);
      CREATE TABLE pos_order_items(id uuid PRIMARY KEY, organization_id uuid, order_id uuid, menu_item_id uuid,
        unit_price numeric, quantity numeric, modifier_total numeric DEFAULT 0, discount_amount numeric DEFAULT 0,
        tax_amount numeric DEFAULT 0, line_total numeric, status text DEFAULT 'served');
      CREATE TABLE invoices(id uuid PRIMARY KEY,organization_id uuid,branch_id uuid,invoice_number text,
        total numeric,tax_total numeric,bill_to_snapshot jsonb);
      CREATE TABLE credit_notes(id uuid PRIMARY KEY,organization_id uuid,branch_id uuid,invoice_id uuid,customer_id uuid,
        note_number text,issue_date date,status text,note_kind text,currency text,reason text,subtotal numeric,tax_total numeric,total numeric);
      CREATE TABLE etims_submissions(credit_note_id uuid,organization_id uuid,status text,kra_reference text,
        control_unit_reference text,qr_payload text,updated_at timestamptz);
      CREATE TABLE journal_entries(id uuid PRIMARY KEY, organization_id uuid, branch_id uuid,
        currency text,status text,total_debit numeric,total_credit numeric,reversed_by_journal_id uuid,reverses_journal_id uuid,
        accounting_date date DEFAULT '2026-11-20',source_document_type text,source_document_id uuid);
      CREATE TABLE journal_entry_lines(journal_id uuid,account_id uuid,credit numeric,debit numeric,
        organization_id uuid,branch_id uuid);
      CREATE TABLE folios (id uuid PRIMARY KEY,organization_id uuid,branch_id uuid,currency text,customer_id uuid);
      CREATE TABLE folio_lines (id uuid,organization_id uuid,source_record_uuid uuid,source_module text,category text,
        folio_id uuid,tax_amount numeric,status text,line_type text);
      CREATE TABLE delivery_orders (id uuid,organization_id uuid,pos_order_id uuid);
      CREATE TABLE invoice_lines (invoice_id uuid,organization_id uuid,source_module text,source_record_id uuid);
      CREATE TABLE pos_payments (id uuid,organization_id uuid,order_id uuid);
      CREATE TABLE payments (id uuid,organization_id uuid,posted_journal_id uuid);
      CREATE TABLE cash_refund_requests (organization_id uuid,pos_payment_id uuid,refund_payment_id uuid,status text);
      CREATE TABLE customers(id uuid,organization_id uuid,auth_user_id uuid,merged_into_id uuid,full_name text);
      CREATE TABLE branches(id uuid,organization_id uuid,active boolean,name text,code text,address text,city text,
        country text,phone text,email text,currency text,timezone text,logo_url text);
      CREATE TABLE carts(id uuid,organization_id uuid,branch_id uuid,customer_id uuid,status text,fulfilment_type text,
        zone_id uuid,scheduled_for timestamptz,promo_code text,tip_amount numeric);
      CREATE TABLE cart_items(id uuid,cart_id uuid,organization_id uuid,menu_item_id uuid,quantity numeric,
        created_at timestamptz DEFAULT now(),special_instructions text,allergy_note text);
      CREATE TABLE cart_item_modifiers(id uuid,organization_id uuid,cart_item_id uuid,group_id uuid,option_id uuid);
      CREATE TABLE modifier_options(id uuid,group_id uuid,organization_id uuid,active boolean,extra_charge numeric);
      CREATE TABLE modifier_groups(id uuid,organization_id uuid,active boolean,min_select integer,max_select integer,required boolean,multi_select boolean);
      CREATE TABLE menu_item_modifier_groups(menu_item_id uuid,organization_id uuid,group_id uuid);
      CREATE TABLE delivery_zones(id uuid,eta_minutes integer);
      CREATE TABLE delivery_settings(pickup_enabled boolean);
      CREATE TABLE promotion_codes(id uuid);
      CREATE TABLE customer_addresses(id uuid);
      CREATE TABLE event_bookings(id uuid);
      CREATE TABLE supplier_invoices(id uuid);
      CREATE TABLE supplier_payments(id uuid);
      CREATE TABLE guest_laundry_orders(id uuid);
      CREATE TABLE reservation_deposits(id uuid);
      CREATE SCHEMA auth;
      CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql AS 'SELECT ''${actor}''::uuid';
      CREATE FUNCTION delivery_get_settings(uuid) RETURNS delivery_settings LANGUAGE sql AS 'SELECT true';
      CREATE FUNCTION neo_fact_currency(uuid,uuid) RETURNS text LANGUAGE sql AS 'SELECT ''KES''::text';
      CREATE FUNCTION neo_service_charge_percent(uuid,uuid) RETURNS numeric LANGUAGE sql AS 'SELECT 0::numeric';
      CREATE FUNCTION current_org_id() RETURNS uuid LANGUAGE sql STABLE AS 'SELECT ''${org}''::uuid';
      CREATE FUNCTION is_org_admin() RETURNS boolean LANGUAGE sql AS 'SELECT true';
      CREATE FUNCTION has_permission(text,text) RETURNS boolean LANGUAGE sql AS 'SELECT true';
      CREATE FUNCTION has_permission(text,text,text) RETURNS boolean LANGUAGE sql AS 'SELECT true';
      CREATE FUNCTION neo_branch_in_scope(uuid) RETURNS boolean LANGUAGE sql AS 'SELECT true';
      CREATE FUNCTION can_read_guest_ledger() RETURNS boolean LANGUAGE sql AS 'SELECT false';
      CREATE FUNCTION in_my_branch_scope(uuid,uuid) RETURNS boolean LANGUAGE sql AS 'SELECT true';
      CREATE FUNCTION is_org_admin_for(uuid) RETURNS boolean LANGUAGE sql AS 'SELECT false';
      CREATE FUNCTION neo_fact_timezone(uuid,uuid) RETURNS text LANGUAGE sql AS 'SELECT ''Africa/Nairobi''::text';
      SET check_function_bodies=off;
    `);
    const parity = "20261115013000_finance_checkout_ledger_parity";
    for (const [file, fn] of [
      ["20261116234500_grn_inspection_document_details", "neo_document_payload"],
      [parity, "delivery_quote_cart"], [parity, "delivery_place_order"], [parity, "neo_delivery_bill"],
      ["20261120080000_scope_guest_operations_property", "neo_guest_place_room_service"],
      ["20261115021000_pos_receipt_account_split", "neo_finance_post_txn"],
      ["20261115014000_pos_refund_original_credit_allocation", "neo_refund_credit_allocation"],
    ] as const) await db.exec(definition(file, fn));
    await db.exec("SET check_function_bodies=on;");
    await db.exec(migration("20261120171000_tax_line_calculator"));
    await db.exec(migration("20261120172000_sales_tax_profiles"));
    await db.exec(migration("20261120173100_sales_tax_pos_documents_and_posting"));
    await db.exec(migration("20261120173200_sales_tax_finance_summary"));
    await db.exec(migration("20261121123300_pos_receipt_saved_tax_rates"));
    await db.exec(migration("20261122162000_folio_document_saved_tax_rows"));
    await db.exec(migration("20261123100000_delete_unused_sales_tax_profiles"));
    await db.exec(`
      INSERT INTO organizations VALUES ('${org}');
      INSERT INTO chart_of_accounts(id,organization_id,code,category,name) VALUES
        ('${vat}','${org}','2041','liability','VAT payable'),('${levy}','${org}','2042','liability','Levy payable'),
        ('${revenue}','${org}','4100','revenue','Sales');
      INSERT INTO tax_codes(organization_id,code,name,rate,inclusive,treatment,tax_account_id,effective_from) VALUES
        ('${org}','VAT','VAT',0.16,true,'standard','${vat}','2020-01-01'),
        ('${org}','LEVY','Catering levy',0.02,true,'standard','${levy}','2020-01-01');
      INSERT INTO sales_tax_profiles(id,organization_id,name,rules) VALUES
        ('${group}','${org}','Food','[{"code":"VAT"},{"code":"LEVY"}]');
      INSERT INTO menu_items(id,organization_id,branch_id,base_price,sales_tax_profile_id,name)
        VALUES ('${menu}','${org}','${branch}',120,'${group}','Bread');
      INSERT INTO pos_orders(id,organization_id,branch_id,subtotal,discount_total) VALUES ('${order}','${org}','${branch}',120,0);
      INSERT INTO pos_order_items(id,organization_id,order_id,menu_item_id,unit_price,quantity,line_total) VALUES
        ('${item}','${org}','${order}','${menu}',120,1,120);
      INSERT INTO branches(id,organization_id,active,name,currency,timezone) VALUES ('${branch}','${org}',true,'Test Property','KES','Africa/Nairobi');
      INSERT INTO customers(id,organization_id,auth_user_id) VALUES ('${actor}','${org}','${actor}');
      INSERT INTO carts VALUES ('${cart}','${org}','${branch}','${actor}','active','pickup',NULL,NULL,NULL,NULL);
      INSERT INTO cart_items(id,cart_id,organization_id,menu_item_id,quantity) VALUES
        ('${item}','${cart}','${org}','${menu}',1);
      INSERT INTO journal_entries(id,organization_id,branch_id,currency,status,total_debit,total_credit,source_document_type,source_document_id)
        VALUES ('${journal}','${org}','${branch}','KES','posted',120,120,'pos_order:revenue','${order}');
      INSERT INTO journal_entry_lines VALUES
        ('${journal}','${vat}',16.27,0,'${org}','${branch}'),
        ('${journal}','${levy}',2.03,0,'${org}','${branch}'),
        ('${journal}','${revenue}',101.70,0,'${org}','${branch}'),
        ('${journal}','${revenue}',0,120,'${org}','${branch}');
      INSERT INTO invoices(id,organization_id,branch_id,invoice_number,total,tax_total,sales_tax_snapshot) VALUES
        ('${invoice}','${org}','${branch}','INV-TEST',120,18.30,
         '[{"label":"Catering levy (LEVY) · Included","amount":2.03},{"label":"VAT · Included","amount":16.27}]');
      INSERT INTO credit_notes VALUES ('${note}','${org}','${branch}','${invoice}','${actor}',
        'CN-TEST','2026-11-20','issued','credit','KES','Returned item',101.70,18.30,120);
    `);
  }, 60_000);

  afterAll(async () => db?.close());

  it("reconciles the receipt and each liability account without raising the customer price", async () => {
    const { rows } = await db.query(`
      SELECT sales_tax_snapshot, line_total, tax_amount,
        neo_pos_sales_tax_post_lines(order_id,120,120) AS posting,
        neo_pos_sales_tax_receipt(order_id,'[{"label":"Tax","amount":18.30},{"label":"Total","amount":120}]') AS receipt
      FROM pos_order_items WHERE id='${item}'
    `);
    expect(rows[0]).toMatchObject({
      line_total: "120.00", tax_amount: "18.30", sales_tax_snapshot: { net: 101.7 },
      posting: [{ code: "2042", credit: 2.03 }, { code: "2041", credit: 16.27 }],
      receipt: [
        { label: "Net before tax", amount: 101.7 },
        { label: "2% Catering levy (LEVY) · Included", amount: 2.03 },
        { label: "16% VAT · Included", amount: 16.27 },
        { label: "Total", amount: 120 },
      ],
    });
  });

  it("keeps two saved VAT rates on separate rows without changing the tax ledger total", async () => {
    await db.exec("BEGIN");
    try {
      await db.exec(`
        UPDATE tax_codes SET rate=0.08 WHERE code='VAT';
        INSERT INTO pos_order_items(id,organization_id,order_id,menu_item_id,unit_price,quantity,line_total)
        VALUES ('82f10000-0000-4000-8000-000000000015','${org}','${order}','${menu}',120,1,120);
        UPDATE pos_orders SET subtotal=240 WHERE id='${order}';
      `);
      const { rows } = await db.query<{ result: { label: string; amount: number }[]; vat: string }>(`
        SELECT neo_pos_sales_tax_receipt('${order}','[{"label":"Tax","amount":29.21},{"label":"Total","amount":240}]')
          AS result,(SELECT sum(amount) FROM neo_pos_saved_sales_taxes('${order}',240,240) WHERE code='VAT') AS vat
      `);
      const vatRows = rows[0]?.result.filter((row) => row.label.includes(" VAT ")) ?? [];
      expect(vatRows.map((row) => row.label)).toEqual(["8% VAT · Included","16% VAT · Included"]);
      expect(vatRows.reduce((sum,row) => sum+row.amount,0)).toBeCloseTo(Number(rows[0]?.vat),2);
    } finally {
      await db.exec("ROLLBACK");
    }
  });

  it("separates proven folio tax components and keeps the remaining tax as recorded", async () => {
    const folio = "82f10000-0000-4000-8000-000000000016";
    await db.exec("BEGIN");
    try {
      await db.query("INSERT INTO folios VALUES ($1,$2,$3,'KES',$4)", [folio,org,branch,actor]);
      await db.query(`INSERT INTO folio_lines (id,organization_id,source_record_uuid,source_module,folio_id,tax_amount,status,line_type)
        VALUES (gen_random_uuid(),$2,$3,'pos',$1,18.30,'posted','charge'),
          (gen_random_uuid(),$2,NULL,'room',$1,5,'posted','charge'),
          (gen_random_uuid(),$2,NULL,'room',$1,100,'voided','charge')`, [folio,org,order]);
      const load = (property: string) => db.query("SELECT neo_folio_document_tax_rows($1,$2) AS tax", [folio,property]);
      expect((await load(branch)).rows).toEqual([{ tax: [
        { label: "16% VAT · Included", amount: 16.27 },
        { label: "2% Catering levy (LEVY) · Included", amount: 2.03 },
        { label: "Other recorded tax", amount: 5 },
      ] }]);
      await expect(load(vat)).rejects.toThrow(/outside your scope/);
    } finally {
      await db.exec("ROLLBACK");
    }
  });

  it("returns the same tax and payable amount from the installed app checkout routine", async () => {
    const { rows } = await db.query(`SELECT delivery_quote_cart('${cart}') AS quote`);
    expect(rows[0]).toMatchObject({ quote: { grand_total: 120, tax_total: 18.3, can_checkout: true,
      tax_breakdown: [{ label: "Catering levy (LEVY) · Included", amount: 2.03 }, { label: "VAT · Included", amount: 16.27 }],
    } });
  });

  it("retains saved rates and rejects a replaced snapshot or deletion of referenced tax versions", async () => {
    await db.exec("UPDATE tax_codes SET rate=0.2 WHERE code='VAT'");
    const { rows } = await db.query(`SELECT sales_tax_snapshot->'taxes' AS taxed FROM pos_order_items WHERE id='${item}'`);
    expect(rows[0]).toMatchObject({ taxed: [{ amount: 16.27 }, { amount: 2.03 }] });
    await expect(db.exec(`UPDATE pos_order_items SET sales_tax_snapshot='{}' WHERE id='${item}'`)).rejects.toThrow(/cannot be supplied/i);
    await expect(db.exec("DELETE FROM tax_codes WHERE code='VAT'")).rejects.toThrow(/referenced/i);
  });

  it("allows deletion of unused archived profiles while retaining saved sale history", async () => {
    await db.exec("BEGIN");
    try {
      await db.exec(`INSERT INTO sales_tax_profiles(organization_id,name,treatment,rules,active)
        VALUES ('${org}','Unused tax setup','none','[]',false)`);
      await db.exec("SET LOCAL ROLE authenticated");
      expect((await db.query("DELETE FROM sales_tax_profiles WHERE name='Unused tax setup' RETURNING name")).rows)
        .toEqual([{ name: "Unused tax setup" }]);
      await db.exec("RESET ROLE");
      await db.exec(`UPDATE menu_items SET sales_tax_profile_id=NULL WHERE id='${menu}';
        UPDATE sales_tax_profiles SET active=false WHERE id='${group}';`);
      await db.exec("SET LOCAL ROLE authenticated");
      await expect(db.exec(`DELETE FROM sales_tax_profiles WHERE id='${group}'`)).rejects.toThrow(/saved sales/);
    } finally {
      await db.exec("ROLLBACK");
    }
  });

  it("reverses the original tax liability accounts on a partial POS refund", async () => {
    const { rows } = await db.query(`SELECT neo_refund_credit_allocation('${journal}','${org}','${branch}','KES',120,0,60,'[]') AS reversal`);
    expect(rows[0]).toMatchObject({ reversal: [
      { code: "2041", debit: 8.14 }, { code: "2042", debit: 1.01 }, { code: "4100", debit: 50.85 },
    ] });
  });

  it("summarizes posted sales and tax per currency from saved amounts", async () => {
    const { rows } = await db.query(`SELECT neo_sales_tax_finance_summary('${branch}','2026-11-01','2026-11-30') AS summary`);
    expect(rows[0]).toMatchObject({ summary: {
      sales: [{ currency: "KES", gross: 120, net: 101.7, sales: 1 }],
      taxes: [{ code: "LEVY", amount: 2.03 }, { code: "VAT", amount: 16.27 }],
    } });
  });

  it("shows the same rounded reductions for a mixed app checkout", async () => {
    const { rows } = await db.query(`SELECT neo_delivery_sales_tax_breakdown(
      '[{"tax_parts":[{"code":"LEVY","name":"Levy","inclusive":true,"amount":2.03},
                       {"code":"VAT","name":"VAT","inclusive":true,"amount":16.27}]},
        {"line_total":116,"tax_rate":16}]',236,118) AS breakdown`);
    expect(rows[0]).toMatchObject({ breakdown: [
      { label: "Tax · Included", amount: 8 },
      { label: "Levy (LEVY) · Included", amount: 1.02 },
      { label: "VAT · Included", amount: 8.13 },
    ] });
  });

  it("prints a full credit note from the original invoice tax snapshot", async () => {
    const { rows } = await db.query(`SELECT neo_document_payload('credit_note','${note}') AS document`);
    expect(rows[0]).toMatchObject({ document: {
      document: { number: "CN-TEST", title: "Credit note" },
      meta: { "Original invoice": "INV-TEST" },
      totals: [
        { label: "Net before tax", amount: 101.7 },
        { label: "Catering levy (LEVY) · Included", amount: 2.03 },
        { label: "VAT · Included", amount: 16.27 },
        { label: "Total credited", amount: 120 },
      ],
    } });
  });
});
