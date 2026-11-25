import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";

const db = new PGlite();

const org = "10000000-0000-4000-8000-000000000001";
const otherOrg = "10000000-0000-4000-8000-000000000002";
const branch = "20000000-0000-4000-8000-000000000001";
const otherBranch = "20000000-0000-4000-8000-000000000002";

let passed = 0;

async function test(name, fn) {
    await fn();
    passed++;
    console.log("PASS:", name);
}

async function event(
    cost,
    valuation = "verified",
    financeStatus = "pending",
    tenant = org,
    property = branch,
    postingType = "consumption",
    status = "posted"
) {
    const id = crypto.randomUUID();

    await db.query(`
        INSERT INTO inventory_posting_events (
            id,
            organization_id,
            branch_id,
            posting_type,
            status,
            cost_snapshot,
            payload,
            finance_posting_status
        )
        VALUES (
            $1,$2,$3,$4,$5,$6,
            jsonb_build_object(
                'valuation_status',$7::text
            ),
            $8
        )
    `, [
        id, tenant, property,
        postingType, status,
        cost, valuation, financeStatus
    ]);

    return id;
}

async function post(id) {
    const r = await db.query(`
        SELECT public.neo_inventory_post_consumption_finance(
            $1
        ) AS result
    `,[id]);

    return r.rows[0].result;
}

async function evidence(id) {
    const r = await db.query(`
        SELECT *
        FROM inventory_posting_events
        WHERE id=$1
    `,[id]);

    return r.rows[0];
}

async function countJournals(id) {
    const r = await db.query(`
        SELECT count(*)::int AS n
        FROM journal_entries
        WHERE source_document_id=$1
    `,[id]);

    return r.rows[0].n;
}

async function setting(name,value) {
    await db.query(
        "SELECT set_config($1,$2,false)",
        [name,value]
    );
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
            id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
            organization_id uuid,
            branch_id uuid,
            source_document_id uuid,
            source_document_type text,
            status text,
            total_debit numeric,
            total_credit numeric,
            accounting_date date,
            currency text,
            posting_lines jsonb,
            UNIQUE (
                organization_id,
                source_document_id,
                source_document_type
            )
        );

        CREATE TABLE inventory_posting_events (
            id uuid PRIMARY KEY,
            organization_id uuid,
            branch_id uuid,
            posting_type text,
            status text,
            cost_snapshot numeric,
            payload jsonb,
            created_at timestamptz DEFAULT now()
        );

        CREATE TABLE procurement_matching_policies (
            inventory_account_code text,
            cost_of_sales_account_code text
        );

        CREATE FUNCTION neo_matching_policy(uuid,uuid)
        RETURNS procurement_matching_policies
        LANGUAGE plpgsql
        AS $$
        DECLARE
            p procurement_matching_policies;
        BEGIN

            IF current_setting(
                'test.invalid_policy',true
            )='on' THEN

                p.inventory_account_code := NULL;
                p.cost_of_sales_account_code := '5090';

            ELSE

                p.inventory_account_code := '1070';
                p.cost_of_sales_account_code := '5090';

            END IF;

            RETURN p;
        END;
        $$;

        CREATE FUNCTION neo_gl_post(
            uuid,uuid,text,text,uuid,text,date,
            text,text,jsonb,uuid,uuid
        )
        RETURNS jsonb
        LANGUAGE plpgsql
        AS $$
        DECLARE
            j uuid;
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
                    'ok',true,
                    'journal_id',j,
                    'duplicate_prevented',true
                );
            END IF;

            SELECT
                sum((x->>'debit')::numeric),
                sum((x->>'credit')::numeric)
            INTO td,tc
            FROM jsonb_array_elements($10) x;

            IF td<>tc OR td<=0 THEN
                RAISE EXCEPTION 'Unbalanced journal';
            END IF;

            INSERT INTO journal_entries (
                organization_id,
                branch_id,
                source_document_id,
                source_document_type,
                status,
                total_debit,
                total_credit,
                accounting_date,
                currency,
                posting_lines
            )
            VALUES (
                $1,$2,$5,$4||':'||$6,
                'posted',td,tc,$7,$8,$10
            )
            RETURNING id INTO j;

            IF current_setting(
                'test.journal_failure',true
            )='on' THEN

                RAISE EXCEPTION
                    'Simulated accounting period failure';

            END IF;

            IF current_setting(
                'test.invalid_evidence',true
            )='on' THEN

                UPDATE journal_entries
                SET total_credit=0
                WHERE id=j;

            END IF;

            RETURN jsonb_build_object(
                'ok',true,
                'journal_id',j,
                'duplicate_prevented',false
            );
        END;
        $$;
    `);

    for (const migration of [
        "20261125164000_inventory_finance_posting_evidence.sql",
        "20261125165000_inventory_cogs_finance_engine.sql"
    ]) {
        await test(
            "Migration executes: "+migration,
            async()=>{
                await db.exec(readFileSync(
                    "supabase/migrations/"+migration,
                    "utf8"
                ));
            }
        );
    }

    const normal = await event(200);

    await test("Verified consumption creates a journal",async()=>{
        const r=await post(normal);

        assert.equal(r.status,"posted");
        assert.equal(r.amount,200);
        assert.ok(r.journal_id);
        assert.equal(await countJournals(normal),1);
    });

    await test("Correct inventory and COGS accounts",async()=>{
        const r=await db.query(`
            SELECT posting_lines
            FROM journal_entries
            WHERE source_document_id=$1
        `,[normal]);

        const lines=r.rows[0].posting_lines;

        assert.equal(lines[0].code,"5090");
        assert.equal(lines[0].debit,200);
        assert.equal(lines[0].credit,0);

        assert.equal(lines[1].code,"1070");
        assert.equal(lines[1].debit,0);
        assert.equal(lines[1].credit,200);
    });

    await test("Successful posting retains durable evidence",async()=>{
        const e=await evidence(normal);

        assert.equal(e.finance_posting_status,"posted");
        assert.ok(e.finance_journal_id);
        assert.ok(e.finance_posted_at);
        assert.equal(e.finance_attempt_count,1);
    });

    await test("Posting replay does not duplicate journal",async()=>{
        const r=await post(normal);

        assert.equal(r.status,"posted");
        assert.equal(r.duplicate_prevented,true);
        assert.equal(await countJournals(normal),1);
        assert.equal(
            (await evidence(normal)).finance_attempt_count,
            1
        );
    });

    await test("Legacy consumption is excluded",async()=>{
        const id=await event(500,"verified",null);

        assert.equal(
            (await post(id)).status,
            "legacy-excluded"
        );

        assert.equal(await countJournals(id),0);
    });

    await test("Unverified consumption does not post",async()=>{
        const id=await event(80,"unverified");

        assert.equal(
            (await post(id)).status,
            "unverified"
        );

        assert.equal(await countJournals(id),0);
        assert.ok(
            (await evidence(id)).finance_posting_error
        );
    });

    await test("Unknown cost does not become zero cost",async()=>{
        const id=await event(null);

        assert.equal(
            (await post(id)).status,
            "unverified"
        );

        assert.equal(await countJournals(id),0);
    });

    await test("Verified zero cost requires no journal",async()=>{
        const id=await event(0);

        assert.equal(
            (await post(id)).status,
            "zero-value"
        );

        assert.equal(await countJournals(id),0);
    });

    await test("Negative cost rejected",async()=>{
        const id=await event(-100);

        assert.equal(
            (await post(id)).status,
            "failed"
        );

        assert.equal(await countJournals(id),0);
    });

    await test("Non-finite cost rejected",async()=>{
        const id=await event("NaN");

        assert.equal(
            (await post(id)).status,
            "failed"
        );

        assert.equal(await countJournals(id),0);
    });

    await test("Cross-organisation posting rejected",async()=>{
        const id=await event(
            200,"verified","pending",otherOrg
        );

        await assert.rejects(
            post(id),
            /Inventory posting event unavailable/
        );

        assert.equal(await countJournals(id),0);
    });

    await test("Unauthorised property rejected",async()=>{
        const id=await event(
            200,"verified","pending",org,otherBranch
        );

        await assert.rejects(
            post(id),
            /outside authorised property/
        );

        assert.equal(await countJournals(id),0);
    });

    await test("Non-consumption event excluded",async()=>{
        const id=await event(
            200,"verified","pending",
            org,branch,"transfer"
        );

        assert.equal(
            (await post(id)).status,
            "ineligible"
        );

        assert.equal(await countJournals(id),0);
    });

    await test("Reversed physical consumption excluded",async()=>{
        const id=await event(
            200,"verified","pending",
            org,branch,"consumption","reversed"
        );

        assert.equal(
            (await post(id)).status,
            "ineligible"
        );

        assert.equal(await countJournals(id),0);
    });

    await test("Missing account configuration records failure",async()=>{
        await setting("test.invalid_policy","on");

        const id=await event(200);

        assert.equal(
            (await post(id)).status,
            "failed"
        );

        assert.equal(await countJournals(id),0);

        assert.match(
            (await evidence(id)).finance_posting_error,
            /Invalid inventory accounting configuration/
        );

        await setting("test.invalid_policy","off");

        assert.equal(
            (await post(id)).status,
            "posted"
        );

        assert.equal(
            (await evidence(id)).finance_attempt_count,
            2
        );
    });

    await test("Journal failure rolls back partial financial write",async()=>{
        await setting("test.journal_failure","on");

        const id=await event(350);

        assert.equal(
            (await post(id)).status,
            "failed"
        );

        assert.equal(await countJournals(id),0);
        assert.equal((await evidence(id)).status,"posted");

        await setting("test.journal_failure","off");

        assert.equal(
            (await post(id)).status,
            "posted"
        );

        assert.equal(await countJournals(id),1);

        assert.equal(
            (await evidence(id)).finance_attempt_count,
            2
        );
    });

    await test("Invalid journal evidence is rejected and rolled back",async()=>{
        await setting("test.invalid_evidence","on");

        const id=await event(250);

        assert.equal(
            (await post(id)).status,
            "failed"
        );

        assert.equal(await countJournals(id),0);

        await setting("test.invalid_evidence","off");
    });

    await test("Journal uses original consumption accounting date",async()=>{
        const id=await event(120);

        await db.query(`
            UPDATE inventory_posting_events
            SET created_at='2026-11-24 22:30:00+00'
            WHERE id=$1
        `,[id]);

        assert.equal(
            (await post(id)).status,
            "posted"
        );

        const r=await db.query(`
            SELECT accounting_date::text AS d
            FROM journal_entries
            WHERE source_document_id=$1
        `,[id]);

        assert.equal(r.rows[0].d,"2026-11-25");
    });

    await test("Ordinary client cannot execute internal posting engine",async()=>{
        const r=await db.query(`
            SELECT has_function_privilege(
                'authenticated',
                'public.neo_inventory_post_consumption_finance(uuid)',
                'EXECUTE'
            ) AS permitted
        `);

        assert.equal(r.rows[0].permitted,false);
    });

    console.log(
        "\nFIN-03H.5C:",
        passed,
        "COGS FINANCE TESTS PASSED"
    );

} catch(error) {

    console.error("\nFIN-03H.5C FAILED");
    console.error(error);
    process.exitCode=1;

} finally {

    await db.close();

}