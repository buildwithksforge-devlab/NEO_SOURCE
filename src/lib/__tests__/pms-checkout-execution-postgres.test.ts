import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

const org = "00000000-0000-4000-8000-000000000101";
const branch = "00000000-0000-4000-8000-000000000102";
const guest = "00000000-0000-4000-8000-000000000103";
const reservation = "00000000-0000-4000-8000-000000000104";
const stay = "00000000-0000-4000-8000-000000000105";
const room = "00000000-0000-4000-8000-000000000106";
const folio = "00000000-0000-4000-8000-000000000107";
const secondFolio = "00000000-0000-4000-8000-000000000108";
const payment = "00000000-0000-4000-8000-000000000109";

function extract(sql: string, name: string): string {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(
    `CREATE OR REPLACE FUNCTION public\\.${escaped}\\([\\s\\S]*?\\$function\\$;`
  );
  const result = sql.match(re)?.[0];
  if (!result) throw new Error(`Missing real SQL function: ${name}`);
  return result;
}

const original = extract(
  readFileSync(
    "supabase/migrations/20260914005249_756324e7-13ed-4ec4-96d5-26b6bec207c5.sql",
    "utf8"
  ),
  "pms_check_out"
);

const finance = extract(
  readFileSync(
    "supabase/migrations/20261115013000_finance_checkout_ledger_parity.sql",
    "utf8"
  ),
  "neo_folio_financial_components"
);

const repair = readFileSync(
  "supabase/migrations/20261116210000_pms_checkout_canonical_balance.sql",
  "utf8"
);

describe("Real PostgreSQL checkout execution and rollback", () => {
  let db: PGlite;

  beforeAll(async () => {
    db = new PGlite();

    await db.exec(`
      CREATE SCHEMA auth;

      CREATE FUNCTION auth.uid()
      RETURNS uuid LANGUAGE sql STABLE
      AS $$ SELECT '${guest}'::uuid $$;

      CREATE FUNCTION public.current_org_id()
      RETURNS uuid LANGUAGE sql STABLE
      AS $$ SELECT '${org}'::uuid $$;

      CREATE FUNCTION public.has_permission(text,text)
      RETURNS boolean LANGUAGE sql STABLE
      AS $$ SELECT $1='pms' AND $2='checkout.perform' $$;

      CREATE FUNCTION public.is_org_admin()
      RETURNS boolean LANGUAGE sql STABLE
      AS $$ SELECT false $$;

      CREATE TABLE public.rooms (
        id uuid PRIMARY KEY,
        occupancy_status text DEFAULT 'occupied',
        housekeeping_status text DEFAULT 'occupied',
        updated_at timestamptz
      );

      CREATE TABLE public.reservations (
        id uuid PRIMARY KEY,
        organization_id uuid,
        status text DEFAULT 'checked-in',
        payment_status text DEFAULT 'part-paid',
        updated_at timestamptz
      );

      CREATE TABLE public.stays (
        id uuid PRIMARY KEY,
        organization_id uuid,
        branch_id uuid,
        reservation_id uuid,
        room_id uuid,
        status text DEFAULT 'checked-in',
        checked_out_at timestamptz,
        checked_out_by uuid,
        updated_at timestamptz
      );

      CREATE TABLE public.folios (
        id uuid PRIMARY KEY,
        organization_id uuid,
        branch_id uuid,
        stay_id uuid,
        folio_type text DEFAULT 'guest',
        currency text DEFAULT 'KES',
        total_charges numeric DEFAULT 0,
        total_payments numeric DEFAULT 0,
        balance numeric DEFAULT 0,
        status text DEFAULT 'open',
        closed_at timestamptz,
        updated_at timestamptz
      );

      CREATE TABLE public.folio_lines (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        organization_id uuid,
        folio_id uuid,
        status text DEFAULT 'posted',
        line_type text DEFAULT 'charge',
        category text DEFAULT 'accommodation',
        net_amount numeric DEFAULT 0,
        tax_amount numeric DEFAULT 0,
        service_charge_amount numeric DEFAULT 0,
        discount_amount numeric DEFAULT 0
      );

      CREATE TABLE public.payments (
        id uuid PRIMARY KEY,
        organization_id uuid,
        folio_id uuid,
        amount numeric,
        currency text DEFAULT 'KES',
        status text
      );

      CREATE TABLE public.payment_allocations (
        payment_id uuid,
        folio_id uuid,
        amount numeric
      );

      CREATE TABLE public.reservation_deposits (
        id uuid PRIMARY KEY,
        organization_id uuid,
        applied_folio_id uuid,
        applied_folio_line_id uuid,
        payment_id uuid,
        amount numeric,
        currency text DEFAULT 'KES',
        status text
      );

      CREATE TABLE public.room_assignments (
        reservation_id uuid,
        status text,
        updated_at timestamptz
      );

      CREATE TABLE public.pms_workflow_events (
        organization_id uuid,
        branch_id uuid,
        event_type text,
        reservation_id uuid,
        stay_id uuid,
        folio_id uuid,
        idempotency_key text,
        created_by uuid,
        UNIQUE(organization_id,idempotency_key)
      );

      CREATE TABLE public.audit_logs (
        organization_id uuid,
        branch_id uuid,
        user_id uuid,
        user_name text,
        action text,
        module text,
        record_id text,
        new_value jsonb,
        reason text
      );

      CREATE FUNCTION public.ops_set_room_status(
        _room uuid,
        _condition text,
        _reason text,
        _note text,
        _source text,
        _record uuid,
        _occupancy text
      )
      RETURNS void LANGUAGE plpgsql AS $$
      BEGIN
        UPDATE public.rooms
        SET housekeeping_status=_condition,
            occupancy_status=_occupancy,
            updated_at=now()
        WHERE id=_room;
      END;
      $$;
    `);

    await db.exec(finance);
    await db.exec(original);

    // This is the critical test: actually run the staged
    // installation against the real original checkout function.
    await db.exec(repair);

    const installed = await db.query<{ definition: string }>(`
      SELECT pg_get_functiondef(
        'public.pms_check_out(uuid,boolean,text)'::regprocedure
      ) AS definition
    `);

    expect(installed.rows[0]?.definition).toContain(
      "Canonical reconciliation replaces the legacy aggregation result"
    );
  }, 45000);

  beforeEach(async () => {
    await db.exec(`
      TRUNCATE
        public.audit_logs,
        public.pms_workflow_events,
        public.room_assignments,
        public.reservation_deposits,
        public.payment_allocations,
        public.payments,
        public.folio_lines,
        public.folios,
        public.stays,
        public.reservations,
        public.rooms;

      INSERT INTO public.rooms(id)
      VALUES ('${room}');

      INSERT INTO public.reservations(id,organization_id)
      VALUES ('${reservation}','${org}');

      INSERT INTO public.stays(
        id,organization_id,branch_id,reservation_id,room_id
      )
      VALUES (
        '${stay}','${org}','${branch}',
        '${reservation}','${room}'
      );

      INSERT INTO public.folios(
        id,organization_id,branch_id,stay_id,folio_type
      )
      VALUES (
        '${folio}','${org}','${branch}','${stay}','guest'
      );

      INSERT INTO public.folio_lines(
        folio_id,organization_id,line_type,
        category,net_amount
      )
      VALUES (
        '${folio}','${org}','charge','accommodation',12000
      );

      INSERT INTO public.room_assignments(reservation_id,status)
      VALUES ('${reservation}','active');
    `);
  });

  afterAll(async () => {
    await db?.close();
  });

  async function snapshot() {
    const result = await db.query<{
      stay_status: string;
      reservation_status: string;
      folio_status: string;
      occupancy: string;
      housekeeping: string;
      balance: string;
      workflow_count: string;
      audit_count: string;
    }>(`
      SELECT
        s.status AS stay_status,
        r.status AS reservation_status,
        f.status AS folio_status,
        rm.occupancy_status AS occupancy,
        rm.housekeeping_status AS housekeeping,
        f.balance::text AS balance,
        (SELECT count(*)::text
           FROM public.pms_workflow_events) AS workflow_count,
        (SELECT count(*)::text
           FROM public.audit_logs) AS audit_count
      FROM public.stays s
      JOIN public.reservations r ON r.id=s.reservation_id
      JOIN public.folios f ON f.stay_id=s.id AND f.folio_type='guest'
      JOIN public.rooms rm ON rm.id=s.room_id
    `);
    const row = result.rows[0]; if (!row) throw new Error("Missing checkout state"); return row;
  }

  async function checkOut(force = false, notes = "") {
    return db.query<{ result: Record<string, unknown> }>(
      "SELECT public.pms_check_out($1,$2,$3) AS result",
      [reservation,force,notes]
    );
  }

  async function collect(amount: number) {
    await db.query(
      `INSERT INTO public.payments(
         id,organization_id,folio_id,amount,currency,status
       ) VALUES ($1,$2,$3,$4,'KES','confirmed')`,
      [payment,org,folio,amount]
    );
    await db.query(
      `INSERT INTO public.payment_allocations(
         payment_id,folio_id,amount
       ) VALUES ($1,$2,$3)`,
      [payment,folio,amount]
    );
  }

  it("checks out a fully paid stay and releases its room", async () => {
    await collect(12000);
    const response = await checkOut();

    expect(response.rows[0]?.result?.["ok"]).toBe(true);
    expect(Number(response.rows[0]?.result?.["outstanding"])).toBe(0);

    const state = await snapshot();
    expect(state.stay_status).toBe("checked-out");
    expect(state.reservation_status).toBe("checked-out");
    expect(state.folio_status).toBe("settled");
    expect(state.occupancy).toBe("vacant");
    expect(state.housekeeping).toBe("dirty");
    expect(Number(state.balance)).toBe(0);
    expect(Number(state.workflow_count)).toBe(1);
    expect(Number(state.audit_count)).toBe(1);
  });

  it("blocks an unpaid checkout and changes nothing", async () => {
    const before = await snapshot();

    await expect(checkOut()).rejects.toThrow(/not settled/i);

    expect(await snapshot()).toEqual(before);
  });

  it("refuses forced checkout without override authority", async () => {
    const before = await snapshot();

    await expect(
      checkOut(true,"Attempted unpaid checkout")
    ).rejects.toThrow(/override authority/i);

    expect(await snapshot()).toEqual(before);
  });

  it("blocks multi-folio checkout with no operational changes", async () => {
    await db.query(
      `INSERT INTO public.folios(
         id,organization_id,branch_id,stay_id,folio_type
       ) VALUES ($1,$2,$3,$4,'corporate')`,
      [secondFolio,org,branch,stay]
    );

    const before = await snapshot();

    await expect(checkOut()).rejects.toThrow(
      /exactly one folio/i
    );

    expect(await snapshot()).toEqual(before);
  });

  it("is idempotent after a successful checkout", async () => {
    await collect(12000);
    await checkOut();
    const before = await snapshot();

    const again = await checkOut();
    expect(again.rows[0]?.result?.["idempotent"]).toBe(true);

    expect(await snapshot()).toEqual(before);
  });
});