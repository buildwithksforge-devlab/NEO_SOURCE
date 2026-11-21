import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

const ids = {
  org: "00000000-0000-4000-8000-000000000401",
  branch: "00000000-0000-4000-8000-000000000402",
  actor: "00000000-0000-4000-8000-000000000403",
  reservation: "00000000-0000-4000-8000-000000000404",
  room: "00000000-0000-4000-8000-000000000405",
  deposit: "00000000-0000-4000-8000-000000000406",
  journal: "00000000-0000-4000-8000-000000000407",
  cash: "00000000-0000-4000-8000-000000000408",
  liability: "00000000-0000-4000-8000-000000000409",
  receivable: "00000000-0000-4000-8000-000000000410",
  otherBranch: "00000000-0000-4000-8000-000000000411",
};

function functionSource(path: string, name: string) {
  const sql = readFileSync(path, "utf8");
  const pattern = new RegExp(
    `CREATE OR REPLACE FUNCTION public\\.${name}\\([\\s\\S]*?\\$function\\$;`
  );
  const match = sql.match(pattern)?.[0];
  if (!match) throw new Error(`Source function ${name} missing`);
  return match;
}

const checkInSource = functionSource(
  "supabase/migrations/20260830040148_a1812bd0-17aa-444a-bfff-c9ba5b8a0230.sql",
  "pms_check_in"
);
const applySource = functionSource(
  "supabase/migrations/20260831043706_a114fd29-7595-4771-b0de-57407fb6c220.sql",
  "pms_apply_deposits_to_folio"
);

describe("PMS combined check-in and deposit Finance transaction", () => {
  let db: PGlite;

  beforeAll(async () => {
    db = new PGlite();

    await db.exec(`
      CREATE ROLE anon NOLOGIN;
      CREATE SCHEMA auth;

      CREATE FUNCTION auth.uid() RETURNS uuid
      LANGUAGE sql STABLE AS $$ SELECT '${ids.actor}'::uuid $$;

      CREATE FUNCTION public.current_org_id() RETURNS uuid
      LANGUAGE sql STABLE AS $$ SELECT '${ids.org}'::uuid $$;

      CREATE FUNCTION public.has_permission(text,text)
      RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT true $$;

      CREATE FUNCTION public.neo_fact_currency(uuid,uuid)
      RETURNS text LANGUAGE sql STABLE AS $$ SELECT 'KES'::text $$;

      CREATE FUNCTION public.next_document_number(text)
      RETURNS text LANGUAGE sql AS $$ SELECT 'INV-TEST'::text $$;

      CREATE FUNCTION public.pkg_allocate_folio_line(uuid,text)
      RETURNS void LANGUAGE plpgsql AS $$
      BEGIN
        RETURN;
      END
      $$;

      CREATE TABLE public.reservations (
        id uuid PRIMARY KEY,
        organization_id uuid,
        branch_id uuid,
        arrival_date date,
        departure_date date,
        status text,
        room_id uuid,
        customer_id uuid,
        rate_plan_id uuid,
        nightly_rate numeric,
        corporate_account_id uuid,
        group_booking_id uuid,
        updated_at timestamptz
      );

      CREATE TABLE public.rooms (
        id uuid PRIMARY KEY,
        organization_id uuid,
        branch_id uuid,
        room_condition text,
        room_number text,
        occupancy_status text,
        housekeeping_status text,
        updated_at timestamptz
      );

      CREATE TABLE public.stays (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        organization_id uuid,
        branch_id uuid,
        reservation_id uuid,
        customer_id uuid,
        room_id uuid,
        checked_in_by uuid,
        expected_departure date,
        status text DEFAULT 'in-house'
      );

      CREATE TABLE public.folios (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        organization_id uuid,
        branch_id uuid,
        folio_number text,
        reservation_id uuid,
        stay_id uuid,
        customer_id uuid,
        corporate_account_id uuid,
        group_booking_id uuid,
        created_by uuid,
        folio_type text DEFAULT 'guest',
        status text DEFAULT 'open',
        total_payments numeric DEFAULT 0,
        total_charges numeric DEFAULT 0,
        total_taxes numeric DEFAULT 0,
        balance numeric DEFAULT 0,
        updated_at timestamptz
      );

      CREATE TABLE public.folio_lines (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        organization_id uuid,
        branch_id uuid,
        folio_id uuid,
        reservation_id uuid,
        line_type text,
        category text,
        source_module text,
        description text,
        operational_date date,
        quantity numeric,
        unit_price numeric,
        gross_amount numeric,
        tax_amount numeric DEFAULT 0,
        service_charge_amount numeric DEFAULT 0,
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
        amount numeric,
        currency text,
        reference text,
        status text,
        applied_folio_id uuid,
        applied_folio_line_id uuid,
        applied_at timestamptz
      );

      CREATE TABLE public.finance_posting_receipts (
        organization_id uuid,
        idempotency_key text,
        status text,
        journal_id uuid
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
        reversed_by_journal_id uuid,
        source_document_type text,
        source_document_id uuid,
        total_debit numeric,
        total_credit numeric
      );

      CREATE TABLE public.journal_entry_lines (
        journal_id uuid,
        organization_id uuid,
        branch_id uuid,
        account_id uuid,
        debit numeric,
        credit numeric
      );

      CREATE TABLE public.rate_plans (
        id uuid PRIMARY KEY,
        tax_rate numeric,
        service_charge_rate numeric,
        tax_treatment text
      );

      CREATE TABLE public.room_assignments (
        reservation_id uuid,
        status text,
        stay_id uuid,
        updated_at timestamptz
      );

      CREATE TABLE public.room_status_history (
        organization_id uuid,
        branch_id uuid,
        room_id uuid,
        field text,
        previous_value text,
        new_value text,
        reason text,
        changed_by uuid
      );

      CREATE TABLE public.notifications (
        organization_id uuid,
        branch_id uuid,
        category text,
        title text,
        body text,
        link text
      );

      CREATE TABLE public.customer_timeline_events (
        organization_id uuid,
        branch_id uuid,
        customer_id uuid,
        event_type text,
        description text,
        source_module text,
        source_record_id text,
        staff_user_id uuid
      );

      CREATE TABLE public.pms_workflow_events (
        organization_id uuid,
        branch_id uuid,
        event_type text,
        reservation_id uuid,
        stay_id uuid,
        folio_id uuid,
        idempotency_key text,
        created_by uuid
      );

      CREATE TABLE public.audit_logs (
        organization_id uuid,
        user_id uuid,
        user_name text,
        action text,
        module text,
        record_id text,
        new_value jsonb,
        reason text
      );

      CREATE TABLE public.test_finance_control (
        reject_posting boolean NOT NULL DEFAULT false
      );

      INSERT INTO public.test_finance_control VALUES (false);

      CREATE FUNCTION public.neo_connection_journal_matches(
        _journal uuid,_org uuid,_branch uuid,_currency text,
        _amount numeric,_type text,_source uuid
      )
      RETURNS boolean LANGUAGE sql STABLE AS $$
        SELECT EXISTS (
          SELECT 1 FROM public.journal_entries j
          WHERE j.id=_journal
            AND j.organization_id=_org
            AND j.branch_id IS NOT DISTINCT FROM _branch
            AND j.currency=_currency
            AND j.status='posted'
            AND j.reversed_by_journal_id IS NULL
            AND j.source_document_type=_type
            AND j.source_document_id=_source
            AND _amount>0
            AND j.total_debit=_amount
            AND j.total_credit=_amount
            AND NOT EXISTS (
              SELECT 1 FROM public.journal_entry_lines l
              LEFT JOIN public.chart_of_accounts a ON a.id=l.account_id
              WHERE l.journal_id=j.id
                AND (
                  l.organization_id IS DISTINCT FROM _org
                  OR l.branch_id IS DISTINCT FROM _branch
                  OR a.organization_id IS DISTINCT FROM _org
                  OR l.debit IS NULL OR l.credit IS NULL
                  OR l.debit<0 OR l.credit<0
                )
            )
            AND (
              SELECT COALESCE(sum(l.debit),0)
              FROM public.journal_entry_lines l
              WHERE l.journal_id=j.id
            )=_amount
            AND (
              SELECT COALESCE(sum(l.credit),0)
              FROM public.journal_entry_lines l
              WHERE l.journal_id=j.id
            )=_amount
        )
      $$;

      CREATE FUNCTION public.neo_gl_post(
        _org uuid,_branch uuid,_module text,
        _source_type text,_source uuid,_action text,
        _date date,_currency text,_description text,
        _lines jsonb,_customer uuid
      )
      RETURNS jsonb LANGUAGE plpgsql AS $$
      DECLARE
        jid uuid;
        item jsonb;
        aid uuid;
      BEGIN
        IF (SELECT reject_posting FROM public.test_finance_control LIMIT 1)
        THEN
          RAISE EXCEPTION 'test_finance_posting_failure';
        END IF;

        INSERT INTO public.journal_entries(
          organization_id,branch_id,currency,status,
          source_document_type,source_document_id,
          total_debit,total_credit
        )
        VALUES (
          _org,_branch,_currency,'posted',
          _source_type||':'||_action,_source,
          (SELECT COALESCE(sum((x->>'debit')::numeric),0)
           FROM jsonb_array_elements(_lines) x),
          (SELECT COALESCE(sum((x->>'credit')::numeric),0)
           FROM jsonb_array_elements(_lines) x)
        )
        RETURNING id INTO jid;

        FOR item IN SELECT value FROM jsonb_array_elements(_lines)
        LOOP
          SELECT id INTO STRICT aid
          FROM public.chart_of_accounts
          WHERE organization_id=_org AND code=item->>'code';

          INSERT INTO public.journal_entry_lines(
            journal_id,organization_id,branch_id,account_id,debit,credit
          )
          VALUES(
            jid,_org,_branch,aid,
            COALESCE((item->>'debit')::numeric,0),
            COALESCE((item->>'credit')::numeric,0)
          );
        END LOOP;

        RETURN jsonb_build_object('ok',true,'journal_id',jid);
      END
      $$;
    `);

    await db.exec(checkInSource);
    await db.exec(applySource);

    for (const path of [
      "supabase/migrations/20261024120000_f03_guest_deposit_liability_clearing.sql",
      "supabase/migrations/20261116190000_pms_future_checkin_guard.sql",
      "supabase/migrations/20261116231000_pms_deposit_original_journal_guard.sql",
      "supabase/migrations/20261116232000_pms_checkin_room_property_guard.sql",
      "supabase/migrations/20261116233000_pms_deposit_property_scope.sql",
    ]) {
      await db.exec(readFileSync(path, "utf8"));
    }

    await db.exec(`
      CREATE TRIGGER test_apply_deposit_on_folio
      AFTER INSERT ON public.folios
      FOR EACH ROW
      EXECUTE FUNCTION public.pms_apply_deposits_to_folio();
    `);
  }, 60000);

  beforeEach(async () => {
    await db.exec(`
      TRUNCATE
        public.journal_entry_lines,
        public.journal_entries,
        public.finance_posting_receipts,
        public.reservation_deposits,
        public.folio_lines,
        public.folios,
        public.stays,
        public.room_assignments,
        public.room_status_history,
        public.notifications,
        public.customer_timeline_events,
        public.pms_workflow_events,
        public.audit_logs,
        public.reservations,
        public.rooms,
        public.chart_of_accounts,
        public.rate_plans;

      UPDATE public.test_finance_control SET reject_posting=false;
    `);

    await db.query(
      `INSERT INTO public.rooms(
        id,organization_id,branch_id,room_condition,
        room_number,occupancy_status,housekeeping_status
       ) VALUES ($1,$2,$3,'vacant-clean','101','vacant','clean')`,
      [ids.room,ids.org,ids.branch]
    );

    await db.query(
      `INSERT INTO public.reservations(
        id,organization_id,branch_id,arrival_date,departure_date,
        status,room_id,nightly_rate
       ) VALUES (
        $1,$2,$3,
        (now() AT TIME ZONE 'Africa/Nairobi')::date,
        (now() AT TIME ZONE 'Africa/Nairobi')::date + 2,
        'confirmed',$4,12000
       )`,
      [ids.reservation,ids.org,ids.branch,ids.room]
    );

    for (const [id,code] of [
      [ids.cash,"1010"],
      [ids.liability,"2020"],
      [ids.receivable,"1060"],
    ]) {
      await db.query(
        `INSERT INTO public.chart_of_accounts VALUES ($1,$2,$3)`,
        [id,ids.org,code]
      );
    }

    await db.query(
      `INSERT INTO public.reservation_deposits(
        id,organization_id,branch_id,reservation_id,
        amount,currency,status
       ) VALUES ($1,$2,$3,$4,4000,'KES','held')`,
      [ids.deposit,ids.org,ids.branch,ids.reservation]
    );

    // Test fixture for an already posted original deposit receipt.
    await db.query(
      `INSERT INTO public.journal_entries(
        id,organization_id,branch_id,currency,status,
        source_document_type,source_document_id,
        total_debit,total_credit
       ) VALUES (
        $1,$2,$3,'KES','posted',
        'reservation_deposit:deposit',$4,4000,4000
       )`,
      [ids.journal,ids.org,ids.branch,ids.deposit]
    );

    await db.query(
      `INSERT INTO public.journal_entry_lines(
        journal_id,organization_id,branch_id,account_id,debit,credit
       ) VALUES
         ($1,$2,$3,$4,4000,0),
         ($1,$2,$3,$5,0,4000)`,
      [ids.journal,ids.org,ids.branch,ids.cash,ids.liability]
    );

    await db.query(
      `INSERT INTO public.finance_posting_receipts(
        organization_id,idempotency_key,status,journal_id
       ) VALUES ($1,$2,'posted',$3)`,
      [ids.org,`deposit:${ids.deposit}`,ids.journal]
    );
  });

  afterAll(async () => {
    await db?.close();
  });

  async function checkIn() {
    const result = await db.query<{
      result: {
        stay_id: string;
        folio_id: string;
        idempotent: boolean;
      };
    }>(
      `SELECT public.pms_check_in($1,1,'integration test') AS result`,
      [ids.reservation]
    );
    return result.rows[0]!.result;
  }

  async function count(table: string) {
    const allowed = new Set([
      "stays","folios","folio_lines","journal_entries"
    ]);
    if (!allowed.has(table)) throw new Error("Unexpected table");
    const result = await db.query<{n: number}>(
      `SELECT count(*)::int AS n FROM public.${table}`
    );
    return result.rows[0]!.n;
  }

  it("checks in once, applies deposit and posts arrival night", async () => {
    const result = await checkIn();

    expect(result.idempotent).toBe(false);
    expect(await count("stays")).toBe(1);
    expect(await count("folios")).toBe(1);
    expect(await count("folio_lines")).toBe(2);
    expect(await count("journal_entries")).toBe(2);

    const folio = await db.query<{
      total_charges: string;
      total_payments: string;
      balance: string;
    }>(
      `SELECT total_charges,total_payments,balance
       FROM public.folios WHERE id=$1`,
      [result.folio_id]
    );

    expect(Number(folio.rows[0]?.total_charges)).toBe(12000);
    expect(Number(folio.rows[0]?.total_payments)).toBe(4000);
    expect(Number(folio.rows[0]?.balance)).toBe(8000);

    const deposit = await db.query<{
      status: string;
      applied_folio_id: string;
    }>(
      `SELECT status,applied_folio_id
       FROM public.reservation_deposits WHERE id=$1`,
      [ids.deposit]
    );

    expect(deposit.rows[0]?.status).toBe("applied");
    expect(deposit.rows[0]?.applied_folio_id).toBe(result.folio_id);

    const posting = await db.query<{n:number}>(`
      SELECT count(*)::int AS n
      FROM public.journal_entries
      WHERE source_document_type =
        'reservation_deposit_application:application'
    `);
    expect(posting.rows[0]?.n).toBe(1);
  });

  it("replays check-in without a second folio, charge or journal", async () => {
    const first = await checkIn();
    const second = await checkIn();

    expect(second.idempotent).toBe(true);
    expect(second.stay_id).toBe(first.stay_id);
    expect(second.folio_id).toBe(first.folio_id);

    expect(await count("stays")).toBe(1);
    expect(await count("folios")).toBe(1);
    expect(await count("folio_lines")).toBe(2);
    expect(await count("journal_entries")).toBe(2);
  });

  it("rolls back the entire check-in if liability posting fails", async () => {
    await db.exec(`
      UPDATE public.test_finance_control SET reject_posting=true;
    `);

    await expect(checkIn()).rejects.toThrow(
      /test_finance_posting_failure/
    );

    expect(await count("stays")).toBe(0);
    expect(await count("folios")).toBe(0);
    expect(await count("folio_lines")).toBe(0);
    expect(await count("journal_entries")).toBe(1);

    const state = await db.query<{
      reservation_status: string;
      deposit_status: string;
    }>(`
      SELECT
        (SELECT status FROM public.reservations LIMIT 1)
          AS reservation_status,
        (SELECT status FROM public.reservation_deposits LIMIT 1)
          AS deposit_status
    `);

    expect(state.rows[0]?.reservation_status).toBe("confirmed");
    expect(state.rows[0]?.deposit_status).toBe("held");
  });

  it("rejects a room belonging to a different branch", async () => {
    await db.query(
      `UPDATE public.rooms SET branch_id=$1 WHERE id=$2`,
      [ids.otherBranch,ids.room]
    );

    await expect(checkIn()).rejects.toThrow(
      /belongs to another property/
    );
    expect(await count("stays")).toBe(0);
    expect(await count("folios")).toBe(0);
  });
});