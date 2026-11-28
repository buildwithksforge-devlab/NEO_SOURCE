import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";

const db = new PGlite();

const org = crypto.randomUUID();
const branch = crypto.randomUUID();
const otherOrg = crypto.randomUUID();
const otherBranch = crypto.randomUUID();
const item = crypto.randomUUID();
const location = crypto.randomUUID();
const orderItem = crypto.randomUUID();

let passed = 0;

async function test(name,fn) {
    await fn();
    passed++;
    console.log("PASS:",name);
}

async function fixture(options = {}) {

    const event = crypto.randomUUID();
    const original = crypto.randomUUID();
    const restoration = crypto.randomUUID();

    await db.query(`
        INSERT INTO inventory_posting_events (
            id,organization_id,branch_id,
            order_item_id,posting_type,
            finance_posting_status
        )
        VALUES ($1,$2,$3,$4,$5,'posted')
    `,[
        event,
        options.eventOrg ?? org,
        options.eventBranch ?? branch,
        orderItem,
        options.postingType ?? "consumption"
    ]);

    await db.query(`
        INSERT INTO stock_movements (
            id,organization_id,stock_item_id,
            location_id,movement_type,
            reference_type,reference_id,
            unit,quantity,value,idempotency_key
        )
        VALUES (
            $1,$2,$3,$4,'consumption',
            'pos_order_item',$5,
            'kg',$6,$7,$8
        )
    `,[
        original,
        options.originalOrg ?? org,
        item,
        location,
        orderItem,
        options.originalQuantity ?? -2,
        options.originalValue ?? -200,
        "consume:"+original
    ]);

    await db.query(`
        INSERT INTO stock_movements (
            id,organization_id,stock_item_id,
            location_id,movement_type,
            reference_type,reference_id,
            unit,quantity,value,idempotency_key
        )
        VALUES (
            $1,$2,$3,$4,$5,
            'pos_order_item',$6,
            $7,$8,$9,$10
        )
    `,[
        restoration,
        options.restorationOrg ?? org,
        options.restorationItem ?? item,
        options.restorationLocation ?? location,
        options.restorationType ?? "reversal",
        options.referenceId ?? orderItem,
        options.unit ?? "kg",
        options.quantity ?? 2,
        options.value ?? 200,
        options.key ??
            "reverse:"+orderItem+":"+original
    ]);

    return {event,original,restoration};
}

async function validate(f) {

    const r = await db.query(`
        SELECT public.neo_inventory_validate_restoration(
            $1,$2,$3
        ) AS result
    `,[f.event,f.original,f.restoration]);

    return r.rows[0].result;
}

try {

    await db.exec(`
        CREATE ROLE anon;
        CREATE ROLE authenticated;

        CREATE FUNCTION current_org_id()
        RETURNS uuid
        LANGUAGE sql STABLE
        AS $$ SELECT '${org}'::uuid $$;

        CREATE FUNCTION neo_branch_in_scope(uuid)
        RETURNS boolean
        LANGUAGE sql STABLE
        AS $$ SELECT $1='${branch}'::uuid $$;

        CREATE TABLE journal_entries (
            id uuid PRIMARY KEY
        );

        CREATE TABLE inventory_posting_events (
            id uuid PRIMARY KEY,
            organization_id uuid,
            branch_id uuid,
            order_item_id uuid,
            posting_type text,
            finance_posting_status text,
            finance_journal_id uuid
        );

        CREATE TABLE stock_locations (
            id uuid PRIMARY KEY,
            organization_id uuid,
            branch_id uuid
        );

        CREATE TABLE stock_movements (
            id uuid PRIMARY KEY,
            organization_id uuid,
            stock_item_id uuid,
            location_id uuid,
            movement_type text,
            reference_type text,
            reference_id uuid,
            unit text,
            quantity numeric,
            value numeric,
            idempotency_key text
        );

        CREATE TABLE stock_container_events (
            id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
            organization_id uuid,
            stock_movement_id uuid,
            event_type text
        );

        INSERT INTO stock_locations
        VALUES ('${location}','${org}','${branch}');
    `);

    for (const migration of [
        "20261125171000_inventory_finance_reversal_evidence.sql",
        "20261125172000_inventory_finance_reversal_calculation.sql",
        "20261125173000_inventory_reversal_movement_validation.sql"
    ]) {

        await test("Migration executes: "+migration,async()=>{
            await db.exec(readFileSync(
                "supabase/migrations/"+migration,
                "utf8"
            ));
        });

    }

    await test("Complete physical restoration validated",async()=>{
        const f=await fixture();
        const r=await validate(f);

        assert.equal(r.status,"validated");
        assert.equal(r.restored_quantity,2);
        assert.equal(r.restored_value,200);
        assert.equal(r.original_consumed_value,200);
    });

    await test("Proportional partial restoration validated",async()=>{
        const f=await fixture({
            quantity:0.5,
            value:50
        });

        const r=await validate(f);

        assert.equal(r.restored_quantity,0.5);
        assert.equal(r.restored_value,50);
    });

    await test("Cross-organisation event rejected",async()=>{
        const f=await fixture({eventOrg:otherOrg});

        await assert.rejects(
            validate(f),
            /Original consumption event unavailable/
        );
    });

    await test("Cross-property event rejected",async()=>{
        const f=await fixture({
            eventBranch:otherBranch
        });

        await assert.rejects(
            validate(f),
            /outside authorised property/
        );
    });

    await test("Non-consumption event rejected",async()=>{
        const f=await fixture({
            postingType:"transfer"
        });

        await assert.rejects(
            validate(f),
            /Original event is not consumption/
        );
    });

    await test("Cross-organisation original movement rejected",async()=>{
        const f=await fixture({
            originalOrg:otherOrg
        });

        await assert.rejects(
            validate(f),
            /Original stock movement unavailable/
        );
    });

    await test("Cross-organisation restoration rejected",async()=>{
        const f=await fixture({
            restorationOrg:otherOrg
        });

        await assert.rejects(
            validate(f),
            /Restoration stock movement unavailable/
        );
    });

    await test("Incorrect stock item rejected",async()=>{
        const f=await fixture({
            restorationItem:crypto.randomUUID()
        });

        await assert.rejects(
            validate(f),
            /Restoration movement identity mismatch/
        );
    });

    await test("Incorrect stock location rejected",async()=>{
        const f=await fixture({
            restorationLocation:crypto.randomUUID()
        });

        await assert.rejects(
            validate(f),
            /Restoration movement identity mismatch/
        );
    });

    await test("Incorrect unit rejected",async()=>{
        const f=await fixture({unit:"litre"});

        await assert.rejects(
            validate(f),
            /Restoration movement identity mismatch/
        );
    });

    await test("Incorrect order reference rejected",async()=>{
        const f=await fixture({
            referenceId:crypto.randomUUID()
        });

        await assert.rejects(
            validate(f),
            /Restoration movement identity mismatch/
        );
    });

    await test("Non-reversal movement rejected",async()=>{
        const f=await fixture({
            restorationType:"receipt"
        });

        await assert.rejects(
            validate(f),
            /Restoration movement identity mismatch/
        );
    });

    await test("Incorrect reversal identity rejected",async()=>{
        const f=await fixture({
            key:"invalid-reversal-key"
        });

        await assert.rejects(
            validate(f),
            /Restoration idempotency identity mismatch/
        );
    });

    await test("Opened bottle cannot become sealed stock",async()=>{
        const f=await fixture();

        await db.query(`
            INSERT INTO stock_container_events (
                organization_id,
                stock_movement_id,event_type
            )
            VALUES ($1,$2,'open')
        `,[org,f.original]);

        await assert.rejects(
            validate(f),
            /Opened container cannot be restored/
        );
    });

    await test("Excess restored quantity rejected",async()=>{
        const f=await fixture({
            quantity:3,
            value:300
        });

        await assert.rejects(
            validate(f),
            /exceeds consumed quantity/
        );
    });

    await test("Excess restored value rejected",async()=>{
        const f=await fixture({value:250});

        await assert.rejects(
            validate(f),
            /exceeds consumed value/
        );
    });

    await test("Changed purchase cost cannot alter restoration value",async()=>{
        const f=await fixture({
            quantity:1,
            value:120
        });

        await assert.rejects(
            validate(f),
            /differs from original consumption cost/
        );
    });

    await test("Negative restoration rejected",async()=>{
        const f=await fixture({
            quantity:-1,
            value:-100
        });

        await assert.rejects(
            validate(f),
            /Invalid physical restoration evidence/
        );
    });

    await test("Non-finite monetary evidence rejected",async()=>{
        const f=await fixture({value:"NaN"});

        await assert.rejects(
            validate(f),
            /Invalid physical restoration evidence/
        );
    });

    await test("Same original and restoration movement rejected",async()=>{
        const f=await fixture();

        f.restoration=f.original;

        await assert.rejects(
            validate(f),
            /Invalid restoration movement identity/
        );
    });

    await test("Previous failed financial reversal counts toward physical limits",async()=>{
        const f=await fixture({
            quantity:1.5,
            value:150
        });

        const previous=crypto.randomUUID();

        await db.query(`
            INSERT INTO stock_movements (
                id,organization_id,stock_item_id,
                location_id,movement_type,
                reference_type,reference_id,
                unit,quantity,value
            )
            VALUES (
                $1,$2,$3,$4,'reversal',
                'pos_order_item',$5,'kg',1,100
            )
        `,[previous,org,item,location,orderItem]);

        await db.query(`
            INSERT INTO neo_inventory_finance_reversals (
                organization_id,branch_id,
                consumption_event_id,
                original_stock_movement_id,
                restoration_stock_movement_id,
                restored_quantity,
                restored_value,
                accounting_date,status
            )
            VALUES (
                $1,$2,$3,$4,$5,
                1,100,current_date,'failed'
            )
        `,[org,branch,f.event,f.original,previous]);

        await assert.rejects(
            validate(f),
            /exceeds consumed quantity/
        );
    });

    await test("Ordinary client cannot execute restoration validator",async()=>{
        const r=await db.query(`
            SELECT has_function_privilege(
                'authenticated',
                'public.neo_inventory_validate_restoration(uuid,uuid,uuid)',
                'EXECUTE'
            ) AS permitted
        `);

        assert.equal(r.rows[0].permitted,false);
    });

    console.log(
        "\nFIN-03I.3B:",
        passed,
        "RESTORATION VALIDATION TESTS PASSED"
    );

} catch(error) {

    console.error("\nFIN-03I.3B FAILED");
    console.error(error);
    process.exitCode=1;

} finally {

    await db.close();

}