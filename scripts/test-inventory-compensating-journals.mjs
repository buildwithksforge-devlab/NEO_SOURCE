import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";

const db = new PGlite();

const org = crypto.randomUUID();
const branch = crypto.randomUUID();
const otherBranch = crypto.randomUUID();
const item = crypto.randomUUID();
const location = crypto.randomUUID();
const inventoryAccount = crypto.randomUUID();
const cogsAccount = crypto.randomUUID();
const incorrectAccount = crypto.randomUUID();

let passed = 0;

async function test(name,fn) {
    await fn();
    passed++;
    console.log("PASS:",name);
}

async function setting(name,value) {
    await db.query(
        "SELECT set_config($1,$2,false)",
        [name,value]
    );
}

async function fixture(cost=200,financeStatus="posted") {

    const event = crypto.randomUUID();
    const orderItem = crypto.randomUUID();
    const journal = financeStatus==="posted"
        ? crypto.randomUUID()
        : null;

    if(journal) {

        await db.query(`
            INSERT INTO journal_entries (
                id,organization_id,branch_id,
                source_module,source_document_id,
                source_document_type,status,
                total_debit,total_credit,
                currency,accounting_date
            )
            VALUES (
                $1,$2,$3,'inventory',$4,
                'inventory_posting_event:consumption_cogs',
                'posted',round($5::numeric,2),
                round($5::numeric,2),'KES','2026-11-25'
            )
        `,[journal,org,branch,event,cost]);

        await db.query(`
            INSERT INTO journal_entry_lines (
                journal_id,organization_id,
                branch_id,account_id,debit,credit
            )
            VALUES
                ($1,$2,$3,$4,round($6::numeric,2),0),
                ($1,$2,$3,$5,0,round($6::numeric,2))
        `,[
            journal,org,branch,
            cogsAccount,inventoryAccount,cost
        ]);

    }

    await db.query(`
        INSERT INTO inventory_posting_events (
            id,organization_id,branch_id,
            order_item_id,posting_type,status,
            finance_posting_status,finance_journal_id,
            cost_snapshot,payload
        )
        VALUES (
            $1,$2,$3,$4,'consumption','posted',
            $5,$6,$7,
            '{"valuation_status":"verified"}'::jsonb
        )
    `,[
        event,org,branch,orderItem,
        financeStatus,journal,cost
    ]);

    return {event,orderItem,journal,cost};
}

async function restoration(f,quantity,value) {

    const original = crypto.randomUUID();
    const restored = crypto.randomUUID();

    await db.query(`
        INSERT INTO stock_movements (
            id,organization_id,stock_item_id,
            location_id,movement_type,
            reference_type,reference_id,
            unit,quantity,value,idempotency_key
        )
        VALUES
        (
            $1,$3,$4,$5,'consumption',
            'pos_order_item',$6,'kg',
            -$7::numeric,-$8::numeric,$9
        ),
        (
            $2,$3,$4,$5,'reversal',
            'pos_order_item',$6,'kg',
            $7::numeric,$8::numeric,$10
        )
    `,[
        original,restored,org,item,location,
        f.orderItem,quantity,value,
        "consume:"+original,
        "reverse:"+f.orderItem+":"+original
    ]);

    return {...f,original,restored};
}

async function post(f) {

    const r=await db.query(`
        SELECT public.neo_inventory_post_restoration_finance(
            $1,$2,$3
        ) AS result
    `,[f.event,f.original,f.restored]);

    return r.rows[0].result;
}

async function evidence(f) {

    const r=await db.query(`
        SELECT *
        FROM neo_inventory_finance_reversals
        WHERE restoration_stock_movement_id=$1
    `,[f.restored]);

    return r.rows[0];
}

async function countReversalJournals(f) {

    const r=await db.query(`
        SELECT count(*)::int AS n
        FROM journal_entries j
        JOIN neo_inventory_finance_reversals r
          ON j.source_document_id=r.id
        WHERE r.consumption_event_id=$1
          AND j.source_document_type=
              'inventory_finance_reversal:restoration_cogs'
    `,[f.event]);

    return r.rows[0].n;
}

async function validateOriginal(f) {

    const r=await db.query(`
        SELECT public.neo_inventory_validate_cogs_journal(
            $1
        ) AS result
    `,[f.event]);

    return r.rows[0].result;
}

try {

    await db.exec(`
        CREATE ROLE anon;
        CREATE ROLE authenticated;
        CREATE FUNCTION public.neo_fact_timezone(uuid,uuid)
        RETURNS text
        LANGUAGE sql STABLE
        AS $$ SELECT 'Africa/Nairobi'::text $$;

        CREATE FUNCTION public.neo_fact_currency(uuid,uuid)
        RETURNS text
        LANGUAGE sql STABLE
        AS $$ SELECT 'KES'::text $$;


        CREATE FUNCTION current_org_id()
        RETURNS uuid LANGUAGE sql STABLE
        AS $$ SELECT '${org}'::uuid $$;

        CREATE FUNCTION neo_branch_in_scope(uuid)
        RETURNS boolean LANGUAGE sql STABLE
        AS $$ SELECT $1='${branch}'::uuid $$;

        CREATE TABLE chart_of_accounts (
            id uuid PRIMARY KEY,
            organization_id uuid,
            code text
        );

        INSERT INTO chart_of_accounts VALUES
            ('${inventoryAccount}','${org}','1070'),
            ('${cogsAccount}','${org}','5090'),
            ('${incorrectAccount}','${org}','9999');

        CREATE FUNCTION neo_gl_acct(uuid,text)
        RETURNS uuid
        LANGUAGE sql STABLE
        AS $$
            SELECT id
            FROM chart_of_accounts
            WHERE organization_id=$1
              AND code=$2
            LIMIT 1
        $$;

        CREATE TABLE journal_entries (
            id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
            organization_id uuid,
            branch_id uuid,
            source_module text,
            source_document_id uuid,
            source_document_type text,
            status text,
            total_debit numeric,
            total_credit numeric,
            currency text,
            accounting_date date,
            reversed_by_journal_id uuid,
            reverses_journal_id uuid,
            UNIQUE (
                organization_id,
                source_document_id,
                source_document_type
            )
        );

        CREATE TABLE journal_entry_lines (
            id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
            journal_id uuid,
            organization_id uuid,
            branch_id uuid,
            account_id uuid,
            debit numeric,
            credit numeric
        );

        CREATE TABLE inventory_posting_events (
            id uuid PRIMARY KEY,
            organization_id uuid,
            branch_id uuid,
            order_item_id uuid,
            posting_type text,
            status text,
            finance_posting_status text,
            finance_journal_id uuid,
            cost_snapshot numeric,
            payload jsonb
        );

        CREATE TABLE stock_locations (
            id uuid PRIMARY KEY,
            organization_id uuid,
            branch_id uuid
        );

        INSERT INTO stock_locations VALUES (
            '${location}','${org}','${branch}'
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
            idempotency_key text,
            created_at timestamptz DEFAULT now()
        );

        CREATE TABLE stock_container_events (
            id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
            organization_id uuid,
            stock_movement_id uuid,
            event_type text
        );

        CREATE FUNCTION neo_gl_post(
            uuid,uuid,text,text,uuid,text,date,
            text,text,jsonb,uuid,uuid
        )
        RETURNS jsonb
        LANGUAGE plpgsql
        AS $$
        DECLARE
            j uuid;
            x jsonb;
            a uuid;
            td numeric;
            tc numeric;
        BEGIN

            SELECT id INTO j
            FROM journal_entries
            WHERE organization_id=$1
              AND source_document_id=$5
              AND source_document_type=$4||':'||$6;

            IF j IS NOT NULL THEN
                RETURN jsonb_build_object(
                    'journal_id',j
                );
            END IF;

            SELECT
                sum((v->>'debit')::numeric),
                sum((v->>'credit')::numeric)
            INTO td,tc
            FROM jsonb_array_elements($10) v;

            IF td<>tc OR td<=0 THEN
                RAISE EXCEPTION 'Unbalanced journal';
            END IF;

            INSERT INTO journal_entries (
                organization_id,branch_id,
                source_module,source_document_id,
                source_document_type,status,
                total_debit,total_credit,
                accounting_date,currency
            )
            VALUES (
                $1,$2,$3,$5,$4||':'||$6,
                'posted',td,tc,$7,$8
            )
            RETURNING id INTO j;

            FOR x IN
                SELECT value
                FROM jsonb_array_elements($10)
            LOOP

                a := neo_gl_acct($1,x->>'code');

                IF current_setting(
                    'test.wrong_account',true
                )='on'
                AND (x->>'debit')::numeric>0
                THEN
                    a := '${incorrectAccount}'::uuid;
                END IF;

                INSERT INTO journal_entry_lines (
                    journal_id,organization_id,
                    branch_id,account_id,debit,credit
                )
                VALUES (
                    j,$1,$2,a,
                    (x->>'debit')::numeric,
                    (x->>'credit')::numeric
                );

            END LOOP;

            IF current_setting(
                'test.post_failure',true
            )='on' THEN

                RAISE EXCEPTION
                    'Simulated closed accounting period';

            END IF;

            RETURN jsonb_build_object(
                'journal_id',j
            );

        END;
        $$;
    `);

    for(const migration of [
        "20261125171000_inventory_finance_reversal_evidence.sql",
        "20261125172000_inventory_finance_reversal_calculation.sql",
        "20261125173000_inventory_reversal_movement_validation.sql",
        "20261125174000_inventory_cogs_journal_validation.sql",
        "20261125175000_inventory_compensating_journal_engine.sql"
    ]) {

        await test("Migration executes: "+migration,async()=>{
            await db.exec(readFileSync(
                "supabase/migrations/"+migration,
                "utf8"
            ));
        });

    }

    await test("Original journal identity validated",async()=>{

        const f=await fixture();
        const r=await validateOriginal(f);

        assert.equal(r.status,"validated");
        assert.equal(r.posted_amount,200);
        assert.equal(r.cogs_account_id,cogsAccount);
        assert.equal(
            r.inventory_account_id,
            inventoryAccount
        );

    });

    await test("Full restoration creates compensating journal",async()=>{

        const f=await restoration(
            await fixture(),2,200
        );

        const r=await post(f);

        assert.equal(r.status,"posted");
        assert.equal(r.amount,200);
        assert.equal(r.remaining_posted_amount,0);

        assert.equal(
            await countReversalJournals(f),1
        );

    });

    await test("Original journal remains posted and unchanged",async()=>{

        const f=await restoration(
            await fixture(),2,200
        );

        assert.equal((await post(f)).status,"posted");

        const r=await db.query(`
            SELECT *
            FROM journal_entries
            WHERE id=$1
        `,[f.journal]);

        assert.equal(r.rows[0].status,"posted");
        assert.equal(
            r.rows[0].reversed_by_journal_id,null
        );

        assert.equal(
            Number(r.rows[0].total_debit),200
        );

    });

    await test("Compensating journal uses original account IDs",async()=>{

        const f=await restoration(
            await fixture(),1,100
        );

        const r=await post(f);

        assert.equal(r.status,"posted");

        const lines=await db.query(`
            SELECT account_id,
                   debit::float8 AS debit,
                   credit::float8 AS credit
            FROM journal_entry_lines
            WHERE journal_id=$1
        `,[r.journal_id]);

        assert.ok(lines.rows.some(x=>
            x.account_id===inventoryAccount
            && x.debit===100 && x.credit===0
        ));

        assert.ok(lines.rows.some(x=>
            x.account_id===cogsAccount
            && x.debit===0 && x.credit===100
        ));

    });

    await test("Duplicate restoration cannot duplicate journal",async()=>{

        const f=await restoration(
            await fixture(),1,100
        );

        const first=await post(f);
        const second=await post(f);

        assert.equal(first.status,"posted");
        assert.equal(second.status,"posted");
        assert.equal(second.duplicate_prevented,true);
        assert.equal(first.journal_id,second.journal_id);

        assert.equal(
            await countReversalJournals(f),1
        );

    });

    await test("Multiple restored components accumulate correctly",async()=>{

        const f=await fixture(200);

        const first=await restoration(f,1,80);
        const second=await restoration(f,1,40);
        const third=await restoration(f,1,80);

        assert.equal((await post(first)).amount,80);
        assert.equal((await post(second)).amount,40);

        const r=await post(third);

        assert.equal(r.amount,80);
        assert.equal(r.remaining_posted_amount,0);

        assert.equal(
            await countReversalJournals(f),3
        );

    });

    await test("Excess cumulative financial restoration rejected",async()=>{

        const f=await fixture(200);

        const first=await restoration(f,1,180);
        const second=await restoration(f,1,30);

        assert.equal((await post(first)).status,"posted");
        assert.equal((await post(second)).status,"failed");

        assert.equal(
            await countReversalJournals(f),1
        );

    });

    await test("Historical consumption does not generate reversal",async()=>{

        const f=await restoration(
            await fixture(200,null),1,100
        );

        assert.equal(
            (await post(f)).status,"legacy-excluded"
        );

        assert.equal(
            await countReversalJournals(f),0
        );

    });

    await test("Unresolved original finance remains unverified",async()=>{

        const f=await restoration(
            await fixture(200,"failed"),1,100
        );

        assert.equal(
            (await post(f)).status,"unverified"
        );

        assert.equal(
            await countReversalJournals(f),0
        );

    });

    await test("Verified zero-cost restoration creates no journal",async()=>{

        const f=await restoration(
            await fixture(0,"zero-value"),1,0
        );

        assert.equal(
            (await post(f)).status,"zero-value"
        );

        assert.equal(
            await countReversalJournals(f),0
        );

    });

    await test("Original journal amount mismatch rejected",async()=>{

        const f=await fixture();

        await db.query(`
            UPDATE journal_entries
            SET total_debit=250
            WHERE id=$1
        `,[f.journal]);

        await assert.rejects(
            validateOriginal(f),
            /journal identity mismatch/
        );

    });

    await test("Malformed original journal lines rejected",async()=>{

        const f=await fixture();

        await db.query(`
            UPDATE journal_entry_lines
            SET credit=-10
            WHERE journal_id=$1 AND credit>0
        `,[f.journal]);

        await assert.rejects(
            validateOriginal(f),
            /invalid lines/
        );

    });

    await test("Previously reversed original journal rejected",async()=>{

        const f=await fixture();

        await db.query(`
            UPDATE journal_entries
            SET reversed_by_journal_id=gen_random_uuid()
            WHERE id=$1
        `,[f.journal]);

        await assert.rejects(
            validateOriginal(f),
            /journal identity mismatch/
        );

    });

    await test("Wrong compensating account rolls back financial posting",async()=>{

        const f=await restoration(
            await fixture(),1,100
        );

        await setting("test.wrong_account","on");

        assert.equal((await post(f)).status,"failed");
        assert.equal(await countReversalJournals(f),0);

        assert.match(
            (await evidence(f)).posting_error,
            /journal lines do not reconcile/
        );

        await setting("test.wrong_account","off");

        assert.equal((await post(f)).status,"posted");

    });

    await test("Financial posting failure retains restoration evidence",async()=>{

        const f=await restoration(
            await fixture(),1,100
        );

        await setting("test.post_failure","on");

        assert.equal((await post(f)).status,"failed");

        assert.equal(
            (await evidence(f)).status,"failed"
        );

        assert.equal(await countReversalJournals(f),0);

        await setting("test.post_failure","off");

        assert.equal((await post(f)).status,"posted");
        assert.equal((await evidence(f)).attempt_count,2);

    });

    await test("Restoration accounting date follows original movement date",async()=>{

        const f=await restoration(
            await fixture(),1,100
        );

        await db.query(`
            UPDATE stock_movements
            SET created_at='2026-11-24 22:30:00+00'
            WHERE id=$1
        `,[f.restored]);

        const r=await post(f);

        assert.equal(r.status,"posted");

        const j=await db.query(`
            SELECT accounting_date::text AS d
            FROM journal_entries
            WHERE id=$1
        `,[r.journal_id]);

        assert.equal(j.rows[0].d,"2026-11-25");

    });

    await test("Unauthorised property rejected",async()=>{

        const f=await restoration(
            await fixture(),1,100
        );

        await db.query(`
            UPDATE inventory_posting_events
            SET branch_id=$2
            WHERE id=$1
        `,[f.event,otherBranch]);

        await assert.rejects(
            post(f),
            /outside authorised property/
        );

    });

    await test("Ordinary client cannot invoke reversal engine",async()=>{

        const r=await db.query(`
            SELECT has_function_privilege(
                'authenticated',
                'public.neo_inventory_post_restoration_finance(uuid,uuid,uuid)',
                'EXECUTE'
            ) AS permitted
        `);

        assert.equal(r.rows[0].permitted,false);

    });

    console.log(
        "\nFIN-03I.4C:",passed,
        "COMPENSATING JOURNAL TESTS PASSED"
    );

} catch(error) {

    console.error("\nFIN-03I.4C FAILED");
    console.error(error);
    process.exitCode=1;

} finally {

    await db.close();

}