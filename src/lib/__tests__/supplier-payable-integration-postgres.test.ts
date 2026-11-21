import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
const read = (path: string) => readFileSync(path,"utf8");
const fn = (path: string,name: string) => read(path).match(new RegExp(`CREATE OR REPLACE FUNCTION public\\.${name}\\([\\s\\S]*?\\$function\\$\\s*;`))![0];
const matchingSource = "supabase/migrations/20261115020000_supplier_matching_quantity_parity.sql";
const repair = read("supabase/migrations/20261116235700_supplier_payable_journal_identity.sql");
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12,"0")}`;
const org=id(1), branch=id(2), supplier=id(3), purchase=id(4), invoice=id(5), stock=id(6), actor=id(7), period=id(8);
describe("supplier acceptance through matching and actual GL/period posting", () => {
  let db: PGlite;
  beforeAll(async () => {
    db=new PGlite();
    await db.exec(`CREATE ROLE authenticated; CREATE SCHEMA auth;
      CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT '${actor}'::uuid $$;
      CREATE FUNCTION current_org_id() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT '${org}'::uuid $$;
      CREATE FUNCTION has_permission(text,text) RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT coalesce(current_setting('test.allowed',true),'true')='true' $$;
      CREATE FUNCTION is_org_admin() RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT false $$;
      CREATE FUNCTION is_active_staff() RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT true $$;
      CREATE FUNCTION neo_branch_in_scope(uuid) RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT $1='${branch}'::uuid $$;
      CREATE FUNCTION neo_assert_capability(text,text,text) RETURNS void LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Not permitted'; END $$;
      CREATE FUNCTION neo_fact_currency(uuid,uuid) RETURNS text LANGUAGE sql STABLE AS $$ SELECT 'KES' $$;
      CREATE FUNCTION neo_ap_sync_match_amounts(uuid) RETURNS void LANGUAGE plpgsql AS $$ BEGIN END $$;
      CREATE TABLE procurement_matching_policies(match_mode text,quantity_tolerance_pct numeric,price_tolerance_pct numeric,price_tolerance_amount numeric,expense_account_code text,grni_account_code text,payable_account_code text,tax_input_account_code text);
      INSERT INTO procurement_matching_policies VALUES('three-way',0,0,0,'5000','2100','2000','1300');
      CREATE FUNCTION neo_matching_policy(uuid,uuid) RETURNS procurement_matching_policies LANGUAGE sql STABLE AS $$ SELECT * FROM procurement_matching_policies LIMIT 1 $$;
      CREATE TABLE supplier_invoices(id uuid PRIMARY KEY,organization_id uuid,branch_id uuid,supplier_id uuid,order_id uuid,invoice_number text,status text,amount numeric,tax_amount numeric,match_status text,journal_id uuid,invoice_date date,approved_by uuid,approved_at timestamptz,notes text);
      CREATE TABLE supplier_invoice_lines(id uuid PRIMARY KEY,supplier_invoice_id uuid,organization_id uuid,stock_item_id uuid,description text,quantity numeric,unit_price numeric,net_amount numeric,tax_amount numeric,total_amount numeric);
      CREATE TABLE purchase_orders(id uuid PRIMARY KEY,organization_id uuid,branch_id uuid,supplier_id uuid,currency text,status text,order_number text,invoiced_amount numeric,total_amount numeric);
      CREATE TABLE purchase_order_lines(id uuid PRIMARY KEY,organization_id uuid,order_id uuid,stock_item_id uuid,description text,quantity numeric,accepted_quantity numeric,received_quantity numeric,unit_price numeric,cancelled_quantity numeric,invoiced_quantity numeric,created_at timestamptz);
      CREATE TABLE stock_items(id uuid,name text);
      CREATE TABLE supplier_invoice_discrepancies(organization_id uuid,supplier_invoice_id uuid,order_id uuid,stock_item_id uuid,kind text,severity text,detail text,actual_value numeric,expected_value numeric,variance numeric,resolved boolean DEFAULT false);
      CREATE TABLE chart_of_accounts(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),organization_id uuid,code text,active boolean DEFAULT true,postable boolean DEFAULT true,is_header boolean DEFAULT false,UNIQUE(organization_id,code));
      CREATE TABLE accounting_periods(id uuid PRIMARY KEY,organization_id uuid,name text,status text);
      INSERT INTO accounting_periods VALUES('${period}','${org}','November 2026','open');
      CREATE TABLE journal_entries(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),organization_id uuid,branch_id uuid,journal_number text,journal_type text,accounting_date date,period_id uuid,source_module text,source_document_type text,source_document_id uuid,idempotency_key text,description text,currency text,status text,created_by uuid,reverses_journal_id uuid,reversed_by_journal_id uuid,total_debit numeric,total_credit numeric,posted_by uuid,posted_at timestamptz,created_at timestamptz DEFAULT now());
      CREATE TABLE journal_entry_lines(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),organization_id uuid,journal_id uuid,line_number integer,account_id uuid,description text,debit numeric,credit numeric,branch_id uuid,customer_id uuid);
      CREATE SEQUENCE journal_number;
      CREATE FUNCTION next_document_number(text,text,uuid) RETURNS text LANGUAGE sql VOLATILE AS $$ SELECT 'JV-'||nextval('journal_number') $$;
      CREATE FUNCTION neo_gl_period(uuid,date) RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT id FROM accounting_periods WHERE organization_id=$1 LIMIT 1 $$;
      CREATE FUNCTION fin_period_for(uuid,date) RETURNS accounting_periods LANGUAGE sql STABLE AS $$ SELECT * FROM accounting_periods WHERE organization_id=$1 LIMIT 1 $$;
      CREATE FUNCTION neo_system_posting() RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT coalesce(current_setting('neo.system_posting',true),'off')='on' $$;
      CREATE FUNCTION neo_gl_acct(uuid,text) RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT id FROM chart_of_accounts WHERE organization_id=$1 AND code=$2 AND active AND postable AND NOT is_header $$;
      CREATE FUNCTION neo_finance_ensure_account(uuid,text,text,text,text) RETURNS void LANGUAGE sql AS $$ INSERT INTO chart_of_accounts(organization_id,code) VALUES($1,$2) ON CONFLICT(organization_id,code) DO NOTHING $$;
    `);
    await db.exec(fn(matchingSource,"proc_three_way_match"));
    await db.exec(read("supabase/migrations/20261116231500_supplier_purchase_approval_guard.sql"));
    await db.exec(fn(matchingSource,"neo_supplier_invoice_accept"));
    await db.exec(fn("supabase/migrations/20261114013000_shared_workspace_workflows.sql","neo_gl_post"));
    await db.exec(fn("supabase/migrations/20260824061411_4a5ea0a9-50b0-432e-9dfa-20e867f53f07.sql","fin_post_journal"));
    await db.exec("REVOKE ALL ON FUNCTION neo_supplier_invoice_accept(uuid,text) FROM PUBLIC; GRANT EXECUTE ON FUNCTION neo_supplier_invoice_accept(uuid,text) TO authenticated");
    await db.exec(repair);
  },30_000);
  beforeEach(async () => {
    await db.exec(`TRUNCATE supplier_invoices,supplier_invoice_lines,purchase_orders,purchase_order_lines,stock_items,supplier_invoice_discrepancies,journal_entries,journal_entry_lines,chart_of_accounts;
      SELECT set_config('test.allowed','true',false); UPDATE accounting_periods SET status='open';
      INSERT INTO purchase_orders VALUES('${purchase}','${org}','${branch}','${supplier}','KES','approved','LPO-1',0,580);
      INSERT INTO purchase_order_lines VALUES('${id(10)}','${org}','${purchase}','${stock}','Rice',4,4,4,50,0,0,'2026-11-01'),('${id(11)}','${org}','${purchase}','${stock}','Rice',6,4,6,50,0,0,'2026-11-02');
      INSERT INTO stock_items VALUES('${stock}','Rice');
      INSERT INTO supplier_invoices VALUES('${invoice}','${org}','${branch}','${supplier}','${purchase}','SUP-1','received',464,64,'pending',null,'2026-11-16',null,null,null);
      INSERT INTO supplier_invoice_lines VALUES('${id(12)}','${invoice}','${org}','${stock}','Rice',8,50,400,64,464);`);
  });
  afterAll(async () => { await db?.close(); });
  async function accept(reason: string | null=null) { return (await db.query<{ value: Record<string,any> }>("SELECT neo_supplier_invoice_accept($1,$2) value",[invoice,reason])).rows[0]!.value; }
  async function journalCount() { return (await db.query<{ n: number }>("SELECT count(*)::int n FROM journal_entries")).rows[0]!.n; }
  it("creates one balanced payable with original invoice/property/currency and allocates repeated PO lines once",async () => {
    const result=await accept();
    expect(result["ok"]).toBe(true);
    expect((await db.query("SELECT status,source_document_type,source_document_id,branch_id,currency,total_debit::float8 debit,total_credit::float8 credit FROM journal_entries")).rows[0]).toEqual({status:"posted",source_document_type:"supplier_invoice:payable",source_document_id:invoice,branch_id:branch,currency:"KES",debit:464,credit:464});
    expect((await db.query("SELECT a.code,l.debit::float8 debit,l.credit::float8 credit FROM journal_entry_lines l JOIN chart_of_accounts a ON a.id=l.account_id ORDER BY a.code")).rows).toEqual([{code:"1300",debit:64,credit:0},{code:"2000",debit:0,credit:464},{code:"2100",debit:400,credit:0}]);
    expect((await db.query("SELECT invoiced_quantity::float8 quantity FROM purchase_order_lines ORDER BY id")).rows).toEqual([{quantity:4},{quantity:4}]);
    expect((await db.query("SELECT invoiced_amount::float8 amount,status FROM purchase_orders")).rows[0]).toEqual({amount:464,status:"partially-invoiced"});
    expect(await accept()).toMatchObject({already_posted:true,journal_id:result["journal_id"]});
    expect(await journalCount()).toBe(1);
    expect((await db.query("SELECT sum(invoiced_quantity)::float8 quantity FROM purchase_order_lines")).rows[0]).toEqual({quantity:8});
  });
  it.each(["cancelled","rejected","voided","reversed"])("refuses %s invoices even with a written override",async (status) => {
    await db.query("UPDATE supplier_invoices SET status=$1",[status]);
    await expect(accept("Manager override")).rejects.toThrow(/cannot be accepted/);
    expect(await journalCount()).toBe(0);
  });
  it("blocks unapproved purchases even with a written variance reason",async () => {
    await db.exec("UPDATE purchase_orders SET status='draft'");
    await expect(accept("Manager override")).rejects.toThrow(/must be approved/);
    expect(await journalCount()).toBe(0);
  });
  it("rolls back journal, invoice acceptance and PO quantities when the accounting period is closed",async () => {
    await db.exec("UPDATE accounting_periods SET status='hard_closed'");
    await expect(accept()).rejects.toThrow(/Accounting period/);
    expect(await journalCount()).toBe(0);
    expect((await db.query("SELECT status,journal_id FROM supplier_invoices")).rows[0]).toEqual({status:"received",journal_id:null});
    expect((await db.query("SELECT sum(invoiced_quantity)::float8 quantity FROM purchase_order_lines")).rows[0]).toEqual({quantity:0});
  });
  it.each(["source","amount","currency","reversal","lines"])("refuses a saved journal with conflicting %s evidence",async (defect) => {
    await accept();
    if(defect==="source") await db.exec(`UPDATE journal_entries SET source_document_id='${id(30)}'`);
    if(defect==="amount") await db.exec("UPDATE journal_entries SET total_debit=999,total_credit=999");
    if(defect==="currency") await db.exec("UPDATE journal_entries SET currency='USD'");
    if(defect==="reversal") await db.exec(`UPDATE journal_entries SET reversed_by_journal_id='${id(30)}'`);
    if(defect==="lines") await db.exec("UPDATE journal_entry_lines SET credit=0 WHERE credit>0");
    await expect(accept()).rejects.toThrow(/Saved invoice journal is not confirmed/);
    expect(await journalCount()).toBe(1);
  });
  it("checks new posting evidence before linking a journal returned by the GL service",async () => {
    // Replay an existing GL journal after losing the invoice link, simulating interrupted handoff.
    await accept();
    await db.exec("UPDATE supplier_invoices SET journal_id=null; UPDATE journal_entries SET total_debit=400,total_credit=400; UPDATE journal_entry_lines SET debit=0 WHERE debit>0; UPDATE journal_entry_lines SET credit=400 WHERE credit>0; UPDATE journal_entry_lines SET debit=400 WHERE line_number=1");
    await expect(accept("Written variance")).rejects.toThrow(/successfully posted journal/);
    expect((await db.query("SELECT journal_id FROM supplier_invoices")).rows[0]).toEqual({journal_id:null});
  });
  it("retains permission and property guards",async () => {
    await db.exec("SELECT set_config('test.allowed','false',false)");
    await expect(accept()).rejects.toThrow(/Not permitted/);
    await db.exec(`SELECT set_config('test.allowed','true',false); UPDATE supplier_invoices SET branch_id='${id(30)}'`);
    await expect(accept()).rejects.toThrow(/outside authorized property/);
  });
  it("reapplies without changing approval grants or posting additional journals",async () => {
    await accept(); await db.exec(repair);
    expect(await journalCount()).toBe(1);
    expect((await db.query("SELECT has_function_privilege('authenticated','neo_supplier_invoice_accept(uuid,text)','EXECUTE') allowed")).rows[0]).toEqual({allowed:true});
  });
});
