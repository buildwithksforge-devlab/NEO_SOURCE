import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";

const db = new PGlite();

let passed = 0;

async function test(name,fn) {
    await fn();
    passed++;
    console.log("PASS:",name);
}

async function allocate(original,posted,previous, reversed, restored) {

    const r = await db.query(`
        SELECT public.neo_inventory_reversal_allocation(
            $1::numeric,
            $2::numeric,
            $3::numeric,
            $4::numeric,
            $5::numeric
        ) AS result
    `,[original,posted,previous,reversed,restored]);

    return r.rows[0].result;
}

try {

    await db.exec(`
        CREATE ROLE anon;
        CREATE ROLE authenticated;
    `);

    await db.exec(readFileSync(
        "supabase/migrations/20261125172000_inventory_finance_reversal_calculation.sql",
        "utf8"
    ));

    await test("Complete stock restoration reverses full cost",async()=>{
        const r = await allocate(200,200,0,0,200);

        assert.equal(r.reversal_amount,200);
        assert.equal(r.remaining_posted_amount,0);
    });

    await test("Partial restoration reverses eligible cost only",async()=>{
        const r = await allocate(200,200,0,0,80);

        assert.equal(r.reversal_amount,80);
        assert.equal(r.remaining_posted_amount,120);
    });

    await test("Subsequent restoration accounts for earlier reversal",async()=>{
        const r = await allocate(200,200,80,80,40);

        assert.equal(r.reversal_amount,40);
        assert.equal(r.cumulative_reversed_amount,120);
        assert.equal(r.remaining_posted_amount,80);
    });

    await test("Final restoration clears remaining eligible value",async()=>{
        const r = await allocate(200,200,120,120,80);

        assert.equal(r.reversal_amount,80);
        assert.equal(r.remaining_posted_amount,0);
    });

    await test("Cumulative rounding does not over-reverse",async()=>{
        const first = await allocate(
            1.005,1.01,0,0,0.335
        );

        assert.equal(first.reversal_amount,0.34);

        const second = await allocate(
            1.005,1.01,0.335,0.34,0.335
        );

        assert.equal(second.reversal_amount,0.33);

        const third = await allocate(
            1.005,1.01,0.67,0.67,0.335
        );

        assert.equal(third.reversal_amount,0.34);
        assert.equal(third.remaining_posted_amount,0);
    });

    await test("Sub-cent restoration can produce zero journal amount",async()=>{
        const r = await allocate(1,1,0,0,0.004);

        assert.equal(r.reversal_amount,0);
    });

    await test("Sub-cent values accumulate into later reversals",async()=>{
        const r = await allocate(1,1,0.004,0,0.004);

        assert.equal(r.reversal_amount,0.01);
    });

    await test("Zero-cost stock creates no financial reversal",async()=>{
        const r = await allocate(0,0,0,0,0);

        assert.equal(r.reversal_amount,0);
    });

    await test("Excess restoration rejected",async()=>{
        await assert.rejects(
            allocate(200,200,150,150,60),
            /exceeds original consumption value/
        );
    });

    await test("Negative restoration rejected",async()=>{
        await assert.rejects(
            allocate(200,200,0,0,-20),
            /Invalid inventory reversal/
        );
    });

    await test("Unknown monetary evidence rejected",async()=>{
        await assert.rejects(
            allocate(null,200,0,0,20),
            /Invalid inventory reversal/
        );
    });

    await test("Non-finite monetary evidence rejected",async()=>{
        await assert.rejects(
            allocate(200,200,0,0,"NaN"),
            /Invalid inventory reversal/
        );
    });

    await test("Original journal mismatch rejected",async()=>{
        await assert.rejects(
            allocate(200,250,0,0,20),
            /Original journal amount disagrees/
        );
    });

    await test("Previous reversal mismatch rejected",async()=>{
        await assert.rejects(
            allocate(200,200,50,60,20),
            /Previous reversal amounts do not reconcile/
        );
    });

    await test("Historical over-reversal rejected",async()=>{
        await assert.rejects(
            allocate(200,200,220,200,0),
            /Historical reversal exceeds/
        );
    });

    await test("Ordinary client cannot invoke internal calculation",async()=>{
        const r = await db.query(`
            SELECT has_function_privilege(
                'authenticated',
                'public.neo_inventory_reversal_allocation(numeric,numeric,numeric,numeric,numeric)',
                'EXECUTE'
            ) AS permitted
        `);

        assert.equal(r.rows[0].permitted,false);
    });

    console.log(
        "\nFIN-03I.2B:",passed,
        "REVERSAL VALUATION TESTS PASSED"
    );

} catch(error) {

    console.error(error);
    process.exitCode = 1;

} finally {

    await db.close();

}