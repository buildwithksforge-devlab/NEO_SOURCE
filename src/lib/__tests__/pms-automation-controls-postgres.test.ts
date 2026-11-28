import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

const ids = {
  org: "00000000-0000-4000-8000-000000000501",
  branch: "00000000-0000-4000-8000-000000000502",
  user: "00000000-0000-4000-8000-000000000503",
  reservation: "00000000-0000-4000-8000-000000000504",
  room: "00000000-0000-4000-8000-000000000505",
  ratePlan: "00000000-0000-4000-8000-000000000506",
  stay: "00000000-0000-4000-8000-000000000507",
  folio: "00000000-0000-4000-8000-000000000508",
  otherOrg: "00000000-0000-4000-8000-000000000509",
  otherReservation: "00000000-0000-4000-8000-000000000510",
  otherStay: "00000000-0000-4000-8000-000000000511",
  otherFolio: "00000000-0000-4000-8000-000000000512",
  otherBranch: "00000000-0000-4000-8000-000000000513",
};

const source = readFileSync(
  "supabase/migrations/20260814141422_db5e0bea-1012-4101-a3e8-51b9c176a02d.sql",
  "utf8",
);

const original = source.match(
  /CREATE OR REPLACE FUNCTION public\.pms_post_accommodation\([\s\S]*?END; \$\$;/
)?.[0];

if (!original) {
  throw new Error("Latest reviewed nightly accommodation function missing");
}

const propertyMigration = readFileSync(
  "supabase/migrations/20261116235600_pms_nightly_property_scope.sql",
  "utf8",
);

const migration = readFileSync(
  "supabase/migrations/20261116235500_pms_nightly_pricing_parity.sql",
  "utf8",
);

const automaticMigration = readFileSync(
  "supabase/migrations/20261124100000_pms_automatic_accommodation.sql",
  "utf8",
);
const controlsMigration = readFileSync(
  "supabase/migrations/20261124110000_pms_automation_controls.sql",
  "utf8",
);
const scopedMigration = readFileSync(
  "supabase/migrations/20261124090000_pms_scoped_accommodation_posting.sql",
  "utf8",
);

describe("PMS scoped accommodation PostgreSQL", () => {
  let db: PGlite;

  beforeAll(async () => {
    db = new PGlite();

    await db.exec(`
      CREATE SCHEMA auth;
      CREATE ROLE anon;
      CREATE ROLE authenticated;

      CREATE FUNCTION public.is_org_admin()
      RETURNS boolean LANGUAGE sql STABLE
      AS $$ SELECT false $$;

      CREATE FUNCTION public.neo_branch_in_scope(uuid)
      RETURNS boolean LANGUAGE sql STABLE
      AS $$
        SELECT current_setting('test.scope',true)
               IS DISTINCT FROM 'off'
      $$;

      CREATE TABLE public.branches (
        id uuid PRIMARY KEY,
        organization_id uuid NOT NULL
      );

      CREATE TABLE public.business_days (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        organization_id uuid NOT NULL,
        branch_id uuid NOT NULL,
        business_date date NOT NULL,
        status text NOT NULL,
        UNIQUE (organization_id,branch_id,business_date)
      );

      CREATE FUNCTION auth.uid() RETURNS uuid
      LANGUAGE sql STABLE
      AS $$ SELECT '${ids.user}'::uuid $$;

      CREATE FUNCTION public.current_org_id() RETURNS uuid
      LANGUAGE sql STABLE
      AS $$ SELECT '${ids.org}'::uuid $$;

      CREATE FUNCTION public.has_permission(text,text)
      RETURNS boolean LANGUAGE sql STABLE
      AS $$
        SELECT current_setting('test.post_permission',true)
               IS DISTINCT FROM 'off'
      $$;

      CREATE FUNCTION public.pkg_allocate_folio_line(uuid,text)
      RETURNS void LANGUAGE plpgsql
      AS $$ BEGIN RETURN; END $$;

      CREATE TABLE public.reservations (
        id uuid PRIMARY KEY,
        organization_id uuid NOT NULL,
        branch_id uuid,
        arrival_date date NOT NULL,
        departure_date date NOT NULL,
        nightly_rate numeric NOT NULL,
        rate_plan_id uuid
      );

      CREATE TABLE public.stays (
        id uuid PRIMARY KEY,
        organization_id uuid NOT NULL,
        branch_id uuid,
        reservation_id uuid NOT NULL,
        room_id uuid,
        status text NOT NULL
      );

      CREATE TABLE public.folios (
        id uuid PRIMARY KEY,
        organization_id uuid NOT NULL,
        branch_id uuid,
        stay_id uuid,
        reservation_id uuid,
        folio_type text NOT NULL,
        status text NOT NULL,
        total_charges numeric DEFAULT 0,
        total_taxes numeric DEFAULT 0,
        balance numeric DEFAULT 0,
        updated_at timestamptz
      );

      CREATE TABLE public.rooms (
        id uuid PRIMARY KEY,
        organization_id uuid,
        branch_id uuid,
        room_number text
      );

      CREATE TABLE public.rate_plans (
        id uuid PRIMARY KEY,
        organization_id uuid,
        branch_id uuid,
        tax_rate numeric,
        service_charge_rate numeric,
        tax_treatment text
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
        tax_amount numeric,
        service_charge_amount numeric,
        net_amount numeric,
        posted_by uuid,
        status text DEFAULT 'posted'
      );

      -- Isolated fixture only, NOT evidence of a production index.
      CREATE UNIQUE INDEX test_accommodation_one_night
      ON public.folio_lines(reservation_id,operational_date)
      WHERE line_type='charge' AND category='accommodation' AND status='posted';
    `);

    await db.exec(original);
    await db.exec(migration);
    await db.exec(propertyMigration);
    await db.exec(scopedMigration);
    await db.exec("CREATE ROLE service_role");
    await db.exec(automaticMigration);
    await db.exec(controlsMigration);

    // The original accommodation fixture may use a fixed actor.
    // Override it only inside this isolated PGlite database.
    // An empty test.actor represents an unattended scheduler.
    await db.exec(`
      CREATE OR REPLACE FUNCTION auth.uid()
      RETURNS uuid
      LANGUAGE sql
      STABLE
      AS $$
        SELECT NULLIF(
          current_setting('test.actor', true),
          ''
        )::uuid
      $$;
    `);
  }, 45000);

  beforeEach(async () => {
    await db.exec(`
      SELECT
        set_config('test.post_permission','on',false),
        set_config('test.scope','on',false),
        set_config('test.actor','00000000-0000-4000-8000-000000000503',false),
        set_config('neo.pms_accommodation_job_run_id','',false);
    `);
    await db.exec(`
      TRUNCATE
        public.neo_pms_accommodation_automation_settings,
        public.neo_pms_accommodation_job_runs,
        public.business_days,
        public.branches,
        public.folio_lines,
        public.folios,
        public.stays,
        public.reservations,
        public.rooms,
        public.rate_plans;

      INSERT INTO public.branches VALUES
        ('${ids.branch}','${ids.org}'),
        ('${ids.otherBranch}','${ids.org}');

      INSERT INTO public.business_days(
        organization_id,branch_id,business_date,status
      ) VALUES
        ('${ids.org}','${ids.branch}',DATE '2026-11-17','open'),
        ('${ids.org}','${ids.otherBranch}',DATE '2026-11-17','open');
      INSERT INTO public.rooms VALUES
        ('${ids.room}','${ids.org}','${ids.branch}','101');

      INSERT INTO public.rate_plans VALUES
        ('${ids.ratePlan}','${ids.org}',NULL,16,10,'exclusive');

      INSERT INTO public.reservations VALUES (
        '${ids.reservation}','${ids.org}','${ids.branch}',
        DATE '2026-11-16',DATE '2026-11-19',
        12000,'${ids.ratePlan}'
      );

      INSERT INTO public.stays VALUES (
        '${ids.stay}','${ids.org}','${ids.branch}',
        '${ids.reservation}','${ids.room}','in-house'
      );

      INSERT INTO public.folios (
        id,organization_id,branch_id,stay_id,reservation_id,folio_type,status
      ) VALUES (
        '${ids.folio}','${ids.org}','${ids.branch}',
        '${ids.stay}','${ids.reservation}','guest','open'
      );
    `);
  });

  afterAll(async () => {
    await db?.close();
  });

  async function post(date: string) {
    const r = await db.query<{n:number}>(
      "SELECT public.pms_post_accommodation($1::date) AS n",
      [date],
    );
    return r.rows[0]?.n;
  }

  async function totals() {
    const r = await db.query<{
      gross: string;
      tax: string;
      service: string;
      net: string;
      lines: number;
    }>(`
      SELECT
        COALESCE(sum(gross_amount),0)::text AS gross,
        COALESCE(sum(tax_amount),0)::text AS tax,
        COALESCE(sum(service_charge_amount),0)::text AS service,
        COALESCE(sum(net_amount),0)::text AS net,
        count(*)::int AS lines
      FROM public.folio_lines
      WHERE organization_id='${ids.org}'
    `);
    return r.rows[0]!;
  }

  const localToday = `
    (now() AT TIME ZONE 'Africa/Nairobi')::date
  `;

  async function prepareCurrentStay() {
    await db.exec(`
      UPDATE public.business_days
      SET business_date = ${localToday}
      WHERE branch_id = '${ids.branch}';

      UPDATE public.reservations
      SET arrival_date = ${localToday} - 1,
          departure_date = ${localToday} + 2
      WHERE id = '${ids.reservation}';
    `);
  }

  async function enableProperty() {
    await db.exec(`
      INSERT INTO public.neo_pms_accommodation_automation_settings(
        organization_id,
        branch_id,
        enabled,
        activation_date
      )
      VALUES (
        '${ids.org}',
        '${ids.branch}',
        true,
        ${localToday}
      );
    `);
  }

  it("does not post automatically when properties have not opted in", async () => {
    const result = await db.query<{ result: {
      status: string;
      eligible_property_days: number;
      posted: number;
    } }>(`
      SELECT public.neo_pms_post_accommodation_scheduled(true) AS result
    `);

    expect(result.rows[0]?.result.posted).toBe(0);
    expect(result.rows[0]?.result.eligible_property_days).toBe(0);

    const charges = await db.query<{ count: number }>(`
      SELECT count(*)::integer AS count FROM public.folio_lines
    `);

    expect(charges.rows[0]?.count).toBe(0);
  });

  it("does not post historical business days even when enabled", async () => {
    await db.exec(`
      INSERT INTO public.neo_pms_accommodation_automation_settings(
        organization_id, branch_id, enabled, activation_date
      )
      VALUES (
        '${ids.org}',
        '${ids.branch}',
        true,
        DATE '2026-11-17'
      );
    `);

    const result = await db.query<{ result: {
      eligible_property_days: number;
      posted: number;
    } }>(`
      SELECT public.neo_pms_post_accommodation_scheduled(true) AS result
    `);

    expect(result.rows[0]?.result.eligible_property_days).toBe(0);
    expect(result.rows[0]?.result.posted).toBe(0);
  });

  it("links real automatic charges to their completed execution", async () => {
    await prepareCurrentStay();
    await enableProperty();

    await db.exec(`
      SELECT set_config('test.actor', '', false);
    `);

    const execution = await db.query<{ result: {
      completed: number;
      failed: number;
      posted: number;
    } }>(`
      SELECT public.neo_pms_post_accommodation_scheduled(true) AS result
    `);

        const failures = await db.query<{
      branch_id: string;
      business_date: string;
      status: string;
      error_message: string | null;
    }>(`
      SELECT
        branch_id,
        business_date::text,
        status,
        error_message
      FROM public.neo_pms_accommodation_job_runs
      ORDER BY started_at DESC
    `);

    expect(
      execution.rows[0]?.result.failed,
      JSON.stringify({
        execution: execution.rows[0]?.result,
        databaseFailures: failures.rows
      }, null, 2)
    ).toBe(0);
    expect(execution.rows[0]?.result.posted).toBe(1);

    const links = await db.query<{
      job_id: string;
      status: string;
      posted_count: number;
      gross: string;
      service: string;
      tax: string;
      net: string;
      posted_by: string | null;
    }>(`
      SELECT
        l.automatic_job_run_id AS job_id,
        r.status,
        r.posted_count,
        l.gross_amount::text AS gross,
        l.service_charge_amount::text AS service,
        l.tax_amount::text AS tax,
        l.net_amount::text AS net,
        l.posted_by
      FROM public.folio_lines l
      JOIN public.neo_pms_accommodation_job_runs r
        ON r.id = l.automatic_job_run_id
      WHERE l.category = 'accommodation'
    `);

    expect(links.rows).toHaveLength(1);

    const line = links.rows[0]!;

    expect(line.job_id).toBeTruthy();
    expect(line.status).toBe('completed');
    expect(line.posted_count).toBe(1);
    expect(Number(line.gross)).toBe(12000);
    expect(Number(line.service)).toBe(1200);
    expect(Number(line.tax)).toBe(2112);
    expect(Number(line.net)).toBe(15312);
    expect(line.posted_by).toBeNull();

    const second = await db.query<{ result: {
      posted: number;
      failed: number;
    } }>(`
      SELECT public.neo_pms_post_accommodation_scheduled(true) AS result
    `);

    expect(second.rows[0]?.result.failed).toBe(0);
    expect(second.rows[0]?.result.posted).toBe(0);
  });

  it("rejects employee attempts to enable accommodation automation", async () => {
    await db.exec("SET ROLE authenticated");

    try {
      await expect(db.query(`
        INSERT INTO public.neo_pms_accommodation_automation_settings(
          organization_id, branch_id, enabled, activation_date
        )
        VALUES (
          '${ids.org}',
          '${ids.branch}',
          true,
          ${localToday}
        )
      `)).rejects.toThrow();

      await expect(db.query(`
        SELECT public.neo_pms_post_accommodation_scheduled(true)
      `)).rejects.toThrow();
    } finally {
      await db.exec("RESET ROLE");
    }
  });

  it("does not permit employees to forge scheduled attribution", async () => {
    await prepareCurrentStay();

    await db.exec(`
      INSERT INTO public.neo_pms_accommodation_job_runs(
        organization_id,
        branch_id,
        business_date,
        status
      )
      VALUES (
        '${ids.org}',
        '${ids.branch}',
        ${localToday},
        'running'
      );
    `);

    await db.exec(`
      SELECT set_config(
        'neo.pms_accommodation_job_run_id',
        (
          SELECT id::text
          FROM public.neo_pms_accommodation_job_runs
          LIMIT 1
        ),
        false
      );
    `);

    try {
      await expect(db.query(`
        SELECT public.pms_post_accommodation_scoped(
          '${ids.branch}'::uuid,
          ${localToday}
        )
      `)).rejects.toThrow(
        'Employee sessions cannot claim automatic accommodation attribution'
      );

      const charges = await db.query<{ count: number }>(`
        SELECT count(*)::integer AS count
        FROM public.folio_lines
      `);

      expect(charges.rows[0]?.count).toBe(0);
    } finally {
      await db.exec(`
        SELECT set_config(
          'neo.pms_accommodation_job_run_id',
          '',
          false
        );
      `);
    }
  });

  it("prevents reassignment of an automatic charge to another run", async () => {
    await prepareCurrentStay();
    await enableProperty();

    await db.exec(`
      SELECT set_config('test.actor', '', false);
      SELECT public.neo_pms_post_accommodation_scheduled(true);
    `);

    await expect(db.query(`
      UPDATE public.folio_lines
      SET automatic_job_run_id = NULL
      WHERE automatic_job_run_id IS NOT NULL
    `)).rejects.toThrow(
      'Accommodation automatic-job attribution cannot be changed'
    );
  });
});