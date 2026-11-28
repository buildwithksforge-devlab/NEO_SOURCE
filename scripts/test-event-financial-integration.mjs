import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";

const db = new PGlite();

const ids = {
  org: "10000000-0000-0000-0000-000000000001",
  otherOrg: "10000000-0000-0000-0000-000000000002",
  branch: "20000000-0000-0000-0000-000000000001",
  otherBranch: "20000000-0000-0000-0000-000000000002",
  event: "30000000-0000-0000-0000-000000000001",
  customer: "40000000-0000-0000-0000-000000000001",
  invoice: "50000000-0000-0000-0000-000000000001"
};

let passed = 0;
let failed = 0;

async function query(sql,params=[]) {
  return (await db.query(sql,params)).rows;
}

async function scalar(sql,params=[]) {
  return Object.values((await query(sql,params))[0])[0];
}

const executedTestNames = new Set();

async function test(name, run) {
  if (executedTestNames.has(name)) {
    console.error("FATAL: Recursive or duplicate test execution:", name);
    process.exit(1);
  }

  executedTestNames.add(name);
  try {
    await run();
    passed++;
    console.log("PASS:",name);
  } catch(error) {
    failed++;
    console.error("FAIL:",name,error.message);
    try { await db.exec("ROLLBACK"); } catch {}
  }
}

async function setting(key,value) {
  await query(
    "SELECT set_config($1,$2,false)",
    [key,value]
  );
}

async function account(code,category) {
  return scalar(`
    INSERT INTO public.chart_of_accounts(
      organization_id,code,category
    )
    VALUES ($1,$2,$3)
    RETURNING id
  `,[ids.org,code,category]);
}

async function payment(amount,method,status="confirmed") {
  return scalar(`
    INSERT INTO public.payments(
      organization_id,branch_id,
      source_module,source_record_id,
      amount,method,status
    )
    VALUES ($1,$2,'events',$3,$4,$5,$6)
    RETURNING id
  `,[ids.org,ids.branch,ids.event,amount,method,status]);
}

async function journal(type,source) {
  return scalar(`
    INSERT INTO public.journal_entries(
      organization_id,branch_id,
      source_document_type,source_document_id,status
    )
    VALUES ($1,$2,$3,$4,'draft')
    RETURNING id
  `,[ids.org,ids.branch,type,source]);
}

async function line(journalId,accountId,debit,credit) {
  await query(`
    INSERT INTO public.journal_entry_lines(
      organization_id,journal_id,
      account_id,debit,credit
    )
    VALUES ($1,$2,$3,$4,$5)
  `,[ids.org,journalId,accountId,debit,credit]);
}

async function post(id) {
  await query(`
    UPDATE public.journal_entries
    SET status='posted'
    WHERE id=$1
  `,[id]);
}

try {
  await db.exec(`
    CREATE ROLE anon;
    CREATE ROLE authenticated;

    CREATE SCHEMA auth;

    CREATE FUNCTION auth.uid()
    RETURNS uuid LANGUAGE sql STABLE AS $$
      SELECT '90000000-0000-0000-0000-000000000001'::uuid
    $$;

    CREATE FUNCTION public.neo_finance_reverse_posting(
      text,uuid,text,text
    )
    RETURNS jsonb LANGUAGE sql AS $$
      SELECT jsonb_build_object('ok',true)
    $$;

    CREATE FUNCTION public.current_org_id()
    RETURNS uuid LANGUAGE sql STABLE AS $$
      SELECT nullif(
        current_setting('test.org',true),''
      )::uuid
    $$;

    CREATE FUNCTION public.neo_branch_in_scope(uuid)
    RETURNS boolean LANGUAGE sql STABLE AS $$
      SELECT $1 = nullif(
        current_setting('test.branch',true),''
      )::uuid
    $$;

    CREATE FUNCTION public.neo_gl_account_code(
      uuid,text,uuid
    )
    RETURNS text LANGUAGE sql AS $$
      SELECT CASE $2
        WHEN 'cash' THEN '1010'
        WHEN 'mpesa' THEN '1020'
        WHEN 'bank' THEN '1030'
        ELSE NULL
      END
    $$;

    CREATE TABLE public.chart_of_accounts(
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      organization_id uuid,
      code text,
      category text NOT NULL CHECK (
        category IN (
          'asset','liability','equity',
          'revenue','cost_of_sales',
          'operating_expense','other_income',
          'other_expense'
        )
      )
    );

    CREATE TABLE public.event_bookings(
      id uuid PRIMARY KEY,
      organization_id uuid,
      branch_id uuid,
      customer_id uuid,
      deposit_paid numeric DEFAULT 0,
      status text DEFAULT 'confirmed'
    );

    CREATE TABLE public.invoices(
      id uuid PRIMARY KEY,
      organization_id uuid,
      event_booking_id uuid
    );

    CREATE TABLE public.payments(
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      organization_id uuid,
      branch_id uuid,
      source_module text,
      source_record_id uuid,
      amount numeric,
      method text,
      status text,
      destination_account_id uuid,
      posted_journal_id uuid
    );

    CREATE TABLE public.event_payments(
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      organization_id uuid,
      branch_id uuid,
      booking_id uuid,
      entry_type text,
      amount numeric,
      payment_id uuid
    );

    CREATE TABLE public.journal_entries(
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      organization_id uuid,
      branch_id uuid,
      source_document_type text,
      source_document_id uuid,
      status text DEFAULT 'draft',
      reversed_by_journal_id uuid
    );

    CREATE TABLE public.journal_entry_lines(
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      organization_id uuid,
      journal_id uuid,
      account_id uuid,
      debit numeric DEFAULT 0,
      credit numeric DEFAULT 0
    );

    CREATE FUNCTION public.neo_finance_post_txn(
      _source_type text,
      _source_id uuid,
      _automatic boolean
    )
    RETURNS jsonb LANGUAGE plpgsql AS $$
    DECLARE
      org uuid := public.current_org_id();
      ev public.event_bookings;
      amount numeric;
      paid numeric;
      remainder numeric;
      lines jsonb;
    BEGIN

      IF _source_type = 'fixture' THEN

        RETURN jsonb_build_object('ok',true);

      ELSIF _source_type = 'event_deposit' THEN

        SELECT * INTO ev
        FROM public.event_bookings
        WHERE id = _source_id
          AND organization_id = org;

        amount := ev.deposit_paid;

        lines := jsonb_build_array(
          jsonb_build_object(
            'code','1010','debit',amount
          ),
          jsonb_build_object(
            'code','2030','credit',amount
          )
        );

      ELSIF _source_type = 'event_invoice' THEN

        RETURN jsonb_build_object('ok',true);

      ELSIF _source_type = 'event_cancellation' THEN

        SELECT * INTO ev
        FROM public.event_bookings
        WHERE id = _source_id
          AND organization_id = org;

        PERFORM public.neo_finance_reverse_posting('event_earned', ev.id, 'earned', 'Event cancelled');

        amount := 2000;
        paid := ev.deposit_paid;
        remainder := greatest(paid - amount, 0);

        IF amount = 0 AND remainder = 0 THEN
          RETURN jsonb_build_object('ok',true);
        END IF;

      END IF;

      RETURN jsonb_build_object(
        'ok',true,'lines',lines
      );

    END $$;
  `);

  for (const migration of [
    "20261125184000_inventory_journal_line_integrity.sql",
    "20261125185000_income_tax_account_classification.sql",
    "20261125190000_event_financial_recognition_guards.sql",
    "20261125191000_event_deposit_allocation_guard.sql",
    "20261125194000_event_mixed_payment_allocation.sql",
    "20261125195000_event_collection_reconciliation.sql",
    "20261125201000_event_cancellation_refund_liability.sql"
  ]) {
    await db.exec(readFileSync(
      "supabase/migrations/"+migration,
      "utf8"
    ));
    console.log("INSTALLED:",migration);
  }

  await setting("test.org",ids.org);
  await setting("test.branch",ids.branch);

  await query(`
    INSERT INTO public.event_bookings(
      id,organization_id,branch_id,
      customer_id,deposit_paid
    )
    VALUES ($1,$2,$3,$4,10000)
  `,[ids.event,ids.org,ids.branch,ids.customer]);

  const cash = await account("1010","asset");
  const mpesa = await account("1020","asset");
  const bank = await account("1030","asset");
  const liability = await account("2030","liability");
  const revenue = await account("4010","revenue");

  let p1,p2;

  await test("Explicit income tax category accepted",async()=>{
    assert.ok(await account(
      "5900","income_tax_expense"
    ));
  });

  await test("Mixed event payment allocations",async()=>{
    p1 = await payment(4000,"cash");
    p2 = await payment(6000,"mpesa");

    const result = await scalar(`
      SELECT public.neo_event_deposit_settlement_lines(
        $1,$2,10000
      )
    `,[ids.org,ids.event]);

    assert.equal(result.length,3);
    assert.equal(
      result.find(x=>x.code==="1010").debit,
      4000
    );
    assert.equal(
      result.find(x=>x.code==="1020").debit,
      6000
    );
    assert.equal(
      result.find(x=>x.code==="2030").credit,
      10000
    );
  });

  await test("Unconfirmed payments excluded",async()=>{
    await payment(5000,"bank","pending");

    const result = await scalar(`
      SELECT public.neo_event_deposit_settlement_lines(
        $1,$2,10000
      )
    `,[ids.org,ids.event]);

    assert.equal(
      result.some(x=>x.code==="1030"),
      false
    );
  });

  await test("Payment total mismatch rejected",async()=>{
    await assert.rejects(scalar(`
      SELECT public.neo_event_deposit_settlement_lines(
        $1,$2,12000
      )
    `,[ids.org,ids.event]));
  });

  await test("Cross-organisation allocation rejected",async()=>{
    await assert.rejects(scalar(`
      SELECT public.neo_event_deposit_settlement_lines(
        $1,$2,10000
      )
    `,[ids.otherOrg,ids.event]));
  });

  await test("Cross-property allocation rejected",async()=>{
    await setting("test.branch",ids.otherBranch);
    try {
      await assert.rejects(scalar(`
        SELECT public.neo_event_deposit_settlement_lines(
          $1,$2,10000
        )
      `,[ids.org,ids.event]));
    } finally {
      await setting("test.branch",ids.branch);
    }
  });

  await test("Aggregate journal with wrong account rejected",async()=>{
    const j = await journal(
      "event_deposit:deposit",ids.event
    );

    await line(j,cash,10000,0);
    await line(j,liability,0,10000);

    await assert.rejects(post(j));

    assert.equal(await scalar(`
      SELECT status FROM public.journal_entries
      WHERE id=$1
    `,[j]),"draft");
  });

  async function individualReceipt(paymentId,amount,accountId) {
    const ep = await scalar(`
      INSERT INTO public.event_payments(
        organization_id,branch_id,booking_id,
        entry_type,amount,payment_id
      )
      VALUES ($1,$2,$3,'deposit',$4,$5)
      RETURNING id
    `,[
      ids.org,ids.branch,ids.event,
      amount,paymentId
    ]);

    const j = await journal("event_payment",ep);

    await line(j,accountId,amount,0);
    await line(j,liability,0,amount);

    await post(j);

    await query(`
      UPDATE public.payments
      SET posted_journal_id=$2
      WHERE id=$1
    `,[paymentId,j]);

    return j;
  }

  await test("Individual receipt journals reconcile",async()=>{
    await individualReceipt(p1,4000,cash);
    await individualReceipt(p2,6000,mpesa);

    const evidence = await scalar(`
      SELECT public.neo_event_collection_posting_evidence(
        $1,$2
      )
    `,[ids.org,ids.event]);

    assert.equal(evidence.fully_posted,true);
    assert.equal(evidence.verified_entries,2);
    assert.equal(evidence.posted_deposits,10000);
  });

  await test("Aggregate posting returns existing receipt evidence",async()=>{
    const result = await scalar(`
      SELECT public.neo_finance_post_txn(
        'event_deposit',$1,true
      )
    `,[ids.event]);

    assert.equal(result.ok,true);
    assert.equal(result.duplicate_prevented,true);
    assert.equal(
      result.reason,
      "already_posted_individually"
    );
  });

  await test("Duplicate aggregate deposit journal rejected",async()=>{
    const j = await journal(
      "event_deposit:deposit",ids.event
    );

    await line(j,cash,4000,0);
    await line(j,mpesa,6000,0);
    await line(j,liability,0,10000);

    await assert.rejects(post(j));
  });

  await test("Invoice and earned revenue cannot both post",async()=>{
    await query(`
      INSERT INTO public.invoices
      VALUES ($1,$2,$3)
    `,[ids.invoice,ids.org,ids.event]);

    const invoiceJournal = await journal(
      "event_invoice:invoice",
      ids.invoice
    );

    await line(invoiceJournal,revenue,0,20000);

    await post(invoiceJournal);

    const earned = await journal(
      "event_earned:earned",
      ids.event
    );

    await assert.rejects(post(earned));
  });

  await test("Cancellation cannot invent a cash refund",async()=>{
    const j = await journal(
      "event_cancellation:cancellation",
      ids.event
    );

    await line(j,liability,10000,0);
    await line(j,cash,0,10000);

    await assert.rejects(post(j));
  });

  await test("Posted inventory journal lines are immutable",async()=>{
    const j = await journal(
      "inventory_posting_event:consumption_cogs",
      ids.event
    );

    await line(j,cash,100,0);
    await post(j);

    await assert.rejects(query(`
      UPDATE public.journal_entry_lines
      SET debit=200
      WHERE journal_id=$1
    `,[j]));

    await assert.rejects(query(`
      DELETE FROM public.journal_entry_lines
      WHERE journal_id=$1
    `,[j]));
  });

  await test("Unposted inventory journals remain editable",async()=>{
    const j = await journal(
      "inventory_posting_event:consumption_cogs",
      ids.event
    );

    await line(j,cash,100,0);

    await query(`
      UPDATE public.journal_entry_lines
      SET debit=200
      WHERE journal_id=$1
    `,[j]);

    assert.equal(Number(await scalar(`
      SELECT debit
      FROM public.journal_entry_lines
      WHERE journal_id=$1
    `,[j])),200);
  });

  await test("Cancellation records outstanding refund obligation",async()=>{

    await query(`
      UPDATE public.event_bookings
      SET status='cancelled'
      WHERE id=$1
    `,[ids.event]);

    const result = await scalar(`
      SELECT public.neo_finance_post_txn(
        'event_cancellation',$1,true
      )
    `,[ids.event]);

    assert.equal(result.ok,false);
    assert.equal(result.refund_amount,8000);
    assert.equal(result.refund_obligation_recorded,true);

    assert.equal(Number(await scalar(`
      SELECT count(*)
      FROM public.neo_event_refund_obligations
      WHERE booking_id=$1
    `,[ids.event])),1);
  });

  await test("Repeated cancellation cannot duplicate obligation",async()=>{

    await scalar(`
      SELECT public.neo_finance_post_txn(
        'event_cancellation',$1,true
      )
    `,[ids.event]);

    assert.equal(Number(await scalar(`
      SELECT count(*)
      FROM public.neo_event_refund_obligations
      WHERE booking_id=$1
    `,[ids.event])),1);

    assert.equal(await scalar(`
      SELECT status
      FROM public.neo_event_refund_obligations
      WHERE booking_id=$1
    `,[ids.event]),"awaiting-settlement");
  });

  await test("Unauthorised property cannot record refund obligation",async()=>{

    await setting("test.branch",ids.otherBranch);

    try {
      await assert.rejects(scalar(`
        SELECT public.neo_record_event_refund_obligation(
          $1,$2,8000
        )
      `,[ids.org,ids.event]));
    } finally {
      await setting("test.branch",ids.branch);
    }
  });

} catch(error) {
  failed++;
  console.error("EVENT INTEGRATION FAILURE:",error);
} finally {
  await db.close();
}

console.log("\nEVENT FINANCIAL INTEGRATION RESULTS");
console.log("PASSED:",passed);
console.log("FAILED:",failed);

process.exitCode = failed ? 1 : 0;