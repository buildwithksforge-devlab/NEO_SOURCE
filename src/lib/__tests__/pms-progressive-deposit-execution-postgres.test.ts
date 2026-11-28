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
