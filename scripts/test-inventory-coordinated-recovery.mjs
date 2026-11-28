import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";

const db = new PGlite();

const org = "10000000-0000-0000-0000-000000000001";
const branch = "20000000-0000-0000-0000-000000000001";
const actor = "30000000-0000-0000-0000-000000000001";
const other = "40000000-0000-0000-0000-000000000001";
const journal = "50000000-0000-0000-0000-000000000001";

let passed = 0;
let failed = 0;

const executed = new Set();

async function q(sql,params=[]) {
  return (await db.query(sql,params)).rows;
}

async function scalar(sql,params=[]) {
  return Object.values((await q(sql,params))[0])[0];
}

async function setting(key,value) {
  await q("SELECT set_config($1,$2,false)",[key,value]);
}

async function test(name,run) {
  if(executed.has(name)) throw Error("Duplicate test: "+name);
  executed.add(name);

  try {
    await run();
    passed++;
    console.log("PASS:",name);
  } catch(error) {
    failed++;
    console.error("FAIL:",name,error.message);
  }
}

async function event(status,finance,cost,journalId=null) {
  return scalar(`
    INSERT INTO public.inventory_posting_events(
      organization_id,branch_id,status,
      finance_posting_status,cost_snapshot,
      finance_journal_id,payload
    )
    VALUES($1,$2,$3,$4,$5,$6,'{"valuation_status":"verified"}')
    RETURNING id
  `,[org,branch,status,finance,cost,journalId]);
}

async function retry(id) {
  return scalar(
    "SELECT public.neo_retry_inventory_consumption_finance($1)",
    [id]
  );
}

try {
  await db.exec(`
    CREATE ROLE anon;
    CREATE ROLE authenticated;
    CREATE SCHEMA auth;

    CREATE FUNCTION auth.uid()
    RETURNS uuid LANGUAGE sql STABLE AS $$
      SELECT nullif(current_setting('test.actor',true),'')::uuid
    $$;

    CREATE FUNCTION public.current_org_id()
    RETURNS uuid LANGUAGE sql STABLE AS $$
      SELECT nullif(current_setting('test.org',true),'')::uuid
    $$;

    CREATE FUNCTION public.neo_branch_in_scope(uuid)
    RETURNS boolean LANGUAGE sql STABLE AS $$
      SELECT $1 = current_setting('test.branch',true)::uuid
    $$;

    CREATE FUNCTION public.is_org_admin()
    RETURNS boolean LANGUAGE sql STABLE AS $$
      SELECT current_setting('test.admin',true)='yes'
    $$;

    CREATE FUNCTION public.has_permission(text,text)
    RETURNS boolean LANGUAGE sql STABLE AS $$
      SELECT false
    $$;

    CREATE TABLE public.inventory_posting_events(
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      organization_id uuid,
      branch_id uuid,
      status text,
      finance_posting_status text,
      finance_journal_id uuid,
      cost_snapshot numeric,
      payload jsonb
    );

    CREATE TABLE public.neo_inventory_finance_reversals(
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      organization_id uuid,
      branch_id uuid,
      consumption_event_id uuid,
      original_stock_movement_id uuid DEFAULT gen_random_uuid(),
      restoration_stock_movement_id uuid DEFAULT gen_random_uuid()
    );

    CREATE TABLE public.fixture_calls(
      kind text,
      event_id uuid
    );

    CREATE FUNCTION public.neo_inventory_post_consumption_finance(uuid)
    RETURNS jsonb LANGUAGE plpgsql AS $$
    BEGIN
      INSERT INTO public.fixture_calls VALUES('original',$1);

      UPDATE public.inventory_posting_events
      SET finance_posting_status='posted',
          finance_journal_id=CASE
            WHEN cost_snapshot=0 THEN NULL
            ELSE '50000000-0000-0000-0000-000000000001'::uuid
          END
      WHERE id=$1;

      RETURN jsonb_build_object('status','posted');
    END $$;

    CREATE FUNCTION public.neo_inventory_post_restoration_finance(
      uuid,uuid,uuid
    )
    RETURNS jsonb LANGUAGE plpgsql AS $$
    BEGIN
      INSERT INTO public.fixture_calls VALUES('restoration',$1);
      RETURN jsonb_build_object('status','posted');
    END $$;
  `);

  await db.exec(readFileSync(
    "supabase/migrations/20261125202000_inventory_coordinated_recovery.sql",
    "utf8"
  ));

  await setting("test.org",org);
  await setting("test.branch",branch);
  await setting("test.actor",actor);
  await setting("test.admin","yes");

  await test("Legacy event excluded",async()=>{
    const id=await event("posted",null,100);
    assert.equal((await retry(id)).status,"legacy-excluded");
  });

  await test("Reversed event without original journal remains blocked",async()=>{
    const id=await event("reversed","failed",100);

    assert.equal(
      (await retry(id)).status,
      "coordinated-recovery-required"
    );

    assert.equal(Number(await scalar(`
      SELECT count(*) FROM public.fixture_calls
      WHERE event_id=$1
    `,[id])),0);
  });

  await test("Original accounting and restoration retried together",async()=>{
    const id=await event("posted","failed",100);

    await q(`
      INSERT INTO public.neo_inventory_finance_reversals(
        organization_id,branch_id,consumption_event_id
      )
      VALUES($1,$2,$3)
    `,[org,branch,id]);

    const result=await retry(id);

    assert.equal(result.status,"recovery-attempted");
    assert.equal(result.restorations_attempted,1);

    const calls=await q(`
      SELECT kind FROM public.fixture_calls
      WHERE event_id=$1
    `,[id]);

    assert.deepEqual(
      calls.map(x=>x.kind),
      ["original","restoration"]
    );
  });

  await test("Existing reversed journal can recover restoration",async()=>{
    const id=await event("reversed","posted",100,journal);

    await q(`
      INSERT INTO public.neo_inventory_finance_reversals(
        organization_id,branch_id,consumption_event_id
      )
      VALUES($1,$2,$3)
    `,[org,branch,id]);

    const result=await retry(id);

    assert.equal(result.restorations_attempted,1);
    assert.equal(result.original.status,"existing-original-journal");
  });

  await test("Verified zero-cost restoration reaches engine",async()=>{
    const id=await event("posted","pending",0);

    await q(`
      INSERT INTO public.neo_inventory_finance_reversals(
        organization_id,branch_id,consumption_event_id
      )
      VALUES($1,$2,$3)
    `,[org,branch,id]);

    const result=await retry(id);
    assert.equal(result.restorations_attempted,1);
  });

  await test("Cross-property recovery rejected",async()=>{
    const id=await event("posted","pending",100);

    await setting("test.branch",other);

    try {
      await assert.rejects(retry(id));
    } finally {
      await setting("test.branch",branch);
    }
  });

  await test("Cross-organisation recovery rejected",async()=>{
    const id=await event("posted","pending",100);

    await setting("test.org",other);

    try {
      await assert.rejects(retry(id));
    } finally {
      await setting("test.org",org);
    }
  });

  await test("Ordinary employee cannot initiate finance recovery",async()=>{
    const id=await event("posted","pending",100);

    await setting("test.admin","no");

    try {
      await assert.rejects(retry(id));
    } finally {
      await setting("test.admin","yes");
    }
  });

} catch(error) {
  failed++;
  console.error("INTEGRATION FAILURE:",error.message);
} finally {
  await db.close();
}

console.log("PASSED:",passed);
console.log("FAILED:",failed);

process.exitCode = failed ? 1 : 0;