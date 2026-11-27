import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
const read = (path: string) => readFileSync(path,"utf8");
const fn = (path: string,name: string) => read(path).match(new RegExp(`CREATE OR REPLACE FUNCTION public\\.${name}\\([\\s\\S]*?\\$function\\$\\s*;`))![0];
const matchingSource = "supabase/migrations/20261115020000_supplier_matching_quantity_parity.sql";
const repair = read("supabase/migrations/20261116235700_supplier_payable_journal_identity.sql");
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12,"0")}`;
const org=id(1), branch=id(2), supplier=id(3), purchase=id(4), invoice=id(5), stock=id(6), actor=id(7), period=id(8);
describe("current supplier settlement with actual payable and GL posting", () => {
  let db: PGlite;
  beforeAll(async () => {
    db=new PGlite();
    await db.exec(`CREATE ROLE authenticated; CREATE SCHEMA auth;
      CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT coalesce(nullif(current_setting('test.actor',true),''),'${actor}')::uuid $$;
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

    await db.exec(`
      ALTER TABLE supplier_invoices
        ADD COLUMN receipt_id uuid,
        ADD COLUMN created_by uuid;

      CREATE FUNCTION current_access_scope()
        RETURNS text LANGUAGE sql STABLE
        AS $$ SELECT coalesce(current_setting('test.scope',true),'operational') $$;

      CREATE FUNCTION neo_local_today(uuid)
        RETURNS date LANGUAGE sql STABLE
        AS $$ SELECT CURRENT_DATE $$;

      CREATE FUNCTION is_org_admin()
        RETURNS boolean LANGUAGE sql STABLE
        AS $$ SELECT false $$;
    `.replace(
      /CREATE FUNCTION is_org_admin\(\)[\s\S]*?SELECT false \$\$;/,
      ""
    ));

    await db.exec(`
      CREATE TABLE goods_receipts(
        id uuid PRIMARY KEY,
        organization_id uuid,
        branch_id uuid,
        supplier_id uuid,
        order_id uuid,
        status text
      );

      CREATE TABLE goods_receipt_lines(
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        organization_id uuid,
        receipt_id uuid,
        order_line_id uuid,
        stock_item_id uuid,
        quantity_accepted numeric,
        quantity_returned numeric DEFAULT 0
      );

      CREATE TABLE neo_supplier_capture_line_reservations(
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        organization_id uuid,
        submission_id uuid,
        supplier_invoice_id uuid,
        receipt_id uuid,
        purchase_order_line_id uuid,
        quantity numeric
      );
    `);

    const currentSource = read(
      "supabase/migrations/20261126024000_supplier_invoice_review_integration.sql"
    );

    const currentApproval = currentSource.match(
      /CREATE OR REPLACE FUNCTION public\.neo_supplier_invoice_accept\([\s\S]*?\bAS\s+(\$[a-z0-9_]*\$)[\s\S]*?\1\s*;/i
    );

    expect(currentApproval).not.toBeNull();

    expect(currentApproval![0]).toContain(
      "SUPPLIER_CURRENT_POSTING_EVIDENCE_V1"
    );    await db.exec(currentApproval![0]);

    await db.exec(`

      ALTER TABLE supplier_invoices
        ADD COLUMN paid_amount numeric DEFAULT 0,
        ADD COLUMN updated_at timestamptz;

      ALTER TABLE chart_of_accounts
        ADD COLUMN category text,
        ADD COLUMN name text;

      CREATE OR REPLACE FUNCTION
      neo_finance_ensure_account(uuid,text,text,text,text)
      RETURNS void
      LANGUAGE sql
      AS $$
        INSERT INTO chart_of_accounts(
          organization_id,code,name,category
        )
        VALUES($1,$2,$3,$4)
        ON CONFLICT(organization_id,code) DO NOTHING
      $$;

      CREATE FUNCTION has_permission(text,text,text)
      RETURNS boolean
      LANGUAGE sql
      STABLE
      AS $$
        SELECT coalesce(
          current_setting('test.allowed',true),
          'true'
        )='true'
      $$;

      CREATE TABLE bank_accounts(

        id uuid PRIMARY KEY,

        organization_id uuid,

        branch_id uuid,

        currency text,

        active boolean,

        gl_account_id uuid

      );

      CREATE TABLE supplier_payments(

        id uuid PRIMARY KEY,

        organization_id uuid,

        branch_id uuid,

        supplier_id uuid,

        supplier_invoice_id uuid,

        schedule_id uuid,

        status text,

        amount numeric,

        currency text,

        method text,

        bank_account_id uuid,

        external_reference text,

        payment_number text,

        created_by uuid,

        approved_by uuid,

        approved_at timestamptz,

        paid_on date,

        journal_id uuid,

        updated_at timestamptz

      );

      CREATE TABLE payment_schedules(

        id uuid PRIMARY KEY,

        organization_id uuid,

        status text,

        updated_at timestamptz

      );

      CREATE TABLE finance_posting_receipts(

        organization_id uuid,

        idempotency_key text,

        status text

      );

      CREATE TABLE audit_logs(

        organization_id uuid,

        branch_id uuid,

        user_id uuid,

        action text,

        module text,

        record_id text,

        previous_value jsonb,

        new_value jsonb,

        reason text

      );

      CREATE FUNCTION neo_record_posting_receipt(

        uuid,uuid,text,uuid,text,text,
        numeric,text,uuid,text,text,date

      ) RETURNS void

      LANGUAGE plpgsql

      AS $$ BEGIN END $$;

      CREATE FUNCTION neo_financial_state_set(

        uuid,uuid,text,uuid,text,text,text,text,
        numeric,text,date,uuid,uuid,uuid,uuid,text

      ) RETURNS void

      LANGUAGE plpgsql

      AS $$ BEGIN END $$;

    `);

    const currentSettlement = currentSource.match(

      /CREATE OR REPLACE FUNCTION public\.neo_supplier_payment_advance\([\s\S]*?\bAS\s+(\$[a-z0-9_]*\$)[\s\S]*?\1\s*;/i

    );

    expect(currentSettlement).not.toBeNull();

    expect(currentSettlement![0]).toContain(
      "SUPPLIER_SETTLEMENT_CLOSURE_V1"
    );

    await db.exec(currentSettlement![0]);

  },30_000);
  beforeEach(async () => {
    await db.exec(`TRUNCATE supplier_payments,payment_schedules,finance_posting_receipts,bank_accounts,audit_logs,goods_receipts,goods_receipt_lines,neo_supplier_capture_line_reservations,supplier_invoices,supplier_invoice_lines,purchase_orders,purchase_order_lines,stock_items,supplier_invoice_discrepancies,journal_entries,journal_entry_lines,chart_of_accounts;
      SELECT set_config('test.allowed','true',false); UPDATE accounting_periods SET status='open';
      INSERT INTO purchase_orders VALUES('${purchase}','${org}','${branch}','${supplier}','KES','approved','LPO-1',0,580);
      INSERT INTO purchase_order_lines VALUES('${id(10)}','${org}','${purchase}','${stock}','Rice',4,4,4,50,0,0,'2026-11-01'),('${id(11)}','${org}','${purchase}','${stock}','Rice',6,4,6,50,0,0,'2026-11-02');
      INSERT INTO stock_items VALUES('${stock}','Rice');      INSERT INTO supplier_invoices(
        id,organization_id,branch_id,supplier_id,order_id,
        invoice_number,status,amount,tax_amount,match_status,
        journal_id,invoice_date,approved_by,approved_at,notes,
        receipt_id,created_by
      )
      VALUES(
        '${invoice}','${org}','${branch}','${supplier}','${purchase}',
        'SUP-1','received',464,64,'pending',
        null,'2026-11-16',null,null,null,
        '${id(40)}','${id(41)}'
      );

      SELECT set_config('test.actor','',false); SELECT set_config('test.scope','operational',false);

      INSERT INTO goods_receipts VALUES(
        '${id(40)}','${org}','${branch}','${supplier}',
        '${purchase}','posted'
      );

      INSERT INTO goods_receipt_lines(
        organization_id,receipt_id,order_line_id,
        stock_item_id,quantity_accepted
      )
      VALUES
        ('${org}','${id(40)}','${id(10)}','${stock}',4),
        ('${org}','${id(40)}','${id(11)}','${stock}',4);

      INSERT INTO neo_supplier_capture_line_reservations(
        organization_id,submission_id,supplier_invoice_id,
        receipt_id,purchase_order_line_id,quantity
      )
      VALUES
        ('${org}','${id(42)}','${invoice}','${id(40)}','${id(10)}',4),
        ('${org}','${id(42)}','${invoice}','${id(40)}','${id(11)}',4);
      INSERT INTO supplier_invoice_lines VALUES('${id(12)}','${invoice}','${org}','${stock}','Rice',8,50,400,64,464);`);
  });
  afterAll(async () => { await db?.close(); });
  async function accept(reason: string | null=null) { return (await db.query<{ value: Record<string,any> }>("SELECT neo_supplier_invoice_accept($1,$2) value",[invoice,reason])).rows[0]!.value; }
  async function journalCount() { return (await db.query<{ n: number }>("SELECT count(*)::int n FROM journal_entries")).rows[0]!.n; }

  const payer=id(50);
  const approver=id(51);
  const bank=id(52);
  const bankLedger=id(53);
  const paymentOne=id(54);
  const paymentTwo=id(55);

  async function setActor(value:string) {

    await db.query(
      "SELECT set_config('test.actor',$1,false)",
      [value]
    );

  }

  async function prepareInvoice() {

    const result=await accept();

    expect(result["ok"]).toBe(true);

    expect(await journalCount()).toBe(1);

    await db.exec(`

      INSERT INTO chart_of_accounts(
        id,organization_id,code,name,category
      )

      VALUES(
        '${bankLedger}','${org}',
        '1025','Synthetic settlement bank','asset'
      );

      INSERT INTO bank_accounts VALUES(
        '${bank}','${org}','${branch}',
        'KES',true,'${bankLedger}'
      );

    `);

  }

  async function createPayment(
    payment:string,
    amount:number,
    reference:string
  ) {

    await db.query(`

      INSERT INTO supplier_payments(

        id,organization_id,branch_id,supplier_id,

        supplier_invoice_id,status,amount,currency,

        method,bank_account_id,external_reference,

        payment_number,created_by,paid_on

      )

      VALUES(

        $1,$2,$3,$4,$5,'draft',$6,'KES',

        'bank_transfer',$7,$8,$9,$10,

        '2026-11-17'

      )

    `,[

      payment,org,branch,supplier,invoice,

      amount,bank,reference,

      "PAY-"+payment.slice(-4),payer

    ]);

  }

  async function advance(
    payment:string,
    action:string,
    reason:string|null=null
  ) {

    return (await db.query<{
      value:Record<string,unknown>
    }>(

      "SELECT neo_supplier_payment_advance($1,$2,$3) value",

      [payment,action,reason]

    )).rows[0]!.value;

  }

  async function releasePayment(payment:string) {

    await setActor(payer);

    expect((await advance(payment,"submit"))["ok"])
      .toBe(true);

    await setActor(approver);

    expect((await advance(payment,"approve"))["ok"])
      .toBe(true);

    await setActor(payer);

    expect((await advance(payment,"release"))["ok"])
      .toBe(true);

  }

  async function invoicePosition() {

    return (await db.query(`

      SELECT
        status,
        paid_amount::float8 paid
      FROM supplier_invoices
      WHERE id='${invoice}'

    `)).rows[0];

  }

  it("settles partial and final payments through actual GL posting",async()=>{

    await prepareInvoice();

    await createPayment(
      paymentOne,200,"BANK-TEST-001"
    );

    await releasePayment(paymentOne);

    expect((await advance(paymentOne,"settle"))["ok"])
      .toBe(true);

    expect(await invoicePosition()).toEqual({

      status:"partially_paid",

      paid:200,

    });

    await createPayment(
      paymentTwo,264,"BANK-TEST-002"
    );

    await releasePayment(paymentTwo);

    expect((await advance(paymentTwo,"settle"))["ok"])
      .toBe(true);

    expect(await invoicePosition()).toEqual({

      status:"paid",

      paid:464,

    });

    expect(await journalCount()).toBe(3);

    const balances=(await db.query(`

      SELECT

        a.code,

        sum(jl.debit-jl.credit)::float8 balance

      FROM journal_entry_lines jl

      JOIN chart_of_accounts a

        ON a.id=jl.account_id

      GROUP BY a.code

      ORDER BY a.code

    `)).rows;

    expect(balances).toEqual([

      {code:"1025",balance:-464},

      {code:"1300",balance:64},

      {code:"2000",balance:0},

      {code:"2100",balance:400},

    ]);

    expect((await advance(paymentTwo,"settle"))["idempotent"])
      .toBe(true);

    expect(await journalCount()).toBe(3);

  });

  it("uses original AP account after matching policy changes",async()=>{

    await prepareInvoice();

    await db.exec(`

      UPDATE procurement_matching_policies

      SET payable_account_code='2200'

    `);

    try {

      await createPayment(
        paymentOne,100,"BANK-TEST-003"
      );

      await releasePayment(paymentOne);

      expect((await advance(paymentOne,"settle"))["ok"])
        .toBe(true);

      const lines=(await db.query(`

        SELECT a.code,jl.debit::float8 debit

        FROM journal_entry_lines jl

        JOIN chart_of_accounts a

          ON a.id=jl.account_id

        JOIN journal_entries j

          ON j.id=jl.journal_id

        WHERE j.source_document_id='${paymentOne}'

          AND jl.debit>0

      `)).rows;

      expect(lines).toEqual([

        {code:"2000",debit:100},

      ]);

    } finally {

      await db.exec(`

        UPDATE procurement_matching_policies

        SET payable_account_code='2000'

      `);

    }

  });

  it("rejects payment approval by its creator",async()=>{

    await prepareInvoice();

    await createPayment(
      paymentOne,100,"BANK-TEST-004"
    );

    await setActor(payer);

    await advance(paymentOne,"submit");

    await expect(
      advance(paymentOne,"approve")
    ).rejects.toThrow(
      /cannot be approved by the person/i
    );

    expect(await journalCount()).toBe(1);

  });

  it("rejects settlement before independent approval and release",async()=>{

    await prepareInvoice();

    await createPayment(
      paymentOne,100,"BANK-TEST-005"
    );

    await setActor(payer);

    await expect(
      advance(paymentOne,"settle")
    ).rejects.toThrow(
      /only a released payment/i
    );

    expect(await journalCount()).toBe(1);

  });

  it("rejects payment exceeding outstanding liability",async()=>{

    await prepareInvoice();

    await createPayment(
      paymentOne,465,"BANK-TEST-006"
    );

    await releasePayment(paymentOne);

    await expect(
      advance(paymentOne,"settle")
    ).rejects.toThrow(
      /remains outstanding/i
    );

    expect(await journalCount()).toBe(1);

    expect(await invoicePosition()).toEqual({

      status:"approved",

      paid:0,

    });

  });

  it("rejects a bank account belonging to another property",async()=>{

    await prepareInvoice();

    await createPayment(
      paymentOne,100,"BANK-TEST-007"
    );

    await releasePayment(paymentOne);

    await db.exec(`

      UPDATE bank_accounts

      SET branch_id='${id(90)}'

    `);

    await expect(
      advance(paymentOne,"settle")
    ).rejects.toThrow(
      /active ledger mapping/i
    );

    expect(await journalCount()).toBe(1);

  });

  it("rejects bank account currency mismatch",async()=>{

    await prepareInvoice();

    await createPayment(
      paymentOne,100,"BANK-TEST-008"
    );

    await releasePayment(paymentOne);

    await db.exec(

      "UPDATE bank_accounts SET currency='USD'"

    );

    await expect(
      advance(paymentOne,"settle")
    ).rejects.toThrow(
      /active ledger mapping/i
    );

    expect(await journalCount()).toBe(1);

  });

  it("rejects a repeated external settlement reference",async()=>{

    await prepareInvoice();

    await createPayment(
      paymentOne,100,"BANK-TEST-009"
    );

    await releasePayment(paymentOne);

    expect((await advance(paymentOne,"settle"))["ok"])
      .toBe(true);

    await createPayment(
      paymentTwo,100,"bank-test-009"
    );

    await releasePayment(paymentTwo);

    await expect(
      advance(paymentTwo,"settle")
    ).rejects.toThrow(
      /external supplier payment reference already settled/i
    );

    expect(await journalCount()).toBe(2);

  });

  it("rejects settlement against a reversed invoice journal",async()=>{

    await prepareInvoice();

    await createPayment(
      paymentOne,100,"BANK-TEST-010"
    );

    await releasePayment(paymentOne);

    await db.exec(`

      UPDATE journal_entries

      SET reversed_by_journal_id='${id(91)}'

      WHERE source_document_id='${invoice}'

    `);

    await expect(
      advance(paymentOne,"settle")
    ).rejects.toThrow(
      /valid payable journal/i
    );

    expect(await journalCount()).toBe(1);

  });

  it("rejects corrupted historical invoice journal lines",async()=>{

    await prepareInvoice();

    await createPayment(
      paymentOne,100,"BANK-TEST-011"
    );

    await releasePayment(paymentOne);

    await db.exec(`

      UPDATE journal_entry_lines

      SET debit=debit-1

      WHERE debit>0

    `);

    await expect(
      advance(paymentOne,"settle")
    ).rejects.toThrow(
      /journal lines do not reconcile/i
    );

    expect(await journalCount()).toBe(1);

  });

  it("rejects technical access to supplier payment processing",async()=>{

    await prepareInvoice();

    await createPayment(
      paymentOne,100,"BANK-TEST-012"
    );

    await releasePayment(paymentOne);

    await db.exec(

      "SELECT set_config('test.scope','technical',false)"

    );

    await expect(
      advance(paymentOne,"settle")
    ).rejects.toThrow(
      /operational finance payment authority/i
    );

    expect(await journalCount()).toBe(1);

  });

  it("blocks additional settlement when prior payment evidence is inconsistent",async()=>{

    await prepareInvoice();

    await createPayment(
      paymentOne,100,"BANK-TEST-013"
    );

    await releasePayment(paymentOne);

    expect((await advance(paymentOne,"settle"))["ok"])
      .toBe(true);

    await db.exec(`

      UPDATE journal_entries

      SET total_credit=999

      WHERE source_document_id='${paymentOne}'

    `);

    await createPayment(
      paymentTwo,100,"BANK-TEST-014"
    );

    await releasePayment(paymentTwo);

    await expect(
      advance(paymentTwo,"settle")
    ).rejects.toThrow(
      /previous supplier payments require accounting reconciliation/i
    );

    expect(await journalCount()).toBe(2);

  });

});
