import {PGlite} from "@electric-sql/pglite";
import {readFileSync} from "node:fs";
import {
  beforeAll,beforeEach,afterAll,describe,it,expect
} from "vitest";

const id=(n:number)=>
  `00000000-0000-4000-8000-${String(n).padStart(12,"0")}`;

const org=id(1),branch=id(2),actor=id(3),
      request=id(4),payment=id(5),order=id(6),
      journal=id(7);

let db:PGlite;

beforeAll(async()=>{

  db=new PGlite();

  await db.exec(`

    CREATE ROLE anon;
    CREATE ROLE authenticated;
    CREATE ROLE service_role;
    CREATE SCHEMA auth;

    CREATE FUNCTION auth.uid()
    RETURNS uuid LANGUAGE sql AS $$
      SELECT '${actor}'::uuid
    $$;

    CREATE FUNCTION current_org_id()
    RETURNS uuid LANGUAGE sql AS $$
      SELECT '${org}'::uuid
    $$;

    CREATE FUNCTION current_access_scope()
    RETURNS text LANGUAGE sql AS $$
      SELECT coalesce(
        current_setting('test.scope',true),
        'operational'
      )
    $$;

    CREATE FUNCTION neo_branch_in_scope(uuid)
    RETURNS boolean LANGUAGE sql AS $$
      SELECT $1='${branch}'::uuid
    $$;

    CREATE TABLE pos_refund_requests(
      id uuid PRIMARY KEY,
      organization_id uuid,
      branch_id uuid,
      payment_id uuid,
      order_id uuid,
      amount numeric,
      status text,
      method text
    );

    CREATE TABLE pos_payments(
      id uuid PRIMARY KEY,
      organization_id uuid,
      branch_id uuid,
      order_id uuid,
      amount numeric,
      status text,
      method text,
      currency text
    );

    CREATE TABLE pos_orders(
      id uuid PRIMARY KEY,
      organization_id uuid,
      branch_id uuid,
      currency text
    );

    CREATE TABLE journal_entries(
      id uuid PRIMARY KEY,
      organization_id uuid,
      branch_id uuid,
      source_document_id uuid,
      source_document_type text,
      status text,
      currency text,
      total_debit numeric,
      total_credit numeric,
      reversed_by_journal_id uuid,
      reverses_journal_id uuid
    );

    CREATE TABLE journal_entry_lines(
      journal_id uuid,
      organization_id uuid,
      branch_id uuid,
      debit numeric,
      credit numeric
    );

  `);

  const source=readFileSync(
    "supabase/migrations/20261126010000_bill_reopening_financial_integrity.sql",
    "utf8"
  );

  const section=source.split(
    "-- NEO_POS_REFUND_FINANCIAL_CLOSURE_V1"
  )[1]?.split("DO $refund_install$")[0];

  if(!section){
    throw new Error("Refund closure source unavailable");
  }

  await db.exec(section);

},60000);

afterAll(async()=>{

  await db?.close();

});

beforeEach(async()=>{

  await db.exec(`

    TRUNCATE pos_refund_requests,pos_payments,pos_orders,
      journal_entries,journal_entry_lines;

    SELECT set_config('test.scope','operational',false);

    INSERT INTO pos_orders VALUES(
      '${order}','${org}','${branch}','KES'
    );

    INSERT INTO pos_payments VALUES(
      '${payment}','${org}','${branch}',
      '${order}',5000,'confirmed','cash','KES'
    );

    INSERT INTO pos_refund_requests VALUES(
      '${request}','${org}','${branch}',
      '${payment}','${order}',5000,'pending','cash'
    );

    INSERT INTO journal_entries VALUES(
      '${journal}','${org}','${branch}',
      '${request}','pos_refund:refund',
      'posted','KES',5000,5000,NULL,NULL
    );

    INSERT INTO journal_entry_lines VALUES
      ('${journal}','${org}','${branch}',5000,0),
      ('${journal}','${org}','${branch}',0,5000);

  `);

});

async function guard(approve:boolean|null=true){

  return db.query(
    "SELECT neo_pos_refund_financial_guard($1,$2)",
    [request,approve]
  );

}

async function posting(value:unknown={ok:true,journal_id:journal}){

  return db.query(
    "SELECT neo_pos_refund_require_posting($1,$2::jsonb)",
    [request,JSON.stringify(value)]
  );

}

describe("POS refund financial closure",()=>{

  it("allows a valid full refund boundary",async()=>{

    await expect(guard()).resolves.toBeDefined();

  });

  it("blocks unsafe partial refund execution",async()=>{

    await db.exec("UPDATE pos_refund_requests SET amount=2000");

    await expect(guard()).rejects.toThrow(/Partial refund/);

  });

  it("blocks refund above original collection",async()=>{

    await db.exec("UPDATE pos_refund_requests SET amount=6000");

    await expect(guard()).rejects.toThrow(/exceeds original/);

  });

  it("blocks refund against an unconfirmed payment",async()=>{

    await db.exec("UPDATE pos_payments SET status='pending'");

    await expect(guard()).rejects.toThrow(/confirmed payment/);

  });

  it("blocks technical financial execution",async()=>{

    await db.exec(
      "SELECT set_config('test.scope','technical',false)"
    );

    await expect(guard()).rejects.toThrow(/Operational refund/);

  });

  it("blocks cross-property refund authority",async()=>{

    await db.exec(`
      UPDATE pos_refund_requests
      SET branch_id='${id(99)}'
    `);

    await expect(guard()).rejects.toThrow(/property scope/);

  });

  it("requires an explicit refund decision",async()=>{

    await expect(guard(null)).rejects.toThrow(/Explicit refund/);

  });

  it("preserves refund rejection",async()=>{

    await expect(guard(false)).resolves.toBeDefined();

  });

  it("accepts matching posted accounting evidence",async()=>{

    await expect(posting()).resolves.toBeDefined();

  });

  it("blocks unsuccessful accounting results",async()=>{

    await expect(
      posting({ok:false})
    ).rejects.toThrow(/not successfully posted/);

  });

  it("blocks missing journal identity",async()=>{

    await expect(
      posting({ok:true})
    ).rejects.toThrow(/not successfully posted/);

  });

  it("blocks draft journal evidence",async()=>{

    await db.exec("UPDATE journal_entries SET status='draft'");

    await expect(posting()).rejects.toThrow(/inconsistent/);

  });

  it("blocks incorrect journal totals",async()=>{

    await db.exec("UPDATE journal_entries SET total_credit=4999");

    await expect(posting()).rejects.toThrow(/inconsistent/);

  });

  it("blocks corrupt journal lines",async()=>{

    await db.exec(`
      UPDATE journal_entry_lines
      SET credit=1
      WHERE debit>0
    `);

    await expect(posting()).rejects.toThrow(/lines are invalid/);

  });

  it("blocks unbalanced actual journal lines",async()=>{

    await db.exec(`
      UPDATE journal_entry_lines
      SET credit=4000
      WHERE credit>0
    `);

    await expect(posting()).rejects.toThrow(/not balanced/);

  });

  it("blocks reversed refund journals",async()=>{

    await db.exec(`
      UPDATE journal_entries
      SET reversed_by_journal_id='${id(99)}'
    `);

    await expect(posting()).rejects.toThrow(/inconsistent/);

  });

});