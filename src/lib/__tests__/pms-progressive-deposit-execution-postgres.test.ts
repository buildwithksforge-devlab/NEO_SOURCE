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
