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
  }, 45000);

  beforeEach(async () => {
    await db.exec(`
      SELECT
        set_config('test.post_permission','on',false),
        set_config('test.scope','on',false);
    `);
    await db.exec(`
      TRUNCATE public.business_days, public.branches, public.folio_lines, public.folios, public.stays,
               public.reservations, public.rooms, public.rate_plans;

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

  it("installs exclusive and inclusive pricing into the real function", async () => {
    const r = await db.query<{definition:string}>(`
      SELECT pg_get_functiondef(
        'public.pms_post_accommodation(date)'::regprocedure
      ) AS definition
    `);
    const sql = r.rows[0]?.definition ?? "";
    expect(sql).toContain("service_charge_rate");
    expect(sql).toContain("tax_treatment");
    expect(sql).toContain("service_charge_amount");
  });

  it("posts exclusive tax on room plus service charge", async () => {
    expect(await post("2026-11-17")).toBe(1);

    const t = await totals();
    expect(Number(t.gross)).toBe(12000);
    expect(Number(t.service)).toBe(1200);
    expect(Number(t.tax)).toBe(2112);
    expect(Number(t.net)).toBe(15312);
    expect(t.lines).toBe(1);

    const f = await db.query<{balance:string}>(`
      SELECT balance FROM public.folios WHERE id='${ids.folio}'
    `);
    expect(Number(f.rows[0]?.balance)).toBe(15312);
  });

  it("does not add extra tax or service for inclusive pricing", async () => {
    await db.exec(`
      UPDATE public.rate_plans SET tax_treatment='inclusive'
      WHERE id='${ids.ratePlan}';
    `);

    expect(await post("2026-11-17")).toBe(1);
    const t = await totals();
    expect(Number(t.gross)).toBe(12000);
    expect(Number(t.tax)).toBe(0);
    expect(Number(t.service)).toBe(0);
    expect(Number(t.net)).toBe(12000);
  });

  it("does not duplicate a night with the fixture uniqueness index", async () => {
    expect(await post("2026-11-17")).toBe(1);
    expect(await post("2026-11-17")).toBe(0);

    const t = await totals();
    expect(t.lines).toBe(1);
    expect(Number(t.net)).toBe(15312);
  });

  it("posts distinct occupied nights but not departure day", async () => {
    expect(await post("2026-11-16")).toBe(1);
    expect(await post("2026-11-17")).toBe(1);
    expect(await post("2026-11-18")).toBe(1);
    expect(await post("2026-11-19")).toBe(0);

    const t = await totals();
    expect(t.lines).toBe(3);
    expect(Number(t.net)).toBe(45936);
  });

  it("does not post another organisation's stay", async () => {
    await db.query(
      `INSERT INTO public.reservations VALUES (
        $1,$2,$3,DATE '2026-11-16',DATE '2026-11-19',
        12000,$4
      )`,
      [ids.otherReservation,ids.otherOrg,ids.branch,ids.ratePlan]
    );

    await db.query(
      `INSERT INTO public.stays VALUES (
        $1,$2,$3,$4,$5,'in-house'
      )`,
      [ids.otherStay,ids.otherOrg,ids.branch,
       ids.otherReservation,ids.room]
    );

    await db.query(
      `INSERT INTO public.folios (
        id,organization_id,branch_id,stay_id,reservation_id,folio_type,status
      ) VALUES ($1,$2,$3,$4,$5,'guest','open')`,
      [ids.otherFolio,ids.otherOrg,ids.branch,ids.otherStay,ids.otherReservation]
    );

    expect(await post("2026-11-17")).toBe(1);

    const r = await db.query<{n:number}>(`
      SELECT count(*)::int AS n FROM public.folio_lines
      WHERE folio_id='${ids.otherFolio}'
    `);
    expect(r.rows[0]?.n).toBe(0);
  });

  it("preserves same-property accommodation posting", async () => {
    expect(await post("2026-11-17")).toBe(1);
    expect(Number((await totals()).net)).toBe(15312);
  });

  it("rejects a reservation from another branch", async () => {
    await db.query(
      "UPDATE public.reservations SET branch_id=$1 WHERE id=$2",
      [ids.otherBranch,ids.reservation],
    );
    expect(await post("2026-11-17")).toBe(0);
    expect((await totals()).lines).toBe(0);
  });

  it("rejects a folio from another branch", async () => {
    await db.query(
      "UPDATE public.folios SET branch_id=$1 WHERE id=$2",
      [ids.otherBranch,ids.folio],
    );
    expect(await post("2026-11-17")).toBe(0);
    expect((await totals()).lines).toBe(0);
  });

  it("rejects a folio associated with another reservation", async () => {
    await db.query(
      "UPDATE public.folios SET reservation_id=$1 WHERE id=$2",
      [ids.otherReservation,ids.folio],
    );
    expect(await post("2026-11-17")).toBe(0);
    expect((await totals()).lines).toBe(0);
  });

  it("rejects a room from another organisation", async () => {
    await db.query(
      "UPDATE public.rooms SET organization_id=$1 WHERE id=$2",
      [ids.otherOrg,ids.room],
    );
    expect(await post("2026-11-17")).toBe(0);
    expect((await totals()).lines).toBe(0);
  });

  it("rejects a room from another branch", async () => {
    await db.query(
      "UPDATE public.rooms SET branch_id=$1 WHERE id=$2",
      [ids.otherBranch,ids.room],
    );
    expect(await post("2026-11-17")).toBe(0);
    expect((await totals()).lines).toBe(0);
  });

  it("rejects a rate plan from another branch", async () => {
    await db.query(
      "UPDATE public.rate_plans SET branch_id=$1 WHERE id=$2",
      [ids.otherBranch,ids.ratePlan],
    );
    expect(await post("2026-11-17")).toBe(0);
    expect((await totals()).lines).toBe(0);
  });

  it("accepts an organisation-wide rate plan", async () => {
    const r = await db.query<{branch_id:string|null}>(
      "SELECT branch_id FROM public.rate_plans WHERE id=$1",
      [ids.ratePlan],
    );
    expect(r.rows[0]?.branch_id).toBeNull();
    expect(await post("2026-11-17")).toBe(1);
  });
  async function postScoped(branch: string, date: string) {
    const result = await db.query<{ n: number }>(
      `SELECT public.pms_post_accommodation_scoped(
        $1::uuid,$2::date
      ) AS n`,
      [branch,date],
    );

    return result.rows[0]?.n;
  }

  it("restricts legacy posting and grants scoped posting", async () => {
    const result = await db.query<{
      legacy: boolean;
      scoped: boolean;
      anonymous: boolean;
    }>(`
      SELECT
        has_function_privilege(
          'authenticated',
          'public.pms_post_accommodation(date)',
          'EXECUTE'
        ) AS legacy,
        has_function_privilege(
          'authenticated',
          'public.pms_post_accommodation_scoped(uuid,date)',
          'EXECUTE'
        ) AS scoped,
        has_function_privilege(
          'anon',
          'public.pms_post_accommodation_scoped(uuid,date)',
          'EXECUTE'
        ) AS anonymous
    `);

    expect(result.rows[0]?.legacy).toBe(false);
    expect(result.rows[0]?.scoped).toBe(true);
    expect(result.rows[0]?.anonymous).toBe(false);
  });
  it("installs the automatic accommodation service functions", async () => {
    const result = await db.query<{
      internal: boolean;
      scheduled: boolean;
    }>(`
      SELECT
        to_regprocedure(
          'public.neo_pms_post_accommodation_job(uuid,uuid,date)'
        ) IS NOT NULL AS internal,
        to_regprocedure(
          'public.neo_pms_post_accommodation_scheduled(boolean)'
        ) IS NOT NULL AS scheduled
    `);

    expect(result.rows[0]?.internal).toBe(true);
    expect(result.rows[0]?.scheduled).toBe(true);
  });

  it("prevents employees from executing the automatic financial engine", async () => {
    const result = await db.query<{
      internal: boolean;
      scheduled: boolean;
      serviceInternal: boolean;
      serviceScheduled: boolean;
    }>(`
      SELECT
        has_function_privilege(
          'authenticated',
          'public.neo_pms_post_accommodation_job(uuid,uuid,date)',
          'EXECUTE'
        ) AS internal,
        has_function_privilege(
          'authenticated',
          'public.neo_pms_post_accommodation_scheduled(boolean)',
          'EXECUTE'
        ) AS scheduled,
        has_function_privilege(
          'service_role',
          'public.neo_pms_post_accommodation_job(uuid,uuid,date)',
          'EXECUTE'
        ) AS "serviceInternal",
        has_function_privilege(
          'service_role',
          'public.neo_pms_post_accommodation_scheduled(boolean)',
          'EXECUTE'
        ) AS "serviceScheduled"
    `);

    expect(result.rows[0]?.internal).toBe(false);
    expect(result.rows[0]?.scheduled).toBe(false);
    expect(result.rows[0]?.serviceInternal).toBe(false);
    expect(result.rows[0]?.serviceScheduled).toBe(false);
  });

  it("automatic accommodation scheduler defaults to dry-run", async () => {
    const before = await db.query<{ count: number }>(`
      SELECT count(*)::integer AS count
      FROM public.folio_lines
    `);

    const result = await db.query<{ result: {
      status: string;
      posted: number;
      completed: number;
      failed: number;
      properties_with_open_days: number;
    } }>(`
      SELECT public.neo_pms_post_accommodation_scheduled() AS result
    `);

    const after = await db.query<{ count: number }>(`
      SELECT count(*)::integer AS count
      FROM public.folio_lines
    `);

    expect(result.rows[0]?.result.status).toBe("dry_run");
    expect(result.rows[0]?.result.posted).toBe(0);
    expect(result.rows[0]?.result.completed).toBe(0);
    expect(result.rows[0]?.result.failed).toBe(0);
    expect(after.rows[0]?.count).toBe(before.rows[0]?.count);
  });

  it("scheduled accommodation execution is repeatable without duplicate charges", async () => {
    const first = await db.query<{ result: {
      status: string;
      completed: number;
      failed: number;
      posted: number;
    } }>(`
      SELECT public.neo_pms_post_accommodation_scheduled(true) AS result
    `);

    expect(first.rows[0]?.result.failed).toBe(0);
    expect(first.rows[0]?.result.status).toBe("completed");

    // A successful empty run is not proof of financial posting.
    expect(first.rows[0]?.result.posted).toBeGreaterThan(0);

    const charged = await db.query<{ count: number }>(`
      SELECT count(*)::integer AS count
      FROM public.folio_lines
      WHERE category = 'accommodation'
        AND line_type = 'charge'
    `);

    expect(charged.rows[0]?.count).toBeGreaterThanOrEqual(
      first.rows[0]!.result.posted
    );

    const second = await db.query<{ result: {
      status: string;
      completed: number;
      failed: number;
      posted: number;
    } }>(`
      SELECT public.neo_pms_post_accommodation_scheduled(true) AS result
    `);

    expect(second.rows[0]?.result.failed).toBe(0);
    expect(second.rows[0]?.result.posted).toBe(0);

    const evidence = await db.query<{ count: number }>(`
      SELECT count(*)::integer AS count
      FROM public.neo_pms_accommodation_job_runs
      WHERE status = 'completed'
    `);

    expect(evidence.rows[0]!.count).toBeGreaterThanOrEqual(
      first.rows[0]!.result.completed +
      second.rows[0]!.result.completed
    );
  });
  it("scheduled posting works without an employee session", async () => {
    // Simulate pg_cron: there is no authenticated hotel employee.
    await db.exec(`
      SELECT set_config('test.actor', '', false);
    `);

    const result = await db.query<{
      result: {
        status: string;
        posted: number;
        failed: number;
      };
    }>(`
      SELECT
        public.neo_pms_post_accommodation_scheduled(true)
        AS result
    `);

    expect(result.rows[0]?.result.failed).toBe(0);
    expect(result.rows[0]?.result.status).toBe("completed");
    expect(result.rows[0]?.result.posted).toBeGreaterThan(0);

    const evidence = await db.query<{
      posted_count: number;
    }>(`
      SELECT COALESCE(
        SUM(posted_count), 0
      )::integer AS posted_count
      FROM public.neo_pms_accommodation_job_runs
      WHERE status = 'completed'
    `);

    expect(evidence.rows[0]?.posted_count).toBeGreaterThan(0);

    const charges = await db.query<{
      count: number;
    }>(`
      SELECT count(*)::integer AS count
      FROM public.folio_lines
      WHERE category = 'accommodation'
        AND line_type = 'charge'
    `);

    expect(charges.rows[0]?.count).toBeGreaterThan(0);
  });
  it("records failed unattended posting without partial charges", async () => {
    const before = await db.query<{ count: number }>(`
      SELECT count(*)::integer AS count
      FROM public.folio_lines
    `);

    await db.exec(`
      CREATE FUNCTION public.test_block_automatic_accommodation()
      RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        RAISE EXCEPTION 'Simulated accommodation posting failure';
      END;
      $$;

      CREATE TRIGGER test_block_automatic_accommodation
      BEFORE INSERT ON public.folio_lines
      FOR EACH ROW
      EXECUTE FUNCTION public.test_block_automatic_accommodation();
    `);

    try {
      await db.exec(`
        SELECT set_config('test.actor', '', false);
      `);

      const result = await db.query<{
        result: {
          status: string;
          completed: number;
          failed: number;
          posted: number;
        };
      }>(`
        SELECT public.neo_pms_post_accommodation_scheduled(true)
        AS result
      `);

      expect(result.rows[0]?.result.status).toBe("exceptions");
      expect(result.rows[0]?.result.failed).toBeGreaterThan(0);
      expect(result.rows[0]?.result.posted).toBe(0);

      const after = await db.query<{ count: number }>(`
        SELECT count(*)::integer AS count
        FROM public.folio_lines
      `);

      expect(after.rows[0]?.count).toBe(before.rows[0]?.count);

      const evidence = await db.query<{
        count: number;
      }>(`
        SELECT count(*)::integer AS count
        FROM public.neo_pms_accommodation_job_runs
        WHERE status = 'failed'
          AND error_message LIKE
            '%Simulated accommodation posting failure%'
      `);

      expect(evidence.rows[0]?.count).toBeGreaterThan(0);
    } finally {
      await db.exec(`
        DROP TRIGGER IF EXISTS test_block_automatic_accommodation
        ON public.folio_lines;

        DROP FUNCTION IF EXISTS
        public.test_block_automatic_accommodation();
      `);
    }
  });
  it("automatic accommodation preserves exact accounting and system attribution", async () => {
    // Simulate the unattended database scheduler.
    await db.exec(`
      SELECT set_config('test.actor', '', false);
    `);

    const result = await db.query<{
      result: {
        status: string;
        posted: number;
        failed: number;
      };
    }>(`
      SELECT public.neo_pms_post_accommodation_scheduled(true) AS result
    `);

    expect(result.rows[0]?.result.status).toBe("completed");
    expect(result.rows[0]?.result.failed).toBe(0);
    expect(result.rows[0]?.result.posted).toBe(1);

    const charges = await db.query<{
      branch_id: string;
      reservation_id: string;
      operational_date: string;
      gross_amount: string;
      service_charge_amount: string;
      tax_amount: string;
      net_amount: string;
      posted_by: string | null;
      source_module: string;
    }>(`
      SELECT
        branch_id,
        reservation_id,
        operational_date::text,
        gross_amount::text,
        service_charge_amount::text,
        tax_amount::text,
        net_amount::text,
        posted_by,
        source_module
      FROM public.folio_lines
      WHERE category = 'accommodation'
        AND line_type = 'charge'
    `);

    expect(charges.rows).toHaveLength(1);

    const charge = charges.rows[0]!;

    expect(charge.branch_id).toBe(ids.branch);
    expect(charge.reservation_id).toBe(ids.reservation);
    expect(charge.operational_date).toBe("2026-11-17");

    expect(Number(charge.gross_amount)).toBe(12000);
    expect(Number(charge.service_charge_amount)).toBe(1200);
    expect(Number(charge.tax_amount)).toBe(2112);
    expect(Number(charge.net_amount)).toBe(15312);

    // An unattended job must not impersonate an employee.
    expect(charge.posted_by).toBeNull();
    expect(charge.source_module).toBe("pms");

    const folio = await db.query<{
      total_charges: string;
      total_taxes: string;
      balance: string;
    }>(`
      SELECT
        total_charges::text,
        total_taxes::text,
        balance::text
      FROM public.folios
      WHERE id = '${ids.folio}'
    `);

    expect(folio.rows).toHaveLength(1);
    expect(Number(folio.rows[0]!.total_charges)).toBe(12000);
    expect(Number(folio.rows[0]!.total_taxes)).toBe(2112);
    expect(Number(folio.rows[0]!.balance)).toBe(15312);

    const evidence = await db.query<{
      organization_id: string;
      branch_id: string;
      business_date: string;
      posted_count: number;
      status: string;
    }>(`
      SELECT
        organization_id,
        branch_id,
        business_date::text,
        posted_count,
        status
      FROM public.neo_pms_accommodation_job_runs
      WHERE branch_id = '${ids.branch}'
      ORDER BY started_at DESC
      LIMIT 1
    `);

    expect(evidence.rows).toHaveLength(1);

    expect(evidence.rows[0]).toMatchObject({
      organization_id: ids.org,
      branch_id: ids.branch,
      business_date: "2026-11-17",
      posted_count: 1,
      status: "completed",
    });
  });
  it("automatic posting isolates property failures", async () => {
    const secondRoom = "00000000-0000-4000-8000-000000000901";
    const secondReservation = "00000000-0000-4000-8000-000000000902";
    const secondStay = "00000000-0000-4000-8000-000000000903";
    const secondFolio = "00000000-0000-4000-8000-000000000904";

    // The existing fixture already contains two properties.
    // Give the second property its own room, reservation,
    // occupied stay and guest folio.
    await db.exec(`
      INSERT INTO public.rooms
      VALUES (
        '${secondRoom}',
        '${ids.org}',
        '${ids.otherBranch}',
        '201'
      );

      INSERT INTO public.reservations
      VALUES (
        '${secondReservation}',
        '${ids.org}',
        '${ids.otherBranch}',
        DATE '2026-11-16',
        DATE '2026-11-19',
        12000,
        '${ids.ratePlan}'
      );

      INSERT INTO public.stays
      VALUES (
        '${secondStay}',
        '${ids.org}',
        '${ids.otherBranch}',
        '${secondReservation}',
        '${secondRoom}',
        'in-house'
      );

      INSERT INTO public.folios (
        id,
        organization_id,
        branch_id,
        stay_id,
        reservation_id,
        folio_type,
        status
      )
      VALUES (
        '${secondFolio}',
        '${ids.org}',
        '${ids.otherBranch}',
        '${secondStay}',
        '${secondReservation}',
        'guest',
        'open'
      );
    `);

    // Deliberately prevent accommodation charges at Property A.
    await db.exec(`
      CREATE FUNCTION public.test_reject_first_property()
      RETURNS trigger
      LANGUAGE plpgsql
      AS $$
      BEGIN
        IF NEW.branch_id = '${ids.branch}'::uuid THEN
          RAISE EXCEPTION
            'Simulated first-property financial failure';
        END IF;

        RETURN NEW;
      END;
      $$;

      CREATE TRIGGER test_reject_first_property
      BEFORE INSERT ON public.folio_lines
      FOR EACH ROW
      EXECUTE FUNCTION public.test_reject_first_property();
    `);

    try {
      await db.exec(`
        SELECT set_config('test.actor', '', false);
      `);

      const execution = await db.query<{
        result: {
          status: string;
          completed: number;
          failed: number;
          posted: number;
        };
      }>(`
        SELECT
          public.neo_pms_post_accommodation_scheduled(true)
          AS result
      `);

      expect(execution.rows[0]?.result.status).toBe("exceptions");
      expect(execution.rows[0]?.result.failed).toBe(1);
      expect(execution.rows[0]?.result.completed).toBe(1);
      expect(execution.rows[0]?.result.posted).toBe(1);

      const charges = await db.query<{
        branch_id: string;
        reservation_id: string;
        gross: string;
        service: string;
        tax: string;
        net: string;
      }>(`
        SELECT
          branch_id,
          reservation_id,
          gross_amount::text AS gross,
          service_charge_amount::text AS service,
          tax_amount::text AS tax,
          net_amount::text AS net
        FROM public.folio_lines
        WHERE category = 'accommodation'
          AND line_type = 'charge'
      `);

      // Property A must have no accommodation charge.
      // Property B must have exactly one correct charge.
      expect(charges.rows).toHaveLength(1);

      const charge = charges.rows[0]!;

      expect(charge.branch_id).toBe(ids.otherBranch);
      expect(charge.reservation_id).toBe(secondReservation);
      expect(Number(charge.gross)).toBe(12000);
      expect(Number(charge.service)).toBe(1200);
      expect(Number(charge.tax)).toBe(2112);
      expect(Number(charge.net)).toBe(15312);

      const folios = await db.query<{
        branch_id: string;
        balance: string;
      }>(`
        SELECT
          branch_id,
          balance::text
        FROM public.folios
        WHERE id IN (
          '${ids.folio}',
          '${secondFolio}'
        )
      `);

      expect(folios.rows).toHaveLength(2);

      const failedFolio = folios.rows.find(
        row => row.branch_id === ids.branch
      );

      const successfulFolio = folios.rows.find(
        row => row.branch_id === ids.otherBranch
      );

      expect(Number(failedFolio?.balance)).toBe(0);
      expect(Number(successfulFolio?.balance)).toBe(15312);

      const evidence = await db.query<{
        branch_id: string;
        status: string;
        posted_count: number;
        error_message: string | null;
      }>(`
        SELECT
          branch_id,
          status,
          posted_count,
          error_message
        FROM public.neo_pms_accommodation_job_runs
        WHERE business_date = DATE '2026-11-17'
          AND organization_id = '${ids.org}'
        ORDER BY started_at DESC
      `);

      expect(
        evidence.rows.some(
          row =>
            row.branch_id === ids.branch &&
            row.status === "failed" &&
            row.posted_count === 0 &&
            row.error_message?.includes(
              "Simulated first-property financial failure"
            )
        )
      ).toBe(true);

      expect(
        evidence.rows.some(
          row =>
            row.branch_id === ids.otherBranch &&
            row.status === "completed" &&
            row.posted_count === 1
        )
      ).toBe(true);

    } finally {
      await db.exec(`
        DROP TRIGGER IF EXISTS test_reject_first_property
        ON public.folio_lines;

        DROP FUNCTION IF EXISTS
        public.test_reject_first_property();
      `);
    }
  });
  it("installs the scoped accommodation function", async () => {
    const result = await db.query<{ name: string }>(`
      SELECT to_regprocedure(
        'public.pms_post_accommodation_scoped(uuid,date)'
      )::text AS name
    `);

    expect(result.rows[0]?.name).toContain(
      "pms_post_accommodation_scoped"
    );
  });

  it("posts accommodation with correct pricing", async () => {
    expect(await postScoped(ids.branch,"2026-11-17")).toBe(1);

    const result = await totals();

    expect(result.lines).toBe(1);
    expect(Number(result.gross)).toBe(12000);
    expect(Number(result.service)).toBe(1200);
    expect(Number(result.tax)).toBe(2112);
    expect(Number(result.net)).toBe(15312);
  });

  it("prevents duplicate accommodation charges", async () => {
    expect(await postScoped(ids.branch,"2026-11-17")).toBe(1);
    expect(await postScoped(ids.branch,"2026-11-17")).toBe(0);

    expect((await totals()).lines).toBe(1);
  });

  it("rejects posting to a closed business day", async () => {
    await db.query(
      `UPDATE public.business_days
       SET status='closed'
       WHERE branch_id=$1`,
      [ids.branch],
    );

    await expect(
      postScoped(ids.branch,"2026-11-17")
    ).rejects.toThrow(/open property business day/);

    expect((await totals()).lines).toBe(0);
  });

  it("rejects future accommodation posting", async () => {
    await expect(
      postScoped(ids.branch,"2099-12-30")
    ).rejects.toThrow(/Future accommodation posting/);
  });

  it("rejects an unknown property", async () => {
    await expect(
      postScoped(
        "00000000-0000-4000-8000-000000000699",
        "2026-11-17"
      )
    ).rejects.toThrow(/Unknown property/);
  });

  it("does not post a different property's stay", async () => {
    expect(
      await postScoped(ids.otherBranch,"2026-11-17")
    ).toBe(0);

    expect((await totals()).lines).toBe(0);
  });

  it("rejects an employee without posting permission", async () => {
    await db.exec(`
      SELECT set_config('test.post_permission','off',false);
    `);

    await expect(
      postScoped(ids.branch,"2026-11-17")
    ).rejects.toThrow(/Not permitted/);

    expect((await totals()).lines).toBe(0);
  });

  it("rejects an employee outside the property scope", async () => {
    await db.exec(`
      SELECT set_config('test.scope','off',false);
    `);

    await expect(
      postScoped(ids.branch,"2026-11-17")
    ).rejects.toThrow(/outside permitted scope/);

    expect((await totals()).lines).toBe(0);
  });

  it("keeps two populated properties financially isolated", async () => {
    const roomB = "00000000-0000-4000-8000-000000000601";
    const reservationB = "00000000-0000-4000-8000-000000000602";
    const stayB = "00000000-0000-4000-8000-000000000603";
    const folioB = "00000000-0000-4000-8000-000000000604";

    await db.query(
      `INSERT INTO public.rooms
       VALUES ($1,$2,$3,'201')`,
      [roomB,ids.org,ids.otherBranch],
    );

    await db.query(
      `INSERT INTO public.reservations
       VALUES (
         $1,$2,$3,
         DATE '2026-11-16',
         DATE '2026-11-19',
         8000,$4
       )`,
      [reservationB,ids.org,ids.otherBranch,ids.ratePlan],
    );

    await db.query(
      `INSERT INTO public.stays
       VALUES ($1,$2,$3,$4,$5,'in-house')`,
      [stayB,ids.org,ids.otherBranch,reservationB,roomB],
    );

    await db.query(
      `INSERT INTO public.folios(
        id,organization_id,branch_id,
        stay_id,reservation_id,folio_type,status
      )
      VALUES ($1,$2,$3,$4,$5,'guest','open')`,
      [folioB,ids.org,ids.otherBranch,stayB,reservationB],
    );

    expect(await postScoped(ids.branch,"2026-11-17")).toBe(1);

    let result = await db.query<{branch_id:string}>(`
      SELECT branch_id FROM public.folio_lines
      WHERE category='accommodation'
    `);

    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]?.branch_id).toBe(ids.branch);

    expect(await postScoped(ids.otherBranch,"2026-11-17")).toBe(1);

    const balances = await db.query<{
      branch_id:string;
      balance:string;
    }>(`
      SELECT branch_id,balance::text AS balance
      FROM public.folios
      ORDER BY branch_id
    `);

    expect(balances.rows).toHaveLength(2);

    const first = balances.rows.find(
      row => row.branch_id === ids.branch
    );

    const second = balances.rows.find(
      row => row.branch_id === ids.otherBranch
    );

    expect(Number(first?.balance)).toBe(15312);
    expect(Number(second?.balance)).toBe(10208);

    result = await db.query<{branch_id:string}>(`
      SELECT branch_id FROM public.folio_lines
      WHERE category='accommodation'
    `);

    expect(result.rows).toHaveLength(2);
  });
});