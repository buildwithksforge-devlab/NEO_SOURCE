import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";

const migration = readFileSync(
  "supabase/migrations/20261125234000_inventory_controlled_accounting_recovery.sql",
  "utf8"
);

const org = "10000000-0000-0000-0000-000000000001";
const branch = "20000000-0000-0000-0000-000000000001";
const event = "30000000-0000-0000-0000-000000000001";
const original = "40000000-0000-0000-0000-000000000001";
const restoration = "50000000-0000-0000-0000-000000000001";

const recoveryFunction = migration.match(
  /CREATE OR REPLACE FUNCTION\s+public\.neo_inventory_recover_reversed_accounting\s*\([\s\S]*?\$function\$;/
)?.[0];

if (!recoveryFunction) {
  throw new Error(
    "Canonical coordinated recovery function unavailable"
  );
}


function requireRow<T>(rows: T[]): T {
  const row = rows[0];

  if (row === undefined) {
    throw new Error(
      "Expected PostgreSQL result row was not returned."
    );
  }

  return row;
}

describe("coordinated inventory accounting transaction", () => {

  let db: PGlite;

  beforeEach(async () => {

    db = new PGlite();

    await db.exec(`

      CREATE TABLE public.inventory_posting_events (

        id uuid PRIMARY KEY,

        organization_id uuid,

        branch_id uuid,

        status text,

        finance_journal_id uuid,

        finance_posting_status text,

        cost_snapshot numeric

      );

      CREATE TABLE public.neo_inventory_finance_reversals (

        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),

        organization_id uuid,

        branch_id uuid,

        consumption_event_id uuid,

        original_stock_movement_id uuid,

        restoration_stock_movement_id uuid,

        status text,

        reversed_amount numeric

      );

      CREATE TABLE public.test_journals (

        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),

        kind text NOT NULL UNIQUE,

        debit numeric NOT NULL,

        credit numeric NOT NULL

      );

      CREATE TABLE public.test_stock_movements (

        id uuid PRIMARY KEY,

        quantity numeric

      );

      CREATE TABLE public.test_controls (

        eligible boolean NOT NULL,

        original_failure boolean NOT NULL,

        restoration_failure boolean NOT NULL,

        restoration_amount numeric NOT NULL

      );

      INSERT INTO public.test_controls

      VALUES (true,false,false,150);

      CREATE FUNCTION public.current_org_id()

      RETURNS uuid LANGUAGE sql AS $$

        SELECT '${org}'::uuid

      $$;

      CREATE FUNCTION
      public.neo_inventory_reversed_recovery_eligible(uuid)

      RETURNS boolean LANGUAGE sql AS $$

        SELECT eligible

          AND EXISTS (

            SELECT 1

            FROM public.inventory_posting_events e

            WHERE e.id = $1

              AND e.organization_id = '${org}'::uuid

              AND e.finance_journal_id IS NULL

              AND e.status = 'reversed'

          )

        FROM public.test_controls

      $$;

      -- Controlled original accounting engine.
      -- Simulates the existing engine's persisted outcome.

      CREATE FUNCTION
      public.neo_inventory_post_consumption_finance(uuid)

      RETURNS jsonb

      LANGUAGE plpgsql AS $$

      DECLARE

        jid uuid;

      BEGIN

        IF (

          SELECT original_failure

          FROM public.test_controls

        ) THEN

          RETURN '{"status":"failed"}'::jsonb;

        END IF;

        INSERT INTO public.test_journals (

          kind,debit,credit

        )

        VALUES ('original-cogs',150,150)

        RETURNING id INTO jid;

        UPDATE public.inventory_posting_events

        SET finance_journal_id = jid,

            finance_posting_status = 'posted'

        WHERE id = $1;

        RETURN jsonb_build_object(

          'status','posted',

          'journal_id',jid,

          'amount',150

        );

      END;

      $$;

      -- Controlled compensating accounting engine.

      CREATE FUNCTION
      public.neo_inventory_post_restoration_finance(
        uuid,uuid,uuid
      )

      RETURNS jsonb

      LANGUAGE plpgsql AS $$

      DECLARE

        amount numeric;

        jid uuid;

      BEGIN

        IF (

          SELECT restoration_failure

          FROM public.test_controls

        ) THEN

          RETURN '{"status":"failed"}'::jsonb;

        END IF;

        SELECT restoration_amount

        INTO amount

        FROM public.test_controls;

        INSERT INTO public.test_journals (

          kind,debit,credit

        )

        VALUES (

          'restoration-cogs',

          amount,

          amount

        )

        RETURNING id INTO jid;

        UPDATE public.neo_inventory_finance_reversals

        SET status = 'posted',

            reversed_amount = amount

        WHERE consumption_event_id = $1

          AND original_stock_movement_id = $2

          AND restoration_stock_movement_id = $3;

        RETURN jsonb_build_object(

          'status','posted',

          'journal_id',jid,

          'amount',amount

        );

      END;

      $$;

    `);

    await db.exec(recoveryFunction!);

    await db.query(`

      INSERT INTO public.inventory_posting_events

      VALUES (

        $1,$2,$3,

        'reversed',

        NULL,

        'failed',

        150

      )

    `,[event,org,branch]);

    await db.query(`

      INSERT INTO public.neo_inventory_finance_reversals (

        organization_id,

        branch_id,

        consumption_event_id,

        original_stock_movement_id,

        restoration_stock_movement_id,

        status

      )

      VALUES ($1,$2,$3,$4,$5,'failed')

    `,[org,branch,event,original,restoration]);

    await db.query(`

      INSERT INTO public.test_stock_movements

      VALUES ($1,-2),($2,2)

    `,[original,restoration]);

  });

  afterEach(async () => {

    await db.close();

  });

  async function recover() {

    const result = await db.query<{ result: any }>(`

      SELECT
        public.neo_inventory_recover_reversed_accounting(
          $1
        ) AS result

    `,[event]);

    return requireRow(result.rows).result;

  }

  async function journalCount() {

    const result = await db.query<{ count: number }>(`

      SELECT count(*)::int AS count

      FROM public.test_journals

    `);

    return requireRow(result.rows).count;

  }

  async function assertRolledBack() {

    expect(await journalCount()).toBe(0);

    const state = await db.query<{

      finance_journal_id: string | null;

      finance_posting_status: string;

    }>(`

      SELECT

        finance_journal_id,

        finance_posting_status

      FROM public.inventory_posting_events

      WHERE id = $1

    `,[event]);

    expect(
      requireRow(state.rows).finance_journal_id
    ).toBeNull();

    expect(
      requireRow(state.rows).finance_posting_status
    ).toBe("failed");

    const reversal = await db.query<{

      status: string;

      reversed_amount: string | null;

    }>(`

      SELECT status,reversed_amount

      FROM public.neo_inventory_finance_reversals

    `);

    expect(
      requireRow(reversal.rows).status
    ).toBe("failed");

    expect(
      requireRow(reversal.rows).reversed_amount
    ).toBeNull();

  }

  it("recognizes original and compensating costs together",async () => {

    const result = await recover();

    expect(result.status).toBe("recovered");

    expect(
      result.restorations_reconciled
    ).toBe(1);

    expect(await journalCount()).toBe(2);

    const totals = await db.query<{

      debit: string;

      credit: string;

    }>(`

      SELECT

        sum(debit)::text AS debit,

        sum(credit)::text AS credit

      FROM public.test_journals

    `);

    expect(
      requireRow(totals.rows).debit
    ).toBe("300");

    expect(
      requireRow(totals.rows).credit
    ).toBe("300");

  });

  it("rolls back when original accounting fails",async () => {

    await db.exec(`

      UPDATE public.test_controls

      SET original_failure = true

    `);

    await expect(
      recover()
    ).rejects.toThrow();

    await assertRolledBack();

  });

  it("rolls back original accounting when restoration fails",async () => {

    await db.exec(`

      UPDATE public.test_controls

      SET restoration_failure = true

    `);

    await expect(
      recover()
    ).rejects.toThrow();

    await assertRolledBack();

  });

  it("rolls back both journals when monetary values do not reconcile",async () => {

    await db.exec(`

      UPDATE public.test_controls

      SET restoration_amount = 149

    `);

    await expect(
      recover()
    ).rejects.toThrow();

    await assertRolledBack();

  });

  it("rejects recovery when eligibility is not established",async () => {

    await db.exec(`

      UPDATE public.test_controls

      SET eligible = false

    `);

    await expect(
      recover()
    ).rejects.toThrow();

    await assertRolledBack();

  });

  it("does not duplicate journals on a repeated attempt",async () => {

    await recover();

    await expect(
      recover()
    ).rejects.toThrow();

    expect(await journalCount()).toBe(2);

  });

  it("does not change physical movement quantities",async () => {

    const before = await db.query(`

      SELECT *

      FROM public.test_stock_movements

      ORDER BY id

    `);

    await recover();

    const after = await db.query(`

      SELECT *

      FROM public.test_stock_movements

      ORDER BY id

    `);

    expect(after.rows).toEqual(before.rows);

  });

});