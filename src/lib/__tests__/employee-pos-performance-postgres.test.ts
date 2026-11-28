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
  org: "10000000-0000-4000-8000-000000000001",
  otherOrg: "20000000-0000-4000-8000-000000000001",
  branch: "10000000-0000-4000-8000-000000000002",
  otherBranch: "10000000-0000-4000-8000-000000000003",
  foreignBranch: "20000000-0000-4000-8000-000000000002",
  waiterA: "10000000-0000-4000-8000-000000000010",
  waiterB: "10000000-0000-4000-8000-000000000011",
  manager: "10000000-0000-4000-8000-000000000012",
  employeeA: "10000000-0000-4000-8000-000000000020",
  employeeB: "10000000-0000-4000-8000-000000000021",
};

const migration = readFileSync(
  "supabase/migrations/" +
    "20261124150000_employee_pos_performance_foundation.sql",
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

if (!reportingGuard) {
  throw new Error("Production reporting guard definition missing");
}

type PerformanceRow = {
  profile_id: string;
  employee_id: string | null;
  orders_created: number | string;
  orders_currently_assigned: number | string;
  created_orders_finalized: number | string;
  created_orders_cancelled: number | string;
  created_orders_voided: number | string;
  finalized_bill_value: number | string;
  assigned_orders_finalized: number | string;
};

describe("NE? employee POS performance PostgreSQL", () => {
  let db: PGlite;

  async function session(
    actor: string,
    reports = false,
    branch = ids.branch,
  ) {
    await db.query(
      "SELECT set_config('test.actor',$1,false)",
      [actor],
    );
    await db.query(
      "SELECT set_config('test.report',$1,false)",
      [reports ? "true" : "false"],
    );
    await db.query(
      "SELECT set_config('test.branch',$1,false)",
      [branch],
    );
    await db.exec("SET test.active = 'true'");
    await db.exec("SET test.scope = 'branch'");
  }

  async function performance(
    branch: string | null = ids.branch,
    from = "2026-11-01",
    to = "2026-11-30",
  ) {
    return (
      await db.query<PerformanceRow>(
        `SELECT * FROM public.neo_employee_pos_performance(
          $1::date,$2::date,$3::uuid
        )`,
        [from, to, branch],
      )
    ).rows;
  }

  beforeAll(async () => {
    db = new PGlite();

    await db.exec(`
      CREATE SCHEMA auth;
      CREATE ROLE authenticated;

      CREATE FUNCTION auth.uid()
      RETURNS uuid LANGUAGE sql STABLE
      AS $$
        SELECT nullif(
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
        SELECT current_setting('test.report',true) = 'true'
      $$;

      CREATE FUNCTION public.neo_branch_in_scope(_branch uuid)
      RETURNS boolean LANGUAGE sql STABLE
      AS $$
        SELECT _branch = nullif(
          current_setting('test.branch',true),''
        )::uuid
      $$;

      CREATE TABLE public.branches (
        id uuid PRIMARY KEY,
        organization_id uuid NOT NULL
      );

      INSERT INTO public.branches VALUES
        ('${ids.branch}','${ids.org}'),
        ('${ids.otherBranch}','${ids.org}'),
        ('${ids.foreignBranch}','${ids.otherOrg}');

      CREATE FUNCTION public.is_active_staff()
      RETURNS boolean LANGUAGE sql STABLE
      AS $$
        SELECT current_setting('test.active',true) = 'true'
      $$;

      CREATE FUNCTION public.current_access_scope()
      RETURNS text LANGUAGE sql STABLE
      AS $$
        SELECT current_setting('test.scope',true)
      $$;

      CREATE TABLE public.pos_orders (
        id uuid PRIMARY KEY,
        organization_id uuid NOT NULL,
        branch_id uuid NOT NULL,
        created_by uuid,
        waiter_id uuid,
        status text NOT NULL,
        grand_total numeric NOT NULL,
        created_at timestamptz NOT NULL
      );

      CREATE TABLE public.employees (
        id uuid PRIMARY KEY,
        organization_id uuid NOT NULL,
        profile_id uuid
      );

      ALTER TABLE public.pos_orders
        ENABLE ROW LEVEL SECURITY;

      CREATE POLICY employee_pos_test_scope
      ON public.pos_orders
      FOR SELECT TO authenticated
      USING (
        organization_id = public.current_org_id()
        AND public.neo_branch_in_scope(branch_id)
        AND (
          public.has_permission('pos','reports.view')
          OR created_by = auth.uid()
          OR waiter_id = auth.uid()
        )
      );

      GRANT USAGE ON SCHEMA public, auth TO authenticated;
      GRANT SELECT ON public.branches TO authenticated;
      GRANT SELECT ON public.pos_orders TO authenticated;
      GRANT SELECT ON public.employees TO authenticated;
    `);

    await db.exec(reportingGuard);
    await db.exec(migration);

    await db.exec(`
      INSERT INTO public.employees
        (id,organization_id,profile_id)
      VALUES
        ('${ids.employeeA}','${ids.org}','${ids.waiterA}'),
        ('${ids.employeeB}','${ids.org}','${ids.waiterB}');

      INSERT INTO public.pos_orders
        (id,organization_id,branch_id,created_by,
         waiter_id,status,grand_total,created_at)
      VALUES
        ('10000000-0000-4000-8000-000000000101',
         '${ids.org}','${ids.branch}',
         '${ids.waiterA}','${ids.waiterB}',
         'closed',1000,'2026-11-10'),

        ('10000000-0000-4000-8000-000000000102',
         '${ids.org}','${ids.branch}',
         '${ids.waiterA}','${ids.waiterA}',
         'cancelled',500,'2026-11-11'),

        ('10000000-0000-4000-8000-000000000103',
         '${ids.org}','${ids.branch}',
         '${ids.waiterB}','${ids.waiterB}',
         'paid',2000,'2026-11-12'),

        ('10000000-0000-4000-8000-000000000104',
         '${ids.org}','${ids.branch}',
         '${ids.waiterB}','${ids.waiterB}',
         'voided',300,'2026-11-13'),

        ('10000000-0000-4000-8000-000000000105',
         '${ids.org}','${ids.otherBranch}',
         '${ids.waiterB}','${ids.waiterB}',
         'closed',9000,'2026-11-14'),

        ('20000000-0000-4000-8000-000000000101',
         '${ids.otherOrg}','${ids.foreignBranch}',
         '${ids.waiterB}','${ids.waiterB}',
         'closed',99999,'2026-11-15');
    `);

    await db.exec("SET ROLE authenticated");
  }, 60_000);

  beforeEach(async () => {
    await session(ids.waiterA);
  });

  afterAll(async () => {
    await db?.close();
  });

  it("returns only personal performance without reporting permission", async () => {
    const rows = await performance();

    expect(rows).toHaveLength(1);
    expect(rows[0]?.profile_id).toBe(ids.waiterA);
    expect(Number(rows[0]?.orders_created)).toBe(2);
    expect(Number(rows[0]?.finalized_bill_value)).toBe(1000);
  });

  it("keeps original creator and current waiter attribution separate", async () => {
    await session(ids.manager, true);

    const rows = await performance();

    const a = rows.find(
      (row) => row.profile_id === ids.waiterA,
    );
    const b = rows.find(
      (row) => row.profile_id === ids.waiterB,
    );

    expect(Number(a?.orders_created)).toBe(2);
    expect(Number(a?.orders_currently_assigned)).toBe(1);
    expect(Number(b?.orders_currently_assigned)).toBe(3);
  });

  it("excludes cancelled and voided value from finalized bills", async () => {
    await session(ids.manager, true);

    const rows = await performance();

    const a = rows.find(
      (row) => row.profile_id === ids.waiterA,
    );
    const b = rows.find(
      (row) => row.profile_id === ids.waiterB,
    );

    expect(Number(a?.finalized_bill_value)).toBe(1000);
    expect(Number(b?.finalized_bill_value)).toBe(2000);
    expect(Number(a?.created_orders_cancelled)).toBe(1);
    expect(Number(b?.created_orders_voided)).toBe(1);
  });

  it("respects property-level visibility", async () => {
    await session(ids.manager, true);

    const rows = await performance();

    expect(
      rows.reduce(
        (sum, row) =>
          sum + Number(row.finalized_bill_value),
        0,
      ),
    ).toBe(3000);
  });

  it("rejects out-of-scope property requests", async () => {
    await session(ids.manager, true);

    await expect(
      performance(ids.otherBranch),
    ).rejects.toThrow("Property is outside your access");
  });

  it("never includes another organization's records", async () => {
    await session(ids.manager, true);

    await db.exec("SET test.scope = 'organisation'");
    const rows = await performance(null);

    expect(
      rows.every(
        (row) =>
          Number(row.finalized_bill_value) < 99999,
      ),
    ).toBe(true);
  });

  it("rejects invalid reporting periods", async () => {
    await expect(
      performance(ids.branch,"2026-12-01","2026-11-01"),
    ).rejects.toThrow("Invalid performance period");

    await expect(
      performance(ids.branch,"2024-01-01","2026-11-30"),
    ).rejects.toThrow("Performance period cannot exceed");
  });

  it("rejects inactive staff sessions", async () => {
    await db.exec("SET test.active = 'false'");

    await expect(
      performance(),
    ).rejects.toThrow("reporting_session_required");
  });

  it("requires a selected property for branch-scoped staff", async () => {
    await expect(
      performance(null),
    ).rejects.toThrow(
      "explicit_property_required_for_scoped_user",
    );
  });

  it("rejects unauthenticated access", async () => {
    await session("");

    await expect(
      performance(),
    ).rejects.toThrow("Authentication required");
  });
});
