import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";

const db = new PGlite();

const org = "10000000-0000-4000-8000-000000000001";
const otherOrg = "10000000-0000-4000-8000-000000000002";

const branchA = "20000000-0000-4000-8000-000000000001";
const branchB = "20000000-0000-4000-8000-000000000002";

const account = "30000000-0000-4000-8000-000000000001";
const cash = "30000000-0000-4000-8000-000000000002";

const actor = "40000000-0000-4000-8000-000000000001";

let passed = 0;

async function test(name, fn) {
  await fn();
  passed++;
  console.log("PASS:", name);
}

try {

  await db.exec(`
    CREATE SCHEMA auth;

    CREATE FUNCTION auth.uid()
    RETURNS uuid LANGUAGE sql AS
    $$ SELECT '${actor}'::uuid $$;

    CREATE FUNCTION public.current_org_id()
    RETURNS uuid LANGUAGE sql STABLE AS
    $$ SELECT '${org}'::uuid $$;

    CREATE FUNCTION public.current_access_scope()
    RETURNS text LANGUAGE sql STABLE AS
    $$ SELECT nullif(current_setting('test.scope', true), '') $$;

    CREATE FUNCTION public.current_branch_ids()
    RETURNS uuid[] LANGUAGE sql STABLE AS
    $$ SELECT ARRAY['${branchA}'::uuid] $$;

    CREATE FUNCTION public.neo_branch_in_scope(_branch uuid)
    RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $function$
      SELECT CASE
        WHEN public.current_access_scope()
          IN ('organisation','technical') THEN true
        ELSE _branch IS NULL
          OR _branch = ANY(public.current_branch_ids())
      END;
    $function$;

    CREATE FUNCTION public.has_permission(text,text)
    RETURNS boolean LANGUAGE sql STABLE AS
    $$ SELECT true $$;

    CREATE FUNCTION public.is_org_admin()
    RETURNS boolean LANGUAGE sql STABLE AS
    $$ SELECT false $$;

    CREATE FUNCTION public.neo_system_posting()
    RETURNS boolean LANGUAGE sql STABLE AS
    $$ SELECT false $$;

    CREATE FUNCTION public.can_read_general_ledger()
    RETURNS boolean LANGUAGE sql STABLE AS
    $$ SELECT true $$;

    CREATE TABLE public.chart_of_accounts (
      id uuid PRIMARY KEY,
      organization_id uuid,
      code text,
      name text,
      category text,
      active boolean DEFAULT true,
      postable boolean DEFAULT true,
      is_header boolean DEFAULT false
    );

    CREATE TABLE public.branches (
      id uuid PRIMARY KEY,
      name text
    );

    CREATE TABLE public.accounting_periods (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      name text,
      status text
    );

    CREATE TABLE public.journal_entries (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      organization_id uuid,
      branch_id uuid,
      journal_number text,
      journal_type text DEFAULT 'general',
      accounting_date date DEFAULT CURRENT_DATE,
      period_id uuid,
      source_module text,
      source_document_type text,
      source_document_id uuid,
      document_number text,
      description text,
      currency text DEFAULT 'KES',
      status text DEFAULT 'draft',
      total_debit numeric DEFAULT 0,
      total_credit numeric DEFAULT 0,
      reverses_journal_id uuid,
      reversed_by_journal_id uuid,
      created_by uuid,
      posted_by uuid,
      posted_at timestamptz,
      updated_at timestamptz
    );

    CREATE TABLE public.journal_entry_lines (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      organization_id uuid,
      journal_id uuid,
      line_number integer,
      account_id uuid,
      description text,
      debit numeric DEFAULT 0,
      credit numeric DEFAULT 0,
      branch_id uuid,
      department_id uuid,
      cost_centre text,
      revenue_centre text,
      customer_id uuid,
      corporate_account_id uuid,
      supplier_id uuid,
      folio_id uuid,
      event_booking_id uuid,
      payment_method text,
      tax_code_id uuid
    );

    INSERT INTO public.accounting_periods(name,status)
    VALUES ('Test period','open');

    CREATE FUNCTION public.fin_period_for(uuid,date)
    RETURNS public.accounting_periods
    LANGUAGE sql STABLE AS
    $$ SELECT * FROM public.accounting_periods LIMIT 1 $$;

    CREATE FUNCTION public.next_document_number(text)
    RETURNS text LANGUAGE sql AS
    $$ SELECT 'TEST-' || gen_random_uuid()::text $$;
  `);

  const files = process.argv.slice(2);

  if (files.length !== 2) {
    throw new Error("Supply the two original function export files");
  }

  function parseCsv(text) {
    text = text.replace(/^\uFEFF/, "");
    const rows = [];
    let row = [], value = "", quoted = false;

    for (let i = 0; i < text.length; i++) {
      const c = text[i];

      if (c === '"') {
        if (quoted && text[i + 1] === '"') {
          value += '"';
          i++;
        } else {
          quoted = !quoted;
        }
      } else if (c === ";" && !quoted) {
        row.push(value);
        value = "";
      } else if (c === "\n" && !quoted) {
        row.push(value.replace(/\r$/, ""));
        rows.push(row);
        row = [];
        value = "";
      } else {
        value += c;
      }
    }

    if (value.length || row.length) {
      row.push(value);
      rows.push(row);
    }

    const headers = rows.shift();

    return rows.map(r =>
      Object.fromEntries(headers.map((h,i) => [h,r[i]]))
    );
  }

  const exported = files.flatMap(file =>
    parseCsv(readFileSync(file, "utf8"))
  );

  const targets = [
    "fin_trial_balance",
    "neo_general_ledger",
    "fin_post_journal",
    "fin_reverse_journal"
  ];

  for (const name of targets) {
    const row = exported.find(r => r.function_name === name);

    assert.ok(row?.definition, "Missing original function: " + name);

    await db.exec(row.definition);

    console.log("Installed original fixture:", name);
  }

  const migration = readFileSync(
    "supabase/migrations/20261125153000_finance_property_scope_integrity.sql",
    "utf8"
  );

  await test("Actual migration executes with source guards intact", async () => {
    await db.exec(migration);
  });

  await db.exec(`
    INSERT INTO chart_of_accounts
      (id,organization_id,code,name,category)
    VALUES
      ('${account}','${org}','4100','Sales','revenue'),
      ('${cash}','${org}','1010','Cash','asset');

    INSERT INTO branches VALUES
      ('${branchA}','Property A'),
      ('${branchB}','Property B');
  `);

  async function journal(branch, amount, status = "posted", tenant = org) {

    const id = crypto.randomUUID();

    await db.query(`
      INSERT INTO journal_entries
        (id,organization_id,branch_id,journal_number,status)
      VALUES ($1,$2,$3,$4,$5)
    `,[id,tenant,branch,id,status]);

    await db.query(`
      INSERT INTO journal_entry_lines
        (organization_id,journal_id,account_id,branch_id,debit,credit,line_number)
      VALUES
        ($1,$2,$3,$4,0,$5,1),
        ($1,$2,$6,$4,$5,0,2)
    `,[tenant,id,account,branch,amount,cash]);

    return id;
  }

  async function scope(value) {
    await db.query(
      "SELECT set_config('test.scope',$1,false)",
      [value]
    );
  }

  async function trial(branch = null) {
    const result = await db.query(`
      SELECT credit::float8 AS credit
      FROM fin_trial_balance(
        '2000-01-01','2100-01-01',$1
      )
      WHERE account_id=$2
    `,[branch,account]);

    return result.rows[0]?.credit ?? 0;
  }

  async function ledger(branch = null) {
    const result = await db.query(`
      SELECT coalesce(sum(credit),0)::float8 AS credit
      FROM neo_general_ledger(
        '2000-01-01','2100-01-01',$1,$2
      )
    `,[branch,account]);

    return result.rows[0].credit;
  }

  await journal(branchA,100);
  const postedB = await journal(branchB,200);
  await journal(null,300);
  await journal(branchA,900,"posted",otherOrg);

  await scope("property");

  await test("Trial Balance authorised property", async () => {
    assert.equal(await trial(branchA),100);
  });

  await test("Trial Balance denies unauthorised property", async () => {
    assert.equal(await trial(branchB),0);
  });

  await test("Restricted consolidated Trial Balance", async () => {
    assert.equal(await trial(),100);
  });

  await test("Restricted consolidated General Ledger", async () => {
    assert.equal(await ledger(),100);
  });

  await test("General Ledger denies unauthorised property", async () => {
    assert.equal(await ledger(branchB),0);
  });

  await test("Organisation-wide reporting retains valid balances", async () => {
    await scope("organisation");

    assert.equal(await trial(),600);
    assert.equal(await ledger(),600);

    await scope("property");
  });

  const draftA = await journal(branchA,40,"draft");
  const draftB = await journal(branchB,50,"draft");
  const branchless = await journal(null,60,"draft");

  await test("Unauthorised journal posting rejected", async () => {
    await assert.rejects(
      db.query("SELECT fin_post_journal($1)",[draftB]),
      /scope/
    );
  });

  await test("Branchless manual journal rejected", async () => {
    await assert.rejects(
      db.query("SELECT fin_post_journal($1)",[branchless]),
      /organisation scope/
    );
  });

  await test("Authorised journal posting succeeds", async () => {
    await db.query("SELECT fin_post_journal($1)",[draftA]);
    assert.equal(await trial(branchA),140);
  });

  await test("Unauthorised journal reversal rejected", async () => {
    await assert.rejects(
      db.query(
        "SELECT fin_reverse_journal($1,'Test reversal')",
        [postedB]
      ),
      /scope/
    );
  });

  await test("Authorised reversal offsets the original journal", async () => {
    await db.query(
      "SELECT fin_reverse_journal($1,'Test reversal')",
      [draftA]
    );

    const result = await db.query(`
      SELECT balance::float8 AS balance
      FROM fin_trial_balance(
        '2000-01-01','2100-01-01',$1
      )
      WHERE account_id=$2
    `,[branchA,account]);

    assert.equal(result.rows[0].balance,-100);
  });

  await test("Duplicate reversal rejected", async () => {
    await assert.rejects(
      db.query(
        "SELECT fin_reverse_journal($1,'Duplicate')",
        [draftA]
      ),
      /already been reversed/
    );
  });

  await test("Missing access scope cannot access branchless journal", async () => {
    await scope("");

    await assert.rejects(
      db.query("SELECT fin_post_journal($1)",[branchless]),
      /organisation scope/
    );
  });

  console.log("\nFIN-06E:",passed,"TESTS PASSED");

} catch (error) {
  console.error("\nFIN-06E FAILED");
  console.error(error);
  process.exitCode = 1;
} finally {
  await db.close();
}