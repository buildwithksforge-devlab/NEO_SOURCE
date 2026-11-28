import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it
} from "vitest";

const id = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

const org = id(701);
const branch = id(702);
const actor = id(703);
const reservation = id(704);
const customer = id(705);
const folio = id(706);
const deposit = id(707);
const receipt = id(708);
const liability = id(709);
const receivable = id(710);
const cash = id(711);
const revenue = id(712);

const migration = readFileSync(
  "supabase/migrations/20261126023000_customer_advance_deposit_transactions.sql",
  "utf8"
);

function section(start: string, end?: string) {
  const from = migration.indexOf(start);

  if (from < 0) {
    throw new Error(`Missing migration section: ${start}`);
  }

  const to = end
    ? migration.indexOf(end, from + start.length)
    : migration.length;

  if (to < 0) {
    throw new Error(`Missing migration boundary: ${end}`);
  }

  return migration.slice(from, to);
}

describe("actual progressive deposit PostgreSQL execution", () => {
  let db: PGlite;

  beforeAll(async () => {
    db = new PGlite();

    await db.exec(`
      CREATE ROLE anon NOLOGIN;
      CREATE ROLE authenticated NOLOGIN;

      CREATE SCHEMA auth;

      CREATE FUNCTION auth.uid()
      RETURNS uuid LANGUAGE sql STABLE
      AS $$ SELECT '${actor}'::uuid $$;

      CREATE FUNCTION public.current_org_id()
      RETURNS uuid LANGUAGE sql STABLE
      AS $$ SELECT '${org}'::uuid $$;

      CREATE FUNCTION public.neo_branch_in_scope(uuid)
      RETURNS boolean LANGUAGE sql STABLE
      AS $$ SELECT $1 = '${branch}'::uuid $$;

      CREATE FUNCTION public.neo_fact_currency(uuid,uuid)
      RETURNS text LANGUAGE sql STABLE
      AS $$ SELECT 'KES'::text $$;

      CREATE TABLE public.reservations (
        id uuid PRIMARY KEY,
        organization_id uuid,
        branch_id uuid,
        customer_id uuid
      );

      CREATE TABLE public.folios (
        id uuid PRIMARY KEY,
        organization_id uuid,
        branch_id uuid,
        reservation_id uuid,
        customer_id uuid,
        currency text DEFAULT 'KES',
        status text DEFAULT 'open',
        folio_type text DEFAULT 'guest',
        total_payments numeric DEFAULT 0,
        balance numeric DEFAULT 0,
        updated_at timestamptz
      );

      CREATE TABLE public.folio_lines (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        organization_id uuid,
        branch_id uuid,
        reservation_id uuid,
        folio_id uuid,
        customer_id uuid,
        category text,
        line_type text,
        source_module text,
        source_record_id text,
        source_record_uuid uuid,
        idempotency_key text UNIQUE,
        description text,
        operational_date date,
        quantity numeric,
        unit_price numeric,
        gross_amount numeric,
        net_amount numeric,
        posted_by uuid,
        status text DEFAULT 'posted'
      );

      CREATE TABLE public.reservation_deposits (
        id uuid PRIMARY KEY,
        organization_id uuid,
        branch_id uuid,
        reservation_id uuid,
        customer_id uuid,
        payment_id uuid,
        amount numeric,
        currency text,
        status text,
        received_at timestamptz DEFAULT now(),
        applied_folio_id uuid,
        applied_folio_line_id uuid
      );

      CREATE TABLE public.cash_refund_requests (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        organization_id uuid,
        payment_id uuid,
        amount numeric,
        status text
      );

      CREATE TABLE public.chart_of_accounts (
        id uuid PRIMARY KEY,
        organization_id uuid,
        code text
      );

      CREATE TABLE public.journal_entries (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        organization_id uuid,
        branch_id uuid,
        currency text,
        status text,
        source_document_type text,
        source_document_id uuid,
        total_debit numeric,
        total_credit numeric,
        reversed_by_journal_id uuid
      );

      CREATE TABLE public.journal_entry_lines (
        journal_id uuid,
        organization_id uuid,
        branch_id uuid,
        account_id uuid,
        debit numeric,
        credit numeric
      );

      CREATE TABLE public.test_controls (
        reject_posting boolean DEFAULT false,
        wrong_account boolean DEFAULT false
      );

      INSERT INTO public.test_controls VALUES (false,false);

      CREATE FUNCTION public.neo_deposit_net_amount(uuid)
      RETURNS numeric LANGUAGE sql STABLE AS $$
        SELECT d.amount - coalesce((
          SELECT sum(r.amount)
          FROM public.cash_refund_requests r
          WHERE r.payment_id=d.payment_id
            AND r.organization_id=d.organization_id
            AND r.status='settled'
        ),0)
        FROM public.reservation_deposits d
        WHERE d.id=$1
      $$;

      CREATE FUNCTION public.neo_connection_journal_matches(
        _journal uuid,
        _org uuid,
        _branch uuid,
        _currency text,
        _amount numeric,
        _type text,
        _source uuid
      )
      RETURNS boolean LANGUAGE sql STABLE AS $$
        SELECT EXISTS (
          SELECT 1
          FROM public.journal_entries j
          WHERE j.id=_journal
            AND j.organization_id=_org
            AND j.branch_id=_branch
            AND j.currency=_currency
            AND j.status='posted'
            AND j.reversed_by_journal_id IS NULL
            AND j.source_document_type=_type
            AND j.source_document_id=_source
            AND j.total_debit=_amount
            AND j.total_credit=_amount
            AND (
              SELECT coalesce(sum(l.debit),0)
              FROM public.journal_entry_lines l
              WHERE l.journal_id=j.id
            )=_amount
            AND (
              SELECT coalesce(sum(l.credit),0)
              FROM public.journal_entry_lines l
              WHERE l.journal_id=j.id
            )=_amount
        )
      $$;

      CREATE FUNCTION public.neo_gl_post(
        _org uuid,
        _branch uuid,
        _module text,
        _source_type text,
        _source uuid,
        _action text,
        _date date,
        _currency text,
        _description text,
        _lines jsonb,
        _customer uuid,
        _correlation uuid
      )
      RETURNS jsonb LANGUAGE plpgsql AS $$
      DECLARE
        jid uuid;
        item jsonb;
        aid uuid;
        v_account_code text;
      BEGIN
        IF (
          SELECT reject_posting
          FROM public.test_controls
        ) THEN
          RAISE EXCEPTION 'test_finance_posting_failure';
        END IF;

        INSERT INTO public.journal_entries (
          organization_id,branch_id,currency,status,
          source_document_type,source_document_id,
          total_debit,total_credit
        )
        VALUES (
          _org,_branch,_currency,'posted',
          _source_type||':'||_action,_source,
          (
            SELECT coalesce(sum((x->>'debit')::numeric),0)
            FROM jsonb_array_elements(_lines) x
          ),
          (
            SELECT coalesce(sum((x->>'credit')::numeric),0)
            FROM jsonb_array_elements(_lines) x
          )
        )
        RETURNING id INTO jid;

        FOR item IN
          SELECT value FROM jsonb_array_elements(_lines)
        LOOP
          v_account_code := item->>'code';

          IF v_account_code='2020' AND (
            SELECT wrong_account FROM public.test_controls
          ) THEN
            v_account_code := '1010';
          END IF;

          SELECT a.id INTO STRICT aid
          FROM public.chart_of_accounts a
          WHERE a.organization_id=_org
            AND a.code=v_account_code;

          INSERT INTO public.journal_entry_lines
          VALUES (
            jid,_org,_branch,aid,
            coalesce((item->>'debit')::numeric,0),
            coalesce((item->>'credit')::numeric,0)
          );
        END LOOP;

        RETURN jsonb_build_object(
          'ok',true,'journal_id',jid
        );
      END;
      $$;

      CREATE FUNCTION public.pms_apply_deposits_to_folio()
      RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.reservation_id IS NULL THEN RETURN NEW; END IF;
        RETURN NEW;
      END;
      $$;
    `);

    await db.exec(section(
      "-- NEO_PROGRESSIVE_RESERVATION_DEPOSIT_LEDGER_V1",
      "-- NEO_RESERVATION_DEPOSIT_POLICY_V1"
    ));

    await db.exec(section(
      "-- NEO_RESERVATION_DEPOSIT_POLICY_V1",
      "-- NEO_PROGRESSIVE_DEPOSIT_EXECUTION_V1"
    ));

    // Execute only the standalone progressive allocation engine.
    // Later lifecycle integration requires its own database fixtures.
    const executionStart =
      "-- NEO_PROGRESSIVE_DEPOSIT_EXECUTION_V1";

    const connectionStart =
      "-- NEO_PROGRESSIVE_ACCOMMODATION_CONNECTION_V1";

    await db.exec(section(
      executionStart,
      migration.includes(connectionStart)
        ? connectionStart
        : undefined
    ));

    await db.exec(section(
      "-- NEO_PROGRESSIVE_DEPOSIT_FINANCIAL_POSITION_V1",
      "-- NEO_PROGRESSIVE_REFUND_RESERVATION_GUARD_V1"
    ));

    const refundGuardStart =
      "-- NEO_PROGRESSIVE_REFUND_RESERVATION_GUARD_V1";

    await db.exec(section(
      refundGuardStart,
      "-- NEO_PROGRESSIVE_REFUND_SETTLEMENT_V1"
    ));

    await db.exec(`
      ALTER TABLE public.cash_refund_requests
        ADD COLUMN branch_id uuid DEFAULT '${branch}',
        ADD COLUMN currency text DEFAULT 'KES',
        ADD COLUMN folio_id uuid,
        ADD COLUMN pos_payment_id uuid;
    `);

    const settlementSql = section(
      "-- NEO_PROGRESSIVE_REFUND_SETTLEMENT_V1"
    );

    const connectionBoundary = settlementSql.indexOf(
      "DO $progressive_refund_connection$"
    );

    if (connectionBoundary < 0) {
      throw new Error("Refund connection boundary missing");
    }

    await db.exec(
      settlementSql.slice(0,connectionBoundary)
    );

    const connectionSql = section(
      "-- NEO_PROGRESSIVE_ACCOMMODATION_CONNECTION_V1",
      "-- NEO_PROGRESSIVE_DEPOSIT_FINANCIAL_POSITION_V1"
    );

    const connectionEnd = connectionSql.indexOf(
      "DO $progressive_folio_creation$"
    );

    if (connectionEnd < 0) {
      throw new Error(
        "Accommodation connection SQL boundary missing"
      );
    }

    await db.exec(`
      CREATE TABLE public.test_accommodation_finance_control (
        reject_posting boolean NOT NULL DEFAULT false
      );

      INSERT INTO public.test_accommodation_finance_control
      VALUES(false);

      CREATE FUNCTION public.neo_finance_post_txn(
        _source_type text,
        _source_id uuid,
        _silent boolean DEFAULT false
      )
      RETURNS jsonb
      LANGUAGE plpgsql
      AS $finance$
      DECLARE
        l public.folio_lines;
        j uuid;
      BEGIN

        IF _source_type <> 'folio_charge' THEN
          RAISE EXCEPTION 'Unexpected financial source';
        END IF;

        IF (
          SELECT reject_posting
          FROM public.test_accommodation_finance_control
        ) THEN
          RETURN jsonb_build_object(
            'ok',false,
            'reason','simulated_finance_rejection'
          );
        END IF;

        SELECT *
        INTO l
        FROM public.folio_lines
        WHERE id=_source_id
          AND organization_id=public.current_org_id();

        IF l.id IS NULL THEN
          RETURN jsonb_build_object(
            'ok',false,
            'reason','missing_charge'
          );
        END IF;

        SELECT id
        INTO j
        FROM public.journal_entries
        WHERE organization_id=l.organization_id
          AND branch_id=l.branch_id
          AND source_document_id=l.id
          AND source_document_type='folio_charge:revenue'
          AND status='posted'
          AND reversed_by_journal_id IS NULL;

        IF j IS NULL THEN
          RETURN public.neo_gl_post(
            l.organization_id,
            l.branch_id,
            'pms',
            'folio_charge',
            l.id,
            'revenue',
            l.operational_date,
            'KES',
            l.description,
            jsonb_build_array(
              jsonb_build_object(
                'code','1060',
                'debit',l.net_amount,
                'credit',0
              ),
              jsonb_build_object(
                'code','4010',
                'debit',0,
                'credit',l.net_amount
              )
            ),
            l.customer_id,
            NULL
          );
        END IF;

        RETURN jsonb_build_object(
          'ok',true,
          'journal_id',j,
          'duplicate_prevented',true
        );

      END;
      $finance$;
    `);

    await db.exec(
      connectionSql.slice(0,connectionEnd)
    );

    // Confirm the production migration defaults to disabled.
    const enabled = await db.query<{ enabled: boolean }>(
      `SELECT public.neo_progressive_deposit_execution_enabled()
       AS enabled`
    );

    expect(enabled.rows[0]?.enabled).toBe(false);

    // Test-only activation in the disposable PGlite database.
    await db.exec(`
      CREATE OR REPLACE FUNCTION
      public.neo_progressive_deposit_execution_enabled()
      RETURNS boolean LANGUAGE sql STABLE
      AS $$ SELECT true $$;
    `);
  }, 60000);

  beforeEach(async () => {
    await db.exec(`
      TRUNCATE
        public.neo_reservation_deposit_allocations,
        public.neo_reservation_deposit_policies,
        public.cash_refund_requests,
        public.reservation_deposits,
        public.folio_lines,
        public.folios,
        public.reservations,
        public.journal_entry_lines,
        public.journal_entries,
        public.chart_of_accounts;

      UPDATE public.test_controls
      SET reject_posting=false,wrong_account=false;

      INSERT INTO public.reservations
      VALUES (
        '${reservation}','${org}','${branch}','${customer}'
      );

      INSERT INTO public.neo_reservation_deposit_policies (
        reservation_id,organization_id,branch_id,accounting_policy
      )
      VALUES (
        '${reservation}','${org}','${branch}',
        'progressive-accommodation'
      );

      INSERT INTO public.folios (
        id,organization_id,branch_id,reservation_id,customer_id
      )
      VALUES (
        '${folio}','${org}','${branch}',
        '${reservation}','${customer}'
      );

      INSERT INTO public.reservation_deposits (
        id,organization_id,branch_id,reservation_id,
        customer_id,payment_id,amount,currency,status
      )
      VALUES (
        '${deposit}','${org}','${branch}','${reservation}',
        '${customer}','${receipt}',50000,'KES','held'
      );

      INSERT INTO public.chart_of_accounts VALUES
        ('${liability}','${org}','2020'),
        ('${receivable}','${org}','1060'),
        ('${cash}','${org}','1010'),
        ('${revenue}','${org}','4010');
    `);

    await db.query(
      `SELECT public.neo_gl_post(
        $1,$2,'pms','reservation_deposit',$3,'deposit',
        current_date,'KES','Original receipt',
        '[{"code":"1010","debit":50000,"credit":0},
          {"code":"2020","debit":0,"credit":50000}]'::jsonb,
        $4,NULL
      )`,
      [org,branch,deposit,customer]
    );
  });

  afterAll(async () => {
    await db?.close();
  });

  async function addNight(n: number, amount = 19000) {
    const charge = id(800+n);

    await db.query(
      `INSERT INTO public.folio_lines (
        id,organization_id,branch_id,reservation_id,
        folio_id,customer_id,category,line_type,
        operational_date,quantity,unit_price,
        gross_amount,net_amount,status
      )
      VALUES (
        $1,$2,$3,$4,$5,$6,'accommodation','charge',
        current_date+$7::integer,1,$8,$8,$8,'posted'
      )`,
      [charge,org,branch,reservation,folio,customer,n,amount]
    );

    await db.query(
      `UPDATE public.folios SET balance=balance+$2 WHERE id=$1`,
      [folio,amount]
    );

    if (amount > 0) {
      await db.query(
        `SELECT public.neo_gl_post(
          $1,$2,'pms','folio_charge',$3,'revenue',
          current_date,'KES','Accommodation',
          $4::jsonb,$5,NULL
        )`,
        [
          org,branch,charge,
          JSON.stringify([
            {code:"1060",debit:amount,credit:0},
            {code:"4010",debit:0,credit:amount}
          ]),
          customer
        ]
      );
    }

    return charge;
  }

  async function allocate(charge: string) {
    const result = await db.query<{
      result: {
        ok: boolean;
        allocated: number;
        previously_allocated?: number;
        remaining_charge?: number;
        reason?: string;
      };
    }>(
      `SELECT public.neo_allocate_reservation_deposit_to_charge($1)
       AS result`,
      [charge]
    );

    return result.rows[0]!.result;
  }

  async function remaining() {
    const result = await db.query<{ amount: string }>(
      `SELECT public.neo_reservation_deposit_remaining($1) AS amount`,
      [deposit]
    );

    return Number(result.rows[0]!.amount);
  }

  async function position() {
    const result = await db.query<{
      balance: string;
      total_payments: string;
    }>(
      `SELECT balance,total_payments FROM public.folios WHERE id=$1`,
      [folio]
    );

    return {
      balance: Number(result.rows[0]!.balance),
      payments: Number(result.rows[0]!.total_payments)
    };
  }

  async function allocationCount() {
    const result = await db.query<{ n: number }>(
      `SELECT count(*)::int AS n
       FROM public.neo_reservation_deposit_allocations`
    );

    return result.rows[0]!.n;
  }

  it("applies 19000, 19000 and 12000 over three nights", async () => {
    expect((await allocate(await addNight(1))).allocated).toBe(19000);
    expect(await remaining()).toBe(31000);
    expect(await position()).toEqual({
      balance:0,payments:19000
    });

    expect((await allocate(await addNight(2))).allocated).toBe(19000);
    expect(await remaining()).toBe(12000);

    expect((await allocate(await addNight(3))).allocated).toBe(12000);
    expect(await remaining()).toBe(0);

    expect(await position()).toEqual({
      balance:7000,payments:50000
    });

    expect(await allocationCount()).toBe(3);
  });

  it("prevents duplicate allocation and duplicate journals", async () => {
    const charge = await addNight(1);

    await allocate(charge);

    const replay = await allocate(charge);

    expect(replay.allocated).toBe(0);
    expect(replay.previously_allocated).toBe(19000);
    expect(await allocationCount()).toBe(1);
    expect(await remaining()).toBe(31000);
  });

  it("protects the original deposit receipt", async () => {
    await allocate(await addNight(1));

    const result = await db.query<{
      amount: string;
      status: string;
      applied_folio_id: string | null;
    }>(
      `SELECT amount,status,applied_folio_id
       FROM public.reservation_deposits WHERE id=$1`,
      [deposit]
    );

    expect(Number(result.rows[0]!.amount)).toBe(50000);
    expect(result.rows[0]!.status).toBe("held");
    expect(result.rows[0]!.applied_folio_id).toBeNull();
  });

  it("protects money reserved for an approved refund", async () => {
    await db.query(
      `INSERT INTO public.cash_refund_requests (
        organization_id,payment_id,amount,status
      ) VALUES ($1,$2,40000,'approved')`,
      [org,receipt]
    );

    expect((await allocate(await addNight(1))).allocated).toBe(10000);
    expect(await remaining()).toBe(0);
    expect(await position()).toEqual({
      balance:9000,payments:10000
    });
  });

  it("rejects missing accommodation revenue journals", async () => {
    const charge = await addNight(1);

    await db.query(
      `UPDATE public.journal_entries
       SET status='draft'
       WHERE source_document_id=$1`,
      [charge]
    );

    await expect(allocate(charge)).rejects.toThrow(
      /revenue journal/i
    );

    expect(await allocationCount()).toBe(0);
    expect(await remaining()).toBe(50000);
  });

  it("rolls back when the financial posting fails", async () => {
    const charge = await addNight(1);

    await db.exec(`
      UPDATE public.test_controls SET reject_posting=true;
    `);

    await expect(allocate(charge)).rejects.toThrow(
      /test_finance_posting_failure/
    );

    expect(await allocationCount()).toBe(0);
    expect(await remaining()).toBe(50000);
    expect(await position()).toEqual({
      balance:19000,payments:0
    });
  });

  it("rejects balanced journals using the wrong accounts", async () => {
    const charge = await addNight(1);

    await db.exec(`
      UPDATE public.test_controls SET wrong_account=true;
    `);

    await expect(allocate(charge)).rejects.toThrow(
      /ledger accounts/i
    );

    expect(await allocationCount()).toBe(0);
    expect(await remaining()).toBe(50000);

    const result = await db.query<{ n: number }>(
      `SELECT count(*)::int AS n
       FROM public.journal_entries
       WHERE source_document_type =
         'reservation_deposit_allocation:application'`
    );

    expect(result.rows[0]!.n).toBe(0);
  });

  it("does not apply deposits against a zero accommodation charge", async () => {
    const result = await allocate(await addNight(1,0));

    expect(result.allocated).toBe(0);
    expect(await remaining()).toBe(50000);
    expect(await allocationCount()).toBe(0);
  });

  it("protects posted allocation history", async () => {
    await allocate(await addNight(1));

    await expect(db.exec(`
      UPDATE public.neo_reservation_deposit_allocations
      SET amount=1
    `)).rejects.toThrow(/immutable/i);

    await expect(db.exec(`
      DELETE FROM public.neo_reservation_deposit_allocations
    `)).rejects.toThrow(/immutable/i);

    expect(await allocationCount()).toBe(1);
  });

  it("does not reinterpret a legacy fully applied deposit", async () => {
    await db.query(
      `UPDATE public.reservation_deposits
       SET status='applied',applied_folio_id=$2
       WHERE id=$1`,
      [deposit,folio]
    );

    expect(await remaining()).toBe(0);
  });

  it("does not expose internal allocation to authenticated users", async () => {
    const result = await db.query<{ allowed: boolean }>(
      `SELECT has_function_privilege(
        'authenticated',
        'public.neo_allocate_reservation_deposit_to_charge(uuid)',
        'EXECUTE'
      ) AS allowed`
    );

    expect(result.rows[0]!.allowed).toBe(false);
  });

  async function financialPosition() {
    const result = await db.query<{
      result: {
        received: number;
        applied: number;
        refunded: number;
        reserved_refund: number;
        remaining_liability: number;
        available_for_allocation: number;
      };
    }>(
      `SELECT public.neo_progressive_deposit_financial_position($1)
       AS result`,
      [deposit]
    );

    return result.rows[0]!.result;
  }

  it("reports the original deposit and remaining liability separately", async () => {
    await allocate(await addNight(1));

    expect(await financialPosition()).toMatchObject({
      received:50000,
      applied:19000,
      refunded:0,
      reserved_refund:0,
      remaining_liability:31000,
      available_for_allocation:31000
    });
  });

  it("does not reduce liability merely because a refund is approved", async () => {
    await allocate(await addNight(1));

    await db.query(
      `INSERT INTO public.cash_refund_requests (
        organization_id,payment_id,amount,status
      ) VALUES ($1,$2,10000,'approved')`,
      [org,receipt]
    );

    expect(await financialPosition()).toMatchObject({
      received:50000,
      applied:19000,
      refunded:0,
      reserved_refund:10000,
      remaining_liability:31000,
      available_for_allocation:21000
    });
  });

  it("reduces liability after a verified settled refund", async () => {
    await allocate(await addNight(1));

    await db.query(
      `INSERT INTO public.cash_refund_requests (
        organization_id,payment_id,amount,status
      ) VALUES ($1,$2,10000,'settled')`,
      [org,receipt]
    );

    expect(await financialPosition()).toMatchObject({
      received:50000,
      applied:19000,
      refunded:10000,
      reserved_refund:0,
      remaining_liability:21000,
      available_for_allocation:21000
    });
  });

  it("restores allocation availability after a refund is rejected", async () => {
    await allocate(await addNight(1));

    await db.query(
      `INSERT INTO public.cash_refund_requests (
        organization_id,payment_id,amount,status
      ) VALUES ($1,$2,10000,'rejected')`,
      [org,receipt]
    );

    expect(await financialPosition()).toMatchObject({
      remaining_liability:31000,
      reserved_refund:0,
      available_for_allocation:31000
    });
  });

  it("rejects refund reservations exceeding unused deposits", async () => {
    await allocate(await addNight(1));

    await expect(db.query(
      `INSERT INTO public.cash_refund_requests (
        organization_id,payment_id,amount,status
      ) VALUES ($1,$2,32000,'approved')`,
      [org,receipt]
    )).rejects.toThrow(/exceed/i);

    expect(await financialPosition()).toMatchObject({
      remaining_liability:31000,
      reserved_refund:0,
      available_for_allocation:31000
    });
  });

  it("reconciles the final three-night deposit liability", async () => {
    await allocate(await addNight(1));
    await allocate(await addNight(2));
    await allocate(await addNight(3));

    expect(await financialPosition()).toMatchObject({
      received:50000,
      applied:50000,
      refunded:0,
      reserved_refund:0,
      remaining_liability:0,
      available_for_allocation:0
    });

    expect(await position()).toEqual({
      balance:7000,payments:50000
    });

    await db.query(
      `UPDATE public.folios
       SET balance=balance+3000
       WHERE id=$1`,
      [folio]
    );

    expect(await position()).toEqual({
      balance:10000,payments:50000
    });
  });

  it("rejects cumulative refunds exceeding remaining liability", async () => {
    await allocate(await addNight(1));

    await db.query(
      `INSERT INTO public.cash_refund_requests (
        organization_id,payment_id,amount,status
      ) VALUES ($1,$2,10000,'approved')`,
      [org,receipt]
    );

    await expect(db.query(
      `INSERT INTO public.cash_refund_requests (
        organization_id,payment_id,amount,status
      ) VALUES ($1,$2,22000,'pending_approval')`,
      [org,receipt]
    )).rejects.toThrow(/exceed/i);

    expect(await financialPosition()).toMatchObject({
      remaining_liability:31000,
      reserved_refund:10000,
      available_for_allocation:21000
    });
  });

  it("allows refund approval without counting the same request twice", async () => {
    await allocate(await addNight(1));

    await db.query(
      `INSERT INTO public.cash_refund_requests (
        organization_id,payment_id,amount,status
      ) VALUES ($1,$2,31000,'pending_approval')`,
      [org,receipt]
    );

    await db.query(
      `UPDATE public.cash_refund_requests
       SET status='approved'
       WHERE payment_id=$1`,
      [receipt]
    );

    expect(await financialPosition()).toMatchObject({
      remaining_liability:31000,
      reserved_refund:31000,
      available_for_allocation:0
    });
  });

  it("rejects any additional refund after the deposit is exhausted", async () => {
    await allocate(await addNight(1));
    await allocate(await addNight(2));
    await allocate(await addNight(3));

    await expect(db.query(
      `INSERT INTO public.cash_refund_requests (
        organization_id,payment_id,amount,status
      ) VALUES ($1,$2,1,'approved')`,
      [org,receipt]
    )).rejects.toThrow(/exceed/i);

    expect(await remaining()).toBe(0);
  });

  it("rejects increasing an approved refund above its available liability", async () => {
    await allocate(await addNight(1));

    await db.query(
      `INSERT INTO public.cash_refund_requests (
        organization_id,payment_id,amount,status
      ) VALUES ($1,$2,10000,'approved')`,
      [org,receipt]
    );

    await expect(db.query(
      `UPDATE public.cash_refund_requests
       SET amount=32000
       WHERE payment_id=$1`,
      [receipt]
    )).rejects.toThrow(/exceed/i);

    expect(await financialPosition()).toMatchObject({
      reserved_refund:10000,
      available_for_allocation:21000
    });
  });

  it("allows accommodation allocation only from unreserved liability", async () => {
    await allocate(await addNight(1));

    await db.query(
      `INSERT INTO public.cash_refund_requests (
        organization_id,payment_id,amount,status
      ) VALUES ($1,$2,20000,'approved')`,
      [org,receipt]
    );

    expect(
      (await allocate(await addNight(2))).allocated
    ).toBe(11000);

    expect(await financialPosition()).toMatchObject({
      applied:30000,
      remaining_liability:20000,
      reserved_refund:20000,
      available_for_allocation:0
    });

    expect(await position()).toEqual({
      balance:8000,payments:30000
    });
  });

  async function createRefund(
    amount: number,
    status = "approved"
  ) {
    const result = await db.query<{ id: string }>(
      `INSERT INTO public.cash_refund_requests (
        organization_id,payment_id,amount,status
      ) VALUES ($1,$2,$3,$4)
      RETURNING id`,
      [org,receipt,amount,status]
    );

    return result.rows[0]!.id;
  }

  async function validateRefund(refund: string) {
    const result = await db.query<{
      result: {
        ok: boolean;
        progressive: boolean;
        refund_amount?: number;
        remaining_liability_before?: number;
        remaining_liability_after?: number;
        debit_account?: string;
        folio_effect?: number;
      };
    }>(
      `SELECT public.neo_validate_progressive_deposit_refund($1)
       AS result`,
      [refund]
    );

    return result.rows[0]!.result;
  }

  it("validates refunds only against unused progressive liability", async () => {
    await allocate(await addNight(1));

    const refund = await createRefund(10000);

    expect(await validateRefund(refund)).toMatchObject({
      ok:true,
      progressive:true,
      refund_amount:10000,
      remaining_liability_before:31000,
      remaining_liability_after:21000,
      debit_account:"2020",
      folio_effect:0
    });

    expect(await position()).toEqual({
      balance:0,payments:19000
    });
  });

  it("requires refund approval before progressive payout", async () => {
    await allocate(await addNight(1));

    const refund = await createRefund(
      10000,"pending_approval"
    );

    await expect(validateRefund(refund)).rejects.toThrow(
      /approved/i
    );
  });

  it("rejects progressive refunds linked to the accommodation folio", async () => {
    await allocate(await addNight(1));

    const refund = await createRefund(10000);

    await db.query(
      `UPDATE public.cash_refund_requests
       SET folio_id=$2
       WHERE id=$1`,
      [refund,folio]
    );

    await expect(validateRefund(refund)).rejects.toThrow(
      /reconciliation/i
    );
  });

  it("rejects a progressive refund with mismatched property", async () => {
    await allocate(await addNight(1));

    const refund = await createRefund(10000);

    await db.query(
      `UPDATE public.cash_refund_requests
       SET branch_id=$2
       WHERE id=$1`,
      [refund,id(999)]
    );

    await expect(validateRefund(refund)).rejects.toThrow(
      /reconciliation/i
    );
  });

  it("rejects a progressive refund with mismatched currency", async () => {
    await allocate(await addNight(1));

    const refund = await createRefund(10000);

    await db.query(
      `UPDATE public.cash_refund_requests
       SET currency='USD'
       WHERE id=$1`,
      [refund]
    );

    await expect(validateRefund(refund)).rejects.toThrow(
      /reconciliation/i
    );
  });

  it("retains accommodation payments when unused deposits are refunded", async () => {
    await allocate(await addNight(1));

    const refund = await createRefund(10000);

    await validateRefund(refund);

    // Simulate a separately verified completed refund.
    // The actual payout command is tested separately.

    await db.query(
      `UPDATE public.cash_refund_requests
       SET status='settled'
       WHERE id=$1`,
      [refund]
    );

    expect(await financialPosition()).toMatchObject({
      received:50000,
      applied:19000,
      refunded:10000,
      remaining_liability:21000,
      available_for_allocation:21000
    });

    expect(await position()).toEqual({
      balance:0,payments:19000
    });

    expect(
      (await allocate(await addNight(2))).allocated
    ).toBe(19000);

    expect(
      (await allocate(await addNight(3))).allocated
    ).toBe(2000);

    expect(await position()).toEqual({
      balance:17000,payments:40000
    });

    expect(await remaining()).toBe(0);
  });

  async function connectedAccommodationCharge(
    charge: string
  ) {
    const result = await db.query<{
      result: {
        ok: boolean;
        allocated?: number;
        reason?: string;
      };
    }>(
      `SELECT public.neo_connect_accommodation_deposit($1)
       AS result`,
      [charge]
    );

    return result.rows[0]!.result;
  }

  async function removeFixtureRevenueJournal(
    charge: string
  ) {
    await db.query(
      `DELETE FROM public.journal_entry_lines
       WHERE journal_id IN (
         SELECT id
         FROM public.journal_entries
         WHERE source_document_id=$1
           AND source_document_type='folio_charge:revenue'
       )`,
      [charge]
    );

    await db.query(
      `DELETE FROM public.journal_entries
       WHERE source_document_id=$1
         AND source_document_type='folio_charge:revenue'`,
      [charge]
    );
  }

  it("connects accommodation revenue posting to deposit allocation", async () => {
    const charge = await addNight(1);

    await removeFixtureRevenueJournal(charge);

    expect(
      await connectedAccommodationCharge(charge)
    ).toMatchObject({
      ok:true,
      allocated:19000
    });

    expect(await remaining()).toBe(31000);

    expect(await position()).toEqual({
      balance:0,
      payments:19000
    });

    const journals = await db.query<{
      count: number;
    }>(
      `SELECT count(*)::integer AS count
       FROM public.journal_entries
       WHERE source_document_id=$1
         AND source_document_type='folio_charge:revenue'
         AND status='posted'`,
      [charge]
    );

    expect(journals.rows[0]!.count).toBe(1);
  });

  it("reconciles three nights through the accommodation connection", async () => {
    const first = await addNight(1);

    await removeFixtureRevenueJournal(first);

    expect(
      (await connectedAccommodationCharge(first)).allocated
    ).toBe(19000);

    expect(await remaining()).toBe(31000);

    const second = await addNight(2);

    await removeFixtureRevenueJournal(second);

    expect(
      (await connectedAccommodationCharge(second)).allocated
    ).toBe(19000);

    expect(await remaining()).toBe(12000);

    const third = await addNight(3);

    await removeFixtureRevenueJournal(third);

    expect(
      (await connectedAccommodationCharge(third)).allocated
    ).toBe(12000);

    expect(await remaining()).toBe(0);

    expect(await position()).toEqual({
      balance:7000,
      payments:50000
    });
  });

  it("prevents duplicate revenue and allocation through the connected command", async () => {
    const charge = await addNight(1);

    await removeFixtureRevenueJournal(charge);

    await connectedAccommodationCharge(charge);

    await connectedAccommodationCharge(charge);

    const journals = await db.query<{
      count: number;
    }>(
      `SELECT count(*)::integer AS count
       FROM public.journal_entries
       WHERE source_document_id=$1
         AND source_document_type='folio_charge:revenue'
         AND status='posted'`,
      [charge]
    );

    expect(journals.rows[0]!.count).toBe(1);

    expect(await remaining()).toBe(31000);

    expect(await position()).toEqual({
      balance:0,
      payments:19000
    });
  });

  it("does not release guest deposit liability when accommodation Finance posting fails", async () => {
    const charge = await addNight(1);

    await removeFixtureRevenueJournal(charge);

    await db.exec(`
      UPDATE public.test_accommodation_finance_control
      SET reject_posting=true
    `);

    try {
      await expect(
        connectedAccommodationCharge(charge)
      ).rejects.toThrow(
        /Accommodation revenue posting failed/i
      );

      expect(await remaining()).toBe(50000);

      expect(await position()).toEqual({
        balance:19000,
        payments:0
      });
    } finally {
      await db.exec(`
        UPDATE public.test_accommodation_finance_control
        SET reject_posting=false
      `);
    }
  });

  it("does not allocate unused deposits against restaurant charges", async () => {
    const charge = await addNight(1);

    await db.query(
      `UPDATE public.folio_lines
       SET category='restaurant'
       WHERE id=$1`,
      [charge]
    );

    await expect(
      connectedAccommodationCharge(charge)
    ).rejects.toThrow(
      /Valid posted accommodation charge required/i
    );

    expect(await remaining()).toBe(50000);
  });

  it("leaves zero accommodation charges without deposit allocations", async () => {
    const charge = await addNight(1,0);

    expect(
      await connectedAccommodationCharge(charge)
    ).toMatchObject({
      ok:true,
      allocated:0,
      reason:"zero_charge"
    });

    expect(await remaining()).toBe(50000);
  });


  // CANONICAL_PROGRESSIVE_GL_V1
  //
  // Install canonical journal functions in the isolated
  // progressive deposit fixture. Restore the fixture
  // definitions after each integrated acceptance test.

  async function withCanonicalFinance(
    action: () => Promise<void>
  ) {
    await db.exec("BEGIN");

    try {
      await db.exec(`
        ALTER TABLE public.journal_entries
          ADD COLUMN IF NOT EXISTS journal_number text,
          ADD COLUMN IF NOT EXISTS journal_type text,
          ADD COLUMN IF NOT EXISTS accounting_date date,
          ADD COLUMN IF NOT EXISTS period_id uuid,
          ADD COLUMN IF NOT EXISTS source_module text,
          ADD COLUMN IF NOT EXISTS idempotency_key text,
          ADD COLUMN IF NOT EXISTS description text,
          ADD COLUMN IF NOT EXISTS created_by uuid,
          ADD COLUMN IF NOT EXISTS posted_by uuid,
          ADD COLUMN IF NOT EXISTS posted_at timestamptz,
          ADD COLUMN IF NOT EXISTS created_at timestamptz
            DEFAULT now(),
          ADD COLUMN IF NOT EXISTS reverses_journal_id uuid;

        ALTER TABLE public.journal_entry_lines
          ADD COLUMN IF NOT EXISTS line_number integer,
          ADD COLUMN IF NOT EXISTS description text,
          ADD COLUMN IF NOT EXISTS customer_id uuid;

        ALTER TABLE public.chart_of_accounts
          ADD COLUMN IF NOT EXISTS active boolean
            DEFAULT true,
          ADD COLUMN IF NOT EXISTS postable boolean
            DEFAULT true,
          ADD COLUMN IF NOT EXISTS is_header boolean
            DEFAULT false;

        CREATE TABLE IF NOT EXISTS public.accounting_periods (
          id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
          organization_id uuid NOT NULL,
          name text NOT NULL,
          status text NOT NULL
        );

        INSERT INTO public.accounting_periods (
          organization_id,name,status
        )
        VALUES (
          public.current_org_id(),
          'Integrated test period',
          'open'
        );

        CREATE OR REPLACE FUNCTION
        public.neo_system_posting()
        RETURNS boolean LANGUAGE sql STABLE AS $$
          SELECT coalesce(
            current_setting('neo.system_posting',true),
            'off'
          )='on'
        $$;

        CREATE OR REPLACE FUNCTION
        public.current_access_scope()
        RETURNS text LANGUAGE sql STABLE AS $$
          SELECT 'branch'::text
        $$;

        CREATE OR REPLACE FUNCTION
        public.has_permission(text,text)
        RETURNS boolean LANGUAGE sql STABLE AS $$
          SELECT false
        $$;

        CREATE OR REPLACE FUNCTION
        public.is_org_admin()
        RETURNS boolean LANGUAGE sql STABLE AS $$
          SELECT false
        $$;

        CREATE OR REPLACE FUNCTION
        public.neo_gl_acct(uuid,text)
        RETURNS uuid LANGUAGE sql STABLE AS $$
          SELECT id
          FROM public.chart_of_accounts
          WHERE organization_id=$1
            AND code=$2
            AND active
            AND postable
            AND NOT is_header
        $$;

        CREATE OR REPLACE FUNCTION
        public.neo_gl_period(uuid,date)
        RETURNS uuid LANGUAGE sql STABLE AS $$
          SELECT id
          FROM public.accounting_periods
          WHERE organization_id=$1
          LIMIT 1
        $$;

        CREATE OR REPLACE FUNCTION
        public.fin_period_for(uuid,date)
        RETURNS SETOF public.accounting_periods
        LANGUAGE sql STABLE AS $$
          SELECT *
          FROM public.accounting_periods
          WHERE organization_id=$1
          LIMIT 1
        $$;

        CREATE OR REPLACE FUNCTION
        public.next_document_number(text,text,uuid)
        RETURNS text LANGUAGE sql AS $$
          SELECT 'JV-'||gen_random_uuid()::text
        $$;
      `);

      // Replacing the fixture function can require
      // different parameter names. Keep this inside
      // the rollback-protected isolated transaction.

      await db.exec(`
        DROP FUNCTION public.neo_gl_post(
          uuid,uuid,text,text,uuid,text,date,text,
          text,jsonb,uuid,uuid
        );
      `);

      const canonical = Buffer.from(
        "Q1JFQVRFIE9SIFJFUExBQ0UgRlVOQ1RJT04gcHVibGljLmZpbl9wb3N0X2pvdXJuYWwoX2pvdXJuYWwgdXVpZCkKIFJFVFVSTlMganNvbmIKIExBTkdVQUdFIHBscGdzcWwKIFNFQ1VSSVRZIERFRklORVIKIFNFVCBzZWFyY2hfcGF0aCBUTyAncHVibGljJwpBUyAkZnVuY3Rpb24kCkRFQ0xBUkUgaiBwdWJsaWMuam91cm5hbF9lbnRyaWVzOyBwIHB1YmxpYy5hY2NvdW50aW5nX3BlcmlvZHM7IGQgbnVtZXJpYzsgYyBudW1lcmljOyBiYWQgaW50OwpCRUdJTgogIFNFTEVDVCAqIElOVE8gaiBGUk9NIHB1YmxpYy5qb3VybmFsX2VudHJpZXMgV0hFUkUgaWQgPSBfam91cm5hbAogICAgICBBTkQgb3JnYW5pemF0aW9uX2lkID0gcHVibGljLmN1cnJlbnRfb3JnX2lkKCkKICAgICAgRk9SIFVQREFURTsKICBJRiBqLmlkIElTIE5VTEwgVEhFTiBSQUlTRSBFWENFUFRJT04gJ0pvdXJuYWwgbm90IGZvdW5kJzsgRU5EIElGOwogIElGIGoub3JnYW5pemF0aW9uX2lkIDw+IGN1cnJlbnRfb3JnX2lkKCkgVEhFTiBSQUlTRSBFWENFUFRJT04gJ05vdCBwZXJtaXR0ZWQnOyBFTkQgSUY7CiAgSUYgTk9UIChwdWJsaWMubmVvX3N5c3RlbV9wb3N0aW5nKCkgT1IgaGFzX3Blcm1pc3Npb24oJ2ZpbmFuY2UnLCdhcHByb3ZlJykgT1IgaXNfb3JnX2FkbWluKCkpIFRIRU4KICAgIFJBSVNFIEVYQ0VQVElPTiAnWW91IGRvIG5vdCBoYXZlIHBlcm1pc3Npb24gdG8gcG9zdCBqb3VybmFscyc7CiAgRU5EIElGOwogIElGIHB1YmxpYy5uZW9fYnJhbmNoX2luX3Njb3BlKGouYnJhbmNoX2lkKQogICAgICAgSVMgTk9UIFRSVUUgVEhFTgogICAgICAgIFJBSVNFIEVYQ0VQVElPTiAnSm91cm5hbCBvdXRzaWRlIGF1dGhvcmlzZWQgcHJvcGVydHkgc2NvcGUnCiAgICAgICAgICBVU0lORyBFUlJDT0RFID0gJzQyNTAxJzsKICAgIEVORCBJRjsKCiAgICBJRiBwdWJsaWMubmVvX3N5c3RlbV9wb3N0aW5nKCkgSVMgTk9UIFRSVUUKICAgICAgIEFORCBqLmJyYW5jaF9pZCBJUyBOVUxMCiAgICAgICBBTkQgKHB1YmxpYy5jdXJyZW50X2FjY2Vzc19zY29wZSgpIElOICgnb3JnYW5pc2F0aW9uJywndGVjaG5pY2FsJykpIElTIE5PVCBUUlVFIFRIRU4KICAgICAgICBSQUlTRSBFWENFUFRJT04gJ09yZ2FuaXNhdGlvbi13aWRlIGpvdXJuYWwgcmVxdWlyZXMgb3JnYW5pc2F0aW9uIHNjb3BlJwogICAgICAgICAgVVNJTkcgRVJSQ09ERSA9ICc0MjUwMSc7CiAgICBFTkQgSUY7CgogICAgSUYgRVhJU1RTICgKICAgICAgICBTRUxFQ1QgMQogICAgICAgIEZST00gcHVibGljLmpvdXJuYWxfZW50cnlfbGluZXMgbAogICAgICAgIExFRlQgSk9JTiBwdWJsaWMuY2hhcnRfb2ZfYWNjb3VudHMgYQogICAgICAgICAgT04gYS5pZCA9IGwuYWNjb3VudF9pZAogICAgICAgIFdIRVJFIGwuam91cm5hbF9pZCA9IGouaWQKICAgICAgICAgIEFORCBhLm9yZ2FuaXphdGlvbl9pZCBJUyBESVNUSU5DVCBGUk9NIGoub3JnYW5pemF0aW9uX2lkCiAgICApIFRIRU4KICAgICAgICBSQUlTRSBFWENFUFRJT04gJ0pvdXJuYWwgYWNjb3VudCBiZWxvbmdzIHRvIGFub3RoZXIgb3JnYW5pc2F0aW9uJwogICAgICAgICAgVVNJTkcgRVJSQ09ERSA9ICc0MjUwMSc7CiAgICBFTkQgSUY7CgogICAgSUYgRVhJU1RTICgKICAgICAgICBTRUxFQ1QgMQogICAgICAgIEZST00gcHVibGljLmpvdXJuYWxfZW50cnlfbGluZXMgbAogICAgICAgIFdIRVJFIGwuam91cm5hbF9pZCA9IGouaWQKICAgICAgICAgIEFORCAoCiAgICAgICAgICAgIGwub3JnYW5pemF0aW9uX2lkIElTIERJU1RJTkNUIEZST00gai5vcmdhbml6YXRpb25faWQKICAgICAgICAgICAgT1IgcHVibGljLm5lb19icmFuY2hfaW5fc2NvcGUoCiAgICAgICAgICAgICAgICBDT0FMRVNDRShsLmJyYW5jaF9pZCwgai5icmFuY2hfaWQpCiAgICAgICAgICAgICkgSVMgTk9UIFRSVUUKICAgICAgICAgICkKICAgICkgVEhFTgogICAgICAgIFJBSVNFIEVYQ0VQVElPTiAnSm91cm5hbCBsaW5lcyBvdXRzaWRlIGF1dGhvcmlzZWQgc2NvcGUnCiAgICAgICAgICBVU0lORyBFUlJDT0RFID0gJzQyNTAxJzsKICAgIEVORCBJRjsKCiAgICBJRiBqLnN0YXR1cyA9ICdwb3N0ZWQnIFRIRU4gUkVUVVJOIGpzb25iX2J1aWxkX29iamVjdCgnb2snLCB0cnVlLCAnYWxyZWFkeV9wb3N0ZWQnLCB0cnVlLCAnam91cm5hbF9pZCcsIGouaWQpOyBFTkQgSUY7CiAgSUYgai5zdGF0dXMgTk9UIElOICgnZHJhZnQnLCdhcHByb3ZlZCcpIFRIRU4gUkFJU0UgRVhDRVBUSU9OICdKb3VybmFsIGNhbm5vdCBiZSBwb3N0ZWQgZnJvbSBzdGF0dXMgJScsIGouc3RhdHVzOyBFTkQgSUY7CgogIFNFTEVDVCBDT0FMRVNDRShzdW0oZGViaXQpLDApLCBDT0FMRVNDRShzdW0oY3JlZGl0KSwwKSBJTlRPIGQsIGMKICAgIEZST00gcHVibGljLmpvdXJuYWxfZW50cnlfbGluZXMgV0hFUkUgam91cm5hbF9pZCA9IGouaWQ7CiAgSUYgZCA9IDAgQU5EIGMgPSAwIFRIRU4gUkFJU0UgRVhDRVBUSU9OICdKb3VybmFsIGhhcyBubyBsaW5lcyc7IEVORCBJRjsKICBJRiBkIDw+IGMgVEhFTiBSQUlTRSBFWENFUFRJT04gJ0pvdXJuYWwgaXMgbm90IGJhbGFuY2VkIChkZWJpdCAlIHZzIGNyZWRpdCAlKScsIGQsIGM7IEVORCBJRjsKCiAgU0VMRUNUIGNvdW50KCopIElOVE8gYmFkIEZST00gcHVibGljLmpvdXJuYWxfZW50cnlfbGluZXMgbAogICAgSk9JTiBwdWJsaWMuY2hhcnRfb2ZfYWNjb3VudHMgYSBPTiBhLmlkID0gbC5hY2NvdW50X2lkCiAgICBXSEVSRSBsLmpvdXJuYWxfaWQgPSBqLmlkIEFORCAoYS5hY3RpdmUgPSBmYWxzZSBPUiBhLnBvc3RhYmxlID0gZmFsc2UgT1IgYS5pc19oZWFkZXIgPSB0cnVlKTsKICBJRiBiYWQgPiAwIFRIRU4gUkFJU0UgRVhDRVBUSU9OICdKb3VybmFsIHJlZmVyZW5jZXMgaW5hY3RpdmUgb3Igbm9uLXBvc3RhYmxlIGFjY291bnRzJzsgRU5EIElGOwoKICBTRUxFQ1QgKiBJTlRPIHAgRlJPTSBwdWJsaWMuZmluX3BlcmlvZF9mb3Ioai5vcmdhbml6YXRpb25faWQsIGouYWNjb3VudGluZ19kYXRlKTsKICBJRiBwLmlkIElTIE5VTEwgVEhFTiBSQUlTRSBFWENFUFRJT04gJ05vIGFjY291bnRpbmcgcGVyaW9kIGNvdmVycyAlJywgai5hY2NvdW50aW5nX2RhdGU7IEVORCBJRjsKICBJRiBwLnN0YXR1cyBOT1QgSU4gKCdvcGVuJykgQU5EIE5PVCAocC5zdGF0dXMgPSAnc29mdF9jbG9zZWQnIEFORCBqLmpvdXJuYWxfdHlwZSA9ICdhZGp1c3RtZW50JykgVEhFTgogICAgUkFJU0UgRVhDRVBUSU9OICdBY2NvdW50aW5nIHBlcmlvZCAlIGlzICUnLCBwLm5hbWUsIHAuc3RhdHVzOwogIEVORCBJRjsKCiAgSUYgai5qb3VybmFsX3R5cGUgPD4gJ3JldmVyc2FsJyBBTkQgai5zb3VyY2VfZG9jdW1lbnRfaWQgSVMgTk9UIE5VTEwgQU5EIEVYSVNUUyAoCiAgICAgIFNFTEVDVCAxIEZST00gcHVibGljLmpvdXJuYWxfZW50cmllcyB4CiAgICAgIFdIRVJFIHgub3JnYW5pemF0aW9uX2lkID0gai5vcmdhbml6YXRpb25faWQgQU5EIHguaWQgPD4gai5pZAogICAgICAgIEFORCB4LnNvdXJjZV9kb2N1bWVudF90eXBlID0gai5zb3VyY2VfZG9jdW1lbnRfdHlwZQogICAgICAgIEFORCB4LnNvdXJjZV9kb2N1bWVudF9pZCA9IGouc291cmNlX2RvY3VtZW50X2lkCiAgICAgICAgQU5EIHguc3RhdHVzID0gJ3Bvc3RlZCcgQU5EIHguam91cm5hbF90eXBlIDw+ICdyZXZlcnNhbCcKICAgICAgICBBTkQgeC5yZXZlcnNlZF9ieV9qb3VybmFsX2lkIElTIE5VTEwpIFRIRU4KICAgIFJBSVNFIEVYQ0VQVElPTiAnVGhpcyBzb3VyY2UgZG9jdW1lbnQgaGFzIGFscmVhZHkgYmVlbiBwb3N0ZWQnOwogIEVORCBJRjsKCiAgVVBEQVRFIHB1YmxpYy5qb3VybmFsX2VudHJpZXMKICAgIFNFVCBzdGF0dXM9J3Bvc3RlZCcsIHRvdGFsX2RlYml0PWQsIHRvdGFsX2NyZWRpdD1jLCBwZXJpb2RfaWQ9cC5pZCwKICAgICAgICBwb3N0ZWRfYnk9YXV0aC51aWQoKSwgcG9zdGVkX2F0PW5vdygpCiAgICBXSEVSRSBpZCA9IGouaWQ7CgogIFJFVFVSTiBqc29uYl9idWlsZF9vYmplY3QoJ29rJywgdHJ1ZSwgJ2pvdXJuYWxfaWQnLCBqLmlkLCAndG90YWwnLCBkLCAncGVyaW9kJywgcC5uYW1lKTsKRU5EICRmdW5jdGlvbiQ7CkNSRUFURSBPUiBSRVBMQUNFIEZVTkNUSU9OIHB1YmxpYy5uZW9fZ2xfcG9zdChfb3JnIHV1aWQsIF9icmFuY2ggdXVpZCwgX21vZHVsZSB0ZXh0LCBfc291cmNlX3R5cGUgdGV4dCwgX3NvdXJjZV9pZCB1dWlkLCBfcG9zdGluZ190eXBlIHRleHQsIF9kYXRlIGRhdGUsIF9jdXJyZW5jeSB0ZXh0LCBfZGVzYyB0ZXh0LCBfbGluZXMganNvbmIsIF9jdXN0b21lciB1dWlkIERFRkFVTFQgTlVMTDo6dXVpZCwgX3JldmVyc2VzIHV1aWQgREVGQVVMVCBOVUxMOjp1dWlkKQogUkVUVVJOUyBqc29uYgogTEFOR1VBR0UgcGxwZ3NxbAogU0VDVVJJVFkgREVGSU5FUgogU0VUIHNlYXJjaF9wYXRoIFRPICdwdWJsaWMnCkFTICRmdW5jdGlvbiQKREVDTEFSRSBrZXkgdGV4dCA6PSBfc291cmNlX3R5cGUgfHwgJzonIHx8IF9zb3VyY2VfaWQ6OnRleHQgfHwgJzonIHx8IF9wb3N0aW5nX3R5cGU7CiAgICAgICAgaiB1dWlkOyBsbiBqc29uYjsgaSBpbnQgOj0gMDsgdGQgbnVtZXJpYyA6PSAwOyB0YyBudW1lcmljIDo9IDA7IGFjY3QgdXVpZDsKICAgICAgICBkIG51bWVyaWM7IGMgbnVtZXJpYzsgcHJpb3IgdGV4dDsgZXhpc3RpbmcgcHVibGljLmpvdXJuYWxfZW50cmllczsKQkVHSU4KICAgIElGIHB1YmxpYy5jdXJyZW50X29yZ19pZCgpIElTIERJU1RJTkNUIEZST00gX29yZyBPUiBOT1QgY29hbGVzY2UocHVibGljLm5lb19icmFuY2hfaW5fc2NvcGUoX2JyYW5jaCksZmFsc2UpIFRIRU4KICAgICAgUkFJU0UgRVhDRVBUSU9OICdQb3N0aW5nIGlzIG91dHNpZGUgdGhlIGN1cnJlbnQgb3JnYW5pemF0aW9uIG9yIHByb3BlcnR5IHNjb3BlJyBVU0lORyBFUlJDT0RFPSc0MjUwMSc7CiAgICBFTkQgSUY7CiAgICBJRiBfc291cmNlX2lkIElTIE5VTEwgT1IgbnVsbGlmKGJ0cmltKF9zb3VyY2VfdHlwZSksJycpIElTIE5VTEwgT1IgbnVsbGlmKGJ0cmltKF9wb3N0aW5nX3R5cGUpLCcnKSBJUyBOVUxMIFRIRU4KICAgICAgUkFJU0UgRVhDRVBUSU9OICdQb3N0aW5nIHNvdXJjZSBhbmQgdHlwZSBhcmUgcmVxdWlyZWQnIFVTSU5HIEVSUkNPREU9JzIyMDIzJzsKICAgIEVORCBJRjsKICAgIElGIF9saW5lcyBJUyBOVUxMIE9SIGpzb25iX3R5cGVvZihfbGluZXMpPD4nYXJyYXknIFRIRU4gUkFJU0UgRVhDRVBUSU9OICdQb3N0aW5nIGxpbmVzIG11c3QgYmUgYW4gYXJyYXknOyBFTkQgSUY7CiAgICBJRiBqc29uYl9hcnJheV9sZW5ndGgoX2xpbmVzKT0wIFRIRU4gUkFJU0UgRVhDRVBUSU9OICdub3RoaW5nX3RvX3Bvc3QnOyBFTkQgSUY7CiAgICBGT1IgbG4gSU4gU0VMRUNUICogRlJPTSBqc29uYl9hcnJheV9lbGVtZW50cyhfbGluZXMpIExPT1AKICAgICAgZDo9Y29hbGVzY2UoKGxuLT4+J2RlYml0Jyk6Om51bWVyaWMsMCk7Yzo9Y29hbGVzY2UoKGxuLT4+J2NyZWRpdCcpOjpudW1lcmljLDApOwogICAgICBJRiBkPDAgT1IgYzwwIE9SIGQ6OnRleHQgSU4gKCdOYU4nLCdJbmZpbml0eScsJy1JbmZpbml0eScpIE9SIGM6OnRleHQgSU4gKCdOYU4nLCdJbmZpbml0eScsJy1JbmZpbml0eScpIE9SIChkPjAgQU5EIGM+MCkgVEhFTgogICAgICAgIFJBSVNFIEVYQ0VQVElPTiAnUG9zdGluZyBhbW91bnRzIG11c3QgYmUgZmluaXRlIG5vbm5lZ2F0aXZlIGFuZCBvbmUtc2lkZWQnIFVTSU5HIEVSUkNPREU9JzIyMDIzJzsKICAgICAgRU5EIElGOwogICAgRU5EIExPT1A7CiAgICBQRVJGT1JNIHBnX2Fkdmlzb3J5X3hhY3RfbG9jayhoYXNodGV4dGV4dGVuZGVkKCdnbDonfHxfb3JnOjp0ZXh0fHwnOid8fGtleSwwKSk7CiAgU0VMRUNUIGlkIElOVE8gaiBGUk9NIHB1YmxpYy5qb3VybmFsX2VudHJpZXMKICAgV0hFUkUgb3JnYW5pemF0aW9uX2lkID0gX29yZwogICAgIEFORCAoaWRlbXBvdGVuY3lfa2V5ID0ga2V5IE9SIGxlZnQoaWRlbXBvdGVuY3lfa2V5LGxlbmd0aChrZXl8fCc6Y29ycmVjdGlvbjonKSk9a2V5fHwnOmNvcnJlY3Rpb246JykKICAgICBBTkQgcmV2ZXJzZWRfYnlfam91cm5hbF9pZCBJUyBOVUxMCiAgIE9SREVSIEJZIGNyZWF0ZWRfYXQgREVTQyBMSU1JVCAxOwogIElGIGogSVMgTk9UIE5VTEwgVEhFTgogICAgICBTRUxFQ1QgKiBJTlRPIGV4aXN0aW5nIEZST00gcHVibGljLmpvdXJuYWxfZW50cmllcyBXSEVSRSBpZD1qIEZPUiBVUERBVEU7CiAgICAgIElGIGV4aXN0aW5nLmJyYW5jaF9pZCBJUyBESVNUSU5DVCBGUk9NIF9icmFuY2ggT1IgZXhpc3RpbmcuY3VycmVuY3kgSVMgRElTVElOQ1QgRlJPTSBjb2FsZXNjZShfY3VycmVuY3ksJ0tFUycpCiAgICAgICAgIE9SIGV4aXN0aW5nLmFjY291bnRpbmdfZGF0ZSBJUyBESVNUSU5DVCBGUk9NIF9kYXRlCiAgICAgICAgIE9SIGV4aXN0aW5nLnNvdXJjZV9kb2N1bWVudF9pZCBJUyBESVNUSU5DVCBGUk9NIF9zb3VyY2VfaWQgT1IgZXhpc3Rpbmcuc291cmNlX2RvY3VtZW50X3R5cGUgSVMgRElTVElOQ1QgRlJPTSBfc291cmNlX3R5cGV8fCc6J3x8X3Bvc3RpbmdfdHlwZSBUSEVOCiAgICAgICAgUkFJU0UgRVhDRVBUSU9OICdFeGlzdGluZyBqb3VybmFsIHNvdXJjZSwgcHJvcGVydHkgb3IgY3VycmVuY3kgZGlmZmVycyc7CiAgICAgIEVORCBJRjsKICAgICAgSUYgZXhpc3Rpbmcuc3RhdHVzIElTIE5VTEwgT1IgZXhpc3Rpbmcuc3RhdHVzIE5PVCBJTiAoJ3Bvc3RlZCcsJ2RyYWZ0JywnYXBwcm92ZWQnKSBUSEVOIFJBSVNFIEVYQ0VQVElPTiAnRXhpc3Rpbmcgam91cm5hbCBjYW5ub3QgYmUgcmV1c2VkIGZyb20gc3RhdHVzICUnLGV4aXN0aW5nLnN0YXR1czsgRU5EIElGOwogICAgICBTRUxFQ1QgY29hbGVzY2Uoc3VtKGRlYml0KSwwKSxjb2FsZXNjZShzdW0oY3JlZGl0KSwwKSBJTlRPIHRkLHRjIEZST00gcHVibGljLmpvdXJuYWxfZW50cnlfbGluZXMgV0hFUkUgam91cm5hbF9pZD1qOwogICAgICBJRiB0ZDw9MCBPUiB0ZDw+dGMgT1IgdGQ6OnRleHQgSU4gKCdOYU4nLCdJbmZpbml0eScsJy1JbmZpbml0eScpIE9SIHRjOjp0ZXh0IElOICgnTmFOJywnSW5maW5pdHknLCctSW5maW5pdHknKQogICAgICAgICBPUiBFWElTVFMoU0VMRUNUIDEgRlJPTSBwdWJsaWMuam91cm5hbF9lbnRyeV9saW5lcyBsIExFRlQgSk9JTiBwdWJsaWMuY2hhcnRfb2ZfYWNjb3VudHMgYSBPTiBhLmlkPWwuYWNjb3VudF9pZAogICAgICAgICAgICAgV0hFUkUgbC5qb3VybmFsX2lkPWogQU5EIChsLm9yZ2FuaXphdGlvbl9pZCBJUyBESVNUSU5DVCBGUk9NIF9vcmcgT1IgYS5vcmdhbml6YXRpb25faWQgSVMgRElTVElOQ1QgRlJPTSBfb3JnCiAgICAgICAgICAgICAgIE9SIGwuZGViaXQgSVMgTlVMTCBPUiBsLmNyZWRpdCBJUyBOVUxMIE9SIGwuZGViaXQ8MCBPUiBsLmNyZWRpdDwwIE9SIChsLmRlYml0PjAgQU5EIGwuY3JlZGl0PjApKSkgVEhFTgogICAgICAgIFJBSVNFIEVYQ0VQVElPTiAnRXhpc3Rpbmcgam91cm5hbCBoYXMgaW52YWxpZCBvciB1bmJhbGFuY2VkIGxpbmVzJzsKICAgICAgRU5EIElGOwogICAgICBJRiBleGlzdGluZy5zdGF0dXM9J3Bvc3RlZCcgVEhFTgogICAgICAgIElGIGV4aXN0aW5nLnRvdGFsX2RlYml0IElTIERJU1RJTkNUIEZST00gdGQgT1IgZXhpc3RpbmcudG90YWxfY3JlZGl0IElTIERJU1RJTkNUIEZST00gdGMgVEhFTiBSQUlTRSBFWENFUFRJT04gJ1Bvc3RlZCBqb3VybmFsIHRvdGFscyBkaXNhZ3JlZSB3aXRoIGl0cyBsaW5lcyc7IEVORCBJRjsKICAgICAgRUxTRQogICAgICAgIElGIEVYSVNUUyhXSVRIIHdhbnRlZCBBUyAoCiAgICAgICAgICBTRUxFQ1QgcmVxdWVzdGVkLnZhbHVlLT4+J2NvZGUnIEFTIGNvZGUsc3VtKHJvdW5kKGNvYWxlc2NlKChyZXF1ZXN0ZWQudmFsdWUtPj4nZGViaXQnKTo6bnVtZXJpYywwKSwyKSkgQVMgZCxzdW0ocm91bmQoY29hbGVzY2UoKHJlcXVlc3RlZC52YWx1ZS0+PidjcmVkaXQnKTo6bnVtZXJpYywwKSwyKSkgQVMgYwogICAgICAgICAgRlJPTSBqc29uYl9hcnJheV9lbGVtZW50cyhfbGluZXMpIEFTIHJlcXVlc3RlZCh2YWx1ZSkgR1JPVVAgQlkgMQogICAgICAgICksIGFjdHVhbCBBUyAoCiAgICAgICAgICBTRUxFQ1QgYS5jb2RlLHN1bShsLmRlYml0KSBBUyBkLHN1bShsLmNyZWRpdCkgQVMgYyBGUk9NIHB1YmxpYy5qb3VybmFsX2VudHJ5X2xpbmVzIGwgSk9JTiBwdWJsaWMuY2hhcnRfb2ZfYWNjb3VudHMgYSBPTiBhLmlkPWwuYWNjb3VudF9pZAogICAgICAgICAgV0hFUkUgbC5qb3VybmFsX2lkPWogR1JPVVAgQlkgYS5jb2RlCiAgICAgICAgKSBTRUxFQ1QgMSBGUk9NIHdhbnRlZCB3IEZVTEwgSk9JTiBhY3R1YWwgYSBPTiBhLmNvZGU9dy5jb2RlCiAgICAgICAgICBXSEVSRSBjb2FsZXNjZSh3LmQsMCk8PmNvYWxlc2NlKGEuZCwwKSBPUiBjb2FsZXNjZSh3LmMsMCk8PmNvYWxlc2NlKGEuYywwKSkgVEhFTgogICAgICAgICAgUkFJU0UgRVhDRVBUSU9OICdFeGlzdGluZyBkcmFmdCBsaW5lcyBkaWZmZXIgZnJvbSB0aGUgcmVxdWVzdGVkIHBvc3RpbmcnOwogICAgICAgIEVORCBJRjsKICAgICAgICBwcmlvcjo9Y29hbGVzY2UoY3VycmVudF9zZXR0aW5nKCduZW8uc3lzdGVtX3Bvc3RpbmcnLHRydWUpLCdvZmYnKTsKICAgICAgICBCRUdJTgogICAgICAgICAgUEVSRk9STSBzZXRfY29uZmlnKCduZW8uc3lzdGVtX3Bvc3RpbmcnLCdvbicsdHJ1ZSk7CiAgICAgICAgICBQRVJGT1JNIHB1YmxpYy5maW5fcG9zdF9qb3VybmFsKGopOwogICAgICAgICAgUEVSRk9STSBzZXRfY29uZmlnKCduZW8uc3lzdGVtX3Bvc3RpbmcnLHByaW9yLHRydWUpOwogICAgICAgIEVYQ0VQVElPTiBXSEVOIE9USEVSUyBUSEVOCiAgICAgICAgICBQRVJGT1JNIHNldF9jb25maWcoJ25lby5zeXN0ZW1fcG9zdGluZycscHJpb3IsdHJ1ZSk7UkFJU0U7CiAgICAgICAgRU5EOwogICAgICAgIElGIE5PVCBFWElTVFMoU0VMRUNUIDEgRlJPTSBwdWJsaWMuam91cm5hbF9lbnRyaWVzIFdIRVJFIGlkPWogQU5EIHN0YXR1cz0ncG9zdGVkJykgVEhFTiBSQUlTRSBFWENFUFRJT04gJ0V4aXN0aW5nIGpvdXJuYWwgZGlkIG5vdCByZWFjaCBwb3N0ZWQgc3RhdHVzJzsgRU5EIElGOwogICAgICBFTkQgSUY7CiAgICBSRVRVUk4ganNvbmJfYnVpbGRfb2JqZWN0KCdvaycsIHRydWUsICdqb3VybmFsX2lkJywgaiwgJ2R1cGxpY2F0ZV9wcmV2ZW50ZWQnLCB0cnVlKTsKICBFTkQgSUY7CiAgSUYgRVhJU1RTIChTRUxFQ1QgMSBGUk9NIHB1YmxpYy5qb3VybmFsX2VudHJpZXMKICAgICAgICAgICAgIFdIRVJFIG9yZ2FuaXphdGlvbl9pZCA9IF9vcmcgQU5EIGlkZW1wb3RlbmN5X2tleSA9IGtleQogICAgICAgICAgICAgICBBTkQgcmV2ZXJzZWRfYnlfam91cm5hbF9pZCBJUyBOT1QgTlVMTCkgVEhFTgogICAga2V5IDo9IGtleSB8fCAnOmNvcnJlY3Rpb246JyB8fCAoMSArIChTRUxFQ1QgY291bnQoKikgRlJPTSBwdWJsaWMuam91cm5hbF9lbnRyaWVzCiAgICAgIFdIRVJFIG9yZ2FuaXphdGlvbl9pZCA9IF9vcmcgQU5EIGxlZnQoaWRlbXBvdGVuY3lfa2V5LGxlbmd0aChrZXl8fCc6Y29ycmVjdGlvbjonKSk9a2V5fHwnOmNvcnJlY3Rpb246JykpOjp0ZXh0OwogIEVORCBJRjsKCiAgSU5TRVJUIElOVE8gcHVibGljLmpvdXJuYWxfZW50cmllcwogICAgKG9yZ2FuaXphdGlvbl9pZCwgYnJhbmNoX2lkLCBqb3VybmFsX251bWJlciwgam91cm5hbF90eXBlLCBhY2NvdW50aW5nX2RhdGUsCiAgICAgcGVyaW9kX2lkLCBzb3VyY2VfbW9kdWxlLCBzb3VyY2VfZG9jdW1lbnRfdHlwZSwgc291cmNlX2RvY3VtZW50X2lkLAogICAgIGlkZW1wb3RlbmN5X2tleSwgZGVzY3JpcHRpb24sIGN1cnJlbmN5LCBzdGF0dXMsIGNyZWF0ZWRfYnksIHJldmVyc2VzX2pvdXJuYWxfaWQpCiAgVkFMVUVTIChfb3JnLCBfYnJhbmNoLCBwdWJsaWMubmV4dF9kb2N1bWVudF9udW1iZXIoJ2pvdXJuYWwnLCdKVicsX2JyYW5jaCksCiAgICAgICAgICBDQVNFIFdIRU4gX3JldmVyc2VzIElTIE5VTEwgVEhFTiAnYXV0b21hdGljJyBFTFNFICdyZXZlcnNhbCcgRU5ELCBfZGF0ZSwKICAgICAgICAgIHB1YmxpYy5uZW9fZ2xfcGVyaW9kKF9vcmcsIF9kYXRlKSwgX21vZHVsZSwKICAgICAgICAgIF9zb3VyY2VfdHlwZSB8fCAnOicgfHwgX3Bvc3RpbmdfdHlwZSwgX3NvdXJjZV9pZCwga2V5LCBfZGVzYywKICAgICAgICAgIGNvYWxlc2NlKF9jdXJyZW5jeSwnS0VTJyksICdkcmFmdCcsIGF1dGgudWlkKCksIF9yZXZlcnNlcykKICBSRVRVUk5JTkcgaWQgSU5UTyBqOwoKICBGT1IgbG4gSU4gU0VMRUNUICogRlJPTSBqc29uYl9hcnJheV9lbGVtZW50cyhfbGluZXMpIExPT1AKICAgIGQgOj0gcm91bmQoY29hbGVzY2UoKGxuLT4+J2RlYml0Jyk6Om51bWVyaWMsIDApLCAyKTsKICAgIGMgOj0gcm91bmQoY29hbGVzY2UoKGxuLT4+J2NyZWRpdCcpOjpudW1lcmljLCAwKSwgMik7CiAgICBDT05USU5VRSBXSEVOIGQgPSAwIEFORCBjID0gMDsKICAgIGFjY3QgOj0gcHVibGljLm5lb19nbF9hY2N0KF9vcmcsIGxuLT4+J2NvZGUnKTsKICAgIElGIGFjY3QgSVMgTlVMTCBUSEVOCiAgICAgIFJBSVNFIEVYQ0VQVElPTiAnY2hhcnRfb2ZfYWNjb3VudHMgaXMgbWlzc2luZyBwb3N0YWJsZSBhY2NvdW50ICUnLCBsbi0+Pidjb2RlJzsKICAgIEVORCBJRjsKICAgIGkgOj0gaSArIDE7CiAgICBJTlNFUlQgSU5UTyBwdWJsaWMuam91cm5hbF9lbnRyeV9saW5lcwogICAgICAob3JnYW5pemF0aW9uX2lkLCBqb3VybmFsX2lkLCBsaW5lX251bWJlciwgYWNjb3VudF9pZCwgZGVzY3JpcHRpb24sIGRlYml0LCBjcmVkaXQsCiAgICAgICBicmFuY2hfaWQsIGN1c3RvbWVyX2lkKQogICAgVkFMVUVTIChfb3JnLCBqLCBpLCBhY2N0LCBjb2FsZXNjZShsbi0+PidkZXNjcmlwdGlvbicsIF9kZXNjKSwgZCwgYywgX2JyYW5jaCwgX2N1c3RvbWVyKTsKICAgIHRkIDo9IHRkICsgZDsgdGMgOj0gdGMgKyBjOwogIEVORCBMT09QOwoKICBJRiBpID0gMCBUSEVOIFJBSVNFIEVYQ0VQVElPTiAnbm90aGluZ190b19wb3N0JzsgRU5EIElGOwogIElGIHJvdW5kKHRkLDIpIDw+IHJvdW5kKHRjLDIpIFRIRU4KICAgIFJBSVNFIEVYQ0VQVElPTiAnSm91cm5hbCBkb2VzIG5vdCBiYWxhbmNlOiBkZWJpdHMgJSB2cyBjcmVkaXRzICUnLCB0ZCwgdGM7CiAgRU5EIElGOwoKICBVUERBVEUgcHVibGljLmpvdXJuYWxfZW50cmllcwogICAgIFNFVCB0b3RhbF9kZWJpdCA9IHJvdW5kKHRkLDIpLCB0b3RhbF9jcmVkaXQgPSByb3VuZCh0YywyKQogICBXSEVSRSBpZCA9IGo7CgogIC0tIEF1dG9tYXRpYyBtb2R1bGUgcG9zdGluZ3MgYXJlIHN5c3RlbSBwb3N0aW5nczogdGhlIG9wZXJhdGlvbmFsIGF1dGhvcml0eSB3YXMKICAtLSBhbHJlYWR5IHZlcmlmaWVkIHVwc3RyZWFtLCBzbyB0aGUgY2FsbGVyIGRvZXMgbm90IG5lZWQgbWFudWFsIGpvdXJuYWwgcmlnaHRzLgogIHByaW9yIDo9IGNvYWxlc2NlKGN1cnJlbnRfc2V0dGluZygnbmVvLnN5c3RlbV9wb3N0aW5nJywgdHJ1ZSksICdvZmYnKTsKICBQRVJGT1JNIHNldF9jb25maWcoJ25lby5zeXN0ZW1fcG9zdGluZycsICdvbicsIHRydWUpOwogIFBFUkZPUk0gcHVibGljLmZpbl9wb3N0X2pvdXJuYWwoaik7CiAgUEVSRk9STSBzZXRfY29uZmlnKCduZW8uc3lzdGVtX3Bvc3RpbmcnLCBwcmlvciwgdHJ1ZSk7CiAgUkVUVVJOIGpzb25iX2J1aWxkX29iamVjdCgnb2snLCB0cnVlLCAnam91cm5hbF9pZCcsIGosICdkdXBsaWNhdGVfcHJldmVudGVkJywgZmFsc2UpOwpFTkQ7CiRmdW5jdGlvbiQ7Cg==",
        "base64"
      ).toString("utf8");

      await db.exec(canonical);

      const rollout = readFileSync(
        "supabase/migrations/20261126023000_customer_advance_deposit_transactions.sql",
        "utf8"
      );

      const replayPatch = rollout.match(
        /DO \$canonical_posted_journal_replay\$[\s\S]*?\$canonical_posted_journal_replay\$;/
      )?.[0];

      if (!replayPatch) {
        throw new Error("Canonical replay migration missing");
      }

      await db.exec(replayPatch);

      await action();

    } finally {
      await db.exec("ROLLBACK");
    }
  }

  async function integratedAccountBalance(code: string) {
    const result = await db.query<{
      balance: number;
    }>(
      `SELECT coalesce(
         sum(l.debit-l.credit),0
       )::float8 AS balance
       FROM public.journal_entry_lines l
       JOIN public.chart_of_accounts a
         ON a.id=l.account_id
       JOIN public.journal_entries j
         ON j.id=l.journal_id
       WHERE a.code=$1
         AND j.organization_id=public.current_org_id()
         AND j.status='posted'
         AND j.reversed_by_journal_id IS NULL`,
      [code]
    );

    return result.rows[0]!.balance;
  }

  it("integrates progressive deposit allocation with canonical Finance journals", async () => {
    await withCanonicalFinance(async () => {
      const first = await addNight(1);

      await removeFixtureRevenueJournal(first);

      expect(
        await connectedAccommodationCharge(first)
      ).toMatchObject({
        ok:true,
        allocated:19000
      });

      expect(await remaining()).toBe(31000);

      expect(
        await integratedAccountBalance("2020")
      ).toBe(-31000);

      expect(
        await integratedAccountBalance("1060")
      ).toBe(0);

      expect(
        await integratedAccountBalance("4010")
      ).toBe(-19000);
    });
  });

  it("reconciles three nights using the actual progressive allocator and canonical journal functions", async () => {
    await withCanonicalFinance(async () => {
      const expected = [
        {night:1,applied:19000,remaining:31000},
        {night:2,applied:19000,remaining:12000},
        {night:3,applied:12000,remaining:0}
      ];

      for (const entry of expected) {
        const charge = await addNight(entry.night);

        await removeFixtureRevenueJournal(charge);

        expect(
          (await connectedAccommodationCharge(charge)).allocated
        ).toBe(entry.applied);

        expect(await remaining()).toBe(
          entry.remaining
        );
      }

      expect(await position()).toEqual({
        balance:7000,
        payments:50000
      });

      expect(
        await integratedAccountBalance("2020")
      ).toBe(0);

      expect(
        await integratedAccountBalance("1060")
      ).toBe(7000);

      expect(
        await integratedAccountBalance("4010")
      ).toBe(-57000);

      expect(
        await integratedAccountBalance("1010")
      ).toBe(50000);
    });
  });

  it("does not duplicate canonical financial postings during accommodation replay", async () => {
    await withCanonicalFinance(async () => {
      const charge = await addNight(1);

      await removeFixtureRevenueJournal(charge);

      await connectedAccommodationCharge(charge);
      await connectedAccommodationCharge(charge);

      expect(await remaining()).toBe(31000);

      expect(
        await integratedAccountBalance("2020")
      ).toBe(-31000);

      expect(
        await integratedAccountBalance("4010")
      ).toBe(-19000);

      expect(
        await integratedAccountBalance("1060")
      ).toBe(0);

      const result = await db.query<{
        n: number;
      }>(
        `SELECT count(*)::integer AS n
         FROM public.journal_entries
         WHERE source_document_id=$1
           AND source_document_type='folio_charge:revenue'
           AND status='posted'`,
        [charge]
      );

      expect(result.rows[0]!.n).toBe(1);
    });
  });


  // CANONICAL_FINANCE_TRANSACTION_V1

  async function installCanonicalFinanceTransaction() {

    await db.exec(`
      CREATE TABLE IF NOT EXISTS public.pos_orders (
        id uuid PRIMARY KEY,
        organization_id uuid,
        branch_id uuid
      );

      -- Required even when the current folio charge
      -- does not originate from a POS order.

      CREATE TABLE IF NOT EXISTS public.pos_order_items (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        order_id uuid,
        organization_id uuid,
        branch_id uuid,
        sales_tax_snapshot jsonb
      );

      CREATE TABLE IF NOT EXISTS public.payments (
        id uuid PRIMARY KEY
      );

      CREATE TABLE IF NOT EXISTS public.event_bookings (
        id uuid PRIMARY KEY
      );

      CREATE TABLE IF NOT EXISTS public.invoices (
        id uuid PRIMARY KEY
      );

      CREATE TABLE IF NOT EXISTS public.supplier_invoices (
        id uuid PRIMARY KEY
      );

      CREATE TABLE IF NOT EXISTS public.supplier_payments (
        id uuid PRIMARY KEY
      );

      CREATE TABLE IF NOT EXISTS public.guest_laundry_orders (
        id uuid PRIMARY KEY
      );

      ALTER TABLE public.folio_lines
        ADD COLUMN IF NOT EXISTS reference text,
        ADD COLUMN IF NOT EXISTS posting_date timestamptz
          DEFAULT now(),
        ADD COLUMN IF NOT EXISTS tax_amount numeric
          DEFAULT 0,
        ADD COLUMN IF NOT EXISTS service_charge_amount numeric
          DEFAULT 0,
        ADD COLUMN IF NOT EXISTS discount_amount numeric
          DEFAULT 0,
        ADD COLUMN IF NOT EXISTS revenue_centre text
          DEFAULT 'rooms';

      CREATE TABLE IF NOT EXISTS
      public.finance_posting_receipts (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        organization_id uuid NOT NULL,
        branch_id uuid,
        source_module text,
        source_id uuid,
        reference text,
        status text,
        amount numeric,
        currency text,
        folio_line_id uuid,
        posting_type text,
        journal_id uuid,
        idempotency_key text,
        detail text,
        error_message text,
        operational_date date,
        UNIQUE(organization_id,idempotency_key)
      );

      CREATE TABLE public.test_finance_domain_events (
        organization_id uuid,
        branch_id uuid,
        event_name text,
        source_module text,
        source_id uuid,
        payload jsonb,
        idempotency_key text UNIQUE
      );

      CREATE OR REPLACE FUNCTION
      public.neo_fact_timezone(uuid,uuid)
      RETURNS text LANGUAGE sql STABLE AS $$
        SELECT 'Africa/Nairobi'::text
      $$;

      CREATE OR REPLACE FUNCTION
      public.neo_gl_revenue_code_scoped(uuid,text,text)
      RETURNS text LANGUAGE sql STABLE AS $$
        SELECT CASE
          WHEN $2='accommodation' THEN '4010'
          ELSE '4020'
        END
      $$;

      CREATE FUNCTION public.neo_record_posting_receipt(
        _org uuid,
        _branch uuid,
        _source text,
        _source_id uuid,
        _reference text,
        _status text,
        _amount numeric,
        _currency text,
        _folio_line uuid,
        _detail text,
        _error text,
        _date date
      )
      RETURNS void
      LANGUAGE plpgsql
      AS $receipt$
      BEGIN

        INSERT INTO public.finance_posting_receipts (
          organization_id,
          branch_id,
          source_module,
          source_id,
          reference,
          status,
          amount,
          currency,
          folio_line_id,
          detail,
          error_message,
          operational_date,
          idempotency_key
        )
        VALUES (
          _org,
          _branch,
          _source,
          _source_id,
          _reference,
          _status,
          _amount,
          _currency,
          _folio_line,
          _detail,
          _error,
          _date,
          _source||':'||_source_id::text
        )
        ON CONFLICT (
          organization_id,idempotency_key
        )
        DO UPDATE SET
          status=excluded.status,
          amount=excluded.amount,
          detail=excluded.detail,
          error_message=excluded.error_message;

      END;
      $receipt$;

      CREATE FUNCTION public.emit_domain_event(
        _org uuid,
        _branch uuid,
        _event text,
        _source text,
        _source_id uuid,
        _payload jsonb,
        _key text,
        _customer uuid
      )
      RETURNS void LANGUAGE plpgsql AS $$
      BEGIN

        INSERT INTO public.test_finance_domain_events
        VALUES (
          _org,
          _branch,
          _event,
          _source,
          _source_id,
          _payload,
          _key
        )
        ON CONFLICT (idempotency_key)
        DO NOTHING;

      END;
      $$;

      INSERT INTO public.chart_of_accounts (
        id,organization_id,code
      )
      SELECT
        gen_random_uuid(),
        public.current_org_id(),
        code
      FROM unnest(
        ARRAY['2040','2050','4020']
      ) AS account(code)
      WHERE NOT EXISTS (
        SELECT 1
        FROM public.chart_of_accounts a
        WHERE a.organization_id=public.current_org_id()
          AND a.code=account.code
      );

      DROP FUNCTION public.neo_finance_post_txn(
        text,uuid,boolean
      );
    `);

    const sql = Buffer.from(
      "Q1JFQVRFIE9SIFJFUExBQ0UgRlVOQ1RJT04gcHVibGljLm5lb19maW5hbmNlX3Bvc3RfdHhuKF9zb3VyY2VfdHlwZSB0ZXh0LCBfc291cmNlX2lkIHV1aWQsIF9zaWxlbnQgYm9vbGVhbiBERUZBVUxUIGZhbHNlKQogUkVUVVJOUyBqc29uYgogTEFOR1VBR0UgcGxwZ3NxbAogU0VDVVJJVFkgREVGSU5FUgogU0VUIHNlYXJjaF9wYXRoIFRPICdwdWJsaWMnCkFTICRmdW5jdGlvbiQKREVDTEFSRQogIG9yZyB1dWlkIDo9IHB1YmxpYy5jdXJyZW50X29yZ19pZCgpOwogIGJyYW5jaCB1dWlkOyBjdXIgdGV4dDsgcmVmIHRleHQ7IG9jY3VycmVkIGRhdGU7IGFtb3VudCBudW1lcmljIDo9IDA7CiAgcG9zdGluZyB0ZXh0IDo9ICdyZXZlbnVlJzsgbGluZXMganNvbmIgOj0gJ1tdJzo6anNvbmI7IHJlcyBqc29uYjsKICBjdXN0b21lciB1dWlkOyBuZXQgbnVtZXJpYzsgdGF4IG51bWVyaWM7IHN2YyBudW1lcmljOyBzZXR0bGUgdGV4dDsgdGlwX2FjY291bnQgdXVpZDsgdGlwX2NvZGUgdGV4dDsKICBvIHB1YmxpYy5wb3Nfb3JkZXJzOyBmbCBwdWJsaWMuZm9saW9fbGluZXM7IHBheSBwdWJsaWMucGF5bWVudHM7CiAgZXYgcHVibGljLmV2ZW50X2Jvb2tpbmdzOyBpbnYgcHVibGljLmludm9pY2VzOyBzaSBwdWJsaWMuc3VwcGxpZXJfaW52b2ljZXM7CiAgc3AgcHVibGljLnN1cHBsaWVyX3BheW1lbnRzOyBsbyBwdWJsaWMuZ3Vlc3RfbGF1bmRyeV9vcmRlcnM7IGRlbGl2IHJlY29yZDsKICBwYWlkIG51bWVyaWM7IHJlbWFpbmRlciBudW1lcmljOyBrZXkgdGV4dDsgY29sbGVjdGlvbiByZWNvcmQ7IGNvbGxlY3RlZCBudW1lcmljOyByZWZ1bmRfZGVwb3NpdF9zb3VyY2UgcHVibGljLnJlc2VydmF0aW9uX2RlcG9zaXRzOyByZWZ1bmRfZGVwb3NpdF9qb3VybmFsIHV1aWQ7CkJFR0lOCiAgSUYgb3JnIElTIE5VTEwgVEhFTiBSRVRVUk4ganNvbmJfYnVpbGRfb2JqZWN0KCdvaycsIGZhbHNlLCAncmVhc29uJywgJ25vX29yZ2FuaXNhdGlvbicpOyBFTkQgSUY7CiAgSUYgTk9UIF9zaWxlbnQgQU5EIE5PVCAocHVibGljLmlzX29yZ19hZG1pbigpCiAgICAgICAgT1IgcHVibGljLmhhc19wZXJtaXNzaW9uKCdmaW5hbmNlJywnZWRpdCcpIE9SIHB1YmxpYy5oYXNfcGVybWlzc2lvbignZmluYW5jZScsJ2FwcHJvdmUnKSkgVEhFTgogICAgUkFJU0UgRVhDRVBUSU9OICdpbnN1ZmZpY2llbnRfcHJpdmlsZWdlJyBVU0lORyBFUlJDT0RFID0gJzQyNTAxJzsKICBFTkQgSUY7CgogIFBFUkZPUk0gcGdfYWR2aXNvcnlfeGFjdF9sb2NrKGhhc2h0ZXh0ZXh0ZW5kZWQoX3NvdXJjZV90eXBlIHx8ICc6JyB8fCBfc291cmNlX2lkOjp0ZXh0LCAwKSk7CgogIElGIF9zb3VyY2VfdHlwZSA9ICdwb3Nfb3JkZXInIFRIRU4KICAgIFNFTEVDVCAqIElOVE8gbyBGUk9NIHB1YmxpYy5wb3Nfb3JkZXJzCiAgICAgIFdIRVJFIGlkID0gX3NvdXJjZV9pZCBBTkQgb3JnYW5pemF0aW9uX2lkID0gb3JnIEZPUiBVUERBVEU7CiAgICBJRiBvLmlkIElTIE5VTEwgVEhFTiBSRVRVUk4ganNvbmJfYnVpbGRfb2JqZWN0KCdvaycsIGZhbHNlLCAncmVhc29uJywgJ25vdF9mb3VuZCcpOyBFTkQgSUY7CiAgICBJRiBFWElTVFMoU0VMRUNUIDEgRlJPTSBwdWJsaWMuZGVsaXZlcnlfb3JkZXJzIGQgV0hFUkUgZC5wb3Nfb3JkZXJfaWQ9by5pZCBBTkQgZC5vcmdhbml6YXRpb25faWQ9b3JnIEFORCBkLnBheW1lbnRfbWV0aG9kPSdyb29tLWNoYXJnZScpIFRIRU4KICAgICAgUkVUVVJOIHB1YmxpYy5uZW9fZmluYW5jZV9wb3N0X3R4bignZGVsaXZlcnlfb3JkZXInLChTRUxFQ1QgZC5pZCBGUk9NIHB1YmxpYy5kZWxpdmVyeV9vcmRlcnMgZCBXSEVSRSBkLnBvc19vcmRlcl9pZD1vLmlkIEFORCBkLm9yZ2FuaXphdGlvbl9pZD1vcmcpLHRydWUpOwogICAgRU5EIElGOwogICAgSUYgRVhJU1RTKFNFTEVDVCAxIEZST00gcHVibGljLmRlbGl2ZXJ5X29yZGVycyBkIFdIRVJFIGQucG9zX29yZGVyX2lkPW8uaWQgQU5EIGQub3JnYW5pemF0aW9uX2lkPW9yZykgVEhFTgogICAgICBTRUxFQ1QgaS4qIElOVE8gaW52IEZST00gcHVibGljLmludm9pY2VzIGkgSk9JTiBwdWJsaWMuZGVsaXZlcnlfb3JkZXJzIGQgT04gaS5ub3RlcyBMSUtFICdkZWxpdmVyeS1vcmRlcjonfHxkLmlkOjp0ZXh0fHwnJScgQU5EIGkub3JnYW5pemF0aW9uX2lkPWQub3JnYW5pemF0aW9uX2lkIFdIRVJFIGQucG9zX29yZGVyX2lkPW8uaWQgQU5EIGQub3JnYW5pemF0aW9uX2lkPW9yZyBPUkRFUiBCWSBpLmNyZWF0ZWRfYXQgTElNSVQgMTsKICAgICAgSUYgaW52LmlkIElTIE5PVCBOVUxMIEFORCBpbnYuYnJhbmNoX2lkIElTIE5PVCBESVNUSU5DVCBGUk9NIG8uYnJhbmNoX2lkIEFORCBwdWJsaWMubmVvX2Nvbm5lY3Rpb25fam91cm5hbF9tYXRjaGVzKGludi5qb3VybmFsX2lkLG9yZyxpbnYuYnJhbmNoX2lkLGludi5jdXJyZW5jeSxpbnYudG90YWwsJ2RlbGl2ZXJ5X2ludm9pY2UnLGludi5pZCkgVEhFTiBSRVRVUk4ganNvbmJfYnVpbGRfb2JqZWN0KCdvaycsdHJ1ZSwnam91cm5hbF9pZCcsaW52LmpvdXJuYWxfaWQsJ2R1cGxpY2F0ZV9wcmV2ZW50ZWQnLHRydWUsJ3Bvc3RpbmdfdHlwZScsJ2ludm9pY2UnLCdhbW91bnQnLGludi50b3RhbCk7IEVORCBJRjsKICAgICAgUkVUVVJOIGpzb25iX2J1aWxkX29iamVjdCgnb2snLGZhbHNlLCdyZWFzb24nLCdkZWxpdmVyeV9zb3VyY2Vfb3duc19wb3N0aW5nJywnZGV0YWlsJywnVGhpcyBwcm9kdWN0aW9uIG9yZGVyIGlzIGFjY291bnRlZCBmb3IgYnkgaXRzIGxpbmtlZCBkZWxpdmVyeSwgbm90IGEgc2Vjb25kIFBPUyBzYWxlLicpOwogICAgRU5EIElGOwogICAgYnJhbmNoIDo9IG8uYnJhbmNoX2lkOyByZWYgOj0gby5vcmRlcl9udW1iZXI7IGN1c3RvbWVyIDo9IG8uY3VzdG9tZXJfaWQ7CiAgICBvY2N1cnJlZCA6PSAoY29hbGVzY2Uoby5jbG9zZWRfYXQsIG8uY3JlYXRlZF9hdCkpOjpkYXRlOyBhbW91bnQgOj0gY29hbGVzY2Uoby5ncmFuZF90b3RhbCwwKTsKICAgIElGIG8uc3RhdHVzIE5PVCBJTiAoJ2Nsb3NlZCcsJ3BhaWQnLCdzZXR0bGVkJywnY29tcGxldGVkJywnY2hhcmdlZC10by1yb29tJykgVEhFTgogICAgICBSRVRVUk4ganNvbmJfYnVpbGRfb2JqZWN0KCdvaycsIGZhbHNlLCAncmVhc29uJywgJ2luZWxpZ2libGVfbGlmZWN5Y2xlJywKICAgICAgICAnZGV0YWlsJywgJ09yZGVyIGlzICcgfHwgby5zdGF0dXMgfHwgJy4gRHJhZnQsIHNlbnQsIHJlYWR5IGFuZCBzZXJ2ZWQgb3JkZXJzIGFyZSBub3QgcmV2ZW51ZS4nKTsKICAgIEVORCBJRjsKCiAgICBJRiBvLmZvbGlvX2lkIElTIE5PVCBOVUxMIFRIRU4KICAgICAgcG9zdGluZyA6PSAncm9vbV9jaGFyZ2UnOwogICAgICByZXMgOj0gcHVibGljLm5lb19wb3N0X3Bvc19vcmRlcihvLmlkKTsKICAgICAgUEVSRk9STSBwdWJsaWMubmVvX3JlY29yZF9wb3N0aW5nX3JlY2VpcHQob3JnLCBicmFuY2gsICdwb3MnLCBvLmlkLCByZWYsCiAgICAgICAgQ0FTRSBXSEVOIGNvYWxlc2NlKChyZXMtPj4nb2snKTo6Ym9vbGVhbixmYWxzZSkgVEhFTiAncG9zdGVkJyBFTFNFICdibG9ja2VkJyBFTkQsCiAgICAgICAgYW1vdW50LCBwdWJsaWMubmVvX2ZhY3RfY3VycmVuY3kob3JnLCBicmFuY2gpLCBudWxsaWYocmVzLT4+J2ZvbGlvX2xpbmVfaWQnLCcnKTo6dXVpZCwKICAgICAgICAnUm91dGVkIHRvIGZvbGlvICcgfHwgby5mb2xpb19pZDo6dGV4dCB8fCAnIC0gcmV2ZW51ZSBpcyByZWNvZ25pc2VkIG9uIHRoZSBmb2xpbyBjaGFyZ2UsIG5vdCBvbiB0aGUgb3JkZXIuJywKICAgICAgICBOVUxMLCBvY2N1cnJlZCk7CiAgICAgIFVQREFURSBwdWJsaWMuZmluYW5jZV9wb3N0aW5nX3JlY2VpcHRzIFNFVCBwb3N0aW5nX3R5cGUgPSBwb3N0aW5nCiAgICAgICAgV0hFUkUgb3JnYW5pemF0aW9uX2lkID0gb3JnIEFORCBpZGVtcG90ZW5jeV9rZXkgPSAncG9zOicgfHwgby5pZDo6dGV4dDsKICAgICAgU0VMRUNUIGNvYWxlc2NlKHJlcywne30nOjpqc29uYikgfHwganNvbmJfYnVpbGRfb2JqZWN0KAogICAgICAgICdwb3N0aW5nX3R5cGUnLHBvc3RpbmcsJ3Bvc3RpbmdfcmVjZWlwdF9pZCcsci5pZCwnZm9saW9fbGluZV9pZCcsci5mb2xpb19saW5lX2lkLCdqb3VybmFsX2lkJyxyLmpvdXJuYWxfaWQsCiAgICAgICAgJ29rJyxyLnN0YXR1cz0ncG9zdGVkJyBBTkQgci5mb2xpb19saW5lX2lkIElTIE5PVCBOVUxMIEFORCByLmpvdXJuYWxfaWQgSVMgTk9UIE5VTEwsCiAgICAgICAgJ3JlYXNvbicsQ0FTRSBXSEVOIHIuc3RhdHVzPSdwb3N0ZWQnIEFORCByLmZvbGlvX2xpbmVfaWQgSVMgTk9UIE5VTEwgQU5EIHIuam91cm5hbF9pZCBJUyBOT1QgTlVMTAogICAgICAgICAgICAgICAgICAgICBUSEVOICdyb29tX2NoYXJnZV9yZWNvbmNpbGVkJyBFTFNFICdyb29tX2NoYXJnZV9qb3VybmFsX3VudmVyaWZpZWQnIEVORCkKICAgICAgSU5UTyByZXMgRlJPTSBwdWJsaWMuZmluYW5jZV9wb3N0aW5nX3JlY2VpcHRzIHIKICAgICAgV0hFUkUgci5vcmdhbml6YXRpb25faWQ9b3JnIEFORCByLmlkZW1wb3RlbmN5X2tleT0ncG9zOid8fG8uaWQ6OnRleHQ7CiAgICAgIFJFVFVSTiBjb2FsZXNjZShyZXMsanNvbmJfYnVpbGRfb2JqZWN0KCdvaycsZmFsc2UsJ3JlYXNvbicsJ3Jvb21fY2hhcmdlX3JlY2VpcHRfbWlzc2luZycpKTsKICAgIEVORCBJRjsKCiAgICB0YXggOj0gY29hbGVzY2Uoby50YXhfdG90YWwsMCk7IHN2YyA6PSBjb2FsZXNjZShvLnNlcnZpY2VfY2hhcmdlX3RvdGFsLDApOwogICAgYW1vdW50IDo9IGdyZWF0ZXN0KGNvYWxlc2NlKG8uZ3JhbmRfdG90YWwsMCksCiAgICAgICAgICAgICAgICAgICAgICAgY29hbGVzY2Uoby5zdWJ0b3RhbCwwKSAtIGNvYWxlc2NlKG8uZGlzY291bnRfdG90YWwsMCkgKyBjb2FsZXNjZShvLnJvdW5kaW5nX2FkanVzdG1lbnQsMCkpOwogICAgSUYgRVhJU1RTIChTRUxFQ1QgMSBGUk9NIHB1YmxpYy5wb3Nfb3JkZXJfaXRlbXMgaSBXSEVSRSBpLm9yZGVyX2lkPW8uaWQgQU5EIGkuc2FsZXNfdGF4X3NuYXBzaG90IElTIE5PVCBOVUxMKSBUSEVOCiAgICAgIFNFTEVDVCBjb2FsZXNjZShzdW0odC5hbW91bnQpLDApIElOVE8gdGF4IEZST00gcHVibGljLm5lb19wb3Nfc2F2ZWRfc2FsZXNfdGF4ZXMoby5pZCxvLnN1YnRvdGFsLG8uc3VidG90YWwtby5kaXNjb3VudF90b3RhbCkgdDsKICAgIEVORCBJRjsKICAgIG5ldCA6PSBhbW91bnQgLSB0YXggLSBzdmM7CiAgICBJRiBFWElTVFMoU0VMRUNUIDEgRlJPTSBwdWJsaWMucG9zX3BheW1lbnRzIHAgV0hFUkUgcC5vcmRlcl9pZD1vLmlkCiAgICAgIEFORCBwLnN0YXR1cyBJTiAoJ2NvbmZpcm1lZCcsJ3BhaWQnLCdjb21wbGV0ZWQnLCdjYXB0dXJlZCcsJ3NldHRsZWQnKSBBTkQKICAgICAgKHAub3JnYW5pemF0aW9uX2lkIElTIERJU1RJTkNUIEZST00gb3JnIE9SIHAuYnJhbmNoX2lkIElTIERJU1RJTkNUIEZST00gby5icmFuY2hfaWQgT1IgcC5jdXJyZW5jeSBJUyBESVNUSU5DVCBGUk9NIG8uY3VycmVuY3kKICAgICAgIE9SIHAuYW1vdW50IElTIE5VTEwgT1IgcC5hbW91bnQ8PTAgT1IgcC5hbW91bnQ6OnRleHQgSU4gKCdOYU4nLCdJbmZpbml0eScsJy1JbmZpbml0eScpIE9SIHAuYW1vdW50PD5yb3VuZChwLmFtb3VudCwyKSkpIFRIRU4KICAgICBSQUlTRSBFWENFUFRJT04gJ1BPUyBzZXR0bGVtZW50IHJlY2VpcHRzIHJlcXVpcmUgY29uc2lzdGVudCBwcm9wZXJ0eSwgY3VycmVuY3kgYW5kIGZpbml0ZSBhbW91bnRzJzsKICAgIEVORCBJRjsKICAgIFNFTEVDVCBjb2FsZXNjZShzdW0ocC5hbW91bnQpLDApIElOVE8gY29sbGVjdGVkIEZST00gcHVibGljLnBvc19wYXltZW50cyBwIFdIRVJFIHAub3JkZXJfaWQ9by5pZCBBTkQgcC5vcmdhbml6YXRpb25faWQ9b3JnCiAgICAgIEFORCBwLnN0YXR1cyBJTiAoJ2NvbmZpcm1lZCcsJ3BhaWQnLCdjb21wbGV0ZWQnLCdjYXB0dXJlZCcsJ3NldHRsZWQnKTsKICAgIElGIGNvbGxlY3RlZD5hbW91bnQrMC4wMDUgVEhFTiBSQUlTRSBFWENFUFRJT04gJ1ZlcmlmaWVkIFBPUyBjb2xsZWN0aW9ucyBleGNlZWQgdGhlIHNhbGU7IHJlY29uY2lsZSB0aGUgY3VzdG9tZXIgb3ZlcnBheW1lbnQgYmVmb3JlIHNhbGUgcG9zdGluZyc7IEVORCBJRjsKICAgIElGIGNvbGxlY3RlZDxhbW91bnQtMC4wMDUgQU5EIG8uY29ycG9yYXRlX2FjY291bnRfaWQgSVMgTlVMTCBUSEVOIFJBSVNFIEVYQ0VQVElPTiAnUE9TIHNhbGUgbGFja3Mgc3VmZmljaWVudCBzYXZlZCBzZXR0bGVtZW50IHJlY2VpcHRzJzsgRU5EIElGOwogICAgbGluZXM6PSdbXSc6Ompzb25iOwogICAgRk9SIGNvbGxlY3Rpb24gSU4gU0VMRUNUIHAubWV0aG9kLHAuZGVzdGluYXRpb25fYWNjb3VudF9pZCxzdW0ocC5hbW91bnQpIEFTIGFtb3VudCBGUk9NIHB1YmxpYy5wb3NfcGF5bWVudHMgcAogICAgICBXSEVSRSBwLm9yZGVyX2lkPW8uaWQgQU5EIHAub3JnYW5pemF0aW9uX2lkPW9yZyBBTkQgcC5zdGF0dXMgSU4gKCdjb25maXJtZWQnLCdwYWlkJywnY29tcGxldGVkJywnY2FwdHVyZWQnLCdzZXR0bGVkJykKICAgICAgR1JPVVAgQlkgcC5tZXRob2QscC5kZXN0aW5hdGlvbl9hY2NvdW50X2lkIExPT1AKICAgICBJRiBjb2xsZWN0aW9uLmRlc3RpbmF0aW9uX2FjY291bnRfaWQgSVMgTk9UIE5VTEwgQU5EIGxvd2VyKHJlcGxhY2UoY29hbGVzY2UoY29sbGVjdGlvbi5tZXRob2QsJycpLCctJywnXycpKSBOT1QgSU4gKCdjYXJkJywnY2FyZF90ZXJtaW5hbCcsJ2NyZWRpdF9jYXJkJywnZGViaXRfY2FyZCcpCiAgICAgICBBTkQgTk9UIEVYSVNUUyhTRUxFQ1QgMSBGUk9NIHB1YmxpYy5iYW5rX2FjY291bnRzIGIgSk9JTiBwdWJsaWMuY2hhcnRfb2ZfYWNjb3VudHMgYSBPTiBhLmlkPWIuZ2xfYWNjb3VudF9pZCBBTkQgYS5vcmdhbml6YXRpb25faWQ9Yi5vcmdhbml6YXRpb25faWQKICAgICAgICAgV0hFUkUgYi5pZD1jb2xsZWN0aW9uLmRlc3RpbmF0aW9uX2FjY291bnRfaWQgQU5EIGIub3JnYW5pemF0aW9uX2lkPW9yZyBBTkQgYi5hY3RpdmUgQU5EIGEuYWN0aXZlIEFORCBhLnBvc3RhYmxlIEFORCBOT1QgY29hbGVzY2UoYS5pc19oZWFkZXIsZmFsc2UpKSBUSEVOCiAgICAgIFJBSVNFIEVYQ0VQVElPTiAnU2F2ZWQgUE9TIHJlY2VpdmluZyBhY2NvdW50IGlzIHVuYXZhaWxhYmxlOyByZWNvbmNpbGUgaXQgaW5zdGVhZCBvZiBmYWxsaW5nIGJhY2sgdG8gYW5vdGhlciBhY2NvdW50JzsKICAgICBFTkQgSUY7CiAgICAgc2V0dGxlOj1wdWJsaWMubmVvX2dsX2FjY291bnRfY29kZShvcmcsY29sbGVjdGlvbi5tZXRob2QsY29sbGVjdGlvbi5kZXN0aW5hdGlvbl9hY2NvdW50X2lkKTsKICAgICBJRiBudWxsaWYoYnRyaW0oc2V0dGxlKSwnJykgSVMgTlVMTCBUSEVOIFJBSVNFIEVYQ0VQVElPTiAnUE9TIHJlY2VpcHQgc2V0dGxlbWVudCBhY2NvdW50IGlzIG5vdCBjb25maWd1cmVkJzsgRU5EIElGOwogICAgIGxpbmVzOj1saW5lc3x8anNvbmJfYnVpbGRfYXJyYXkoanNvbmJfYnVpbGRfb2JqZWN0KCdjb2RlJyxzZXR0bGUsJ2RlYml0Jyxjb2xsZWN0aW9uLmFtb3VudCwnZGVzY3JpcHRpb24nLCdSZWNlaXB0IHNldHRsZW1lbnQgJ3x8Y29hbGVzY2UocmVmLCcnKSkpOwogICAgRU5EIExPT1A7CiAgICBJRiBjb2xsZWN0ZWQ8YW1vdW50IFRIRU4gbGluZXM6PWxpbmVzfHxqc29uYl9idWlsZF9hcnJheShqc29uYl9idWlsZF9vYmplY3QoJ2NvZGUnLCcxMDYwJywnZGViaXQnLGFtb3VudC1jb2xsZWN0ZWQsJ2Rlc2NyaXB0aW9uJywnQ29ycG9yYXRlIGNyZWRpdCBiYWxhbmNlJykpOyBFTkQgSUY7CiAgICBsaW5lczo9bGluZXN8fGpzb25iX2J1aWxkX2FycmF5KAogICAgICBqc29uYl9idWlsZF9vYmplY3QoJ2NvZGUnLHB1YmxpYy5uZW9fZ2xfcmV2ZW51ZV9jb2RlX3Njb3BlZChvcmcsby5vcmRlcl90eXBlLE5VTEwpLCdjcmVkaXQnLG5ldCksCiAgICAgIGpzb25iX2J1aWxkX29iamVjdCgnY29kZScsJzIwNTAnLCdjcmVkaXQnLHN2YywnZGVzY3JpcHRpb24nLCdTZXJ2aWNlIGNoYXJnZScpKQogICAgICB8fCBDQVNFIFdIRU4gRVhJU1RTIChTRUxFQ1QgMSBGUk9NIHB1YmxpYy5wb3Nfb3JkZXJfaXRlbXMgaSBXSEVSRSBpLm9yZGVyX2lkPW8uaWQgQU5EIGkuc2FsZXNfdGF4X3NuYXBzaG90IElTIE5PVCBOVUxMKQogICAgICAgIFRIRU4gcHVibGljLm5lb19wb3Nfc2FsZXNfdGF4X3Bvc3RfbGluZXMoby5pZCxvLnN1YnRvdGFsLG8uc3VidG90YWwtby5kaXNjb3VudF90b3RhbCkKICAgICAgICBFTFNFIGpzb25iX2J1aWxkX2FycmF5KGpzb25iX2J1aWxkX29iamVjdCgnY29kZScsJzIwNDAnLCdjcmVkaXQnLHRheCwnZGVzY3JpcHRpb24nLCdUYXgnKSkgRU5EOwoKICBFTFNJRiBfc291cmNlX3R5cGUgPSAnZm9saW9fY2hhcmdlJyBUSEVOCiAgICBTRUxFQ1QgKiBJTlRPIGZsIEZST00gcHVibGljLmZvbGlvX2xpbmVzCiAgICAgIFdIRVJFIGlkID0gX3NvdXJjZV9pZCBBTkQgb3JnYW5pemF0aW9uX2lkID0gb3JnIEZPUiBVUERBVEU7CiAgICBJRiBmbC5pZCBJUyBOVUxMIFRIRU4gUkVUVVJOIGpzb25iX2J1aWxkX29iamVjdCgnb2snLCBmYWxzZSwgJ3JlYXNvbicsICdub3RfZm91bmQnKTsgRU5EIElGOwogICAgYnJhbmNoIDo9IGZsLmJyYW5jaF9pZDsgcmVmIDo9IGNvYWxlc2NlKGZsLnJlZmVyZW5jZSwgZmwuZGVzY3JpcHRpb24pOyBjdXN0b21lciA6PSBmbC5jdXN0b21lcl9pZDsKICAgIG9jY3VycmVkIDo9IGNvYWxlc2NlKGZsLm9wZXJhdGlvbmFsX2RhdGUsIGZsLnBvc3RpbmdfZGF0ZTo6ZGF0ZSk7CiAgICBJRiBmbC5zdGF0dXMgPD4gJ3Bvc3RlZCcgT1IgY29hbGVzY2UoZmwubGluZV90eXBlLCdjaGFyZ2UnKSA9ICdwYXltZW50JyBUSEVOCiAgICAgIFJFVFVSTiBqc29uYl9idWlsZF9vYmplY3QoJ29rJywgZmFsc2UsICdyZWFzb24nLCAnaW5lbGlnaWJsZV9saWZlY3ljbGUnLAogICAgICAgICdkZXRhaWwnLCAnT25seSBwb3N0ZWQgZm9saW8gY2hhcmdlcyBhcmUgcmVjb2duaXNlZC4nKTsKICAgIEVORCBJRjsKICAgIHRheCA6PSBjb2FsZXNjZShmbC50YXhfYW1vdW50LDApOwogICAgc3ZjIDo9IGNvYWxlc2NlKGZsLnNlcnZpY2VfY2hhcmdlX2Ftb3VudCwwKTsKICAgIGFtb3VudCA6PSBjb2FsZXNjZShmbC5ncm9zc19hbW91bnQsMCkgLSBjb2FsZXNjZShmbC5kaXNjb3VudF9hbW91bnQsMCkgKyB0YXggKyBzdmM7CiAgICBJRiBmbC5jYXRlZ29yeT0nZ3JhdHVpdHknIFRIRU4gcG9zdGluZzo9J2dyYXR1aXR5LWxpYWJpbGl0eSc7IEVORCBJRjsKICAgIG5ldCA6PSBjb2FsZXNjZShmbC5ncm9zc19hbW91bnQsMCkgLSBjb2FsZXNjZShmbC5kaXNjb3VudF9hbW91bnQsMCk7CiAgICBJRiBmbC5jYXRlZ29yeT0nZ3JhdHVpdHknIFRIRU4KICAgICAgdGlwX2FjY291bnQ6PXB1YmxpYy5uZW9fdGlwX3BheWFibGVfYWNjb3VudChvcmcpOwogICAgICBTRUxFQ1QgYS5jb2RlIElOVE8gdGlwX2NvZGUgRlJPTSBwdWJsaWMuY2hhcnRfb2ZfYWNjb3VudHMgYSBXSEVSRSBhLmlkPXRpcF9hY2NvdW50OwogICAgRU5EIElGOwogICAgSUYgYW1vdW50IDw9IDAgVEhFTiBSRVRVUk4ganNvbmJfYnVpbGRfb2JqZWN0KCdvaycsIGZhbHNlLCAncmVhc29uJywgJ3plcm9fYW1vdW50Jyk7IEVORCBJRjsKICAgIGxpbmVzIDo9IGpzb25iX2J1aWxkX2FycmF5KAogICAgICBqc29uYl9idWlsZF9vYmplY3QoJ2NvZGUnLCAnMTA2MCcsICdkZWJpdCcsIGFtb3VudCwgJ2Rlc2NyaXB0aW9uJywgJ0d1ZXN0IGxlZGdlciAnIHx8IGNvYWxlc2NlKHJlZiwnJykpLAogICAgICBqc29uYl9idWlsZF9vYmplY3QoJ2NvZGUnLCBDQVNFIFdIRU4gZmwuY2F0ZWdvcnk9J2dyYXR1aXR5JyBUSEVOIHRpcF9jb2RlIEVMU0UgcHVibGljLm5lb19nbF9yZXZlbnVlX2NvZGVfc2NvcGVkKG9yZywgZmwuY2F0ZWdvcnksIGZsLnJldmVudWVfY2VudHJlKSBFTkQsICdjcmVkaXQnLCBuZXQpLAogICAgICBqc29uYl9idWlsZF9vYmplY3QoJ2NvZGUnLCAnMjA1MCcsICdjcmVkaXQnLCBzdmMsICdkZXNjcmlwdGlvbicsICdTZXJ2aWNlIGNoYXJnZScpKTsKICAgIElGIGZsLnNvdXJjZV9tb2R1bGUgSU4gKCdwb3MnLCdwb3Nfb3JkZXInKSBBTkQgZmwuY2F0ZWdvcnk8PidncmF0dWl0eScgVEhFTgogICAgICBTRUxFQ1QgKiBJTlRPIG8gRlJPTSBwdWJsaWMucG9zX29yZGVycyBXSEVSRSBpZD1mbC5zb3VyY2VfcmVjb3JkX3V1aWQgQU5EIG9yZ2FuaXphdGlvbl9pZD1vcmcKICAgICAgICBBTkQgYnJhbmNoX2lkIElTIE5PVCBESVNUSU5DVCBGUk9NIGZsLmJyYW5jaF9pZDsKICAgIEVORCBJRjsKICAgIElGIG8uaWQgSVMgTk9UIE5VTEwgQU5EIEVYSVNUUyhTRUxFQ1QgMSBGUk9NIHB1YmxpYy5wb3Nfb3JkZXJfaXRlbXMgaSBXSEVSRSBpLm9yZGVyX2lkPW8uaWQgQU5EIGkuc2FsZXNfdGF4X3NuYXBzaG90IElTIE5PVCBOVUxMKSBUSEVOCiAgICAgIElGIHRheCBJUyBESVNUSU5DVCBGUk9NIChTRUxFQ1QgY29hbGVzY2Uoc3VtKHQuYW1vdW50KSwwKQogICAgICAgIEZST00gcHVibGljLm5lb19wb3Nfc2F2ZWRfc2FsZXNfdGF4ZXMoby5pZCxvLnN1YnRvdGFsLG8uc3VidG90YWwtby5kaXNjb3VudF90b3RhbCkgdCkgVEhFTgogICAgICAgIFJBSVNFIEVYQ0VQVElPTiAnRm9saW8gdGF4IGRvZXMgbm90IHJlY29uY2lsZSB0byB0aGUgc2F2ZWQgUE9TIHNhbGUnOwogICAgICBFTkQgSUY7CiAgICAgIGxpbmVzOj1saW5lc3x8cHVibGljLm5lb19wb3Nfc2FsZXNfdGF4X3Bvc3RfbGluZXMoby5pZCxvLnN1YnRvdGFsLG8uc3VidG90YWwtby5kaXNjb3VudF90b3RhbCk7CiAgICBFTFNFCiAgICAgIGxpbmVzOj1saW5lc3x8anNvbmJfYnVpbGRfYXJyYXkoanNvbmJfYnVpbGRfb2JqZWN0KCdjb2RlJywnMjA0MCcsJ2NyZWRpdCcsdGF4LCdkZXNjcmlwdGlvbicsJ1ZBVCcpKTsKICAgIEVORCBJRjsKCiAgRUxTSUYgX3NvdXJjZV90eXBlID0gJ2ZvbGlvX3BheW1lbnQnIFRIRU4KICAgIFNFTEVDVCAqIElOVE8gcGF5IEZST00gcHVibGljLnBheW1lbnRzCiAgICAgIFdIRVJFIGlkID0gX3NvdXJjZV9pZCBBTkQgb3JnYW5pemF0aW9uX2lkID0gb3JnIEZPUiBVUERBVEU7CiAgICBJRiBwYXkuaWQgSVMgTlVMTCBUSEVOIFJFVFVSTiBqc29uYl9idWlsZF9vYmplY3QoJ29rJywgZmFsc2UsICdyZWFzb24nLCAnbm90X2ZvdW5kJyk7IEVORCBJRjsKICAgIGJyYW5jaCA6PSBwYXkuYnJhbmNoX2lkOyByZWYgOj0gcGF5LnJlY2VpcHRfbnVtYmVyOyBjdXN0b21lciA6PSBwYXkuY3VzdG9tZXJfaWQ7CiAgICBvY2N1cnJlZCA6PSBjb2FsZXNjZShwYXkucGFpZF9hdCwgcGF5LmNyZWF0ZWRfYXQpOjpkYXRlOyBhbW91bnQgOj0gY29hbGVzY2UocGF5LmFtb3VudCwwKTsKICAgIHBvc3RpbmcgOj0gJ2NvbGxlY3Rpb24nOwogICAgSUYgY29hbGVzY2UocGF5LnN0YXR1cywnJykgTk9UIElOICgnY29uZmlybWVkJywnY29tcGxldGVkJywncGFpZCcsJ3N1Y2NlZWRlZCcsJ2NhcHR1cmVkJykgVEhFTgogICAgICBSRVRVUk4ganNvbmJfYnVpbGRfb2JqZWN0KCdvaycsIGZhbHNlLCAncmVhc29uJywgJ2luZWxpZ2libGVfbGlmZWN5Y2xlJywKICAgICAgICAnZGV0YWlsJywgJ09ubHkgY29uZmlybWVkIHJlY2VpcHRzIHJlZHVjZSB0aGUgb3V0c3RhbmRpbmcgYmFsYW5jZS4nKTsKICAgIEVORCBJRjsKICAgIFNFTEVDVCAqIElOVE8gcmVmdW5kX2RlcG9zaXRfc291cmNlIEZST00gcHVibGljLnJlc2VydmF0aW9uX2RlcG9zaXRzIGQgV0hFUkUgZC5wYXltZW50X2lkPXBheS5pZCBBTkQgZC5vcmdhbml6YXRpb25faWQ9b3JnIEFORCBkLnN0YXR1cyBJTiAoJ2hlbGQnLCdhcHBsaWVkJyk7CiAgICBJRiByZWZ1bmRfZGVwb3NpdF9zb3VyY2UuaWQgSVMgTk9UIE5VTEwgVEhFTgogICAgICBJRiByZWZ1bmRfZGVwb3NpdF9zb3VyY2UuYW1vdW50IElTIERJU1RJTkNUIEZST00gYW1vdW50IFRIRU4gUkFJU0UgRVhDRVBUSU9OICdPcmlnaW5hbCBkZXBvc2l0IHJlY2VpcHQgYW1vdW50IGRpZmZlcnMnOyBFTkQgSUY7CiAgICAgIFNFTEVDVCBqLmlkIElOVE8gcmVmdW5kX2RlcG9zaXRfam91cm5hbCBGUk9NIHB1YmxpYy5qb3VybmFsX2VudHJpZXMgaiBXSEVSRSBwdWJsaWMubmVvX2Nvbm5lY3Rpb25fam91cm5hbF9tYXRjaGVzKGouaWQsb3JnLGJyYW5jaCxwYXkuY3VycmVuY3ksYW1vdW50LCdyZXNlcnZhdGlvbl9kZXBvc2l0OmRlcG9zaXQnLHJlZnVuZF9kZXBvc2l0X3NvdXJjZS5pZCkgTElNSVQgMTsKICAgICAgSUYgcmVmdW5kX2RlcG9zaXRfam91cm5hbCBJUyBOVUxMIFRIRU4gUkFJU0UgRVhDRVBUSU9OICdPcmlnaW5hbCBkZXBvc2l0IHJlY2VpcHQgcmVxdWlyZXMgaXRzIHBvc3RlZCBsaWFiaWxpdHkgam91cm5hbCc7IEVORCBJRjsKICAgICAgUkVUVVJOIGpzb25iX2J1aWxkX29iamVjdCgnb2snLHRydWUsJ2pvdXJuYWxfaWQnLHJlZnVuZF9kZXBvc2l0X2pvdXJuYWwsJ2R1cGxpY2F0ZV9wcmV2ZW50ZWQnLHRydWUsJ3Bvc3RpbmdfdHlwZScsJ2RlcG9zaXQnLCdhbW91bnQnLGFtb3VudCk7CiAgICBFTkQgSUY7CiAgICBJRiBwYXkuc291cmNlX21vZHVsZT0nY2FzaF9yZWZ1bmQnIFRIRU4KICAgICAgSUYgTk9UIHB1YmxpYy5uZW9fY2FzaF9yZWZ1bmRfcGF5bWVudF92YWxpZChwYXkuaWQpIFRIRU4gUkFJU0UgRVhDRVBUSU9OICdSZWZ1bmQgcmVjZWlwdCByZXF1aXJlcyBpdHMgc2V0dGxlZCBvcmlnaW5hbC1yZWNlaXB0IGxpbmsgYW5kIG1hdGNoaW5nIHBvc3RlZCBqb3VybmFsJzsgRU5EIElGOwogICAgICBQRVJGT1JNIHB1YmxpYy5uZW9fcmVjb3JkX3Bvc3RpbmdfcmVjZWlwdChvcmcsYnJhbmNoLF9zb3VyY2VfdHlwZSxfc291cmNlX2lkLHJlZiwncG9zdGVkJyxhbW91bnQscGF5LmN1cnJlbmN5LE5VTEwsJ1ZlcmlmaWVkIHNlcGFyYXRlbHkgbGlua2VkIHJlZnVuZCBwYXlvdXQgam91cm5hbCcsTlVMTCxvY2N1cnJlZCk7CiAgICAgIFVQREFURSBwdWJsaWMuZmluYW5jZV9wb3N0aW5nX3JlY2VpcHRzIFNFVCBwb3N0aW5nX3R5cGU9J3JlZnVuZCcsam91cm5hbF9pZD1wYXkucG9zdGVkX2pvdXJuYWxfaWQgV0hFUkUgb3JnYW5pemF0aW9uX2lkPW9yZyBBTkQgc291cmNlX21vZHVsZT1fc291cmNlX3R5cGUgQU5EIHNvdXJjZV9pZD1fc291cmNlX2lkOwogICAgICBSRVRVUk4ganNvbmJfYnVpbGRfb2JqZWN0KCdvaycsdHJ1ZSwnam91cm5hbF9pZCcscGF5LnBvc3RlZF9qb3VybmFsX2lkLCdkdXBsaWNhdGVfcHJldmVudGVkJyx0cnVlLCdhbW91bnQnLGFtb3VudCwncG9zdGluZ190eXBlJywncmVmdW5kJyk7CiAgICBFTkQgSUY7CiAgICBJRiBwYXkuc291cmNlX21vZHVsZT0nZGVsaXZlcnknIEFORCBwYXkucG9zdGVkX2pvdXJuYWxfaWQgSVMgTk9UIE5VTEwgVEhFTgogICAgICBJRiBOT1QgRVhJU1RTKFNFTEVDVCAxIEZST00gcHVibGljLmpvdXJuYWxfZW50cmllcyBqIFdIRVJFIGouaWQ9cGF5LnBvc3RlZF9qb3VybmFsX2lkIEFORCBqLm9yZ2FuaXphdGlvbl9pZD1vcmcgQU5EIGouYnJhbmNoX2lkIElTIE5PVCBESVNUSU5DVCBGUk9NIGJyYW5jaCBBTkQgai5zdGF0dXM9J3Bvc3RlZCcgQU5EIGouc291cmNlX21vZHVsZT0nZGVsaXZlcnknIEFORCBqLnNvdXJjZV9kb2N1bWVudF90eXBlPSdkZWxpdmVyeV9wYXltZW50JyBBTkQgai5zb3VyY2VfZG9jdW1lbnRfaWQ9cGF5LmlkIEFORCBqLmN1cnJlbmN5PXBheS5jdXJyZW5jeSBBTkQgai50b3RhbF9kZWJpdD1hbW91bnQgQU5EIGoudG90YWxfY3JlZGl0PWFtb3VudCBBTkQgYW1vdW50PjAgQU5EIGFtb3VudDo6dGV4dCBOT1QgSU4gKCdOYU4nLCdJbmZpbml0eScsJy1JbmZpbml0eScpIEFORCBOT1QgRVhJU1RTKFNFTEVDVCAxIEZST00gcHVibGljLmpvdXJuYWxfZW50cnlfbGluZXMgbCBXSEVSRSBsLmpvdXJuYWxfaWQ9ai5pZCBBTkQgKGwub3JnYW5pemF0aW9uX2lkIElTIERJU1RJTkNUIEZST00gb3JnIE9SIGwuYnJhbmNoX2lkIElTIERJU1RJTkNUIEZST00gYnJhbmNoKSkgQU5EIChTRUxFQ1QgY29hbGVzY2Uoc3VtKGwuZGViaXQpLDApIEZST00gcHVibGljLmpvdXJuYWxfZW50cnlfbGluZXMgbCBXSEVSRSBsLmpvdXJuYWxfaWQ9ai5pZCk9YW1vdW50IEFORCAoU0VMRUNUIGNvYWxlc2NlKHN1bShsLmNyZWRpdCksMCkgRlJPTSBwdWJsaWMuam91cm5hbF9lbnRyeV9saW5lcyBsIFdIRVJFIGwuam91cm5hbF9pZD1qLmlkKT1hbW91bnQpIFRIRU4gUkFJU0UgRVhDRVBUSU9OICdEZWxpdmVyeSBwYXltZW50IGpvdXJuYWwgZXZpZGVuY2UgaXMgaW5jb21wbGV0ZSc7IEVORCBJRjsKICAgICAgUEVSRk9STSBwdWJsaWMubmVvX3JlY29yZF9wb3N0aW5nX3JlY2VpcHQob3JnLGJyYW5jaCxfc291cmNlX3R5cGUsX3NvdXJjZV9pZCxyZWYsJ3Bvc3RlZCcsYW1vdW50LHBheS5jdXJyZW5jeSxOVUxMLCdFeGlzdGluZyBkZWxpdmVyeSByZWNlaXB0IGpvdXJuYWwgdmVyaWZpZWQnLE5VTEwsb2NjdXJyZWQpOwogICAgICBVUERBVEUgcHVibGljLmZpbmFuY2VfcG9zdGluZ19yZWNlaXB0cyBTRVQgcG9zdGluZ190eXBlPSdjb2xsZWN0aW9uJyxqb3VybmFsX2lkPXBheS5wb3N0ZWRfam91cm5hbF9pZCBXSEVSRSBvcmdhbml6YXRpb25faWQ9b3JnIEFORCBzb3VyY2VfbW9kdWxlPV9zb3VyY2VfdHlwZSBBTkQgc291cmNlX2lkPV9zb3VyY2VfaWQ7CiAgICAgIFJFVFVSTiBqc29uYl9idWlsZF9vYmplY3QoJ29rJyx0cnVlLCdqb3VybmFsX2lkJyxwYXkucG9zdGVkX2pvdXJuYWxfaWQsJ2R1cGxpY2F0ZV9wcmV2ZW50ZWQnLHRydWUsJ2Ftb3VudCcsYW1vdW50LCdwb3N0aW5nX3R5cGUnLCdjb2xsZWN0aW9uJyk7CiAgICBFTkQgSUY7CiAgICBJRiBhbW91bnQgPSAwIFRIRU4gUkVUVVJOIGpzb25iX2J1aWxkX29iamVjdCgnb2snLCBmYWxzZSwgJ3JlYXNvbicsICd6ZXJvX2Ftb3VudCcpOyBFTkQgSUY7CiAgICBsaW5lcyA6PSBqc29uYl9idWlsZF9hcnJheSgKICAgICAganNvbmJfYnVpbGRfb2JqZWN0KCdjb2RlJywgcHVibGljLm5lb19nbF9hY2NvdW50X2NvZGUob3JnLCBwYXkubWV0aG9kLCBwYXkuZGVzdGluYXRpb25fYWNjb3VudF9pZCksCiAgICAgICAgICAgICAgICAgICAgICAgICAnZGViaXQnLCBhbW91bnQsICdkZXNjcmlwdGlvbicsICdSZWNlaXB0ICcgfHwgY29hbGVzY2UocmVmLCcnKSksCiAgICAgIGpzb25iX2J1aWxkX29iamVjdCgnY29kZScsICcxMDYwJywgJ2NyZWRpdCcsIGFtb3VudCwgJ2Rlc2NyaXB0aW9uJywgJ0d1ZXN0IC8gY3VzdG9tZXIgbGVkZ2VyJykpOwoKICAKRUxTSUYgX3NvdXJjZV90eXBlID0gJ2V2ZW50X2RlcG9zaXQnIFRIRU4KCiAgICBJRiBFWElTVFMgKAogICAgICAgIFNFTEVDVCAxCiAgICAgICAgRlJPTSBwdWJsaWMuZXZlbnRfcGF5bWVudHMgZXAKICAgICAgICBXSEVSRSBlcC5vcmdhbml6YXRpb25faWQgPSBvcmcKICAgICAgICAgIEFORCBlcC5ib29raW5nX2lkID0gX3NvdXJjZV9pZAogICAgICAgICAgQU5EIGVwLmVudHJ5X3R5cGUgPSAnZGVwb3NpdCcKICAgICkgVEhFTgoKICAgICAgICBJRiAoCiAgICAgICAgICAgIHB1YmxpYy5uZW9fZXZlbnRfY29sbGVjdGlvbl9wb3N0aW5nX2V2aWRlbmNlKAogICAgICAgICAgICAgICAgb3JnLF9zb3VyY2VfaWQKICAgICAgICAgICAgKS0+PidmdWxseV9wb3N0ZWQnCiAgICAgICAgKTo6Ym9vbGVhbiBJUyBUUlVFIFRIRU4KCiAgICAgICAgICAgIFJFVFVSTiBqc29uYl9idWlsZF9vYmplY3QoCiAgICAgICAgICAgICAgICAnb2snLHRydWUsCiAgICAgICAgICAgICAgICAncmVhc29uJywnYWxyZWFkeV9wb3N0ZWRfaW5kaXZpZHVhbGx5JywKICAgICAgICAgICAgICAgICdkdXBsaWNhdGVfcHJldmVudGVkJyx0cnVlLAogICAgICAgICAgICAgICAgJ2V2aWRlbmNlJywKICAgICAgICAgICAgICAgICAgICBwdWJsaWMubmVvX2V2ZW50X2NvbGxlY3Rpb25fcG9zdGluZ19ldmlkZW5jZSgKICAgICAgICAgICAgICAgICAgICAgICAgb3JnLF9zb3VyY2VfaWQKICAgICAgICAgICAgICAgICAgICApCiAgICAgICAgICAgICk7CgogICAgICAgIEVMU0UKCiAgICAgICAgICAgIFJFVFVSTiBqc29uYl9idWlsZF9vYmplY3QoCiAgICAgICAgICAgICAgICAnb2snLGZhbHNlLAogICAgICAgICAgICAgICAgJ3JlYXNvbicsJ2V2ZW50X2NvbGxlY3Rpb25fcmVjb25jaWxpYXRpb25fcmVxdWlyZWQnLAogICAgICAgICAgICAgICAgJ2RldGFpbCcsCiAgICAgICAgICAgICAgICAgICAgJ0luZGl2aWR1YWwgZXZlbnQgZGVwb3NpdHMgbXVzdCBiZSByZWNvbmNpbGVkIGJlZm9yZSBhZ2dyZWdhdGUgcG9zdGluZy4nCiAgICAgICAgICAgICk7CgogICAgICAgIEVORCBJRjsKCiAgICBFTkQgSUY7CgoKICAgIFNFTEVDVCAqIElOVE8gZXYgRlJPTSBwdWJsaWMuZXZlbnRfYm9va2luZ3MKICAgICAgV0hFUkUgaWQgPSBfc291cmNlX2lkIEFORCBvcmdhbml6YXRpb25faWQgPSBvcmcgRk9SIFVQREFURTsKICAgIElGIGV2LmlkIElTIE5VTEwgVEhFTiBSRVRVUk4ganNvbmJfYnVpbGRfb2JqZWN0KCdvaycsIGZhbHNlLCAncmVhc29uJywgJ25vdF9mb3VuZCcpOyBFTkQgSUY7CiAgICBicmFuY2ggOj0gZXYuYnJhbmNoX2lkOyByZWYgOj0gZXYuZXZlbnRfcmVmZXJlbmNlOyBjdXN0b21lciA6PSBldi5jdXN0b21lcl9pZDsKICAgIG9jY3VycmVkIDo9IGNvYWxlc2NlKGV2LmNvbmZpcm1lZF9hdDo6ZGF0ZSwgZXYuZXZlbnRfZGF0ZSk7IHBvc3RpbmcgOj0gJ2RlcG9zaXQnOwogICAgYW1vdW50IDo9IGNvYWxlc2NlKGV2LmRlcG9zaXRfcGFpZCwgMCk7CiAgICBJRiBhbW91bnQgPD0gMCBUSEVOCiAgICAgIFJFVFVSTiBqc29uYl9idWlsZF9vYmplY3QoJ29rJywgZmFsc2UsICdyZWFzb24nLCAnaW5lbGlnaWJsZV9saWZlY3ljbGUnLAogICAgICAgICdkZXRhaWwnLCAnTm8gZGVwb3NpdCBoYXMgYmVlbiByZWNlaXZlZC4gRm9yZWNhc3QgaXMgbmV2ZXIgcmV2ZW51ZS4nKTsKICAgIEVORCBJRjsKICAgIFNFTEVDVCBwdWJsaWMubmVvX2dsX2FjY291bnRfY29kZShvcmcsIHAubWV0aG9kLCBwLmRlc3RpbmF0aW9uX2FjY291bnRfaWQpIElOVE8gc2V0dGxlCiAgICAgIEZST00gcHVibGljLnBheW1lbnRzIHAKICAgICBXSEVSRSBwLm9yZ2FuaXphdGlvbl9pZCA9IG9yZyBBTkQgcC5zb3VyY2VfbW9kdWxlID0gJ2V2ZW50cycgQU5EIHAuc291cmNlX3JlY29yZF9pZCA9IGV2LmlkCiAgICAgICBBTkQgY29hbGVzY2UocC5zdGF0dXMsJycpIElOICgnY29uZmlybWVkJywnY29tcGxldGVkJywncGFpZCcsJ3N1Y2NlZWRlZCcsJ2NhcHR1cmVkJykKICAgICBPUkRFUiBCWSBwLmFtb3VudCBERVNDIExJTUlUIDE7CiAgICBzZXR0bGUgOj0gY29hbGVzY2Uoc2V0dGxlLCBwdWJsaWMubmVvX2dsX3NldHRsZW1lbnRfY29kZV9mb3Iob3JnLCAnY2FzaCcpLCAnMTAxMCcpOwogICAgCiAgICAgICAgbGluZXMgOj0gcHVibGljLm5lb19ldmVudF9kZXBvc2l0X3NldHRsZW1lbnRfbGluZXMoCiAgICAgICAgICAgIG9yZyxldi5pZCxhbW91bnQKICAgICAgICApOwoKRUxTSUYgX3NvdXJjZV90eXBlID0gJ2V2ZW50X2ludm9pY2UnIFRIRU4KICAgIFNFTEVDVCAqIElOVE8gaW52IEZST00gcHVibGljLmludm9pY2VzCiAgICAgIFdIRVJFIGlkID0gX3NvdXJjZV9pZCBBTkQgb3JnYW5pemF0aW9uX2lkID0gb3JnIEZPUiBVUERBVEU7CiAgICBJRiBpbnYuaWQgSVMgTlVMTCBUSEVOIFJFVFVSTiBqc29uYl9idWlsZF9vYmplY3QoJ29rJywgZmFsc2UsICdyZWFzb24nLCAnbm90X2ZvdW5kJyk7IEVORCBJRjsKICAgIGJyYW5jaCA6PSBpbnYuYnJhbmNoX2lkOyByZWYgOj0gaW52Lmludm9pY2VfbnVtYmVyOyBjdXN0b21lciA6PSBpbnYuY3VzdG9tZXJfaWQ7CiAgICBvY2N1cnJlZCA6PSBpbnYuaXNzdWVfZGF0ZTsgcG9zdGluZyA6PSAnaW52b2ljZSc7IGFtb3VudCA6PSBjb2FsZXNjZShpbnYudG90YWwsMCk7CiAgICBJRiBjb2FsZXNjZShpbnYuc3RhdHVzLCdkcmFmdCcpIE5PVCBJTiAoJ2lzc3VlZCcsJ3NlbnQnLCdwYXJ0aWFsbHlfcGFpZCcsJ3BhaWQnLCdvdmVyZHVlJykgVEhFTgogICAgICBSRVRVUk4ganNvbmJfYnVpbGRfb2JqZWN0KCdvaycsIGZhbHNlLCAncmVhc29uJywgJ2luZWxpZ2libGVfbGlmZWN5Y2xlJywKICAgICAgICAnZGV0YWlsJywgJ0RyYWZ0IGFuZCBjYW5jZWxsZWQgaW52b2ljZXMgYXJlIG5vdCByZWNlaXZhYmxlcy4nKTsKICAgIEVORCBJRjsKICAgIElGIGludi5ub3RlcyBMSUtFICdkZWxpdmVyeS1vcmRlcjolJyBUSEVOCiAgICAgIElGIE5PVCBwdWJsaWMubmVvX2Nvbm5lY3Rpb25fam91cm5hbF9tYXRjaGVzKGludi5qb3VybmFsX2lkLG9yZyxicmFuY2gsaW52LmN1cnJlbmN5LGFtb3VudCwnZGVsaXZlcnlfaW52b2ljZScsaW52LmlkKSBUSEVOIFJBSVNFIEVYQ0VQVElPTiAnRGVsaXZlcnkgaW52b2ljZSBqb3VybmFsIGV2aWRlbmNlIG5lZWRzIHJldmlldyc7IEVORCBJRjsKICAgICAgUkVUVVJOIGpzb25iX2J1aWxkX29iamVjdCgnb2snLHRydWUsJ2pvdXJuYWxfaWQnLGludi5qb3VybmFsX2lkLCdkdXBsaWNhdGVfcHJldmVudGVkJyx0cnVlLCdwb3N0aW5nX3R5cGUnLCdpbnZvaWNlJywnYW1vdW50JyxhbW91bnQpOwogICAgRU5EIElGOwogICAgbmV0IDo9IGNvYWxlc2NlKGludi5zdWJ0b3RhbCwwKSAtIGNvYWxlc2NlKGludi5kaXNjb3VudF90b3RhbCwwKTsKICAgIGxpbmVzIDo9IGpzb25iX2J1aWxkX2FycmF5KAogICAgICBqc29uYl9idWlsZF9vYmplY3QoJ2NvZGUnLCAnMTA2MCcsICdkZWJpdCcsIGFtb3VudCwgJ2Rlc2NyaXB0aW9uJywgJ0ludm9pY2UgJyB8fCBjb2FsZXNjZShyZWYsJycpKSwKICAgICAganNvbmJfYnVpbGRfb2JqZWN0KCdjb2RlJywgQ0FTRSBXSEVOIGludi5ldmVudF9ib29raW5nX2lkIElTIE5PVCBOVUxMIFRIRU4gcHVibGljLm5lb19nbF9yZXZlbnVlX2NvZGVfc2NvcGVkKG9yZywgJ2V2ZW50cycsIE5VTEwpIEVMU0UgJzQwOTAnIEVORCwKICAgICAgICAgICAgICAgICAgICAgICAgICdjcmVkaXQnLCBuZXQpLAogICAgICBqc29uYl9idWlsZF9vYmplY3QoJ2NvZGUnLCAnMjA1MCcsICdjcmVkaXQnLCBjb2FsZXNjZShpbnYuc2VydmljZV9jaGFyZ2VfdG90YWwsMCksCiAgICAgICAgICAgICAgICAgICAgICAgICAnZGVzY3JpcHRpb24nLCAnU2VydmljZSBjaGFyZ2UnKSwKICAgICAganNvbmJfYnVpbGRfb2JqZWN0KCdjb2RlJywgJzIwNDAnLCAnY3JlZGl0JywgY29hbGVzY2UoaW52LnRheF90b3RhbCwwKSwgJ2Rlc2NyaXB0aW9uJywgJ1ZBVCcpKTsKCiAgRUxTSUYgX3NvdXJjZV90eXBlID0gJ2V2ZW50X2Vhcm5lZCcgVEhFTgogICAgU0VMRUNUICogSU5UTyBldiBGUk9NIHB1YmxpYy5ldmVudF9ib29raW5ncwogICAgICBXSEVSRSBpZCA9IF9zb3VyY2VfaWQgQU5EIG9yZ2FuaXphdGlvbl9pZCA9IG9yZyBGT1IgVVBEQVRFOwogICAgSUYgZXYuaWQgSVMgTlVMTCBUSEVOIFJFVFVSTiBqc29uYl9idWlsZF9vYmplY3QoJ29rJywgZmFsc2UsICdyZWFzb24nLCAnbm90X2ZvdW5kJyk7IEVORCBJRjsKICAgIGJyYW5jaCA6PSBldi5icmFuY2hfaWQ7IHJlZiA6PSBldi5ldmVudF9yZWZlcmVuY2U7IGN1c3RvbWVyIDo9IGV2LmN1c3RvbWVyX2lkOwogICAgb2NjdXJyZWQgOj0gZXYuZXZlbnRfZGF0ZTsgcG9zdGluZyA6PSAnZWFybmVkJzsgYW1vdW50IDo9IGNvYWxlc2NlKGV2LnRvdGFsX2Ftb3VudCwwKTsKICAgIElGIGV2LnN0YXR1cyBOT1QgSU4gKCdjb21wbGV0ZWQnLCdjbG9zZWQnKSBUSEVOCiAgICAgIFJFVFVSTiBqc29uYl9idWlsZF9vYmplY3QoJ29rJywgZmFsc2UsICdyZWFzb24nLCAnaW5lbGlnaWJsZV9saWZlY3ljbGUnLAogICAgICAgICdkZXRhaWwnLCAnRXZlbnQgaXMgJyB8fCBldi5zdGF0dXMgfHwgJy4gQ29uZmlybWVkIGFuZCBwcm92aXNpb25hbCBib29raW5ncyBhcmUgZm9yZWNhc3QsIG5vdCByZXZlbnVlLicpOwogICAgRU5EIElGOwogICAgSUYgYW1vdW50IDw9IDAgVEhFTiBSRVRVUk4ganNvbmJfYnVpbGRfb2JqZWN0KCdvaycsIGZhbHNlLCAncmVhc29uJywgJ3plcm9fYW1vdW50Jyk7IEVORCBJRjsKICAgIHBhaWQgOj0gbGVhc3QoY29hbGVzY2UoZXYuZGVwb3NpdF9wYWlkLDApLCBhbW91bnQpOwogICAgcmVtYWluZGVyIDo9IGFtb3VudCAtIHBhaWQ7CiAgICBsaW5lcyA6PSBqc29uYl9idWlsZF9hcnJheSgKICAgICAganNvbmJfYnVpbGRfb2JqZWN0KCdjb2RlJywgJzIwMzAnLCAnZGViaXQnLCBwYWlkLCAnZGVzY3JpcHRpb24nLCAnRGVwb3NpdCBhcHBsaWVkJyksCiAgICAgIGpzb25iX2J1aWxkX29iamVjdCgnY29kZScsICcxMDYwJywgJ2RlYml0JywgcmVtYWluZGVyLCAnZGVzY3JpcHRpb24nLCAnRXZlbnQgcmVjZWl2YWJsZScpLAogICAgICBqc29uYl9idWlsZF9vYmplY3QoJ2NvZGUnLCBwdWJsaWMubmVvX2dsX3JldmVudWVfY29kZV9zY29wZWQob3JnLCAnZXZlbnRzJywgTlVMTCksICdjcmVkaXQnLCBhbW91bnQsICdkZXNjcmlwdGlvbicsICdFdmVudCByZXZlbnVlICcgfHwgY29hbGVzY2UocmVmLCcnKSkpOwoKICBFTFNJRiBfc291cmNlX3R5cGUgPSAnZXZlbnRfY2FuY2VsbGF0aW9uJyBUSEVOCiAgICBTRUxFQ1QgKiBJTlRPIGV2IEZST00gcHVibGljLmV2ZW50X2Jvb2tpbmdzCiAgICAgIFdIRVJFIGlkID0gX3NvdXJjZV9pZCBBTkQgb3JnYW5pemF0aW9uX2lkID0gb3JnIEZPUiBVUERBVEU7CiAgICBJRiBldi5pZCBJUyBOVUxMIFRIRU4gUkVUVVJOIGpzb25iX2J1aWxkX29iamVjdCgnb2snLCBmYWxzZSwgJ3JlYXNvbicsICdub3RfZm91bmQnKTsgRU5EIElGOwogICAgYnJhbmNoIDo9IGV2LmJyYW5jaF9pZDsgcmVmIDo9IGV2LmV2ZW50X3JlZmVyZW5jZTsgY3VzdG9tZXIgOj0gZXYuY3VzdG9tZXJfaWQ7CiAgICBvY2N1cnJlZCA6PSBjb2FsZXNjZShldi5jYW5jZWxsZWRfYXQ6OmRhdGUsIGV2LmV2ZW50X2RhdGUpOyBwb3N0aW5nIDo9ICdjYW5jZWxsYXRpb24nOwogICAgSUYgZXYuc3RhdHVzIDw+ICdjYW5jZWxsZWQnIFRIRU4KICAgICAgUkVUVVJOIGpzb25iX2J1aWxkX29iamVjdCgnb2snLCBmYWxzZSwgJ3JlYXNvbicsICdpbmVsaWdpYmxlX2xpZmVjeWNsZScpOwogICAgRU5EIElGOwogICAgCiAgICBhbW91bnQgOj0gY29hbGVzY2UoZXYuY2FuY2VsbGF0aW9uX2ZlZSwgMCk7CiAgICBwYWlkIDo9IGNvYWxlc2NlKGV2LmRlcG9zaXRfcGFpZCwgMCk7CiAgICAKICAgICAgICByZW1haW5kZXIgOj0gZ3JlYXRlc3QocGFpZCAtIGFtb3VudCwgMCk7CgogICAgICAgIElGIHJlbWFpbmRlciA+IDAgVEhFTgoKICAgICAgICAgICAgUEVSRk9STSBwdWJsaWMubmVvX3JlY29yZF9ldmVudF9yZWZ1bmRfb2JsaWdhdGlvbigKICAgICAgICAgICAgICAgIG9yZyxldi5pZCxyZW1haW5kZXIKICAgICAgICAgICAgKTsKCiAgICAgICAgICAgIFJFVFVSTiBqc29uYl9idWlsZF9vYmplY3QoCiAgICAgICAgICAgICAgICAnb2snLGZhbHNlLAogICAgICAgICAgICAgICAgJ3JlYXNvbicsJ3JlZnVuZF9zZXR0bGVtZW50X3JlcXVpcmVkJywKICAgICAgICAgICAgICAgICdyZWZ1bmRfb2JsaWdhdGlvbl9yZWNvcmRlZCcsdHJ1ZSwKICAgICAgICAgICAgICAgICdyZWZ1bmRfYW1vdW50JyxyZW1haW5kZXIsCiAgICAgICAgICAgICAgICAnZGV0YWlsJywKICAgICAgICAgICAgICAgICAgICAnQ2FuY2VsbGF0aW9uIHJlcXVpcmVzIGNvbnRyb2xsZWQgZmluYW5jaWFsIHNldHRsZW1lbnQuJwogICAgICAgICAgICApOwoKICAgICAgICBFTkQgSUY7CgogICAgUEVSRk9STSBwdWJsaWMubmVvX2ZpbmFuY2VfcmV2ZXJzZV9wb3N0aW5nKCdldmVudF9lYXJuZWQnLCBldi5pZCwgJ2Vhcm5lZCcsICdFdmVudCBjYW5jZWxsZWQnKTsKICAgICAgICBJRiBhbW91bnQgPSAwIEFORCByZW1haW5kZXIgPSAwIFRIRU4KICAgICAgUkVUVVJOIGpzb25iX2J1aWxkX29iamVjdCgnb2snLCB0cnVlLCAncmVhc29uJywgJ25vdGhpbmdfdG9fcmVjb2duaXNlJyk7CiAgICBFTkQgSUY7CiAgICBTRUxFQ1QgcHVibGljLm5lb19nbF9hY2NvdW50X2NvZGUob3JnLCBwLm1ldGhvZCwgcC5kZXN0aW5hdGlvbl9hY2NvdW50X2lkKSBJTlRPIHNldHRsZQogICAgICBGUk9NIHB1YmxpYy5wYXltZW50cyBwCiAgICAgV0hFUkUgcC5vcmdhbml6YXRpb25faWQgPSBvcmcgQU5EIHAuc291cmNlX21vZHVsZSA9ICdldmVudHMnIEFORCBwLnNvdXJjZV9yZWNvcmRfaWQgPSBldi5pZAogICAgIE9SREVSIEJZIHAuYW1vdW50IERFU0MgTElNSVQgMTsKICAgIHNldHRsZSA6PSBjb2FsZXNjZShzZXR0bGUsIHB1YmxpYy5uZW9fZ2xfc2V0dGxlbWVudF9jb2RlX2ZvcihvcmcsICdjYXNoJyksICcxMDEwJyk7CiAgICBsaW5lcyA6PSBqc29uYl9idWlsZF9hcnJheSgKICAgICAganNvbmJfYnVpbGRfb2JqZWN0KCdjb2RlJywgJzIwMzAnLCAnZGViaXQnLCBwYWlkLCAnZGVzY3JpcHRpb24nLCAnRGVwb3NpdCByZWxlYXNlZCcpLAogICAgICBqc29uYl9idWlsZF9vYmplY3QoJ2NvZGUnLCAnMTA2MCcsICdkZWJpdCcsIGdyZWF0ZXN0KGFtb3VudCAtIHBhaWQsIDApLAogICAgICAgICAgICAgICAgICAgICAgICAgJ2Rlc2NyaXB0aW9uJywgJ0NhbmNlbGxhdGlvbiByZWNlaXZhYmxlJyksCiAgICAgIGpzb25iX2J1aWxkX29iamVjdCgnY29kZScsIHB1YmxpYy5uZW9fZ2xfcmV2ZW51ZV9jb2RlX3Njb3BlZChvcmcsICdldmVudHMnLCBOVUxMKSwgJ2NyZWRpdCcsIGFtb3VudCwgJ2Rlc2NyaXB0aW9uJywgJ0NhbmNlbGxhdGlvbiBmZWUgJyB8fCBjb2FsZXNjZShyZWYsJycpKSwKICAgICAganNvbmJfYnVpbGRfb2JqZWN0KCdjb2RlJywgc2V0dGxlLCAnY3JlZGl0JywgcmVtYWluZGVyLCAnZGVzY3JpcHRpb24nLCAnUmVmdW5kIHRvIGNsaWVudCcpKTsKICAgIGFtb3VudCA6PSBncmVhdGVzdChhbW91bnQsIHBhaWQpOwoKICBFTFNJRiBfc291cmNlX3R5cGUgPSAnZGVsaXZlcnlfb3JkZXInIFRIRU4KICAgIFNFTEVDVCBkLmlkLCBkLmJyYW5jaF9pZCwgZC5vcmRlcl9udW1iZXIsIGQuY3VzdG9tZXJfaWQsIGQuZ3JhbmRfdG90YWwsIGQudGF4X3RvdGFsLAogICAgICAgICAgIGQub3JkZXJfc3RhdHVzLCBkLnBheW1lbnRfc3RhdHVzLCBkLnBheW1lbnRfbWV0aG9kLCBkLmRlbGl2ZXJlZF9hdCwgZC5jcmVhdGVkX2F0LAogICAgICAgICAgIGQucG9zX29yZGVyX2lkLGQuZnVsZmlsbWVudF90eXBlLGQuc2VydmljZV9jaGFyZ2VfdG90YWwsZC50aXBfYW1vdW50LGQuY3VycmVuY3kKICAgICAgSU5UTyBkZWxpdiBGUk9NIHB1YmxpYy5kZWxpdmVyeV9vcmRlcnMgZAogICAgICBXSEVSRSBkLmlkID0gX3NvdXJjZV9pZCBBTkQgZC5vcmdhbml6YXRpb25faWQgPSBvcmcgRk9SIFVQREFURTsKICAgIElGIGRlbGl2LmlkIElTIE5VTEwgVEhFTiBSRVRVUk4ganNvbmJfYnVpbGRfb2JqZWN0KCdvaycsIGZhbHNlLCAncmVhc29uJywgJ25vdF9mb3VuZCcpOyBFTkQgSUY7CiAgICBicmFuY2ggOj0gZGVsaXYuYnJhbmNoX2lkOyByZWYgOj0gZGVsaXYub3JkZXJfbnVtYmVyOyBjdXN0b21lciA6PSBkZWxpdi5jdXN0b21lcl9pZDsKICAgIG9jY3VycmVkIDo9IGNvYWxlc2NlKGRlbGl2LmRlbGl2ZXJlZF9hdCwgZGVsaXYuY3JlYXRlZF9hdCk6OmRhdGU7CiAgICBhbW91bnQgOj0gY29hbGVzY2UoZGVsaXYuZ3JhbmRfdG90YWwsMCk7IHRheCA6PSBjb2FsZXNjZShkZWxpdi50YXhfdG90YWwsMCk7CiAgICBJRiBkZWxpdi5wYXltZW50X21ldGhvZD0ncm9vbS1jaGFyZ2UnIFRIRU4KICAgICAgU0VMRUNUICogSU5UTyBvIEZST00gcHVibGljLnBvc19vcmRlcnMgV0hFUkUgaWQ9ZGVsaXYucG9zX29yZGVyX2lkIEFORCBvcmdhbml6YXRpb25faWQ9b3JnOwogICAgICBJRiBvLmlkIElTIE5VTEwgT1Igby5mb2xpb19pZCBJUyBOVUxMIE9SIG8uZm9saW9fcG9zdF9zdGF0dXMgSVMgRElTVElOQ1QgRlJPTSAncG9zdGVkJyBUSEVOCiAgICAgICAgUkVUVVJOIGpzb25iX2J1aWxkX29iamVjdCgnb2snLGZhbHNlLCdyZWFzb24nLCdhd2FpdGluZ19yb29tX2ZvbGlvJywnZGV0YWlsJywnUm9vbSBzZXJ2aWNlIG11c3QgcmVhY2ggaXRzIHNhdmVkIGd1ZXN0IGZvbGlvIGJlZm9yZSBGaW5hbmNlIGNvbXBsZXRpb24uJyk7CiAgICAgIEVORCBJRjsKICAgICAgU0VMRUNUIGNvYWxlc2NlKHN1bShmLm5ldF9hbW91bnQpLDApIElOVE8gcGFpZCBGUk9NIHB1YmxpYy5mb2xpb19saW5lcyBmCiAgICAgICBXSEVSRSBmLm9yZ2FuaXphdGlvbl9pZD1vcmcgQU5EIGYuZm9saW9faWQ9by5mb2xpb19pZCBBTkQgZi5zdGF0dXM9J3Bvc3RlZCcKICAgICAgICAgQU5EIGYuc291cmNlX3JlY29yZF91dWlkPW8uaWQgQU5EIGYuc291cmNlX21vZHVsZT0ncG9zX29yZGVyJwogICAgICAgICBBTkQgZi5pZGVtcG90ZW5jeV9rZXkgSU4gKCdndWVzdF9yb29tX3NlcnZpY2U6J3x8by5pZDo6dGV4dCwnZ3Vlc3Rfcm9vbV9zZXJ2aWNlX3RpcDonfHxvLmlkOjp0ZXh0KTsKICAgICAgSUYgcGFpZCBJUyBESVNUSU5DVCBGUk9NIGFtb3VudCBPUiBOT1QgRVhJU1RTKFNFTEVDVCAxIEZST00gcHVibGljLmZvbGlvX2xpbmVzIGYKICAgICAgICAgIFdIRVJFIGYub3JnYW5pemF0aW9uX2lkPW9yZyBBTkQgZi5mb2xpb19pZD1vLmZvbGlvX2lkIEFORCBmLnN0YXR1cz0ncG9zdGVkJyBBTkQgZi5zb3VyY2VfcmVjb3JkX3V1aWQ9by5pZAogICAgICAgICAgICBBTkQgZi5pZGVtcG90ZW5jeV9rZXk9J2d1ZXN0X3Jvb21fc2VydmljZTonfHxvLmlkOjp0ZXh0KQogICAgICAgIE9SIEVYSVNUUyhTRUxFQ1QgMSBGUk9NIHB1YmxpYy5mb2xpb19saW5lcyBmIFdIRVJFIGYub3JnYW5pemF0aW9uX2lkPW9yZyBBTkQgZi5mb2xpb19pZD1vLmZvbGlvX2lkCiAgICAgICAgICBBTkQgZi5zdGF0dXM9J3Bvc3RlZCcgQU5EIGYuc291cmNlX3JlY29yZF91dWlkPW8uaWQgQU5EIGYuc291cmNlX21vZHVsZT0ncG9zX29yZGVyJwogICAgICAgICAgQU5EIGYuaWRlbXBvdGVuY3lfa2V5IElOICgnZ3Vlc3Rfcm9vbV9zZXJ2aWNlOid8fG8uaWQ6OnRleHQsJ2d1ZXN0X3Jvb21fc2VydmljZV90aXA6J3x8by5pZDo6dGV4dCkKICAgICAgICAgIEFORCBmLm5ldF9hbW91bnQ+MCBBTkQgTk9UIEVYSVNUUyhTRUxFQ1QgMSBGUk9NIHB1YmxpYy5qb3VybmFsX2VudHJpZXMgaiBXSEVSRSBqLm9yZ2FuaXphdGlvbl9pZD1vcmcKICAgICAgICAgICAgQU5EIGouYnJhbmNoX2lkIElTIE5PVCBESVNUSU5DVCBGUk9NIG8uYnJhbmNoX2lkIEFORCBqLnNvdXJjZV9kb2N1bWVudF9pZD1mLmlkCiAgICAgICAgICAgIEFORCBqLnNvdXJjZV9kb2N1bWVudF90eXBlPSdmb2xpb19jaGFyZ2U6J3x8Q0FTRSBXSEVOIGYuY2F0ZWdvcnk9J2dyYXR1aXR5JyBUSEVOICdncmF0dWl0eS1saWFiaWxpdHknIEVMU0UgJ3JldmVudWUnIEVORAogICAgICAgICAgICBBTkQgai5zdGF0dXM9J3Bvc3RlZCcgQU5EIGoucmV2ZXJzZWRfYnlfam91cm5hbF9pZCBJUyBOVUxMIEFORCBqLmN1cnJlbmN5PW8uY3VycmVuY3kKICAgICAgICAgICAgQU5EIGoudG90YWxfZGViaXQ9Zi5uZXRfYW1vdW50IEFORCBqLnRvdGFsX2NyZWRpdD1mLm5ldF9hbW91bnQKICAgICAgICAgICAgQU5EIChTRUxFQ1QgY29hbGVzY2Uoc3VtKGwuZGViaXQpLDApIEZST00gcHVibGljLmpvdXJuYWxfZW50cnlfbGluZXMgbCBXSEVSRSBsLmpvdXJuYWxfaWQ9ai5pZCk9Zi5uZXRfYW1vdW50CiAgICAgICAgICAgIEFORCAoU0VMRUNUIGNvYWxlc2NlKHN1bShsLmNyZWRpdCksMCkgRlJPTSBwdWJsaWMuam91cm5hbF9lbnRyeV9saW5lcyBsIFdIRVJFIGwuam91cm5hbF9pZD1qLmlkKT1mLm5ldF9hbW91bnQKICAgICAgICAgICAgQU5EIE5PVCBFWElTVFMoU0VMRUNUIDEgRlJPTSBwdWJsaWMuam91cm5hbF9lbnRyeV9saW5lcyBsIExFRlQgSk9JTiBwdWJsaWMuY2hhcnRfb2ZfYWNjb3VudHMgYSBPTiBhLmlkPWwuYWNjb3VudF9pZAogICAgICAgICAgICAgIFdIRVJFIGwuam91cm5hbF9pZD1qLmlkIEFORCAobC5vcmdhbml6YXRpb25faWQgSVMgRElTVElOQ1QgRlJPTSBvcmcgT1IgbC5icmFuY2hfaWQgSVMgRElTVElOQ1QgRlJPTSBvLmJyYW5jaF9pZAogICAgICAgICAgICAgICAgT1IgYS5vcmdhbml6YXRpb25faWQgSVMgRElTVElOQ1QgRlJPTSBvcmcgT1IgbC5kZWJpdCBJUyBOVUxMIE9SIGwuY3JlZGl0IElTIE5VTEwgT1IgbC5kZWJpdDwwIE9SIGwuY3JlZGl0PDAKICAgICAgICAgICAgICAgIE9SIChsLmRlYml0PjAgQU5EIGwuY3JlZGl0PjApIE9SIGwuZGViaXQ6OnRleHQgSU4gKCdOYU4nLCdJbmZpbml0eScsJy1JbmZpbml0eScpIE9SIGwuY3JlZGl0Ojp0ZXh0IElOICgnTmFOJywnSW5maW5pdHknLCctSW5maW5pdHknKSkpKSkgVEhFTgogICAgICAgIFJFVFVSTiBqc29uYl9idWlsZF9vYmplY3QoJ29rJyxmYWxzZSwncmVhc29uJywnYXdhaXRpbmdfZm9saW9fam91cm5hbHMnLCdkZXRhaWwnLCdUaGUgc2F2ZWQgZm9saW8gYW1vdW50cyBvciB0aGVpciBwb3N0ZWQgam91cm5hbHMgbmVlZCByZWNvbmNpbGlhdGlvbjsgbm8gc2Vjb25kIHNhbGUgd2FzIHBvc3RlZC4nKTsKICAgICAgRU5EIElGOwogICAgICBQRVJGT1JNIHB1YmxpYy5uZW9fcmVjb3JkX3Bvc3RpbmdfcmVjZWlwdChvcmcsYnJhbmNoLF9zb3VyY2VfdHlwZSxfc291cmNlX2lkLHJlZiwncG9zdGVkJyxhbW91bnQsby5jdXJyZW5jeSxOVUxMLAogICAgICAgICdSZWNvZ25pc2VkIHRocm91Z2ggZ3Vlc3QgZm9saW87IG5vIGR1cGxpY2F0ZSBkZWxpdmVyeSBzYWxlJyxOVUxMLG9jY3VycmVkKTsKICAgICAgVVBEQVRFIHB1YmxpYy5maW5hbmNlX3Bvc3RpbmdfcmVjZWlwdHMgU0VUIHBvc3RpbmdfdHlwZT0nZm9saW8tdHJhbnNmZXInLGpvdXJuYWxfaWQ9TlVMTAogICAgICAgIFdIRVJFIG9yZ2FuaXphdGlvbl9pZD1vcmcgQU5EIHNvdXJjZV9tb2R1bGU9X3NvdXJjZV90eXBlIEFORCBzb3VyY2VfaWQ9X3NvdXJjZV9pZDsKICAgICAgUkVUVVJOIGpzb25iX2J1aWxkX29iamVjdCgnb2snLHRydWUsJ3Bvc3RpbmdfdHlwZScsJ2ZvbGlvLXRyYW5zZmVyJywnZm9saW9faWQnLG8uZm9saW9faWQsJ2Ftb3VudCcsYW1vdW50LCdkdXBsaWNhdGVfcHJldmVudGVkJyx0cnVlKTsKICAgIEVORCBJRjsKICAgIElGIGRlbGl2Lm9yZGVyX3N0YXR1cyBOT1QgSU4gKCdkZWxpdmVyZWQnLCdjb21wbGV0ZWQnKSBUSEVOCiAgICAgIFJFVFVSTiBqc29uYl9idWlsZF9vYmplY3QoJ29rJywgZmFsc2UsICdyZWFzb24nLCAnaW5lbGlnaWJsZV9saWZlY3ljbGUnLAogICAgICAgICdkZXRhaWwnLCAnT25seSBjb21wbGV0ZWQgZGVsaXZlcmllcyBhcmUgcmVjb2duaXNlZC4nKTsKICAgIEVORCBJRjsKICAgIFNFTEVDVCAqIElOVE8gaW52IEZST00gcHVibGljLmludm9pY2VzIGkgV0hFUkUgaS5vcmdhbml6YXRpb25faWQ9b3JnIEFORCBpLm5vdGVzIExJS0UgJ2RlbGl2ZXJ5LW9yZGVyOid8fGRlbGl2LmlkOjp0ZXh0fHwnJScgT1JERVIgQlkgaS5jcmVhdGVkX2F0IExJTUlUIDE7CiAgICBJRiBpbnYuaWQgSVMgTk9UIE5VTEwgVEhFTgogICAgICBJRiBpbnYuYnJhbmNoX2lkIElTIERJU1RJTkNUIEZST00gYnJhbmNoIE9SIGludi5jdXJyZW5jeSBJUyBESVNUSU5DVCBGUk9NIHB1YmxpYy5uZW9fZmFjdF9jdXJyZW5jeShvcmcsYnJhbmNoKSBPUiBpbnYudG90YWwgSVMgRElTVElOQ1QgRlJPTSBhbW91bnQgT1IgTk9UIHB1YmxpYy5uZW9fY29ubmVjdGlvbl9qb3VybmFsX21hdGNoZXMoaW52LmpvdXJuYWxfaWQsb3JnLGJyYW5jaCxpbnYuY3VycmVuY3ksYW1vdW50LCdkZWxpdmVyeV9pbnZvaWNlJyxpbnYuaWQpIFRIRU4gUkFJU0UgRVhDRVBUSU9OICdDb21wbGV0ZWQgZGVsaXZlcnkgaW52b2ljZSBldmlkZW5jZSBuZWVkcyByZXZpZXcnOyBFTkQgSUY7CiAgICAgIFJFVFVSTiBqc29uYl9idWlsZF9vYmplY3QoJ29rJyx0cnVlLCdqb3VybmFsX2lkJyxpbnYuam91cm5hbF9pZCwnZHVwbGljYXRlX3ByZXZlbnRlZCcsdHJ1ZSwncG9zdGluZ190eXBlJywnaW52b2ljZScsJ2Ftb3VudCcsYW1vdW50KTsKICAgIEVORCBJRjsKICAgIElGIGRlbGl2LnBheW1lbnRfc3RhdHVzIElOICgncGFpZCcsJ3NldHRsZWQnLCdjb21wbGV0ZWQnKSBUSEVOCiAgICAgIFNFTEVDVCBwdWJsaWMubmVvX2dsX2FjY291bnRfY29kZShvcmcsIGNvYWxlc2NlKHAubWV0aG9kLCBkZWxpdi5wYXltZW50X21ldGhvZCksIHAuZGVzdGluYXRpb25fYWNjb3VudF9pZCkKICAgICAgICBJTlRPIHNldHRsZQogICAgICAgIEZST00gcHVibGljLnBheW1lbnRzIHAKICAgICAgIFdIRVJFIHAub3JnYW5pemF0aW9uX2lkID0gb3JnIEFORCBwLnNvdXJjZV9tb2R1bGUgPSAnZGVsaXZlcnknIEFORCBwLnNvdXJjZV9yZWNvcmRfaWQgPSBkZWxpdi5pZAogICAgICAgICBBTkQgY29hbGVzY2UocC5zdGF0dXMsJycpIElOICgnY29uZmlybWVkJywnY29tcGxldGVkJywncGFpZCcsJ3N1Y2NlZWRlZCcsJ2NhcHR1cmVkJykKICAgICAgIE9SREVSIEJZIHAuYW1vdW50IERFU0MgTElNSVQgMTsKICAgICAgc2V0dGxlIDo9IGNvYWxlc2NlKHNldHRsZSwgcHVibGljLm5lb19nbF9hY2NvdW50X2NvZGUob3JnLCBkZWxpdi5wYXltZW50X21ldGhvZCwgTlVMTCksICcxMDEwJyk7CiAgICBFTFNFCiAgICAgIHNldHRsZSA6PSAnMTA2MCc7CiAgICBFTkQgSUY7CiAgICBJRiBjb2FsZXNjZShkZWxpdi50aXBfYW1vdW50LDApPjAgVEhFTgogICAgICB0aXBfYWNjb3VudDo9cHVibGljLm5lb190aXBfcGF5YWJsZV9hY2NvdW50KG9yZyk7CiAgICAgIFNFTEVDVCBhLmNvZGUgSU5UTyB0aXBfY29kZSBGUk9NIHB1YmxpYy5jaGFydF9vZl9hY2NvdW50cyBhIFdIRVJFIGEuaWQ9dGlwX2FjY291bnQ7CiAgICBFTkQgSUY7CiAgICBsaW5lcyA6PSBqc29uYl9idWlsZF9hcnJheSgKICAgICAganNvbmJfYnVpbGRfb2JqZWN0KCdjb2RlJywgc2V0dGxlLCAnZGViaXQnLCBhbW91bnQsICdkZXNjcmlwdGlvbicsICdEZWxpdmVyeSAnIHx8IGNvYWxlc2NlKHJlZiwnJykpLAogICAgICBqc29uYl9idWlsZF9vYmplY3QoJ2NvZGUnLCBwdWJsaWMubmVvX2dsX3JldmVudWVfY29kZV9zY29wZWQob3JnLCdkZWxpdmVyeScsTlVMTCksICdjcmVkaXQnLCBhbW91bnQtdGF4LWNvYWxlc2NlKGRlbGl2LnNlcnZpY2VfY2hhcmdlX3RvdGFsLDApLWNvYWxlc2NlKGRlbGl2LnRpcF9hbW91bnQsMCkpLAogICAgICBqc29uYl9idWlsZF9vYmplY3QoJ2NvZGUnLCAnMjA1MCcsICdjcmVkaXQnLCBjb2FsZXNjZShkZWxpdi5zZXJ2aWNlX2NoYXJnZV90b3RhbCwwKSwgJ2Rlc2NyaXB0aW9uJywgJ1NlcnZpY2UgY2hhcmdlJykpCiAgICAgIHx8IENBU0UgV0hFTiBFWElTVFMgKFNFTEVDVCAxIEZST00gcHVibGljLnBvc19vcmRlcl9pdGVtcyBpIFdIRVJFIGkub3JkZXJfaWQ9ZGVsaXYucG9zX29yZGVyX2lkIEFORCBpLnNhbGVzX3RheF9zbmFwc2hvdCBJUyBOT1QgTlVMTCkKICAgICAgICBUSEVOIHB1YmxpYy5uZW9fcG9zX3NhbGVzX3RheF9wb3N0X2xpbmVzKGRlbGl2LnBvc19vcmRlcl9pZCwKICAgICAgICAgIChTRUxFQ1Qgc3VidG90YWwgRlJPTSBwdWJsaWMucG9zX29yZGVycyBXSEVSRSBpZD1kZWxpdi5wb3Nfb3JkZXJfaWQpLAogICAgICAgICAgKFNFTEVDVCBzdWJ0b3RhbC1kaXNjb3VudF90b3RhbCBGUk9NIHB1YmxpYy5wb3Nfb3JkZXJzIFdIRVJFIGlkPWRlbGl2LnBvc19vcmRlcl9pZCkpCiAgICAgICAgRUxTRSBqc29uYl9idWlsZF9hcnJheShqc29uYl9idWlsZF9vYmplY3QoJ2NvZGUnLCcyMDQwJywnY3JlZGl0Jyx0YXgsJ2Rlc2NyaXB0aW9uJywnVkFUJykpIEVORDsKICAgIElGIGNvYWxlc2NlKGRlbGl2LnRpcF9hbW91bnQsMCk+MCBUSEVOCiAgICAgIGxpbmVzOj1saW5lc3x8anNvbmJfYnVpbGRfYXJyYXkoanNvbmJfYnVpbGRfb2JqZWN0KCdjb2RlJyx0aXBfY29kZSwKICAgICAgICAnY3JlZGl0JyxkZWxpdi50aXBfYW1vdW50LCdkZXNjcmlwdGlvbicsJ0NvbGxlY3RlZCByaWRlci9zdGFmZiB0aXBzIHBheWFibGUnKSk7CiAgICBFTkQgSUY7CgogIEVMU0lGIF9zb3VyY2VfdHlwZSA9ICdsYXVuZHJ5X29yZGVyJyBUSEVOCiAgICBTRUxFQ1QgKiBJTlRPIGxvIEZST00gcHVibGljLmd1ZXN0X2xhdW5kcnlfb3JkZXJzCiAgICAgIFdIRVJFIGlkID0gX3NvdXJjZV9pZCBBTkQgb3JnYW5pemF0aW9uX2lkID0gb3JnIEZPUiBVUERBVEU7CiAgICBJRiBsby5pZCBJUyBOVUxMIFRIRU4gUkVUVVJOIGpzb25iX2J1aWxkX29iamVjdCgnb2snLCBmYWxzZSwgJ3JlYXNvbicsICdub3RfZm91bmQnKTsgRU5EIElGOwogICAgYnJhbmNoIDo9IGxvLmJyYW5jaF9pZDsgcmVmIDo9IGxvLmxhdW5kcnlfbnVtYmVyOwogICAgb2NjdXJyZWQgOj0gY29hbGVzY2UobG8uZGVsaXZlcmVkX2F0LCBsby5jcmVhdGVkX2F0KTo6ZGF0ZTsgYW1vdW50IDo9IGNvYWxlc2NlKGxvLnRvdGFsLDApOwogICAgSUYgbG8uc3RhdHVzIE5PVCBJTiAoJ2RlbGl2ZXJlZCcsJ2NvbXBsZXRlZCcsJ2Nsb3NlZCcpIFRIRU4KICAgICAgUkVUVVJOIGpzb25iX2J1aWxkX29iamVjdCgnb2snLCBmYWxzZSwgJ3JlYXNvbicsICdpbmVsaWdpYmxlX2xpZmVjeWNsZScsCiAgICAgICAgJ2RldGFpbCcsICdPbmx5IGNvbXBsZXRlZCBsYXVuZHJ5IG9yZGVycyBhcmUgcmVjb2duaXNlZC4nKTsKICAgIEVORCBJRjsKICAgIElGIGxvLmZvbGlvX2lkIElTIE5VTEwgQU5EIChsby5yZXNlcnZhdGlvbl9pZCBJUyBOT1QgTlVMTCBPUiBsby5yZXNpZGVudCBJUyBUUlVFKSBUSEVOCiAgICAgIFJFVFVSTiBqc29uYl9idWlsZF9vYmplY3QoJ29rJyxmYWxzZSwncmVhc29uJywncmVzaWRlbnRfbGF1bmRyeV9taXNzaW5nX2ZvbGlvJywKICAgICAgICAnZGV0YWlsJywnUmVzaWRlbnQgbGF1bmRyeSBtdXN0IHJlYWNoIGEgZ3Vlc3QgZm9saW87IGl0IGNhbm5vdCBiZSB0cmVhdGVkIGFzIGFuIGFzc3VtZWQgY2FzaCBjb2xsZWN0aW9uLicpOwogICAgRU5EIElGOwogICAgSUYgbG8uZm9saW9faWQgSVMgTk9UIE5VTEwgVEhFTgogICAgICBwb3N0aW5nIDo9ICdmb2xpb19jaGFyZ2UnOwogICAgICByZXMgOj0gcHVibGljLmxhdW5kcnlfcG9zdF9jaGFyZ2UobG8uaWQpOwogICAgICBQRVJGT1JNIHB1YmxpYy5uZW9fcmVjb3JkX3Bvc3RpbmdfcmVjZWlwdChvcmcsIGJyYW5jaCwgJ2xhdW5kcnknLCBsby5pZCwgcmVmLAogICAgICAgIENBU0UgV0hFTiBjb2FsZXNjZSgocmVzLT4+J29rJyk6OmJvb2xlYW4sZmFsc2UpIFRIRU4gJ3Bvc3RlZCcgRUxTRSAnYmxvY2tlZCcgRU5ELAogICAgICAgIGFtb3VudCwgcHVibGljLm5lb19mYWN0X2N1cnJlbmN5KG9yZywgYnJhbmNoKSwgbnVsbGlmKHJlcy0+Pidmb2xpb19saW5lX2lkJywnJyk6OnV1aWQsCiAgICAgICAgJ0NoYXJnZWQgdG8gdGhlIGd1ZXN0IGZvbGlvIC0gcmV2ZW51ZSBpcyByZWNvZ25pc2VkIG9uIHRoZSBmb2xpbyBjaGFyZ2UuJywgTlVMTCwgb2NjdXJyZWQpOwogICAgICBVUERBVEUgcHVibGljLmZpbmFuY2VfcG9zdGluZ19yZWNlaXB0cyBTRVQgcG9zdGluZ190eXBlID0gcG9zdGluZwogICAgICAgIFdIRVJFIG9yZ2FuaXphdGlvbl9pZCA9IG9yZyBBTkQgc291cmNlX21vZHVsZSA9ICdsYXVuZHJ5JyBBTkQgc291cmNlX2lkID0gbG8uaWQ7CiAgICAgIFJFVFVSTiBjb2FsZXNjZShyZXMsJ3t9Jzo6anNvbmIpIHx8IGpzb25iX2J1aWxkX29iamVjdCgncG9zdGluZ190eXBlJywgcG9zdGluZyk7CiAgICBFTkQgSUY7CiAgICB0YXggOj0gY29hbGVzY2UobG8udGF4X2Ftb3VudCwwKTsKICAgIHNldHRsZSA6PSBjb2FsZXNjZShwdWJsaWMubmVvX2dsX3NldHRsZW1lbnRfY29kZV9mb3Iob3JnLCAnY2FzaCcpLCAnMTAxMCcpOwogICAgbGluZXMgOj0ganNvbmJfYnVpbGRfYXJyYXkoCiAgICAgIGpzb25iX2J1aWxkX29iamVjdCgnY29kZScsIHNldHRsZSwgJ2RlYml0JywgYW1vdW50LCAnZGVzY3JpcHRpb24nLCAnTGF1bmRyeSAnIHx8IGNvYWxlc2NlKHJlZiwnJykpLAogICAgICBqc29uYl9idWlsZF9vYmplY3QoJ2NvZGUnLCBwdWJsaWMubmVvX2dsX3JldmVudWVfY29kZV9zY29wZWQob3JnLCAnbGF1bmRyeScsIE5VTEwpLCAnY3JlZGl0JywgYW1vdW50IC0gdGF4KSwKICAgICAganNvbmJfYnVpbGRfb2JqZWN0KCdjb2RlJywgJzIwNDAnLCAnY3JlZGl0JywgdGF4LCAnZGVzY3JpcHRpb24nLCAnVkFUJykpOwoKICBFTFNJRiBfc291cmNlX3R5cGUgPSAnc3VwcGxpZXJfaW52b2ljZScgVEhFTgogICAgU0VMRUNUICogSU5UTyBzaSBGUk9NIHB1YmxpYy5zdXBwbGllcl9pbnZvaWNlcwogICAgICBXSEVSRSBpZCA9IF9zb3VyY2VfaWQgQU5EIG9yZ2FuaXphdGlvbl9pZCA9IG9yZyBGT1IgVVBEQVRFOwogICAgSUYgc2kuaWQgSVMgTlVMTCBUSEVOIFJFVFVSTiBqc29uYl9idWlsZF9vYmplY3QoJ29rJywgZmFsc2UsICdyZWFzb24nLCAnbm90X2ZvdW5kJyk7IEVORCBJRjsKICAgIGJyYW5jaCA6PSBzaS5icmFuY2hfaWQ7IHJlZiA6PSBzaS5pbnZvaWNlX251bWJlcjsgb2NjdXJyZWQgOj0gc2kuaW52b2ljZV9kYXRlOwogICAgYW1vdW50IDo9IGNvYWxlc2NlKHNpLmFtb3VudCwwKTsgdGF4IDo9IGNvYWxlc2NlKHNpLnRheF9hbW91bnQsMCk7IHBvc3RpbmcgOj0gJ3BheWFibGUnOwogICAgSUYgc2kuYXBwcm92ZWRfYXQgSVMgTlVMTCBPUiBzaS5zdGF0dXMgTk9UIElOICgnYXBwcm92ZWQnLCdtYXRjaGVkJywncGFydGlhbGx5X3BhaWQnLCdwYWlkJykgVEhFTgogICAgICBSRVRVUk4ganNvbmJfYnVpbGRfb2JqZWN0KCdvaycsIGZhbHNlLCAncmVhc29uJywgJ2luZWxpZ2libGVfbGlmZWN5Y2xlJywKICAgICAgICAnZGV0YWlsJywgJ09ubHkgYXBwcm92ZWQgc3VwcGxpZXIgaW52b2ljZXMgYmVjb21lIHBheWFibGVzLiBSZXF1ZXN0cyBhbmQgcHVyY2hhc2Ugb3JkZXJzIGRvIG5vdC4nKTsKICAgIEVORCBJRjsKICAgIGxpbmVzIDo9IGpzb25iX2J1aWxkX2FycmF5KAogICAgICBqc29uYl9idWlsZF9vYmplY3QoJ2NvZGUnLCAnMTA3MCcsICdkZWJpdCcsIGFtb3VudCAtIHRheCwgJ2Rlc2NyaXB0aW9uJywgJ0dvb2RzIC8gc2VydmljZXMgcmVjZWl2ZWQnKSwKICAgICAganNvbmJfYnVpbGRfb2JqZWN0KCdjb2RlJywgJzIwNDAnLCAnZGViaXQnLCB0YXgsICdkZXNjcmlwdGlvbicsICdJbnB1dCBWQVQnKSwKICAgICAganNvbmJfYnVpbGRfb2JqZWN0KCdjb2RlJywgJzIwMTAnLCAnY3JlZGl0JywgYW1vdW50LCAnZGVzY3JpcHRpb24nLCAnU3VwcGxpZXIgaW52b2ljZSAnIHx8IGNvYWxlc2NlKHJlZiwnJykpKTsKCiAgRUxTSUYgX3NvdXJjZV90eXBlID0gJ3N1cHBsaWVyX3BheW1lbnQnIFRIRU4KICAgIFNFTEVDVCAqIElOVE8gc3AgRlJPTSBwdWJsaWMuc3VwcGxpZXJfcGF5bWVudHMKICAgICAgV0hFUkUgaWQgPSBfc291cmNlX2lkIEFORCBvcmdhbml6YXRpb25faWQgPSBvcmcgRk9SIFVQREFURTsKICAgIElGIHNwLmlkIElTIE5VTEwgVEhFTiBSRVRVUk4ganNvbmJfYnVpbGRfb2JqZWN0KCdvaycsIGZhbHNlLCAncmVhc29uJywgJ25vdF9mb3VuZCcpOyBFTkQgSUY7CiAgICBicmFuY2ggOj0gc3AuYnJhbmNoX2lkOyByZWYgOj0gc3AucGF5bWVudF9udW1iZXI7IG9jY3VycmVkIDo9IHNwLnBhaWRfb247CiAgICBhbW91bnQgOj0gY29hbGVzY2Uoc3AuYW1vdW50LDApOyBwb3N0aW5nIDo9ICdwYXlhYmxlX3BheW1lbnQnOwogICAgSUYgc3Auc3RhdHVzIE5PVCBJTiAoJ3BhaWQnLCdjb21wbGV0ZWQnLCdzZXR0bGVkJykgVEhFTgogICAgICBSRVRVUk4ganNvbmJfYnVpbGRfb2JqZWN0KCdvaycsIGZhbHNlLCAncmVhc29uJywgJ2luZWxpZ2libGVfbGlmZWN5Y2xlJyk7CiAgICBFTkQgSUY7CiAgICAtLSBNb25leSBsZWF2ZXMgdGhlIGFjY291bnQgdGhlIGhvdGVsIGFjdHVhbGx5IHBhaWQgZnJvbS4KICAgIGxpbmVzIDo9IGpzb25iX2J1aWxkX2FycmF5KAogICAgICBqc29uYl9idWlsZF9vYmplY3QoJ2NvZGUnLCAnMjAxMCcsICdkZWJpdCcsIGFtb3VudCwgJ2Rlc2NyaXB0aW9uJywgJ1N1cHBsaWVyIHBheW1lbnQgJyB8fCBjb2FsZXNjZShyZWYsJycpKSwKICAgICAganNvbmJfYnVpbGRfb2JqZWN0KCdjb2RlJywgcHVibGljLm5lb19nbF9hY2NvdW50X2NvZGUob3JnLCBzcC5tZXRob2QsIHNwLmJhbmtfYWNjb3VudF9pZCksCiAgICAgICAgICAgICAgICAgICAgICAgICAnY3JlZGl0JywgYW1vdW50KSk7CgogIEVMU0UKICAgIFJFVFVSTiBqc29uYl9idWlsZF9vYmplY3QoJ29rJywgZmFsc2UsICdyZWFzb24nLCAndW5rbm93bl9zb3VyY2VfdHlwZScpOwogIEVORCBJRjsKCiAgY3VyIDo9IHB1YmxpYy5uZW9fZmFjdF9jdXJyZW5jeShvcmcsIGJyYW5jaCk7CiAgb2NjdXJyZWQgOj0gY29hbGVzY2Uob2NjdXJyZWQsIChub3coKSBBVCBUSU1FIFpPTkUgcHVibGljLm5lb19mYWN0X3RpbWV6b25lKG9yZywgYnJhbmNoKSk6OmRhdGUpOwogIGtleSA6PSBfc291cmNlX3R5cGUgfHwgJzonIHx8IF9zb3VyY2VfaWQ6OnRleHQgfHwgJzonIHx8IHBvc3Rpbmc7CgogIHJlcyA6PSBwdWJsaWMubmVvX2dsX3Bvc3Qob3JnLCBicmFuY2gsIHNwbGl0X3BhcnQoX3NvdXJjZV90eXBlLCdfJywxKSwgX3NvdXJjZV90eXBlLCBfc291cmNlX2lkLAogICAgICAgICAgICAgICAgICAgICAgICAgICAgcG9zdGluZywgb2NjdXJyZWQsIGN1ciwKICAgICAgICAgICAgICAgICAgICAgICAgICAgIGluaXRjYXAocmVwbGFjZShfc291cmNlX3R5cGUsJ18nLCcgJykpIHx8ICcgJyB8fCBjb2FsZXNjZShyZWYsJycpLAogICAgICAgICAgICAgICAgICAgICAgICAgICAgbGluZXMsIGN1c3RvbWVyLCBOVUxMKTsKCiAgLS0gQSBkdXBsaWNhdGUga2V5IG9yIG9rIGZsYWcgYWxvbmUgaXMgbm90IGV2aWRlbmNlIG9mIGEgY29tcGxldGVkIHBvc3RpbmcuCiAgSUYgcmVzLT4+J29rJyBJUyBESVNUSU5DVCBGUk9NICd0cnVlJyBPUiBOT1QgRVhJU1RTKAogICAgU0VMRUNUIDEgRlJPTSBwdWJsaWMuam91cm5hbF9lbnRyaWVzIGoKICAgIENST1NTIEpPSU4gTEFURVJBTChTRUxFQ1QgY29hbGVzY2Uoc3VtKGwuZGViaXQpLDApIEFTIGQsY29hbGVzY2Uoc3VtKGwuY3JlZGl0KSwwKSBBUyBjCiAgICAgIEZST00gcHVibGljLmpvdXJuYWxfZW50cnlfbGluZXMgbCBXSEVSRSBsLmpvdXJuYWxfaWQ9ai5pZCkgYWN0dWFsCiAgICBXSEVSRSBqLmlkPW51bGxpZihyZXMtPj4nam91cm5hbF9pZCcsJycpOjp1dWlkIEFORCBqLm9yZ2FuaXphdGlvbl9pZD1vcmcKICAgICAgQU5EIGouYnJhbmNoX2lkIElTIE5PVCBESVNUSU5DVCBGUk9NIGJyYW5jaCBBTkQgai5zdGF0dXM9J3Bvc3RlZCcKICAgICAgQU5EIGoucmV2ZXJzZWRfYnlfam91cm5hbF9pZCBJUyBOVUxMIEFORCBqLmN1cnJlbmN5PWN1cgogICAgICBBTkQgai5zb3VyY2VfZG9jdW1lbnRfaWQ9X3NvdXJjZV9pZCBBTkQgai5zb3VyY2VfZG9jdW1lbnRfdHlwZT1fc291cmNlX3R5cGV8fCc6J3x8cG9zdGluZwogICAgICBBTkQgYWN0dWFsLmQ9cm91bmQoYW1vdW50LDIpIEFORCBhY3R1YWwuYz1yb3VuZChhbW91bnQsMikKICAgICAgQU5EIGoudG90YWxfZGViaXQ9YWN0dWFsLmQgQU5EIGoudG90YWxfY3JlZGl0PWFjdHVhbC5jCiAgICAgIEFORCBOT1QgRVhJU1RTKFNFTEVDVCAxIEZST00gcHVibGljLmpvdXJuYWxfZW50cnlfbGluZXMgbCBXSEVSRSBsLmpvdXJuYWxfaWQ9ai5pZAogICAgICAgIEFORCAobC5vcmdhbml6YXRpb25faWQgSVMgRElTVElOQ1QgRlJPTSBvcmcgT1IgbC5icmFuY2hfaWQgSVMgRElTVElOQ1QgRlJPTSBicmFuY2gpKQogICkgVEhFTgogICAgUkFJU0UgRVhDRVBUSU9OICdQb3N0aW5nIGRpZCBub3QgcHJvZHVjZSBhIG1hdGNoaW5nIGJhbGFuY2VkIHBvc3RlZCBqb3VybmFsJyBVU0lORyBFUlJDT0RFPScyMzUxNCc7CiAgRU5EIElGOwoKICBJRiBfc291cmNlX3R5cGU9J3Bvc19vcmRlcicgQU5EIEVYSVNUUygKICAgIFdJVEggd2FudGVkIEFTICgKICAgICAgU0VMRUNUIHZhbHVlLT4+J2NvZGUnIGNvZGUsc3VtKHJvdW5kKGNvYWxlc2NlKCh2YWx1ZS0+PidkZWJpdCcpOjpudW1lcmljLDApLDIpKSBkZWJpdCxzdW0ocm91bmQoY29hbGVzY2UoKHZhbHVlLT4+J2NyZWRpdCcpOjpudW1lcmljLDApLDIpKSBjcmVkaXQKICAgICAgRlJPTSBqc29uYl9hcnJheV9lbGVtZW50cyhsaW5lcykgR1JPVVAgQlkgMQogICAgKSwgYWN0dWFsIEFTICgKICAgICAgU0VMRUNUIGEuY29kZSxzdW0obC5kZWJpdCkgZGViaXQsc3VtKGwuY3JlZGl0KSBjcmVkaXQgRlJPTSBwdWJsaWMuam91cm5hbF9lbnRyeV9saW5lcyBsIEpPSU4gcHVibGljLmNoYXJ0X29mX2FjY291bnRzIGEgT04gYS5pZD1sLmFjY291bnRfaWQKICAgICAgV0hFUkUgbC5qb3VybmFsX2lkPShyZXMtPj4nam91cm5hbF9pZCcpOjp1dWlkIEdST1VQIEJZIGEuY29kZQogICAgKSBTRUxFQ1QgMSBGUk9NIHdhbnRlZCB3IEZVTEwgSk9JTiBhY3R1YWwgYSBVU0lORyhjb2RlKQogICAgICBXSEVSRSBjb2FsZXNjZSh3LmRlYml0LDApPD5jb2FsZXNjZShhLmRlYml0LDApIE9SIGNvYWxlc2NlKHcuY3JlZGl0LDApPD5jb2FsZXNjZShhLmNyZWRpdCwwKQogICkgVEhFTiBSQUlTRSBFWENFUFRJT04gJ0V4aXN0aW5nIFBPUyBqb3VybmFsIGRpZmZlcnMgZnJvbSB0aGUgc2F2ZWQgcmVjZWlwdCBhY2NvdW50IHNwbGl0OyByZWNvbmNpbGUgYmVmb3JlIHJldXNlJzsgRU5EIElGOwogIFBFUkZPUk0gcHVibGljLm5lb19yZWNvcmRfcG9zdGluZ19yZWNlaXB0KG9yZywgYnJhbmNoLCBfc291cmNlX3R5cGUsIF9zb3VyY2VfaWQsIHJlZiwKICAgICdwb3N0ZWQnLCBhbW91bnQsIGN1ciwgTlVMTCwKICAgIENBU0UgV0hFTiBjb2FsZXNjZSgocmVzLT4+J2R1cGxpY2F0ZV9wcmV2ZW50ZWQnKTo6Ym9vbGVhbixmYWxzZSkKICAgICAgICAgVEhFTiAnRHVwbGljYXRlIHJlcGxheSBwcmV2ZW50ZWQgLSB0aGUgZXhpc3Rpbmcgam91cm5hbCB3YXMgcmV1c2VkLicKICAgICAgICAgRUxTRSAnUG9zdGVkIHRvIGpvdXJuYWwgJyB8fCAocmVzLT4+J2pvdXJuYWxfaWQnKSBFTkQsCiAgICBOVUxMLCBvY2N1cnJlZCk7CgogIFVQREFURSBwdWJsaWMuZmluYW5jZV9wb3N0aW5nX3JlY2VpcHRzCiAgICAgU0VUIHBvc3RpbmdfdHlwZSA9IHBvc3RpbmcsIGpvdXJuYWxfaWQgPSAocmVzLT4+J2pvdXJuYWxfaWQnKTo6dXVpZAogICBXSEVSRSBvcmdhbml6YXRpb25faWQgPSBvcmcgQU5EIHNvdXJjZV9tb2R1bGUgPSBfc291cmNlX3R5cGUgQU5EIHNvdXJjZV9pZCA9IF9zb3VyY2VfaWQ7CgogIFBFUkZPUk0gcHVibGljLmVtaXRfZG9tYWluX2V2ZW50KG9yZywgYnJhbmNoLCAnZmluYW5jZS5wb3N0ZWQnLCBfc291cmNlX3R5cGUsIF9zb3VyY2VfaWQsCiAgICBqc29uYl9idWlsZF9vYmplY3QoJ3Bvc3RpbmdfdHlwZScsIHBvc3RpbmcsICdhbW91bnQnLCBhbW91bnQsICdjdXJyZW5jeScsIGN1ciwKICAgICAgICAgICAgICAgICAgICAgICAnam91cm5hbF9pZCcsIHJlcy0+Pidqb3VybmFsX2lkJywgJ29jY3VycmVkX29uJywgb2NjdXJyZWQpLAogICAgJ2ZpbmFuY2UucG9zdGVkOicgfHwga2V5LCBjdXN0b21lcik7CgogIFJFVFVSTiByZXMgfHwganNvbmJfYnVpbGRfb2JqZWN0KCdzb3VyY2VfdHlwZScsIF9zb3VyY2VfdHlwZSwgJ3NvdXJjZV9pZCcsIF9zb3VyY2VfaWQsCiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgJ3Bvc3RpbmdfdHlwZScsIHBvc3RpbmcsICdhbW91bnQnLCBhbW91bnQpOwpFWENFUFRJT04gV0hFTiBPVEhFUlMgVEhFTgogIFBFUkZPUk0gcHVibGljLm5lb19yZWNvcmRfcG9zdGluZ19yZWNlaXB0KG9yZywgYnJhbmNoLCBfc291cmNlX3R5cGUsIF9zb3VyY2VfaWQsIHJlZiwKICAgICdmYWlsZWQnLCBhbW91bnQsIGNvYWxlc2NlKGN1ciwnS0VTJyksIE5VTEwsIE5VTEwsIFNRTEVSUk0sIG9jY3VycmVkKTsKICBJRiBfc2lsZW50IFRIRU4gUkVUVVJOIGpzb25iX2J1aWxkX29iamVjdCgnb2snLCBmYWxzZSwgJ3JlYXNvbicsICdmYWlsZWQnLCAnZGV0YWlsJywgU1FMRVJSTSk7IEVORCBJRjsKICBSQUlTRTsKRU5EICRmdW5jdGlvbiQ7Cg==",
      "base64"
    ).toString("utf8");

    await db.exec(sql);
  }

  it("executes canonical Finance transaction posting with progressive allocation", async () => {
    await withCanonicalFinance(async () => {
      await installCanonicalFinanceTransaction();

      const charge = await addNight(1);

      await removeFixtureRevenueJournal(charge);

      expect(
        await connectedAccommodationCharge(charge)
      ).toMatchObject({
        ok:true,
        allocated:19000
      });

      expect(await remaining()).toBe(31000);

      expect(
        await integratedAccountBalance("2020")
      ).toBe(-31000);

      expect(
        await integratedAccountBalance("1060")
      ).toBe(0);

      expect(
        await integratedAccountBalance("4010")
      ).toBe(-19000);

      const receipt = await db.query<{
        status: string;
        posting_type: string;
        journal_id: string;
      }>(
        `SELECT status,posting_type,journal_id
         FROM public.finance_posting_receipts
         WHERE source_module='folio_charge'
           AND source_id=$1`,
        [charge]
      );

      expect(receipt.rows).toHaveLength(1);

      expect(receipt.rows[0]).toMatchObject({
        status:"posted",
        posting_type:"revenue"
      });

      expect(
        receipt.rows[0]!.journal_id
      ).toBeTruthy();
    });
  });

  it("reconciles all three nights through the canonical Finance transaction", async () => {
    await withCanonicalFinance(async () => {
      await installCanonicalFinanceTransaction();

      const expected = [
        {night:1,applied:19000,remaining:31000},
        {night:2,applied:19000,remaining:12000},
        {night:3,applied:12000,remaining:0}
      ];

      for (const entry of expected) {

        const charge = await addNight(entry.night);

        await removeFixtureRevenueJournal(charge);

        expect(
          (await connectedAccommodationCharge(charge)).allocated
        ).toBe(entry.applied);

        expect(await remaining()).toBe(
          entry.remaining
        );

        expect(
          await integratedAccountBalance("2020")
        ).toBe(-entry.remaining || 0);
      }

      expect(await position()).toEqual({
        balance:7000,
        payments:50000
      });

      expect(
        await integratedAccountBalance("2020")
      ).toBe(0);

      expect(
        await integratedAccountBalance("1060")
      ).toBe(7000);

      expect(
        await integratedAccountBalance("4010")
      ).toBe(-57000);

      expect(
        await integratedAccountBalance("1010")
      ).toBe(50000);

      const receipts = await db.query<{ n: number }>(`
        SELECT count(*)::int AS n
        FROM public.finance_posting_receipts
        WHERE source_module='folio_charge'
          AND status='posted'
          AND journal_id IS NOT NULL
      `);

      expect(receipts.rows[0]!.n).toBe(3);
    });
  });

  it("preserves Finance receipt and journal idempotency on connected replay", async () => {
    await withCanonicalFinance(async () => {
      await installCanonicalFinanceTransaction();

      const charge = await addNight(1);

      await removeFixtureRevenueJournal(charge);

      await connectedAccommodationCharge(charge);
      await connectedAccommodationCharge(charge);

      expect(await remaining()).toBe(31000);

      const evidence = await db.query<{
        journals: number;
        receipts: number;
        events: number;
      }>(
        `SELECT
          (
            SELECT count(*)::int
            FROM public.journal_entries
            WHERE source_document_id=$1
              AND source_document_type='folio_charge:revenue'
              AND status='posted'
          ) AS journals,
          (
            SELECT count(*)::int
            FROM public.finance_posting_receipts
            WHERE source_id=$1
              AND source_module='folio_charge'
              AND status='posted'
          ) AS receipts,
          (
            SELECT count(*)::int
            FROM public.test_finance_domain_events
            WHERE source_id=$1
              AND event_name='finance.posted'
          ) AS events`,
        [charge]
      );

      expect(evidence.rows[0]).toEqual({
        journals:1,
        receipts:1,
        events:1
      });
    });
  });

  it("rejects the actual closed accounting period without releasing deposit liability", async () => {
    await withCanonicalFinance(async () => {
      await installCanonicalFinanceTransaction();

      const charge = await addNight(1);

      await removeFixtureRevenueJournal(charge);

      await db.exec(`
        UPDATE public.accounting_periods
        SET status='closed'
      `);

      await db.exec("SAVEPOINT finance_rejection");

      try {

        await expect(
          connectedAccommodationCharge(charge)
        ).rejects.toThrow(
          /Accommodation revenue posting failed:.*accounting period.*closed/i
        );

      } finally {

        await db.exec(
          "ROLLBACK TO SAVEPOINT finance_rejection"
        );
      }

      expect(await remaining()).toBe(50000);

      expect(await position()).toEqual({
        balance:19000,
        payments:0
      });

      expect(
        await integratedAccountBalance("2020")
      ).toBe(-50000);

      expect(
        await integratedAccountBalance("4010")
      ).toBe(0);

      expect(
        await integratedAccountBalance("1060")
      ).toBe(0);
    });
  });


  // CANONICAL_ACCOMMODATION_LIFECYCLE_V1
  //
  // Actual scoped accommodation posting function
  // connected to canonical Finance and progressive
  // deposit allocation in the isolated fixture.

  async function installAccommodationLifecycle() {

    await db.exec(`
      ALTER TABLE public.reservations
        ADD COLUMN IF NOT EXISTS status text,
        ADD COLUMN IF NOT EXISTS arrival_date date,
        ADD COLUMN IF NOT EXISTS departure_date date,
        ADD COLUMN IF NOT EXISTS nightly_rate numeric,
        ADD COLUMN IF NOT EXISTS rate_plan_id uuid,
        ADD COLUMN IF NOT EXISTS room_id uuid,
        ADD COLUMN IF NOT EXISTS room_type_id uuid,
        ADD COLUMN IF NOT EXISTS adults integer DEFAULT 1,
        ADD COLUMN IF NOT EXISTS children integer DEFAULT 0;

      ALTER TABLE public.folios
        ADD COLUMN IF NOT EXISTS stay_id uuid,
        ADD COLUMN IF NOT EXISTS total_charges numeric DEFAULT 0,
        ADD COLUMN IF NOT EXISTS total_taxes numeric DEFAULT 0,
        ADD COLUMN IF NOT EXISTS total_discounts numeric DEFAULT 0;

      CREATE TABLE IF NOT EXISTS public.branches (
        id uuid PRIMARY KEY,
        organization_id uuid NOT NULL
      );

      CREATE TABLE IF NOT EXISTS public.business_days (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        organization_id uuid NOT NULL,
        branch_id uuid NOT NULL,
        business_date date NOT NULL,
        status text NOT NULL,
        UNIQUE(
          organization_id,
          branch_id,
          business_date
        )
      );

      CREATE TABLE IF NOT EXISTS public.rooms (
        id uuid PRIMARY KEY,
        organization_id uuid,
        branch_id uuid,
        room_number text,
        room_type_id uuid
      );

      CREATE TABLE IF NOT EXISTS public.rate_plans (
        id uuid PRIMARY KEY,
        organization_id uuid,
        branch_id uuid,
        tax_rate numeric DEFAULT 0,
        service_charge_rate numeric DEFAULT 0,
        tax_treatment text DEFAULT 'inclusive'
      );

      CREATE TABLE IF NOT EXISTS public.stays (
        id uuid PRIMARY KEY,
        organization_id uuid NOT NULL,
        branch_id uuid NOT NULL,
        reservation_id uuid NOT NULL,
        room_id uuid,
        status text,
        arrival_date date,
        departure_date date,
        check_in_at timestamptz DEFAULT now(),
        check_out_at timestamptz
      );

      CREATE TABLE public.test_package_posting_evidence (
        folio_line_id uuid PRIMARY KEY,
        source text NOT NULL
      );

      CREATE OR REPLACE FUNCTION
      public.pkg_allocate_folio_line(
        _line uuid,
        _source text DEFAULT 'manual'
      )
      RETURNS jsonb
      LANGUAGE plpgsql
      AS $package$
      BEGIN

        INSERT INTO
          public.test_package_posting_evidence
        VALUES (
          _line,
          _source
        )
        ON CONFLICT DO NOTHING;

        RETURN jsonb_build_object(
          'allocated',1,
          'balanced',true
        );

      END;
      $package$;

      CREATE OR REPLACE FUNCTION
      public.has_permission(text,text)
      RETURNS boolean LANGUAGE sql STABLE AS $$
        SELECT $1='pms'
          AND $2='folios.post_charge'
      $$;

      INSERT INTO public.branches (
        id,organization_id
      )
      SELECT DISTINCT
        branch_id,organization_id
      FROM public.reservations
      ON CONFLICT DO NOTHING;

      INSERT INTO public.business_days (
        organization_id,
        branch_id,
        business_date,
        status
      )
      SELECT DISTINCT
        r.organization_id,
        r.branch_id,
        (now() AT TIME ZONE 'Africa/Nairobi')::date,
        'open'
      FROM public.reservations r
      ON CONFLICT DO NOTHING;

      UPDATE public.reservations
      SET
        status='checked-in',
        nightly_rate=19000,
        arrival_date=
          (now() AT TIME ZONE 'Africa/Nairobi')::date-2,
        departure_date=
          (now() AT TIME ZONE 'Africa/Nairobi')::date+1;

      INSERT INTO public.rooms (
        id,organization_id,branch_id,room_number
      )
      SELECT
        gen_random_uuid(),
        organization_id,
        branch_id,
        'TEST-ROOM'
      FROM public.reservations;

      UPDATE public.reservations r
      SET room_id=(
        SELECT rm.id
        FROM public.rooms rm
        WHERE rm.organization_id=r.organization_id
          AND rm.branch_id=r.branch_id
        LIMIT 1
      );

      INSERT INTO public.rate_plans (
        id,organization_id,branch_id,
        tax_rate,service_charge_rate,tax_treatment
      )
      SELECT
        gen_random_uuid(),
        organization_id,
        branch_id,
        0,0,'inclusive'
      FROM public.reservations;

      UPDATE public.reservations r
      SET rate_plan_id=(
        SELECT rp.id
        FROM public.rate_plans rp
        WHERE rp.organization_id=r.organization_id
          AND rp.branch_id=r.branch_id
        LIMIT 1
      );

      INSERT INTO public.stays (
        id,
        organization_id,
        branch_id,
        reservation_id,
        room_id,
        status,
        arrival_date,
        departure_date
      )
      SELECT
        gen_random_uuid(),
        organization_id,
        branch_id,
        id,
        room_id,
        'in-house',
        arrival_date,
        departure_date
      FROM public.reservations;

      UPDATE public.folios f
      SET stay_id=(
        SELECT s.id
        FROM public.stays s
        WHERE s.reservation_id=f.reservation_id
          AND s.organization_id=f.organization_id
          AND s.branch_id=f.branch_id
        LIMIT 1
      );
    `);

    const accommodationSQL = Buffer.from(
      "Q1JFQVRFIE9SIFJFUExBQ0UgRlVOQ1RJT04gcHVibGljLnBtc19wb3N0X2FjY29tbW9kYXRpb25fc2NvcGVkKF9icmFuY2ggdXVpZCwgX29wZXJhdGlvbmFsX2RhdGUgZGF0ZSBERUZBVUxUIENVUlJFTlRfREFURSkKIFJFVFVSTlMgaW50ZWdlcgogTEFOR1VBR0UgcGxwZ3NxbAogU0VDVVJJVFkgREVGSU5FUgogU0VUIHNlYXJjaF9wYXRoIFRPICdwdWJsaWMnCkFTICRmdW5jdGlvbiQKREVDTEFSRSBfb3JnIHV1aWQgOj0gcHVibGljLmN1cnJlbnRfb3JnX2lkKCk7IF9yIHJlY29yZDsgX24gaW50ZWdlciA6PSAwOyBfdGF4IG51bWVyaWM7IF9zdmMgbnVtZXJpYzsgX2xpbmUgdXVpZDsKQkVHSU4KICAKICBJRiBhdXRoLnVpZCgpIElTIE5VTEwgT1IgX29yZyBJUyBOVUxMIFRIRU4KICAgIFJBSVNFIEVYQ0VQVElPTiAnQXV0aGVudGljYXRlZCB3b3Jrc3BhY2UgcmVxdWlyZWQnCiAgICAgIFVTSU5HIEVSUkNPREU9JzQyNTAxJzsKICBFTkQgSUY7CgogIElGIF9icmFuY2ggSVMgTlVMTCBPUiBfb3BlcmF0aW9uYWxfZGF0ZSBJUyBOVUxMIFRIRU4KICAgIFJBSVNFIEVYQ0VQVElPTiAnUHJvcGVydHkgYW5kIG9wZXJhdGlvbmFsIGRhdGUgYXJlIHJlcXVpcmVkJzsKICBFTkQgSUY7CgogIElGIHB1YmxpYy5oYXNfcGVybWlzc2lvbigKICAgICAgJ3BtcycsJ2ZvbGlvcy5wb3N0X2NoYXJnZScKICApIElTIE5PVCBUUlVFIFRIRU4KICAgIFJBSVNFIEVYQ0VQVElPTiAnTm90IHBlcm1pdHRlZCB0byBwb3N0IGFjY29tbW9kYXRpb24nCiAgICAgIFVTSU5HIEVSUkNPREU9JzQyNTAxJzsKICBFTkQgSUY7CgogIElGIE5PVCBFWElTVFMgKAogICAgU0VMRUNUIDEKICAgIEZST00gcHVibGljLmJyYW5jaGVzIGIKICAgIFdIRVJFIGIuaWQ9X2JyYW5jaAogICAgICBBTkQgYi5vcmdhbml6YXRpb25faWQ9X29yZwogICkgVEhFTgogICAgUkFJU0UgRVhDRVBUSU9OICdVbmtub3duIHByb3BlcnR5JwogICAgICBVU0lORyBFUlJDT0RFPSc0MjUwMSc7CiAgRU5EIElGOwoKICBJRiBwdWJsaWMubmVvX2JyYW5jaF9pbl9zY29wZShfYnJhbmNoKSBJUyBOT1QgVFJVRQogICAgIEFORCBwdWJsaWMuaXNfb3JnX2FkbWluKCkgSVMgTk9UIFRSVUUgVEhFTgogICAgUkFJU0UgRVhDRVBUSU9OICdQcm9wZXJ0eSBvdXRzaWRlIHBlcm1pdHRlZCBzY29wZScKICAgICAgVVNJTkcgRVJSQ09ERT0nNDI1MDEnOwogIEVORCBJRjsKCiAgLS0gS2VueWEtbG9jYWwgY2FsZW5kYXIgZ3VhcmQuIFZlcmlmeSBwcm9wZXJ0eSB0aW1lem9uZSBwb2xpY3kKICAtLSBiZWZvcmUgZW5hYmxpbmcgdGhpcyBvcGVyYXRpb24gZm9yIG90aGVyIHRpbWV6b25lcy4KICBJRiBfb3BlcmF0aW9uYWxfZGF0ZSA+CiAgICAgKG5vdygpIEFUIFRJTUUgWk9ORSAnQWZyaWNhL05haXJvYmknKTo6ZGF0ZSBUSEVOCiAgICBSQUlTRSBFWENFUFRJT04gJ0Z1dHVyZSBhY2NvbW1vZGF0aW9uIHBvc3RpbmcgaXMgcHJvaGliaXRlZCc7CiAgRU5EIElGOwoKICAtLSBUaGUgcmVxdWVzdGVkIGRhdGUgbXVzdCBiZSB0aGUgcHJvcGVydHkncyBvcGVuIGJ1c2luZXNzIGRheS4KICBJRiBOT1QgRVhJU1RTICgKICAgIFNFTEVDVCAxCiAgICBGUk9NIHB1YmxpYy5idXNpbmVzc19kYXlzIGJkCiAgICBXSEVSRSBiZC5vcmdhbml6YXRpb25faWQ9X29yZwogICAgICBBTkQgYmQuYnJhbmNoX2lkPV9icmFuY2gKICAgICAgQU5EIGJkLmJ1c2luZXNzX2RhdGU9X29wZXJhdGlvbmFsX2RhdGUKICAgICAgQU5EIGJkLnN0YXR1cz0nb3BlbicKICApIFRIRU4KICAgIFJBSVNFIEVYQ0VQVElPTgogICAgICAnQWNjb21tb2RhdGlvbiBwb3N0aW5nIHJlcXVpcmVzIHRoZSBvcGVuIHByb3BlcnR5IGJ1c2luZXNzIGRheSc7CiAgRU5EIElGOwoKICAtLSBDb29yZGluYXRlIHdpdGggbmVvX2Nsb3NlX2J1c2luZXNzX2RheSBhbmQgbmVvX29wZW5fYnVzaW5lc3NfZGF5LgogIC0tIEFjcXVpcmUgdGhlIHNoYXJlZCBidXNpbmVzcy1kYXkgbG9jayBiZWZvcmUgdGhlIGFjY29tbW9kYXRpb24gbG9jay4KICBQRVJGT1JNIHBnX2Fkdmlzb3J5X3hhY3RfbG9jaygKICAgIGhhc2h0ZXh0ZXh0ZW5kZWQoCiAgICAgICdidXNpbmVzcy1kYXk6JyB8fCBfb3JnOjp0ZXh0IHx8ICc6JyB8fCBfYnJhbmNoOjp0ZXh0LAogICAgICAwCiAgICApCiAgKTsKCiAgLS0gU2VyaWFsaXplIGFsbCByZXF1ZXN0cyBmb3IgdGhlIHNhbWUgcHJvcGVydHkgYW5kIG5pZ2h0LgogIFBFUkZPUk0gcGdfYWR2aXNvcnlfeGFjdF9sb2NrKAogICAgaGFzaHRleHRleHRlbmRlZCgKICAgICAgX29yZzo6dGV4dCB8fCAnOmFjY29tbW9kYXRpb246JyB8fAogICAgICBfYnJhbmNoOjp0ZXh0IHx8ICc6JyB8fAogICAgICBfb3BlcmF0aW9uYWxfZGF0ZTo6dGV4dCwKICAgICAgMAogICAgKQogICk7CgogIC0tIFJlY2hlY2sgdW5kZXIgc2VyaWFsaXphdGlvbi4KICBJRiBOT1QgRVhJU1RTICgKICAgIFNFTEVDVCAxCiAgICBGUk9NIHB1YmxpYy5idXNpbmVzc19kYXlzIGJkCiAgICBXSEVSRSBiZC5vcmdhbml6YXRpb25faWQ9X29yZwogICAgICBBTkQgYmQuYnJhbmNoX2lkPV9icmFuY2gKICAgICAgQU5EIGJkLmJ1c2luZXNzX2RhdGU9X29wZXJhdGlvbmFsX2RhdGUKICAgICAgQU5EIGJkLnN0YXR1cz0nb3BlbicKICAgIEZPUiBVUERBVEUKICApIFRIRU4KICAgIFJBSVNFIEVYQ0VQVElPTiAnQnVzaW5lc3MgZGF5IGNoYW5nZWQgZHVyaW5nIHBvc3RpbmcnOwogIEVORCBJRjsKCiAgSUYgTk9UIHB1YmxpYy5oYXNfcGVybWlzc2lvbigncG1zJywnZm9saW9zLnBvc3RfY2hhcmdlJykgVEhFTiBSQUlTRSBFWENFUFRJT04gJ05vdCBwZXJtaXR0ZWQgdG8gcG9zdCBjaGFyZ2VzJzsgRU5EIElGOwogIEZPUiBfciBJTgogICAgU0VMRUNUIHMuaWQgQVMgc3RheV9pZCwgcy5yZXNlcnZhdGlvbl9pZCwgZi5pZCBBUyBmb2xpb19pZCwgZi5icmFuY2hfaWQsIHJlcy5uaWdodGx5X3JhdGUsCiAgICAgICAgICAgQ09BTEVTQ0UocnAudGF4X3JhdGUsMCkgQVMgdGF4X3JhdGUsCiAgICAgICAgICAgIENPQUxFU0NFKHJwLnNlcnZpY2VfY2hhcmdlX3JhdGUsMCkgQVMgc2VydmljZV9jaGFyZ2VfcmF0ZSwKICAgICAgICAgICAgQ09BTEVTQ0UocnAudGF4X3RyZWF0bWVudCwnZXhjbHVzaXZlJykgQVMgdGF4X3RyZWF0bWVudCwKICAgICAgICAgICAgcm0ucm9vbV9udW1iZXIKICAgIEZST00gcHVibGljLnN0YXlzIHMKICAgIEpPSU4gcHVibGljLnJlc2VydmF0aW9ucyByZXMKICAgICAgICBPTiByZXMuaWQgPSBzLnJlc2VydmF0aW9uX2lkCiAgICAgICBBTkQgcmVzLm9yZ2FuaXphdGlvbl9pZCA9IHMub3JnYW5pemF0aW9uX2lkCiAgICAgICBBTkQgcmVzLmJyYW5jaF9pZCA9IHMuYnJhbmNoX2lkCiAgICBKT0lOIHB1YmxpYy5mb2xpb3MgZgogICAgICAgIE9OIGYuc3RheV9pZCA9IHMuaWQKICAgICAgIEFORCBmLm9yZ2FuaXphdGlvbl9pZCA9IHMub3JnYW5pemF0aW9uX2lkCiAgICAgICBBTkQgZi5icmFuY2hfaWQgPSBzLmJyYW5jaF9pZAogICAgICAgQU5EIGYucmVzZXJ2YXRpb25faWQgPSByZXMuaWQKICAgICAgIEFORCBmLmZvbGlvX3R5cGU9J2d1ZXN0JwogICAgICAgQU5EIGYuc3RhdHVzPSdvcGVuJwogICAgTEVGVCBKT0lOIHB1YmxpYy5yYXRlX3BsYW5zIHJwCiAgICAgICAgT04gcnAuaWQgPSByZXMucmF0ZV9wbGFuX2lkCiAgICAgICBBTkQgcnAub3JnYW5pemF0aW9uX2lkID0gcy5vcmdhbml6YXRpb25faWQKICAgICAgIEFORCAocnAuYnJhbmNoX2lkIElTIE5VTEwgT1IgcnAuYnJhbmNoX2lkID0gcy5icmFuY2hfaWQpCiAgICBKT0lOIHB1YmxpYy5yb29tcyBybQogICAgICAgIE9OIHJtLmlkID0gcy5yb29tX2lkCiAgICAgICBBTkQgcm0ub3JnYW5pemF0aW9uX2lkID0gcy5vcmdhbml6YXRpb25faWQKICAgICAgIEFORCBybS5icmFuY2hfaWQgPSBzLmJyYW5jaF9pZAogICAgV0hFUkUgcy5vcmdhbml6YXRpb25faWQ9X29yZyBBTkQgcy5icmFuY2hfaWQ9X2JyYW5jaAogICAgICAgIEFORCBzLnN0YXR1cz0naW4taG91c2UnCiAgICAgICAgQU5EIChyZXMucmF0ZV9wbGFuX2lkIElTIE5VTEwgT1IgcnAuaWQgSVMgTk9UIE5VTEwpCiAgICAgIEFORCBfb3BlcmF0aW9uYWxfZGF0ZSA+PSByZXMuYXJyaXZhbF9kYXRlIEFORCBfb3BlcmF0aW9uYWxfZGF0ZSA8IHJlcy5kZXBhcnR1cmVfZGF0ZQogIExPT1AKICAgIElGIF9yLnRheF90cmVhdG1lbnQgPSAnZXhjbHVzaXZlJyBUSEVOCiAgICAgIF9zdmMgOj0gcm91bmQoX3IubmlnaHRseV9yYXRlICogX3Iuc2VydmljZV9jaGFyZ2VfcmF0ZSAvIDEwMC4wLCAyKTsKICAgICAgX3RheCA6PSByb3VuZCgoX3IubmlnaHRseV9yYXRlICsgX3N2YykgKiBfci50YXhfcmF0ZSAvIDEwMC4wLCAyKTsKICAgIEVMU0UKICAgICAgX3N2YyA6PSAwOwogICAgICBfdGF4IDo9IDA7CiAgICBFTkQgSUY7CiAgICBCRUdJTgogICAgICBJTlNFUlQgSU5UTyBwdWJsaWMuZm9saW9fbGluZXMgKG9yZ2FuaXphdGlvbl9pZCwgYnJhbmNoX2lkLCBmb2xpb19pZCwgcmVzZXJ2YXRpb25faWQsIGxpbmVfdHlwZSwKICAgICAgICBjYXRlZ29yeSwgc291cmNlX21vZHVsZSwgZGVzY3JpcHRpb24sIG9wZXJhdGlvbmFsX2RhdGUsIHF1YW50aXR5LCB1bml0X3ByaWNlLAogICAgICAgIGdyb3NzX2Ftb3VudCwgdGF4X2Ftb3VudCwgc2VydmljZV9jaGFyZ2VfYW1vdW50LCBuZXRfYW1vdW50LCBwb3N0ZWRfYnkpCiAgICAgIFZBTFVFUyAoX29yZywgX3IuYnJhbmNoX2lkLCBfci5mb2xpb19pZCwgX3IucmVzZXJ2YXRpb25faWQsICdjaGFyZ2UnLCAnYWNjb21tb2RhdGlvbicsICdwbXMnLAogICAgICAgICdBY2NvbW1vZGF0aW9uIOKAlCByb29tICcgfHwgQ09BTEVTQ0UoX3Iucm9vbV9udW1iZXIsJycpIHx8ICcgwrcgJyB8fCBfb3BlcmF0aW9uYWxfZGF0ZTo6dGV4dCwKICAgICAgICBfb3BlcmF0aW9uYWxfZGF0ZSwgMSwgX3IubmlnaHRseV9yYXRlLCBfci5uaWdodGx5X3JhdGUsIF90YXgsIF9zdmMsCiAgICAgICAgX3IubmlnaHRseV9yYXRlICsgX3RheCArIF9zdmMsIGF1dGgudWlkKCkpCiAgICAgIFJFVFVSTklORyBpZCBJTlRPIF9saW5lOwogICAgICBVUERBVEUgcHVibGljLmZvbGlvcyBTRVQgdG90YWxfY2hhcmdlcyA9IHRvdGFsX2NoYXJnZXMgKyBfci5uaWdodGx5X3JhdGUsCiAgICAgICAgdG90YWxfdGF4ZXMgPSB0b3RhbF90YXhlcyArIF90YXgsCiAgICAgICAgYmFsYW5jZSA9IGJhbGFuY2UgKyBfci5uaWdodGx5X3JhdGUgKyBfdGF4ICsgX3N2YywKICAgICAgICB1cGRhdGVkX2F0PW5vdygpCiAgICAgIFdIRVJFIGlkPV9yLmZvbGlvX2lkOwogICAgICBQRVJGT1JNIHB1YmxpYy5wa2dfYWxsb2NhdGVfZm9saW9fbGluZShfbGluZSwgJ25pZ2h0LWF1ZGl0Jyk7CiAgICAgIF9uIDo9IF9uICsgMTsKICAgIEVYQ0VQVElPTiBXSEVOIHVuaXF1ZV92aW9sYXRpb24gVEhFTgogICAgICBOVUxMOwogICAgRU5EOwogIEVORCBMT09QOwogIFJFVFVSTiBfbjsKRU5EOyAkZnVuY3Rpb24kOwo=",
      "base64"
    ).toString("utf8");

    await db.exec(accommodationSQL);

    // Apply the production connection to the actual
    // scoped function without manufacturing a second
    // accommodation posting implementation.

    const definition = await db.query<{
      definition: string;
    }>(`
      SELECT pg_get_functiondef(
        'public.pms_post_accommodation_scoped(uuid,date)'
        ::regprocedure
      ) AS definition
    `);

    const current = definition.rows[0]!.definition;

    const anchor =
      "PERFORM public.pkg_allocate_folio_line(_line, 'night-audit');";

    if (current.split(anchor).length !== 2) {
      throw new Error(
        "Actual scoped accommodation connection boundary differs"
      );
    }

    const connected = current.replace(
      anchor,
      anchor + "\n" +
      "PERFORM public.neo_connect_accommodation_deposit(_line);"
    );

    await db.exec(connected);

    // ACCOMMODATION_LIFECYCLE_REPLAY_V3
    //
    // Install both actual accommodation functions
    // before executing the shared integrity migration.

    const scheduledJobSQL = Buffer.from(
      "Q1JFQVRFIE9SIFJFUExBQ0UgRlVOQ1RJT04gcHVibGljLm5lb19wbXNfcG9zdF9hY2NvbW1vZGF0aW9uX2pvYihfc2VydmljZV9vcmcgdXVpZCwgX2JyYW5jaCB1dWlkLCBfb3BlcmF0aW9uYWxfZGF0ZSBkYXRlIERFRkFVTFQgQ1VSUkVOVF9EQVRFKQogUkVUVVJOUyBpbnRlZ2VyCiBMQU5HVUFHRSBwbHBnc3FsCiBTRUNVUklUWSBERUZJTkVSCiBTRVQgc2VhcmNoX3BhdGggVE8gJ3B1YmxpYycKQVMgJGZ1bmN0aW9uJApERUNMQVJFIF9vcmcgdXVpZCA6PSBfc2VydmljZV9vcmc7IF9yIHJlY29yZDsgX24gaW50ZWdlciA6PSAwOyBfdGF4IG51bWVyaWM7IF9zdmMgbnVtZXJpYzsgX2xpbmUgdXVpZDsKQkVHSU4KICAKICAKICAtLSBUaGlzIGZ1bmN0aW9uIGlzIG5vdCBhbiBlbXBsb3llZS1mYWNpbmcgUlBDLgogIC0tIEl0cyBFWEVDVVRFIHByaXZpbGVnZSBpcyByZXN0cmljdGVkIHRvIHRoZSBkYXRhYmFzZSBvd25lci4KICBJRiBfc2VydmljZV9vcmcgSVMgTlVMTCBPUiBfYnJhbmNoIElTIE5VTEwKICAgICBPUiBfb3BlcmF0aW9uYWxfZGF0ZSBJUyBOVUxMIFRIRU4KICAgIFJBSVNFIEVYQ0VQVElPTiAnU2NoZWR1bGVkIHBvc3RpbmcgcmVxdWlyZXMgb3JnYW5pc2F0aW9uLCBwcm9wZXJ0eSBhbmQgZGF0ZSc7CiAgRU5EIElGOwoKICBJRiBOT1QgRVhJU1RTICgKICAgIFNFTEVDVCAxCiAgICBGUk9NIHB1YmxpYy5icmFuY2hlcyBiCiAgICBXSEVSRSBiLmlkID0gX2JyYW5jaAogICAgICBBTkQgYi5vcmdhbml6YXRpb25faWQgPSBfc2VydmljZV9vcmcKICApIFRIRU4KICAgIFJBSVNFIEVYQ0VQVElPTiAnU2NoZWR1bGVkIHBvc3RpbmcgcHJvcGVydHkgaXMgb3V0c2lkZSBpdHMgb3JnYW5pc2F0aW9uJzsKICBFTkQgSUY7CgogIElGIF9vcGVyYXRpb25hbF9kYXRlID4KICAgICAobm93KCkgQVQgVElNRSBaT05FICdBZnJpY2EvTmFpcm9iaScpOjpkYXRlIFRIRU4KICAgIFJBSVNFIEVYQ0VQVElPTiAnRnV0dXJlIHNjaGVkdWxlZCBhY2NvbW1vZGF0aW9uIHBvc3RpbmcgaXMgcHJvaGliaXRlZCc7CiAgRU5EIElGOwoKICAtLSBDb29yZGluYXRlIHdpdGggbm9ybWFsIGFjY29tbW9kYXRpb24gcG9zdGluZyBhbmQgZGF5IGNsb3N1cmUuCiAgUEVSRk9STSBwZ19hZHZpc29yeV94YWN0X2xvY2soCiAgICBoYXNodGV4dGV4dGVuZGVkKAogICAgICAnYnVzaW5lc3MtZGF5OicgfHwgX3NlcnZpY2Vfb3JnOjp0ZXh0IHx8ICc6JyB8fCBfYnJhbmNoOjp0ZXh0LAogICAgICAwCiAgICApCiAgKTsKCiAgUEVSRk9STSBwZ19hZHZpc29yeV94YWN0X2xvY2soCiAgICBoYXNodGV4dGV4dGVuZGVkKAogICAgICBfc2VydmljZV9vcmc6OnRleHQgfHwgJzphY2NvbW1vZGF0aW9uOicgfHwKICAgICAgX2JyYW5jaDo6dGV4dCB8fCAnOicgfHwgX29wZXJhdGlvbmFsX2RhdGU6OnRleHQsCiAgICAgIDAKICAgICkKICApOwoKICBJRiBOT1QgRVhJU1RTICgKICAgIFNFTEVDVCAxCiAgICBGUk9NIHB1YmxpYy5idXNpbmVzc19kYXlzIGJkCiAgICBXSEVSRSBiZC5vcmdhbml6YXRpb25faWQgPSBfc2VydmljZV9vcmcKICAgICAgQU5EIGJkLmJyYW5jaF9pZCA9IF9icmFuY2gKICAgICAgQU5EIGJkLmJ1c2luZXNzX2RhdGUgPSBfb3BlcmF0aW9uYWxfZGF0ZQogICAgICBBTkQgYmQuc3RhdHVzID0gJ29wZW4nCiAgICBGT1IgVVBEQVRFCiAgKSBUSEVOCiAgICBSQUlTRSBFWENFUFRJT04gJ1NjaGVkdWxlZCBhY2NvbW1vZGF0aW9uIHJlcXVpcmVzIGFuIG9wZW4gYnVzaW5lc3MgZGF5JzsKICBFTkQgSUY7CgogIEZPUiBfciBJTgogICAgU0VMRUNUIHMuaWQgQVMgc3RheV9pZCwgcy5yZXNlcnZhdGlvbl9pZCwgZi5pZCBBUyBmb2xpb19pZCwgZi5icmFuY2hfaWQsIHJlcy5uaWdodGx5X3JhdGUsCiAgICAgICAgICAgQ09BTEVTQ0UocnAudGF4X3JhdGUsMCkgQVMgdGF4X3JhdGUsCiAgICAgICAgICAgIENPQUxFU0NFKHJwLnNlcnZpY2VfY2hhcmdlX3JhdGUsMCkgQVMgc2VydmljZV9jaGFyZ2VfcmF0ZSwKICAgICAgICAgICAgQ09BTEVTQ0UocnAudGF4X3RyZWF0bWVudCwnZXhjbHVzaXZlJykgQVMgdGF4X3RyZWF0bWVudCwKICAgICAgICAgICAgcm0ucm9vbV9udW1iZXIKICAgIEZST00gcHVibGljLnN0YXlzIHMKICAgIEpPSU4gcHVibGljLnJlc2VydmF0aW9ucyByZXMKICAgICAgICBPTiByZXMuaWQgPSBzLnJlc2VydmF0aW9uX2lkCiAgICAgICBBTkQgcmVzLm9yZ2FuaXphdGlvbl9pZCA9IHMub3JnYW5pemF0aW9uX2lkCiAgICAgICBBTkQgcmVzLmJyYW5jaF9pZCA9IHMuYnJhbmNoX2lkCiAgICBKT0lOIHB1YmxpYy5mb2xpb3MgZgogICAgICAgIE9OIGYuc3RheV9pZCA9IHMuaWQKICAgICAgIEFORCBmLm9yZ2FuaXphdGlvbl9pZCA9IHMub3JnYW5pemF0aW9uX2lkCiAgICAgICBBTkQgZi5icmFuY2hfaWQgPSBzLmJyYW5jaF9pZAogICAgICAgQU5EIGYucmVzZXJ2YXRpb25faWQgPSByZXMuaWQKICAgICAgIEFORCBmLmZvbGlvX3R5cGU9J2d1ZXN0JwogICAgICAgQU5EIGYuc3RhdHVzPSdvcGVuJwogICAgTEVGVCBKT0lOIHB1YmxpYy5yYXRlX3BsYW5zIHJwCiAgICAgICAgT04gcnAuaWQgPSByZXMucmF0ZV9wbGFuX2lkCiAgICAgICBBTkQgcnAub3JnYW5pemF0aW9uX2lkID0gcy5vcmdhbml6YXRpb25faWQKICAgICAgIEFORCAocnAuYnJhbmNoX2lkIElTIE5VTEwgT1IgcnAuYnJhbmNoX2lkID0gcy5icmFuY2hfaWQpCiAgICBKT0lOIHB1YmxpYy5yb29tcyBybQogICAgICAgIE9OIHJtLmlkID0gcy5yb29tX2lkCiAgICAgICBBTkQgcm0ub3JnYW5pemF0aW9uX2lkID0gcy5vcmdhbml6YXRpb25faWQKICAgICAgIEFORCBybS5icmFuY2hfaWQgPSBzLmJyYW5jaF9pZAogICAgV0hFUkUgcy5vcmdhbml6YXRpb25faWQ9X29yZyBBTkQgcy5icmFuY2hfaWQ9X2JyYW5jaAogICAgICAgIEFORCBzLnN0YXR1cz0naW4taG91c2UnCiAgICAgICAgQU5EIChyZXMucmF0ZV9wbGFuX2lkIElTIE5VTEwgT1IgcnAuaWQgSVMgTk9UIE5VTEwpCiAgICAgIEFORCBfb3BlcmF0aW9uYWxfZGF0ZSA+PSByZXMuYXJyaXZhbF9kYXRlIEFORCBfb3BlcmF0aW9uYWxfZGF0ZSA8IHJlcy5kZXBhcnR1cmVfZGF0ZQogIExPT1AKICAgIElGIF9yLnRheF90cmVhdG1lbnQgPSAnZXhjbHVzaXZlJyBUSEVOCiAgICAgIF9zdmMgOj0gcm91bmQoX3IubmlnaHRseV9yYXRlICogX3Iuc2VydmljZV9jaGFyZ2VfcmF0ZSAvIDEwMC4wLCAyKTsKICAgICAgX3RheCA6PSByb3VuZCgoX3IubmlnaHRseV9yYXRlICsgX3N2YykgKiBfci50YXhfcmF0ZSAvIDEwMC4wLCAyKTsKICAgIEVMU0UKICAgICAgX3N2YyA6PSAwOwogICAgICBfdGF4IDo9IDA7CiAgICBFTkQgSUY7CiAgICBCRUdJTgogICAgICBJTlNFUlQgSU5UTyBwdWJsaWMuZm9saW9fbGluZXMgKG9yZ2FuaXphdGlvbl9pZCwgYnJhbmNoX2lkLCBmb2xpb19pZCwgcmVzZXJ2YXRpb25faWQsIGxpbmVfdHlwZSwKICAgICAgICBjYXRlZ29yeSwgc291cmNlX21vZHVsZSwgZGVzY3JpcHRpb24sIG9wZXJhdGlvbmFsX2RhdGUsIHF1YW50aXR5LCB1bml0X3ByaWNlLAogICAgICAgIGdyb3NzX2Ftb3VudCwgdGF4X2Ftb3VudCwgc2VydmljZV9jaGFyZ2VfYW1vdW50LCBuZXRfYW1vdW50LCBwb3N0ZWRfYnkpCiAgICAgIFZBTFVFUyAoX29yZywgX3IuYnJhbmNoX2lkLCBfci5mb2xpb19pZCwgX3IucmVzZXJ2YXRpb25faWQsICdjaGFyZ2UnLCAnYWNjb21tb2RhdGlvbicsICdwbXMnLAogICAgICAgICdBY2NvbW1vZGF0aW9uIOKAlCByb29tICcgfHwgQ09BTEVTQ0UoX3Iucm9vbV9udW1iZXIsJycpIHx8ICcgwrcgJyB8fCBfb3BlcmF0aW9uYWxfZGF0ZTo6dGV4dCwKICAgICAgICBfb3BlcmF0aW9uYWxfZGF0ZSwgMSwgX3IubmlnaHRseV9yYXRlLCBfci5uaWdodGx5X3JhdGUsIF90YXgsIF9zdmMsCiAgICAgICAgX3IubmlnaHRseV9yYXRlICsgX3RheCArIF9zdmMsIE5VTEw6OnV1aWQpCiAgICAgIFJFVFVSTklORyBpZCBJTlRPIF9saW5lOwogICAgICBVUERBVEUgcHVibGljLmZvbGlvcyBTRVQgdG90YWxfY2hhcmdlcyA9IHRvdGFsX2NoYXJnZXMgKyBfci5uaWdodGx5X3JhdGUsCiAgICAgICAgdG90YWxfdGF4ZXMgPSB0b3RhbF90YXhlcyArIF90YXgsCiAgICAgICAgYmFsYW5jZSA9IGJhbGFuY2UgKyBfci5uaWdodGx5X3JhdGUgKyBfdGF4ICsgX3N2YywKICAgICAgICB1cGRhdGVkX2F0PW5vdygpCiAgICAgIFdIRVJFIGlkPV9yLmZvbGlvX2lkOwogICAgICBQRVJGT1JNIHB1YmxpYy5wa2dfYWxsb2NhdGVfZm9saW9fbGluZShfbGluZSwgJ25pZ2h0LWF1ZGl0Jyk7CiAgICAgIF9uIDo9IF9uICsgMTsKICAgIEVYQ0VQVElPTiBXSEVOIHVuaXF1ZV92aW9sYXRpb24gVEhFTgogICAgICBOVUxMOwogICAgRU5EOwogIEVORCBMT09QOwogIFJFVFVSTiBfbjsKRU5EOyAkZnVuY3Rpb24kOwo=",
      "base64"
    ).toString("utf8");

    await db.exec(scheduledJobSQL);

    const rollout = readFileSync(
      "supabase/migrations/20261126023000_customer_advance_deposit_transactions.sql",
      "utf8"
    );

    const integritySQL = rollout.match(
      /DO \$accommodation_integrity\$[\s\S]*?\$accommodation_integrity\$;/
    )?.[0];

    if (!integritySQL) {
      throw new Error(
        "Production accommodation integrity migration missing"
      );
    }

    await db.exec(integritySQL);

    const integrityEvidence = await db.query<{
      scoped: string;
      scheduled: string;
    }>(`
      SELECT
        pg_get_functiondef(
          'public.pms_post_accommodation_scoped(uuid,date)'
          ::regprocedure
        ) AS scoped,

        pg_get_functiondef(
          'public.neo_pms_post_accommodation_job(uuid,uuid,date)'
          ::regprocedure
        ) AS scheduled
    `);

    expect(
      integrityEvidence.rows[0]!.scoped
    ).toContain(
      "neo_accommodation_execution_integrity_v1"
    );

    expect(
      integrityEvidence.rows[0]!.scheduled
    ).toContain(
      "neo_accommodation_execution_integrity_v1"
    );
  }

  async function executeActualAccommodation() {

    const result = await db.query<{
      result: number;
    }>(`
      SELECT public.pms_post_accommodation_scoped(
        (
          SELECT branch_id
          FROM public.reservations
          LIMIT 1
        ),
        (now() AT TIME ZONE 'Africa/Nairobi')::date
      ) AS result
    `);

    return result.rows[0]!.result;
  }

  it("posts actual accommodation charges and applies progressive deposits through canonical Finance", async () => {
    await withCanonicalFinance(async () => {

      await installCanonicalFinanceTransaction();
      await installAccommodationLifecycle();

      expect(
        await executeActualAccommodation()
      ).toBe(1);

      expect(await remaining()).toBe(31000);

      expect(await position()).toEqual({
        balance:0,
        payments:19000
      });

      expect(
        await integratedAccountBalance("2020")
      ).toBe(-31000);

      expect(
        await integratedAccountBalance("1060")
      ).toBe(0);

      expect(
        await integratedAccountBalance("4010")
      ).toBe(-19000);

      const evidence = await db.query<{
        charges: number;
        journals: number;
        packages: number;
      }>(`
        SELECT
          (
            SELECT count(*)::int
            FROM public.folio_lines
            WHERE category='accommodation'
              AND line_type='charge'
          ) AS charges,
          (
            SELECT count(*)::int
            FROM public.journal_entries
            WHERE source_document_type='folio_charge:revenue'
              AND status='posted'
          ) AS journals,
          (
            SELECT count(*)::int
            FROM public.test_package_posting_evidence
          ) AS packages
      `);

      expect(evidence.rows[0]).toEqual({
        charges:1,
        journals:1,
        packages:1
      });
    });
  });

  it("does not duplicate actual nightly accommodation posting", async () => {
    await withCanonicalFinance(async () => {

      await installCanonicalFinanceTransaction();
      await installAccommodationLifecycle();

      expect(
        await executeActualAccommodation()
      ).toBe(1);

      expect(
        await executeActualAccommodation()
      ).toBe(0);

      expect(await remaining()).toBe(31000);

      expect(await position()).toEqual({
        balance:0,
        payments:19000
      });

      const evidence = await db.query<{
        charges: number;
        journals: number;
        packages: number;
        allocations: number;
      }>(`
        SELECT
          (
            SELECT count(*)::int
            FROM public.folio_lines
            WHERE category='accommodation'
              AND line_type='charge'
          ) AS charges,
          (
            SELECT count(*)::int
            FROM public.journal_entries
            WHERE source_document_type='folio_charge:revenue'
              AND status='posted'
          ) AS journals,
          (
            SELECT count(*)::int
            FROM public.test_package_posting_evidence
          ) AS packages,
          (
            SELECT count(*)::int
            FROM public.neo_reservation_deposit_allocations
          ) AS allocations
      `);

      expect(evidence.rows[0]).toEqual({
        charges:1,
        journals:1,
        packages:1,
        allocations:1
      });

      expect(
        await integratedAccountBalance("4010")
      ).toBe(-19000);

      expect(
        await integratedAccountBalance("2020")
      ).toBe(-31000);
    });
  });

  it("rolls back actual accommodation posting when Finance rejects the accounting period", async () => {
    await withCanonicalFinance(async () => {

      await installCanonicalFinanceTransaction();
      await installAccommodationLifecycle();

      await db.exec(`
        UPDATE public.accounting_periods
        SET status='closed'
      `);

      await db.exec("SAVEPOINT lifecycle_rejection");

      try {

        await expect(
          executeActualAccommodation()
        ).rejects.toThrow(
          /accounting period.*closed/i
        );

      } finally {

        await db.exec(
          "ROLLBACK TO SAVEPOINT lifecycle_rejection"
        );
      }

      expect(await remaining()).toBe(50000);

      expect(await position()).toEqual({
        balance:0,
        payments:0
      });

      expect(
        await integratedAccountBalance("2020")
      ).toBe(-50000);

      expect(
        await integratedAccountBalance("4010")
      ).toBe(0);

      const result = await db.query<{
        charges: number;
        packages: number;
      }>(`
        SELECT
          (
            SELECT count(*)::int
            FROM public.folio_lines
            WHERE category='accommodation'
          ) AS charges,
          (
            SELECT count(*)::int
            FROM public.test_package_posting_evidence
          ) AS packages
      `);

      expect(result.rows[0]).toEqual({
        charges:0,
        packages:0
      });
    });
  });

  it("rejects allocation when execution is disabled", async () => {
    const charge = await addNight(1);

    await db.exec(`
      CREATE OR REPLACE FUNCTION
      public.neo_progressive_deposit_execution_enabled()
      RETURNS boolean LANGUAGE sql STABLE
      AS $$ SELECT false $$;
    `);

    try {
      await expect(allocate(charge)).rejects.toThrow(/disabled/i);

      expect(await allocationCount()).toBe(0);
    } finally {
      await db.exec(`
        CREATE OR REPLACE FUNCTION
        public.neo_progressive_deposit_execution_enabled()
        RETURNS boolean LANGUAGE sql STABLE
        AS $$ SELECT true $$;
      `);
    }
  });
});
