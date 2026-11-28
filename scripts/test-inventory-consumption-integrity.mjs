import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";

const db = new PGlite();

let passed = 0;

async function test(name, fn) {
  await fn();
  passed++;
  console.log("PASS:", name);
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

try {
  const exported = process.argv.slice(2).flatMap(file =>
    parseCsv(readFileSync(file,"utf8"))
  );

  const targets = [
    "inventory_consume_order_item_core",
    "neo_pos_item_void_effect"
  ];

  // Install exact original function bodies.
  // Full operational dependencies are not installed
  // during this definition-level test.

  await db.exec("SET check_function_bodies = off");

  for (const name of targets) {
    const row = exported.find(r => r.function_name === name);

    assert.ok(row?.definition, "Missing function: " + name);

    await db.exec(row.definition);

    const result = await db.query(`
      SELECT md5(pg_get_functiondef(p.oid)) AS hash
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid=p.pronamespace
      WHERE n.nspname='public'
        AND p.proname=$1
    `,[name]);

    assert.equal(result.rows[0].hash,row.definition_hash);

    console.log("Original definition verified:",name);
  }

  await db.exec("SET check_function_bodies = on");

  async function metadata() {
    const result = await db.query(`
      SELECT proname, oid, proowner,
             proacl::text AS acl,
             prosecdef, provolatile, proconfig
      FROM pg_proc
      WHERE proname IN (
        'inventory_consume_order_item_core',
        'neo_pos_item_void_effect'
      )
      ORDER BY proname
    `);

    return result.rows;
  }

  const before = await metadata();

  // Definition-level prerequisite only.
  // The real COGS engine is tested in its separate harness.

  await db.exec(`
    CREATE FUNCTION public.neo_inventory_post_consumption_finance(uuid)
    RETURNS jsonb
    LANGUAGE sql
    AS $$
      SELECT jsonb_build_object('status','fixture-only')
    $$;
  `);

  const migrations = [
    "supabase/migrations/20261125154000_inventory_consumption_actual_cost.sql",
    "supabase/migrations/20261125155000_pos_volume_void_integrity.sql",
    "supabase/migrations/20261125163000_pos_actual_volume_consumption_cost.sql",
    "supabase/migrations/20261125170000_inventory_cogs_operational_bridge.sql"
  ];

  for (const path of migrations) {
    await test("Migration executes: " + path, async () => {
      await db.exec(readFileSync(path,"utf8"));
    });
  }

  await test("Function ownership and security metadata preserved", async () => {
    assert.deepEqual(await metadata(),before);
  });

  async function definition(name) {
    const result = await db.query(`
      SELECT pg_get_functiondef(p.oid) AS definition
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid=p.pronamespace
      WHERE n.nspname='public'
        AND p.proname=$1
    `,[name]);

    return result.rows[0].definition;
  }

  const core = await definition("inventory_consume_order_item_core");
  const voidFn = await definition("neo_pos_item_void_effect");

  await test("Consumption captures actual movement UUID", async () => {
    assert.ok(core.includes(
      "v_actual_movement := public.inventory_apply_movement"
    ));
  });

  await test("Actual recorded movement value is used", async () => {
    assert.ok(core.includes("SELECT abs(m.value)"));
    assert.ok(core.includes("v_cost := v_cost + v_actual_value"));
  });

  await test("Consumption evidence includes tenant and movement identity", async () => {
    for (const term of [
      "m.organization_id = v_org",
      "m.reference_id = _order_item",
      "m.stock_item_id = v_comp.item_id",
      "m.location_id = v_line_location",
      "m.idempotency_key = v_key",
      "m.quantity < 0"
    ]) {
      assert.ok(core.includes(term),term);
    }
  });

  await test("Invalid movement values rejected by installed guard", async () => {
    assert.ok(core.includes("v_actual_value IS NULL"));
    assert.ok(core.includes("'NaN','Infinity','-Infinity'"));
  });

  await test("Measured pours detected during cancellation", async () => {
    assert.ok(voidFn.includes("ce.event_type = 'pour'"));
    assert.ok(voidFn.includes("ce.volume_delta_ml < 0"));
    assert.ok(voidFn.includes("v_prepared := true"));
  });

  await test("Opened containers excluded from sealed-stock restoration", async () => {
    assert.ok(voidFn.includes("ce.event_type = 'open'"));
    assert.ok(voidFn.includes(
      "ce.stock_movement_id = stock_movements.id"
    ));
  });

  await test("Original-sale consumption evidence separated from remakes", async () => {
    assert.ok(voidFn.includes("posting_type = 'consumption'"));
  });

  await test("POS accepts actual successful pour response", async () => {
    assert.ok(core.includes("IN ('poured','already-recorded')"));
  });

  await test("POS captures actual volume consumption result", async () => {
    assert.ok(core.includes(
      "v_volume_result := public.inventory_consume_volume"
    ));
  });

  await test("POS uses recorded measured consumption cost", async () => {
    assert.ok(core.includes(
      "(v_volume_result->>'consumed_value')::numeric"
    ));
    assert.ok(core.includes(
      "v_cost := v_cost + v_volume_cost"
    ));
  });

  await test("Unknown measured costs explicitly identified", async () => {
    assert.ok(core.includes("v_unverified_volume_lines"));
    assert.ok(core.includes("'verified_partial_cost', v_cost"));
  });

  await test("Original estimated pour costing removed", async () => {
    assert.ok(!core.includes(
      "(v_ml / v_stock.container_volume_ml)"
    ));
  });

  await test("New consumption enters financial posting lifecycle", async () => {
    assert.ok(core.includes("finance_posting_status"));
    assert.ok(core.includes("'pending'"));
  });

  await test("Financial bridge captures inserted event identity", async () => {
    assert.ok(core.includes(
      "RETURNING id INTO v_finance_event_id"
    ));
  });

  await test("Financial engine invoked for newly inserted events", async () => {
    assert.ok(core.includes(
      "IF v_finance_event_id IS NOT NULL THEN"
    ));

    assert.ok(core.includes(
      "public.neo_inventory_post_consumption_finance("
    ));
  });

  await test("Financial exception handling is installed", async () => {
    assert.ok(core.includes(
      "v_finance_error = MESSAGE_TEXT"
    ));

    assert.ok(core.includes(
      "finance_posting_status = 'failed'"
    ));
  });

  await test("Operational response exposes financial posting evidence", async () => {
    assert.ok(core.includes(
      "'finance_posting',v_finance_result"
    ));

    assert.ok(core.includes(
      "'finance_event_id',v_finance_event_id"
    ));
  });

  console.log("\nFIN-03H.5E:",passed,"DEFINITION TESTS PASSED");

} catch (error) {
  console.error("\nFIN-03E FAILED");
  console.error(error);
  process.exitCode = 1;

} finally {
  await db.close();
}