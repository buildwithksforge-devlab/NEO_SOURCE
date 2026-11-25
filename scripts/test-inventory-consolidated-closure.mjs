import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";

const db = new PGlite();

let passed = 0;
const failures = [];

async function test(name,fn) {
    try {
        await fn();
        passed++;
        console.log("PASS:",name);
    } catch(error) {
        failures.push({name,error:error.message});
        console.error("FAIL:",name);
        console.error(error.message);
    }
}

function parseCsv(text) {

    text=text.replace(/^\uFEFF/,"");

    const rows=[];
    let row=[],value="",quoted=false;

    for(let i=0;i<text.length;i++) {

        const c=text[i];

        if(c==='"') {

            if(quoted && text[i+1]==='"') {
                value+='"';
                i++;
            } else {
                quoted=!quoted;
            }

        } else if(c===";"&&!quoted) {

            row.push(value);
            value="";

        } else if(c==="\n"&&!quoted) {

            row.push(value.replace(/\r$/,""));
            rows.push(row);
            row=[];
            value="";

        } else {

            value+=c;

        }
    }

    if(value.length||row.length) {
        row.push(value);
        rows.push(row);
    }

    const headers=rows.shift();

    return rows.map(r=>
        Object.fromEntries(
            headers.map((h,i)=>[h,r[i]])
        )
    );
}

const org="10000000-0000-4000-8000-000000000001";
const branch="20000000-0000-4000-8000-000000000001";
const event="30000000-0000-4000-8000-000000000001";
const actor="40000000-0000-4000-8000-000000000001";

try {

    await db.exec(`
        CREATE ROLE anon;
        CREATE ROLE authenticated;

        CREATE SCHEMA auth;

        CREATE FUNCTION auth.uid()
        RETURNS uuid LANGUAGE sql STABLE
        AS $$ SELECT '${actor}'::uuid $$;

        CREATE FUNCTION public.current_org_id()
        RETURNS uuid LANGUAGE sql STABLE
        AS $$ SELECT '${org}'::uuid $$;

        CREATE FUNCTION public.neo_branch_in_scope(uuid)
        RETURNS boolean LANGUAGE sql STABLE
        AS $$ SELECT $1='${branch}'::uuid $$;

        CREATE FUNCTION public.is_org_admin()
        RETURNS boolean LANGUAGE sql STABLE
        AS $$ SELECT false $$;

        CREATE FUNCTION public.has_permission(text,text)
        RETURNS boolean LANGUAGE sql STABLE
        AS $$
            SELECT coalesce(
                current_setting('test.finance',true),
                'off'
            )='on'
        $$;

        CREATE TABLE public.journal_entries (
            id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
            organization_id uuid,
            branch_id uuid,
            status text,
            source_document_type text,
            source_document_id uuid,
            source_module text,
            reversed_by_journal_id uuid,
            reverses_journal_id uuid,
            total_debit numeric,
            total_credit numeric,
            currency text,
            accounting_date date
        );

        CREATE TABLE public.inventory_posting_events (
            id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
            organization_id uuid,
            branch_id uuid,
            order_item_id uuid,
            created_at timestamptz DEFAULT now(),
            cost_snapshot numeric,
            payload jsonb,
            finance_posting_status text,
            finance_journal_id uuid,
            finance_posted_at timestamptz,
            finance_posting_error text,
            finance_attempt_count integer DEFAULT 0
        );

        CREATE TABLE public.stock_movements (
            id uuid PRIMARY KEY DEFAULT gen_random_uuid()
        );

        CREATE TABLE public.neo_inventory_finance_reversals (
            id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
            organization_id uuid,
            branch_id uuid,
            consumption_event_id uuid,
            original_stock_movement_id uuid,
            restoration_stock_movement_id uuid,
            accounting_date date,
            restored_quantity numeric,
            restored_value numeric,
            status text,
            posting_error text,
            attempt_count integer DEFAULT 0,
            created_at timestamptz DEFAULT now()
        );

        CREATE FUNCTION
        public.neo_inventory_post_consumption_finance(uuid)
        RETURNS jsonb LANGUAGE sql
        AS $$
            SELECT jsonb_build_object(
                'status','fixture-retry',
                'event_id',$1
            )
        $$;

        CREATE FUNCTION
        public.neo_inventory_post_restoration_finance(uuid,uuid,uuid)
        RETURNS jsonb LANGUAGE sql
        AS $$
            SELECT jsonb_build_object(
                'status','fixture-retry',
                'event_id',$1
            )
        $$;

        GRANT SELECT,INSERT,UPDATE,DELETE
        ON public.inventory_posting_events
        TO authenticated;

        INSERT INTO public.inventory_posting_events (
            id,organization_id,branch_id,
            finance_posting_status,payload,cost_snapshot
        )
        VALUES (
            '${event}','${org}','${branch}',
            'failed','{"valuation_status":"verified"}',200
        );
    `);

    await test("Consolidated financial safeguards execute",async()=>{

        await db.exec(readFileSync(
            "supabase/migrations/20261125180000_inventory_finance_integrity_and_reconciliation.sql",
            "utf8"
        ));

    });

    await test("Ordinary client cannot modify financial evidence",async()=>{

        await db.exec("SET ROLE authenticated");

        try {

            await assert.rejects(
                db.query(`
                    UPDATE inventory_posting_events
                    SET finance_posting_status='posted'
                    WHERE id=$1
                `,[event]),
                /System-managed inventory financial evidence/
            );

        } finally {

            await db.exec("RESET ROLE");

        }

    });

    await test("Ordinary client cannot alter recognised cost",async()=>{

        await db.exec("SET ROLE authenticated");

        try {

            await assert.rejects(
                db.query(`
                    UPDATE inventory_posting_events
                    SET cost_snapshot=1
                    WHERE id=$1
                `,[event]),
                /immutable to clients/
            );

        } finally {

            await db.exec("RESET ROLE");

        }

    });

    await test("Ordinary client cannot delete accounting evidence",async()=>{

        await db.exec("SET ROLE authenticated");

        try {

            await assert.rejects(
                db.query(`
                    DELETE FROM inventory_posting_events
                    WHERE id=$1
                `,[event]),
                /cannot be deleted/
            );

        } finally {

            await db.exec("RESET ROLE");

        }

    });

    await test("Unauthorised financial retry rejected",async()=>{

        await assert.rejects(
            db.query(`
                SELECT neo_retry_inventory_consumption_finance($1)
            `,[event]),
            /Financial approval permission required/
        );

    });

    await test("Authorised financial retry reaches internal engine",async()=>{

        await db.exec(
            "SELECT set_config('test.finance','on',false)"
        );

        const r=await db.query(`
            SELECT neo_retry_inventory_consumption_finance($1)
            AS result
        `,[event]);

        assert.equal(
            r.rows[0].result.status,
            "fixture-retry"
        );

    });

    await test("Financial exceptions register returns scoped evidence",async()=>{

        const r=await db.query(`
            SELECT neo_inventory_finance_exceptions(100)
            AS result
        `);

        assert.ok(
            r.rows[0].result.consumption.some(
                x=>x.id===event
            )
        );

    });

    await test("Independent inventory journal reversal rejected",async()=>{

        const r=await db.query(`
            INSERT INTO journal_entries (
                organization_id,branch_id,status,
                source_document_type,total_debit,total_credit
            )
            VALUES (
                $1,$2,'posted',
                'inventory_posting_event:consumption_cogs',
                200,200
            )
            RETURNING id
        `,[org,branch]);

        await assert.rejects(
            db.query(`
                UPDATE journal_entries
                SET status='reversed'
                WHERE id=$1
            `,[r.rows[0].id]),
            /Use inventory reconciliation/
        );

    });

    await test("Ordinary non-inventory journal is unaffected",async()=>{

        const r=await db.query(`
            INSERT INTO journal_entries (
                organization_id,branch_id,status,
                source_document_type
            )
            VALUES ($1,$2,'posted','manual')
            RETURNING id
        `,[org,branch]);

        await db.query(`
            UPDATE journal_entries
            SET status='reversed'
            WHERE id=$1
        `,[r.rows[0].id]);

    });

    const exported=process.argv.slice(2).flatMap(file=>
        parseCsv(readFileSync(file,"utf8"))
    );

    await test("Original cancellation definition installs",async()=>{

        const original=exported.find(
            r=>r.function_name==="neo_pos_item_void_effect"
        );

        assert.ok(original?.definition);

        await db.exec(
            "SET check_function_bodies=off"
        );

        await db.exec(original.definition);

        await db.exec(
            "SET check_function_bodies=on"
        );

    });

    await test("Original measured-volume cancellation migration executes",async()=>{

        await db.exec(readFileSync(
            "supabase/migrations/20261125155000_pos_volume_void_integrity.sql",
            "utf8"
        ));

    });

    await test("Consolidated operational reversal migration executes",async()=>{

        await db.exec(readFileSync(
            "supabase/migrations/20261125181000_inventory_operational_reversal_integration.sql",
            "utf8"
        ));

    });

    await test("Operational reversal contains financial integration",async()=>{

        const r=await db.query(`
            SELECT pg_get_functiondef(
                'public.neo_pos_item_void_effect()'
                ::regprocedure
            ) AS definition
        `);

        const d=r.rows[0].definition;

        assert.ok(d.includes("v_restoration_id"));
        assert.ok(d.includes("v_prior_system_posting"));
        assert.ok(d.includes(
            "neo_inventory_post_restoration_finance"
        ));
        assert.ok(d.includes(
            "neo_inventory_restoration_exceptions"
        ));
        assert.ok(d.includes("OLD.served_at"));
        assert.ok(d.includes("historical.idempotency_key"));

    });

} catch(error) {

    failures.push({
        name:"Fixture or integration setup",
        error:error.message
    });

} finally {

    console.log("\n=== CONSOLIDATED RESULTS ===");
    console.log("PASSED:",passed);
    console.log("FAILED:",failures.length);

    for(const failure of failures) {
        console.error(
            failure.name+": "+failure.error
        );
    }

    await db.close();

    if(failures.length) {
        process.exitCode=1;
    }

}