import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";

const db = new PGlite();

const ids = {
  org: "10000000-0000-0000-0000-000000000001",
  otherOrg: "10000000-0000-0000-0000-000000000002",
  branch: "20000000-0000-0000-0000-000000000001",
  otherBranch: "20000000-0000-0000-0000-000000000002",
  actor: "30000000-0000-0000-0000-000000000001",
  order: "40000000-0000-0000-0000-000000000001",
  item: "50000000-0000-0000-0000-000000000001",
  primary: "60000000-0000-0000-0000-000000000001",
  secondary: "60000000-0000-0000-0000-000000000002",
  menu: "70000000-0000-0000-0000-000000000001",
  attempt: "80000000-0000-0000-0000-000000000001",
};

let passed = 0;
let failed = 0;

async function query(sql, params = []) {
  return (await db.query(sql, params)).rows;
}

async function scalar(sql, params = []) {
  const rows = await query(sql, params);
  return Object.values(rows[0])[0];
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
    console.log("PASS:", name);
  } catch (error) {
    failed++;
    console.error("FAIL:", name, error.message);
    try { await db.exec("ROLLBACK"); } catch {}
  }
}

async function setting(key, value) {
  await query(
    "SELECT set_config($1,$2,false)",
    [key, value]
  );
}

try {
  await db.exec(`
    CREATE ROLE anon;
    CREATE ROLE authenticated;

    CREATE SCHEMA auth;

    CREATE FUNCTION auth.uid()
    RETURNS uuid LANGUAGE sql STABLE AS $$
      SELECT nullif(
        current_setting('test.actor',true),''
      )::uuid
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

    CREATE FUNCTION public.is_org_admin()
    RETURNS boolean LANGUAGE sql STABLE AS $$
      SELECT current_setting('test.admin',true) = 'yes'
    $$;

    CREATE FUNCTION public.has_permission(text,text)
    RETURNS boolean LANGUAGE sql STABLE AS $$
      SELECT current_setting('test.admin',true) = 'yes'
        OR ($1 = 'pos' AND $2 = 'orders.create')
    $$;

    CREATE TABLE public.pos_orders (
      id uuid PRIMARY KEY,
      organization_id uuid,
      branch_id uuid,
      waiter_id uuid,
      created_by uuid,
      order_type text,
      status text
    );

    CREATE TABLE public.pos_order_items (
      id uuid PRIMARY KEY,
      organization_id uuid,
      order_id uuid,
      menu_item_id uuid,
      item_name text,
      quantity numeric,
      station_id uuid,
      held boolean DEFAULT false,
      status text DEFAULT 'draft',
      sent_at timestamptz
    );

    CREATE TABLE public.station_tickets (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      organization_id uuid,
      branch_id uuid,
      order_id uuid,
      station_id uuid,
      status text DEFAULT 'new'
    );

    CREATE TABLE public.station_ticket_items (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      organization_id uuid,
      ticket_id uuid,
      order_item_id uuid,
      remake_of_id uuid,
      status text DEFAULT 'new'
    );

    CREATE TABLE public.inventory_posting_events (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      organization_id uuid,
      order_id uuid,
      order_item_id uuid,
      status text
    );

    CREATE TABLE public.menu_items (
      id uuid PRIMARY KEY,
      organization_id uuid,
      category_id uuid
    );

    CREATE TABLE public.operational_stations (
      organization_id uuid,
      id uuid PRIMARY KEY,
      name text
    );

    CREATE TABLE public.station_routing_rules (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      organization_id uuid,
      branch_id uuid,
      menu_item_id uuid,
      category_id uuid,
      modifier_option_id uuid,
      order_type text,
      station_id uuid,
      secondary_station_id uuid,
      priority integer DEFAULT 100,
      active boolean DEFAULT true
    );

    CREATE FUNCTION public.neo_kitchen_route_order_item(uuid)
    RETURNS jsonb LANGUAGE sql STABLE AS $$
      SELECT jsonb_build_object(
        'station_id',station_id,
        'source','fixture'
      )
      FROM public.pos_order_items
      WHERE id=$1
    $$;

    -- Controlled routing dependency. Writes before raising
    -- an exception so rollback can be tested explicitly.

    CREATE FUNCTION public.neo_pos_route_tickets_internal(
      _order uuid, _org uuid
    )
    RETURNS jsonb LANGUAGE plpgsql AS $$
    DECLARE o public.pos_orders;
    BEGIN
      SELECT * INTO o FROM public.pos_orders
      WHERE id = _order AND organization_id = _org;

      UPDATE public.pos_orders
      SET status = 'sent'
      WHERE id = _order;

      IF current_setting('test.route_fail',true) = 'yes'
      THEN
        RAISE EXCEPTION
          'routing_unresolved: 1 item';
      END IF;

      RETURN jsonb_build_object(
        'ok',true,
        'order_id',_order,
        'tickets_created',0,
        'items_created',0,
        'items_reused',0,
        'unassigned_station',0
      );
    END $$;
  `);

  const original = readFileSync(
    "supabase/migrations/20260827130313_7cd797d9-1f05-45d9-858b-82d5b3a08388.sql",
    "utf8"
  );

  const match = original.match(
    /CREATE OR REPLACE FUNCTION public\.neo_pos_send_to_kitchen\([\s\S]*?\$function\$;/
  );

  assert.ok(match, "Original POS send definition missing");

  await db.exec(match[0]);

  for (const migration of [
    "20261125192000_pos_handoff_recovery.sql",
    "20261125193000_pos_handoff_ticket_evidence.sql",
    "20261125200000_pos_secondary_station_evidence.sql",
    "20261125203000_pos_canonical_routing_verification.sql"
  ]) {
    await db.exec(readFileSync(
      "supabase/migrations/" + migration,
      "utf8"
    ));
    console.log("INSTALLED:", migration);
  }

  await setting("test.org", ids.org);
  await setting("test.branch", ids.branch);
  await setting("test.actor", ids.actor);
  await setting("test.admin", "yes");
  await setting("test.route_fail", "yes");

  await query(`
    INSERT INTO public.pos_orders
    VALUES ($1,$2,$3,$4,$4,'dine-in','draft')
  `,[ids.order,ids.org,ids.branch,ids.actor]);

  await query(`
    INSERT INTO public.menu_items (id,organization_id)
    VALUES ($1,$2)
  `,[ids.menu,ids.org]);

  await query(`
    INSERT INTO public.pos_order_items (
      id,organization_id,order_id,menu_item_id,
      item_name,quantity,station_id
    )
    VALUES ($1,$2,$3,$4,'Fixture meal',1,$5)
  `,[ids.item,ids.org,ids.order,ids.menu,ids.primary]);

  let failureId;

  await test("Routing failure returns unsuccessful result",async()=>{
    const result = await scalar(
      "SELECT public.neo_pos_send_to_kitchen($1,$2)",
      [ids.order,ids.attempt]
    );
    assert.equal(result.ok,false);
    assert.equal(result.status,"handoff_failed");
  });

  await test("Failed routing rolls back operational changes",async()=>{
    assert.equal(await scalar(
      "SELECT status FROM public.pos_orders WHERE id=$1",
      [ids.order]
    ),"draft");
  });

  await test("Failure evidence survives routing rollback",async()=>{
    const rows = await query(
      "SELECT * FROM public.neo_pos_handoff_failures"
    );
    assert.equal(rows.length,1);
    failureId = rows[0].id;
    assert.equal(rows[0].attempts,1);
  });

  await test("Retry records attempts without duplicate failure rows",async()=>{
    await scalar(
      "SELECT public.neo_pos_send_to_kitchen($1,$2)",
      [ids.order,ids.attempt]
    );
    const rows = await query(
      "SELECT * FROM public.neo_pos_handoff_failures"
    );
    assert.equal(rows.length,1);
    assert.equal(rows[0].attempts,2);
  });

  await test("Supervisor queue exposes genuine failure",async()=>{
    const rows = await query(
      "SELECT * FROM public.neo_pos_handoff_recovery_queue($1,100)",
      [ids.branch]
    );
    assert.equal(rows.length,1);
    assert.equal(rows[0].failure_id,failureId);
    assert.equal(Number(rows[0].ticket_count),0);
  });

  await test("Ordinary employee cannot access supervisor queue",async()=>{
    await setting("test.admin","no");
    try {
      await assert.rejects(
        query("SELECT * FROM public.neo_pos_handoff_recovery_queue(NULL,100)")
      );
    } finally {
      await setting("test.admin","yes");
    }
  });

  await test("Cross-property investigation rejected",async()=>{
    await setting("test.branch",ids.otherBranch);
    try {
      await assert.rejects(scalar(
        "SELECT public.neo_pos_handoff_full_investigation($1)",
        [failureId]
      ));
    } finally {
      await setting("test.branch",ids.branch);
    }
  });

  await test("Cross-organisation investigation rejected",async()=>{
    await setting("test.org",ids.otherOrg);
    try {
      await assert.rejects(scalar(
        "SELECT public.neo_pos_handoff_full_investigation($1)",
        [failureId]
      ));
    } finally {
      await setting("test.org",ids.org);
    }
  });

  await test("Supervisor review retains durable evidence",async()=>{
    const result = await scalar(
      "SELECT public.neo_pos_review_failed_handoff($1,$2)",
      [failureId,"Fixture supervisor review"]
    );
    assert.equal(result.ok,true);
    assert.equal(Number(await scalar(
      "SELECT count(*) FROM public.neo_pos_handoff_reviews"
    )),1);
  });

  await test("Blank review rejected",async()=>{
    await assert.rejects(scalar(
      "SELECT public.neo_pos_review_failed_handoff($1,$2)",
      [failureId," "]
    ));
  });

  await test("Missing primary ticket identified",async()=>{
    const result = await scalar(
      "SELECT public.neo_pos_handoff_full_investigation($1)",
      [failureId]
    );
    assert.equal(
      result.production_routing_plan.missing_primary_items,
      1
    );
    assert.equal(result.routing_verified,false);
  });

  await test("Configured secondary station candidate identified",async()=>{
    await query(`
      INSERT INTO public.station_routing_rules(
        organization_id,branch_id,menu_item_id,
        station_id,secondary_station_id
      )
      VALUES ($1,$2,$3,$4,$5)
    `,[
      ids.org,ids.branch,ids.menu,
      ids.primary,ids.secondary
    ]);

    const result = await scalar(
      "SELECT public.neo_pos_handoff_full_investigation($1)",
      [failureId]
    );

    assert.equal(
      result.secondary_station_coverage.missing_secondary_links,
      1
    );

    assert.equal(
      result.secondary_station_coverage.rule_precedence_verified,
      false
    );
  });

  await test("Real primary ticket evidence changes coverage",async()=>{
    const ticket = await scalar(`
      INSERT INTO public.station_tickets(
        organization_id,branch_id,order_id,station_id
      )
      VALUES ($1,$2,$3,$4)
      RETURNING id
    `,[ids.org,ids.branch,ids.order,ids.primary]);

    await query(`
      INSERT INTO public.station_ticket_items(
        organization_id,ticket_id,order_item_id
      )
      VALUES ($1,$2,$3)
    `,[ids.org,ticket,ids.item]);

    const result = await scalar(
      "SELECT public.neo_pos_handoff_full_investigation($1)",
      [failureId]
    );

    assert.equal(
      result.production_routing_plan.missing_primary_items,
      0
    );
  });

  await test("Successful retry retains unverified investigation",async()=>{
    await setting("test.route_fail","no");

    const result = await scalar(
      "SELECT public.neo_pos_send_to_kitchen($1,$2)",
      [ids.order,ids.attempt]
    );

    assert.equal(result.ok,true);

    const rows = await query(
      "SELECT * FROM public.neo_pos_handoff_recovery_queue($1,100)",
      [ids.branch]
    );

    assert.equal(rows.length,1);
    assert.equal(rows[0].recovery_status,"routing-retried");
  });

  await test("Canonical primary routing verified without secondary candidates",async()=>{

    await query(`
      UPDATE public.station_routing_rules
      SET active=false
      WHERE organization_id=$1
    `,[ids.org]);

    const result=await scalar(`
      SELECT public.neo_pos_canonical_routing_evidence(
        $1,$2,$3
      )
    `,[ids.org,ids.branch,ids.order]);

    assert.equal(result.primary_verified,true);
    assert.equal(result.routing_verified,true);
  });

  await test("Cancelled primary ticket invalidates canonical coverage",async()=>{

    await query(`
      UPDATE public.station_tickets
      SET status='cancelled'
      WHERE order_id=$1
    `,[ids.order]);

    try {

      const result=await scalar(`
        SELECT public.neo_pos_canonical_routing_evidence(
          $1,$2,$3
        )
      `,[ids.org,ids.branch,ids.order]);

      assert.equal(result.routing_verified,false);
      assert.equal(result.missing_primary_items,1);

    } finally {

      await query(`
        UPDATE public.station_tickets
        SET status='new'
        WHERE order_id=$1
      `,[ids.order]);

    }
  });

  await test("Unexpected station link prevents routing verification",async()=>{

    const ticket=await scalar(`
      INSERT INTO public.station_tickets(
        organization_id,branch_id,order_id,station_id
      )
      VALUES ($1,$2,$3,$4)
      RETURNING id
    `,[ids.org,ids.branch,ids.order,ids.secondary]);

    await query(`
      INSERT INTO public.station_ticket_items(
        organization_id,ticket_id,order_item_id
      )
      VALUES ($1,$2,$3)
    `,[ids.org,ticket,ids.item]);

    const result=await scalar(`
      SELECT public.neo_pos_canonical_routing_evidence(
        $1,$2,$3
      )
    `,[ids.org,ids.branch,ids.order]);

    assert.equal(result.routing_verified,false);
    assert.equal(result.items[0].unexpected_station_links,1);
  });

} catch(error) {
  failed++;
  console.error("HANDOFF INTEGRATION FAILURE:",error);
} finally {
  await db.close();
}

console.log("\nHANDOFF BEHAVIOURAL RESULTS");
console.log("PASSED:",passed);
console.log("FAILED:",failed);

process.exitCode = failed ? 1 : 0;