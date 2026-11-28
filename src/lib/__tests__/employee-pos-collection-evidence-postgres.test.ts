import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";

const ids = {
  org: "50000000-0000-4000-8000-000000000001",
  foreignOrg: "60000000-0000-4000-8000-000000000001",
  branch: "50000000-0000-4000-8000-000000000002",
  foreignBranch: "60000000-0000-4000-8000-000000000002",
  cashierA: "50000000-0000-4000-8000-000000000010",
  cashierB: "50000000-0000-4000-8000-000000000011",
  manager: "50000000-0000-4000-8000-000000000012",
  employeeA: "50000000-0000-4000-8000-000000000020",
  orderA: "50000000-0000-4000-8000-000000000100",
  orderB: "50000000-0000-4000-8000-000000000101",
  foreignOrder: "60000000-0000-4000-8000-000000000100",
  paymentA: "50000000-0000-4000-8000-000000000200",
  paymentB: "50000000-0000-4000-8000-000000000201",
};

const migration = readFileSync(
  "supabase/migrations/" +
    "20261124152000_employee_pos_collection_evidence.sql",
  "utf8",
);

const reportingGuardSource = readFileSync(
  "supabase/migrations/" +
    "20260825141224_f4f0bdbb-d70f-4034-b40e-950f97055913.sql",
  "utf8",
);

const reportingGuard = reportingGuardSource.match(
  /CREATE OR REPLACE FUNCTION public\.neo_assert_reporting_scope\(_branch uuid, _from date DEFAULT NULL::date, _to date DEFAULT NULL::date\)[\s\S]*?\$function\$;/,
)?.[0];

type Row = {
  cashier_profile_id: string | null;
  confirmed_payment_count: number | string;
  confirmed_collection_amount: number | string;
  processed_refund_count: number | string;
  processed_refund_amount: number | string;
};

describe("NE? employee POS collection evidence", () => {
  let db: PGlite;

  async function session(actor: string, reporting = false) {
    await db.query(
      "SELECT set_config('test.actor',$1,false)",
      [actor],
    );

    await db.query(
      "SELECT set_config('test.reporting',$1,false)",
      [reporting ? "true" : "false"],
    );

    await db.exec("SET test.active = 'true'");
    await db.exec("SET test.scope = 'branch'");
  }

  async function report(
    branch: string | null = ids.branch,
  ) {
    const result = await db.query<Row>(
      `SELECT *
       FROM public.neo_employee_pos_collection_evidence(
         '2026-11-01'::date,
         '2026-11-30'::date,
         $1::uuid
       )`,
      [branch],
    );

    return result.rows;
  }

  beforeAll(async () => {
    if (!reportingGuard) {
      throw new Error("Production reporting guard missing");
    }

    db = new PGlite();

    await db.exec(`
      CREATE SCHEMA auth;
      CREATE ROLE authenticated;

      CREATE FUNCTION auth.uid()
      RETURNS uuid LANGUAGE sql STABLE
      AS $$
        SELECT NULLIF(
          current_setting('test.actor',true),''
        )::uuid
      $$;

      CREATE FUNCTION public.current_org_id()
      RETURNS uuid LANGUAGE sql STABLE
      AS $$
        SELECT '${ids.org}'::uuid
      $$;

      CREATE FUNCTION public.has_permission(text,text)
      RETURNS boolean LANGUAGE sql STABLE
      AS $$
        SELECT current_setting('test.reporting',true)
               = 'true'
      $$;

      CREATE FUNCTION public.is_active_staff()
      RETURNS boolean LANGUAGE sql STABLE
      AS $$
        SELECT current_setting('test.active',true)
               = 'true'
      $$;

      CREATE FUNCTION public.current_access_scope()
      RETURNS text LANGUAGE sql STABLE
      AS $$
        SELECT current_setting('test.scope',true)
      $$;

      CREATE FUNCTION public.neo_branch_in_scope(
        _branch uuid
      )
      RETURNS boolean LANGUAGE sql STABLE
      AS $$
        SELECT _branch = '${ids.branch}'::uuid
      $$;

      CREATE TABLE public.branches (
        id uuid PRIMARY KEY,
        organization_id uuid NOT NULL
      );

      INSERT INTO public.branches VALUES
        ('${ids.branch}','${ids.org}'),
        ('${ids.foreignBranch}','${ids.foreignOrg}');

      CREATE TABLE public.pos_orders (
        id uuid PRIMARY KEY,
        organization_id uuid NOT NULL,
        branch_id uuid,
        created_by uuid,
        waiter_id uuid
      );

      CREATE TABLE public.pos_payments (
        id uuid PRIMARY KEY,
        organization_id uuid NOT NULL,
        order_id uuid NOT NULL,
        cashier_id uuid,
        amount numeric NOT NULL,
        method text NOT NULL,
        status text NOT NULL,
        paid_at timestamptz
      );

      CREATE TABLE public.pos_refund_requests (
        id uuid PRIMARY KEY,
        organization_id uuid NOT NULL,
        order_id uuid NOT NULL,
        payment_id uuid NOT NULL,
        amount numeric NOT NULL,
        status text NOT NULL,
        decided_at timestamptz
      );

      CREATE TABLE public.employees (
        id uuid PRIMARY KEY,
        organization_id uuid NOT NULL,
        profile_id uuid
      );

      ALTER TABLE public.pos_orders
        ENABLE ROW LEVEL SECURITY;

      CREATE POLICY order_scope
      ON public.pos_orders
      FOR SELECT TO authenticated
      USING (
        organization_id = '${ids.org}'::uuid
        AND branch_id = '${ids.branch}'::uuid
        AND (
          public.has_permission('pos','reports.view')
          OR created_by = auth.uid()
          OR waiter_id = auth.uid()
        )
      );

      GRANT USAGE ON SCHEMA public, auth
        TO authenticated;

      GRANT SELECT ON
        public.branches,
        public.pos_orders,
        public.pos_payments,
        public.pos_refund_requests,
        public.employees
      TO authenticated;
    `);

    await db.exec(reportingGuard);
    await db.exec(migration);

    await db.exec(`
      INSERT INTO public.employees VALUES
        ('${ids.employeeA}','${ids.org}','${ids.cashierA}');

      INSERT INTO public.pos_orders VALUES
        ('${ids.orderA}','${ids.org}','${ids.branch}',
         '${ids.cashierA}','${ids.cashierA}'),
        ('${ids.orderB}','${ids.org}','${ids.branch}',
         '${ids.cashierB}','${ids.cashierB}'),
        ('${ids.foreignOrder}','${ids.foreignOrg}',
         '${ids.foreignBranch}','${ids.cashierB}','${ids.cashierB}');

      INSERT INTO public.pos_payments VALUES
        ('${ids.paymentA}','${ids.org}','${ids.orderA}',
         '${ids.cashierA}',1000,'cash','confirmed','2026-11-10'),
        ('${ids.paymentB}','${ids.org}','${ids.orderB}',
         '${ids.cashierB}',2000,'mpesa','confirmed','2026-11-11'),
        ('50000000-0000-4000-8000-000000000202',
         '${ids.org}','${ids.orderA}',
         '${ids.cashierA}',5000,'room-charge','confirmed','2026-11-12'),
        ('50000000-0000-4000-8000-000000000203',
         '${ids.org}','${ids.orderA}',
         '${ids.cashierA}',700,'cash','pending','2026-11-13'),
        ('50000000-0000-4000-8000-000000000204',
         '${ids.org}','${ids.orderA}',
         '${ids.cashierA}',800,'cash','reversed','2026-11-14'),
        ('60000000-0000-4000-8000-000000000201',
         '${ids.foreignOrg}','${ids.foreignOrder}',
         '${ids.cashierB}',99000,'cash','confirmed','2026-11-15');

      INSERT INTO public.pos_refund_requests VALUES
        ('50000000-0000-4000-8000-000000000301',
         '${ids.org}','${ids.orderA}','${ids.paymentA}',
         250,'processed','2026-11-16'),
        ('50000000-0000-4000-8000-000000000302',
         '${ids.org}','${ids.orderA}','${ids.paymentA}',
         100,'pending','2026-11-17');
    `);

    await db.exec("SET ROLE authenticated");
  }, 60_000);

  beforeEach(async () => {
    await session(ids.cashierA);
  });

  afterAll(async () => {
    await db?.close();
  });

  it("attributes confirmed collections to the cashier", async () => {
    const rows = await report();

    expect(rows).toHaveLength(1);
    expect(rows[0]?.cashier_profile_id).toBe(ids.cashierA);
    expect(Number(rows[0]?.confirmed_payment_count)).toBe(1);
    expect(Number(rows[0]?.confirmed_collection_amount)).toBe(1000);
  });

  it("keeps processed refunds separate from collections", async () => {
    const rows = await report();

    expect(Number(rows[0]?.processed_refund_count)).toBe(1);
    expect(Number(rows[0]?.processed_refund_amount)).toBe(250);
  });

  it("excludes pending, reversed and room-charge amounts", async () => {
    const rows = await report();

    expect(Number(rows[0]?.confirmed_collection_amount)).toBe(1000);
  });

  it("does not expose other cashiers to ordinary staff", async () => {
    const rows = await report();

    expect(rows.some(
      (row) => row.cashier_profile_id === ids.cashierB,
    )).toBe(false);
  });

  it("allows authorized reporting across visible orders", async () => {
    await session(ids.manager, true);

    const rows = await report();

    expect(rows).toHaveLength(2);

    expect(
      rows.reduce(
        (sum, row) =>
          sum + Number(row.confirmed_collection_amount),
        0,
      ),
    ).toBe(3000);
  });

  it("never includes another organization's collections", async () => {
    await session(ids.manager, true);

    const rows = await report();

    expect(rows.every(
      (row) =>
        Number(row.confirmed_collection_amount) < 99000,
    )).toBe(true);
  });

  it("rejects out-of-scope properties", async () => {
    await session(ids.manager, true);

    await expect(
      report(ids.foreignBranch),
    ).rejects.toThrow();
  });


  // Cashier cross-owner attribution regression.
  //
  // The cashier receives a payment for an order that was
  // neither created by nor assigned to that cashier.
  //
  // The cashier must receive collection credit without
  // receiving direct access to the other waiter's order.

  it("credits a cashier for another waiter's order without exposing that order", async () => {
    const sharedPayment =
      "50000000-0000-4000-8000-000000000299";

    // The fixture owner inserts the payment.
    // Normal application users cannot write via this test.
    await db.exec("RESET ROLE");

    try {
      await db.query(
        `INSERT INTO public.pos_payments (
          id,
          organization_id,
          order_id,
          cashier_id,
          amount,
          method,
          status,
          paid_at
        )
        VALUES (
          $1::uuid,
          $2::uuid,
          $3::uuid,
          $4::uuid,
          400,
          'cash',
          'confirmed',
          '2026-11-18'
        )`,
        [
          sharedPayment,
          ids.org,
          ids.orderB,
          ids.cashierA,
        ],
      );

      await db.exec("SET ROLE authenticated");

      await session(ids.cashierA);

      // Existing order-level RLS must still prevent
      // cashier A from browsing waiter B's order.
      const hiddenOrder = await db.query<{ id: string }>(
        `SELECT id
         FROM public.pos_orders
         WHERE id = $1::uuid`,
        [ids.orderB],
      );

      expect(hiddenOrder.rows).toHaveLength(0);

      // But the financial reporting function must include
      // the confirmed collection handled by cashier A.
      const rows = await report();

      expect(rows).toHaveLength(1);

      expect(rows[0]?.cashier_profile_id)
        .toBe(ids.cashierA);

      expect(
        Number(rows[0]?.confirmed_payment_count),
      ).toBe(2);

      expect(
        Number(rows[0]?.confirmed_collection_amount),
      ).toBe(1400);

      // Cashier B must not appear in cashier A's report.
      expect(
        rows.some(
          (row) =>
            row.cashier_profile_id === ids.cashierB,
        ),
      ).toBe(false);

    } finally {
      // Restore the original fixture for other tests.
      await db.exec("RESET ROLE");

      await db.query(
        `DELETE FROM public.pos_payments
         WHERE id = $1::uuid`,
        [sharedPayment],
      );

      await db.exec("SET ROLE authenticated");
    }
  });

  it("rejects inactive staff sessions", async () => {
    await db.exec("SET test.active = 'false'");

    await expect(report()).rejects.toThrow(
      "reporting_session_required",
    );
  });

  it("rejects unauthenticated sessions", async () => {
    await session("");

    await expect(report()).rejects.toThrow(
      "Authentication required",
    );
  });
});
