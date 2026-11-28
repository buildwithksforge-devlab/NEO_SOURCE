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

async function allocate(volume, value, consumed) {
  const result = await db.query(`
    SELECT public.neo_open_container_value_allocation(
      $1::numeric,
      $2::numeric,
      $3::numeric
    ) AS result
  `, [volume, value, consumed]);

  return result.rows[0].result;
}

try {
  await db.exec(readFileSync(
    "supabase/migrations/20261125161000_open_container_value_calculation.sql",
    "utf8"
  ));

  await test("30 ml tot from 750 ml bottle", async () => {
    const r = await allocate(750,3000,30);

    assert.equal(r.consumed_value,120);
    assert.equal(r.remaining_value,2880);
    assert.equal(r.remaining_ml,720);
  });

  await test("Second pour retains original historical value", async () => {
    const r = await allocate(720,2880,30);

    assert.equal(r.consumed_value,120);
    assert.equal(r.remaining_value,2760);
  });

  await test("Mixed open-container pool uses pooled cost", async () => {
    const r = await allocate(1500,7500,30);

    assert.equal(r.consumed_value,150);
    assert.equal(r.remaining_value,7350);
  });

  await test("Complete depletion clears remaining value", async () => {
    const r = await allocate(30,120,30);

    assert.equal(r.consumed_value,120);
    assert.equal(r.remaining_value,0);
    assert.equal(r.remaining_ml,0);
  });

  await test("Repeated fractional pours preserve total value", async () => {
    let volume = 750;
    let value = 1000;
    let consumed = 0;

    while (volume > 0) {
      const r = await allocate(
        volume,
        value,
        Math.min(30,volume)
      );

      consumed += r.consumed_value;
      volume = r.remaining_ml;
      value = r.remaining_value;
    }

    assert.ok(Math.abs(consumed - 1000) < 0.000001);
    assert.equal(value,0);
  });

  await test("Unknown historical value is not treated as zero", async () => {
    const r = await allocate(750,null,30);

    assert.equal(r.valuation_status,"unverified");
    assert.equal(r.consumed_value,null);
    assert.equal(r.remaining_value,null);
  });

  await test("Unknown pool depletion preserves unknown consumption cost", async () => {
    const r = await allocate(30,null,30);

    assert.equal(r.consumed_value,null);
    assert.equal(r.remaining_value,0);
    assert.equal(r.remaining_ml,0);
  });

  await test("Verified zero-cost stock remains distinguishable", async () => {
    const r = await allocate(750,0,30);

    assert.equal(r.valuation_status,"verified");
    assert.equal(r.consumed_value,0);
  });

  await test("Excess volume rejected", async () => {
    await assert.rejects(
      allocate(30,120,60),
      /Invalid open-container volume/
    );
  });

  await test("Negative consumption rejected", async () => {
    await assert.rejects(
      allocate(750,3000,-30),
      /Invalid open-container volume/
    );
  });

  await test("Negative inventory value rejected", async () => {
    await assert.rejects(
      allocate(750,-3000,30),
      /Invalid open-container monetary/
    );
  });

  await test("Non-finite volume rejected", async () => {
    await assert.rejects(
      allocate("NaN",3000,30),
      /Invalid open-container volume/
    );
  });

  await test("Non-finite monetary value rejected", async () => {
    await assert.rejects(
      allocate(750,"Infinity",30),
      /Invalid open-container monetary/
    );
  });

  console.log("\nFIN-03H.2:",passed,"VALUATION TESTS PASSED");

} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  await db.close();
}