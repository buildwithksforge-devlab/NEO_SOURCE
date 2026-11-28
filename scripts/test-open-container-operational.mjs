import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";

const db = new PGlite();

const org = "10000000-0000-4000-8000-000000000001";
const branch = "20000000-0000-4000-8000-000000000001";
const item = "30000000-0000-4000-8000-000000000001";
const location = "40000000-0000-4000-8000-000000000001";
const actor = "50000000-0000-4000-8000-000000000001";

let passed = 0;

async function test(name, fn) {
    await fn();
    passed++;
    console.log("PASS:",name);
}

function parseCsv(text) {
    text = text.replace(/^\uFEFF/,"");

    const rows = [];
    let row = [], value = "", quoted = false;

    for (let i=0; i<text.length; i++) {
        const c=text[i];

        if (c === '"') {
            if (quoted && text[i+1] === '"') {
                value += '"';
                i++;
            } else {
                quoted = !quoted;
            }
        } else if (c === ";" && !quoted) {
            row.push(value);
            value="";
        } else if (c === "\n" && !quoted) {
            row.push(value.replace(/\r$/,""));
            rows.push(row);
            row=[];
            value="";
        } else {
            value+=c;
        }
    }

    if (value.length || row.length) {
        row.push(value);
        rows.push(row);
    }

    const headers=rows.shift();

    return rows.map(r =>
        Object.fromEntries(
            headers.map((h,i)=>[h,r[i]])
        )
    );
}

async function pool() {
    const r=await db.query(`
        SELECT open_volume_ml::float8 AS volume,
               open_inventory_value::float8 AS value,
               valuation_volume_ml::float8 AS valued_volume
        FROM stock_open_containers
        WHERE stock_item_id=$1 AND location_id=$2
    `,[item,location]);

    return r.rows[0];
}

async function open(key) {
    const r=await db.query(`
        SELECT inventory_open_container(
            $1,$2,'Test opening','test',NULL,$3
        ) AS result
    `,[item,location,key]);

    return r.rows[0].result;
}

async function pour(ml,key) {
    const r=await db.query(`
        SELECT inventory_consume_volume(
            $1,$2,$3,'Test pour','pour','test',NULL,$4
        ) AS result
    `,[item,location,ml,key]);

    return r.rows[0].result;
}

try {

    await db.exec(`
        CREATE SCHEMA auth;

        CREATE FUNCTION auth.uid()
        RETURNS uuid LANGUAGE sql AS
        $$ SELECT '${actor}'::uuid $$;

        CREATE FUNCTION current_org_id()
        RETURNS uuid LANGUAGE sql STABLE AS
        $$ SELECT '${org}'::uuid $$;

        CREATE FUNCTION neo_system_posting()
        RETURNS boolean LANGUAGE sql STABLE AS
        $$ SELECT false $$;

        CREATE FUNCTION has_permission(text,text)
        RETURNS boolean LANGUAGE sql STABLE AS
        $$ SELECT coalesce(
            current_setting('test.allowed',true),'on'
        )='on' $$;

        CREATE FUNCTION neo_branch_in_scope(uuid)
        RETURNS boolean LANGUAGE sql STABLE AS
        $$ SELECT $1='${branch}'::uuid $$;

        CREATE TABLE stock_items (
            id uuid PRIMARY KEY,
            organization_id uuid,
            branch_id uuid,
            name text,
            container_volume_ml numeric,
            may_open_for_pours boolean,
            base_unit text,
            average_cost numeric
        );

        CREATE TABLE stock_locations (
            id uuid PRIMARY KEY,
            organization_id uuid,
            branch_id uuid,
            name text
        );

        CREATE TABLE stock_movements (
            id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
            organization_id uuid,
            stock_item_id uuid,
            location_id uuid,
            movement_type text,
            quantity numeric,
            value numeric,
            idempotency_key text,
            reference_type text,
            reference_id uuid
        );

        CREATE TABLE stock_open_containers (
            id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
            organization_id uuid,
            branch_id uuid,
            stock_item_id uuid,
            location_id uuid,
            open_volume_ml numeric DEFAULT 0,
            containers_open integer DEFAULT 0,
            last_opened_at timestamptz,
            updated_at timestamptz,
            UNIQUE(stock_item_id,location_id)
        );

        CREATE TABLE stock_container_events (
            id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
            organization_id uuid,
            branch_id uuid,
            stock_item_id uuid,
            location_id uuid,
            event_type text,
            containers_delta integer,
            volume_delta_ml numeric,
            open_volume_after_ml numeric,
            reason_code text,
            reason text,
            reference_type text,
            reference_id uuid,
            stock_movement_id uuid,
            idempotency_key text,
            performed_by uuid,
            UNIQUE(organization_id,idempotency_key)
        );

        CREATE FUNCTION inventory_apply_movement(
            uuid,uuid,numeric,text,text,numeric,
            text,uuid,text,text,uuid,uuid
        )
        RETURNS uuid
        LANGUAGE plpgsql
        AS $$
        DECLARE v_id uuid;
        BEGIN
            INSERT INTO stock_movements (
                organization_id,
                stock_item_id,
                location_id,
                movement_type,
                quantity,
                value,
                idempotency_key,
                reference_type,
                reference_id
            )
            VALUES (
                current_org_id(),
                $1,$2,$5,$3,$3*$6,$10,$7,$8
            )
            RETURNING id INTO v_id;

            RETURN v_id;
        END;
        $$;

        INSERT INTO stock_items VALUES (
            '${item}','${org}','${branch}',
            'Test beverage',750,true,'unit',3000
        );

        INSERT INTO stock_locations VALUES (
            '${location}','${org}','${branch}','Test Bar'
        );
    `);

    const exported=process.argv.slice(2).flatMap(file =>
        parseCsv(readFileSync(file,"utf8"))
    );

    for (const name of [
        "inventory_open_container",
        "inventory_consume_volume"
    ]) {
        const row=exported.find(r=>r.function_name===name);

        assert.ok(row?.definition,"Missing function: "+name);

        await db.exec(row.definition);

        console.log("Installed original:",name);
    }

    for (const migration of [
        "20261125160000_open_container_valuation_foundation.sql",
        "20261125161000_open_container_value_calculation.sql",
        "20261125162000_open_container_operational_valuation.sql"
    ]) {
        await test("Migration executes: "+migration,async()=>{
            await db.exec(readFileSync(
                "supabase/migrations/"+migration,"utf8"
            ));
        });
    }

    await test("Bottle opening preserves inventory value",async()=>{
        const r=await open("open-1");

        assert.equal(r.opened_value,3000);
        assert.equal((await pool()).volume,750);
        assert.equal((await pool()).value,3000);
    });

    await test("Opening retry does not duplicate inventory",async()=>{
        const r=await open("open-1");

        assert.equal(r.status,"already-recorded");
        assert.equal((await pool()).volume,750);
        assert.equal((await pool()).value,3000);

        const count=await db.query(
            "SELECT count(*)::int AS n FROM stock_movements"
        );

        assert.equal(count.rows[0].n,1);
    });

    await test("30 ml pour consumes actual value",async()=>{
        const r=await pour(30,"pour-1");

        assert.equal(r.consumed_value,120);
        assert.equal((await pool()).volume,720);
        assert.equal((await pool()).value,2880);
    });

    await test("Pour retry does not deduct twice",async()=>{
        const r=await pour(30,"pour-1");

        assert.equal(r.status,"already-recorded");
        assert.equal(r.consumed_value,120);
        assert.equal((await pool()).volume,720);
    });

    await test("Conflicting retry quantity rejected",async()=>{
        await assert.rejects(
            pour(60,"pour-1"),
            /identity conflict/
        );

        assert.equal((await pool()).volume,720);
    });

    await test("Purchase price change does not revalue open stock",async()=>{
        await db.query(
            "UPDATE stock_items SET average_cost=4500 WHERE id=$1",
            [item]
        );

        const r=await pour(30,"pour-2");

        assert.equal(r.consumed_value,120);
        assert.equal((await pool()).value,2760);
    });

    await test("New bottle contributes its own acquisition value",async()=>{
        await open("open-2");

        assert.equal((await pool()).volume,1440);
        assert.equal((await pool()).value,7260);
    });

    await test("Complete depletion consumes exact remaining value",async()=>{
        const r=await pour(1440,"pour-all");

        assert.equal(r.consumed_value,7260);
        assert.equal((await pool()).volume,0);
        assert.equal((await pool()).value,0);
    });

    await test("Automatic opening supplies required liquid",async()=>{
        const r=await pour(30,"auto-pour");

        assert.equal(r.consumed_value,180);
        assert.equal((await pool()).volume,720);
        assert.equal((await pool()).value,4320);
    });

    await test("Historical unknown inventory remains unverified",async()=>{
        await db.exec(`
            UPDATE stock_open_containers
            SET open_inventory_value=NULL,
                valuation_volume_ml=NULL
        `);

        const r=await pour(30,"unknown-pour");

        assert.equal(r.consumed_value,null);
        assert.equal(r.valuation_status,"unverified");
        assert.equal((await pool()).volume,690);
        assert.equal((await pool()).value,null);
    });

    await test("Unauthorised pour rejected without deduction",async()=>{
        await db.exec(
            "SELECT set_config('test.allowed','off',false)"
        );

        await assert.rejects(
            pour(30,"denied-pour"),
            /Not permitted/
        );

        assert.equal((await pool()).volume,690);

        await db.exec(
            "SELECT set_config('test.allowed','on',false)"
        );
    });

    await test("Non-finite pour rejected",async()=>{
        await assert.rejects(
            pour("NaN","invalid-pour"),
            /Pour volume/
        );

        assert.equal((await pool()).volume,690);
    });

    console.log(
        "\nFIN-03H.3:",passed,
        "OPERATIONAL TESTS PASSED"
    );

} catch(error) {
    console.error("\nFIN-03H.3 FAILED");
    console.error(error);
    process.exitCode=1;
} finally {
    await db.close();
}