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
  org: "70000000-0000-4000-8000-000000000001",
  foreignOrg: "80000000-0000-4000-8000-000000000001",
  branch: "70000000-0000-4000-8000-000000000002",
  foreignBranch: "80000000-0000-4000-8000-000000000002",
  manager: "70000000-0000-4000-8000-000000000010",
  cashier: "70000000-0000-4000-8000-000000000011",
  order: "70000000-0000-4000-8000-000000000100",
  foreignOrder: "80000000-0000-4000-8000-000000000100",
  payment: "70000000-0000-4000-8000-000000000200",
};

const migration = readFileSync(
  "supabase/migrations/" +
  "20261124153000_pos_full_period_financial_evidence.sql",
  "utf8",
);

const source = readFileSync(
  "supabase/migrations/" +
  "20260825141224_f4f0bdbb-d70f-4034-b40e-950f97055913.sql",
  "utf8",
);

const guard = source.match(
  /CREATE OR REPLACE FUNCTION public\.neo_assert_reporting_scope\(_branch uuid, _from date DEFAULT NULL::date, _to date DEFAULT NULL::date\)[\s\S]*?\$function\$;/,
)?.[0];

type Summary = {
  finalized_order_count: string | number;
  finalized_bill_value: string | number;
  finalized_discount_value: string | number;
  confirmed_payment_count: string | number;
  confirmed_collection_value: string | number;
  room_charge_payment_count: string | number;
  room_charge_payment_value: string | number;
  processed_refund_count: string | number;
  processed_refund_value: string | number;
};

describe("NEO full-period POS financial evidence", () => {
  let db: PGlite;

  async function session(
    actor = ids.manager,
    reporting = true,
  ) {
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
    from = "2026-11-01",
    to = "2026-11-30",
  ) {
    const result = await db.query<Summary>(
      `SELECT * FROM
       public.neo_pos_full_period_financial_evidence(
         $1::date,$2::date,$3::uuid
       )`,
      [from, to, branch],
    );

    return result.rows[0];
  }

  beforeAll(async () => {
    if (!guard) {
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
        status text NOT NULL,
        grand_total numeric NOT NULL,
        discount_total numeric NOT NULL DEFAULT 0,
        closed_at timestamptz
      );

      CREATE TABLE public.pos_payments (
        id uuid PRIMARY KEY,
        organization_id uuid NOT NULL,
        order_id uuid NOT NULL,
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

      GRANT USAGE ON SCHEMA public, auth
      TO authenticated;

      GRANT SELECT ON public.branches
      TO authenticated;
    `);

    await db.exec(guard);
    await db.exec(migration);

    await db.exec(`
      -- More than 200 finalized orders.
      -- This demonstrates independence from UI pagination.
      INSERT INTO public.pos_orders (
        id,organization_id,branch_id,status,
        grand_total,discount_total,closed_at
      )
      SELECT
        gen_random_uuid(),
        '${ids.org}'::uuid,
        '${ids.branch}'::uuid,
        'closed',
        100,
        0,
        '2026-11-10'::timestamptz
      FROM generate_series(1,250);

      INSERT INTO public.pos_orders VALUES
        ('${ids.order}','${ids.org}','${ids.branch}',
         'closed',5000,200,'2026-11-11'),

        ('70000000-0000-4000-8000-000000000101',
         '${ids.org}','${ids.branch}',
         'cancelled',9000,0,'2026-11-12'),

        ('70000000-0000-4000-8000-000000000102',
         '${ids.org}','${ids.branch}',
         'closed',7000,0,NULL),

        ('${ids.foreignOrder}','${ids.foreignOrg}',
         '${ids.foreignBranch}',
         'closed',99999,0,'2026-11-13');

      INSERT INTO public.pos_payments VALUES
        ('${ids.payment}','${ids.org}','${ids.order}',
         1000,'cash','confirmed','2026-11-15'),

        ('70000000-0000-4000-8000-000000000201',
         '${ids.org}','${ids.order}',
         2000,'room-charge','confirmed','2026-11-15'),

        ('70000000-0000-4000-8000-000000000202',
         '${ids.org}','${ids.order}',
         300,'cash','pending','2026-11-15'),

        ('70000000-0000-4000-8000-000000000203',
         '${ids.org}','${ids.order}',
         400,'cash','reversed','2026-11-15'),

        ('70000000-0000-4000-8000-000000000204',
         '${ids.org}','${ids.order}',
         250,'mpesa','confirmed','2026-11-15'),

        ('80000000-0000-4000-8000-000000000201',
         '${ids.foreignOrg}','${ids.foreignOrder}',
         99000,'cash','confirmed','2026-11-15');

      INSERT INTO public.pos_refund_requests VALUES
        ('70000000-0000-4000-8000-000000000301',
         '${ids.org}','${ids.order}','${ids.payment}',
         100,'processed','2026-11-16'),

        ('70000000-0000-4000-8000-000000000302',
         '${ids.org}','${ids.order}','${ids.payment}',
         50,'pending','2026-11-16');
    `);

    await db.exec("SET ROLE authenticated");
  }, 60_000);

  beforeEach(async () => {
    await session();
  });

  afterAll(async () => {
    await db?.close();
  });

  it("reports all 251 finalized orders, not 200", async () => {
    const row = await report();

    expect(Number(row?.finalized_order_count)).toBe(251);
    expect(Number(row?.finalized_bill_value)).toBe(30000);
  });

  it("reports discounts separately", async () => {
    const row = await report();

    expect(Number(row?.finalized_discount_value)).toBe(200);
  });

  it("excludes pending and reversed payments", async () => {
    const row = await report();

    expect(Number(row?.confirmed_payment_count)).toBe(2);
    expect(Number(row?.confirmed_collection_value)).toBe(1250);
  });

  it("keeps room-charge payment evidence separate", async () => {
    const row = await report();

    expect(Number(row?.room_charge_payment_count)).toBe(1);
    expect(Number(row?.room_charge_payment_value)).toBe(2000);
  });

  it("does not multiply collections when refunds exist", async () => {
    const row = await report();

    expect(Number(row?.confirmed_collection_value)).toBe(1250);
    expect(Number(row?.processed_refund_count)).toBe(1);
    expect(Number(row?.processed_refund_value)).toBe(100);
  });

  it("does not assign undated closed orders to the period", async () => {
    const row = await report();

    expect(Number(row?.finalized_order_count)).toBe(251);
  });

  it("excludes foreign-organization records", async () => {
    const row = await report();

    expect(Number(row?.finalized_bill_value)).toBe(30000);
  });

  it("requires management POS reporting permission", async () => {
    await session(ids.cashier, false);

    await expect(report()).rejects.toThrow(
      "POS reporting permission required",
    );
  });

  it("rejects out-of-scope properties", async () => {
    await expect(
      report(ids.foreignBranch),
    ).rejects.toThrow();
  });

  it("rejects inactive reporting sessions", async () => {
    await db.exec("SET test.active = 'false'");

    await expect(report()).rejects.toThrow(
      "reporting_session_required",
    );
  });

  it("rejects organization-wide requests from branch staff", async () => {
    await expect(report(null)).rejects.toThrow(
      "explicit_property_required_for_scoped_user",
    );
  });

  it("rejects invalid reporting periods", async () => {
    await expect(
      report(ids.branch,"2026-12-01","2026-11-01"),
    ).rejects.toThrow("invalid_report_period");
  });
});
