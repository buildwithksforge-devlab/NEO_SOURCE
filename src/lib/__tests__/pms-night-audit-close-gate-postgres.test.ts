import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

const migrationPath = join(
  process.cwd(),
  "supabase",
  "migrations",
  "20260924090000_finish_controlled_finance_flows.sql",
);
const migration = readFileSync(migrationPath, "utf8");
const functionStart = migration.indexOf(
  "CREATE OR REPLACE FUNCTION public.neo_close_business_day(",
);
const functionEnd = migration.indexOf("$function$;", functionStart) + "$function$;".length;
const closeBusinessDaySql = migration.slice(functionStart, functionEnd);

const auditSource = readFileSync(
  "supabase/migrations/20261003133000_repair_night_audit_eod_contract.sql",
  "utf8",
);
const auditStart = auditSource.indexOf(
  "CREATE OR REPLACE FUNCTION public.neo_night_audit_run(",
);
const auditEnd = auditSource.indexOf("$function$;", auditStart);
if (auditStart < 0 || auditEnd < 0) {
  throw new Error("Reviewed Night Audit function not found");
}
const auditFunctionSql = auditSource.slice(
  auditStart, auditEnd + "$function$;".length,
);
const helperMigration = readFileSync(
  "supabase/migrations/20261117000000_pms_missing_accommodation_reconciliation.sql",
  "utf8",
);
const gateMigration = readFileSync(
  "supabase/migrations/20261117001500_pms_night_audit_accommodation_gate.sql",
  "utf8",
);
describe("business-day close PostgreSQL flow", () => {
  let db: PGlite;
  const organizationId = "aa17d427-f816-49bc-b02e-1a89e44806a2";
  const branchId = "a3000000-0000-4000-8000-000000000001";
  const actorId = "a3000000-0000-4000-8000-000000000002";
  const businessDate = "2099-12-30";

  beforeAll(async () => {
    if (functionStart < 0 || closeBusinessDaySql.length === 0) {
      throw new Error(`Could not find neo_close_business_day in ${migrationPath}`);
    }

    db = new PGlite();
    await db.exec(`
      CREATE ROLE anon;
      CREATE ROLE authenticated;
      CREATE SCHEMA auth;
      CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$
        SELECT nullif(current_setting('test.actor', true), '')::uuid
      $$;
      CREATE FUNCTION current_org_id() RETURNS uuid LANGUAGE sql STABLE AS $$
        SELECT nullif(current_setting('test.organization', true), '')::uuid
      $$;
      CREATE FUNCTION has_permission(text, text, text) RETURNS boolean LANGUAGE sql STABLE AS $$
        SELECT current_setting('test.close_permission', true) = 'on'
      $$;
      CREATE FUNCTION is_org_admin() RETURNS boolean LANGUAGE sql STABLE AS $$
        SELECT current_setting('test.admin', true) = 'on'
      $$;
      CREATE FUNCTION neo_branch_in_scope(uuid) RETURNS boolean LANGUAGE sql STABLE AS $$
        SELECT $1::text = current_setting('test.branch', true)
      $$;

      CREATE TABLE branches(id uuid PRIMARY KEY, organization_id uuid);
      CREATE TABLE business_days(
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        organization_id uuid NOT NULL,
        branch_id uuid NOT NULL,
        business_date date NOT NULL,
        status text NOT NULL,
        opened_at timestamptz DEFAULT now(),
        opened_by uuid,
        closed_at timestamptz,
        closed_by uuid,
        close_mode text,
        notes text,
        updated_at timestamptz,
        UNIQUE (organization_id, branch_id, business_date)
      );
      CREATE TABLE night_audit_runs(
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        organization_id uuid NOT NULL,
        branch_id uuid NOT NULL,
        business_date date NOT NULL,
        status text,
        stage text,
        result_digest text,
        blocking_count integer,
        run_reference text
      );
      CREATE TABLE pos_shifts(organization_id uuid, branch_id uuid, status text);
      CREATE TABLE pos_orders(organization_id uuid, branch_id uuid, created_at timestamptz, status text);
      CREATE TABLE rider_cash_remittances(
        organization_id uuid,
        branch_id uuid,
        submitted_at timestamptz,
        status text
      );
      CREATE TABLE cash_refund_requests(
        organization_id uuid,
        branch_id uuid,
        created_at timestamptz,
        status text
      );
      CREATE TABLE test_finance_exceptions(branch_id uuid, business_date date);
      CREATE TABLE test_posting_queue(branch_id uuid, business_date date, eligible boolean);
      CREATE TABLE audit_logs(
        organization_id uuid,
        branch_id uuid,
        user_id uuid,
        action text,
        module text,
        record_id text,
        new_value jsonb,
        reason text
      );
      CREATE FUNCTION neo_finance_exception_register(uuid, date, date)
      RETURNS TABLE(exception_id integer) LANGUAGE sql STABLE AS $$
        SELECT row_number() OVER ()::integer
          FROM test_finance_exceptions
         WHERE branch_id = $1 AND business_date BETWEEN $2 AND $3
      $$;
      CREATE FUNCTION neo_finance_posting_queue(uuid, date, date)
      RETURNS TABLE(eligible boolean) LANGUAGE sql STABLE AS $$
        SELECT q.eligible FROM test_posting_queue q
         WHERE q.branch_id = $1 AND q.business_date BETWEEN $2 AND $3
      $$;
      CREATE TABLE reservations (
        id uuid PRIMARY KEY,
        organization_id uuid NOT NULL,
        branch_id uuid NOT NULL,
        arrival_date date NOT NULL,
        departure_date date NOT NULL,
        nightly_rate numeric NOT NULL
      );

      CREATE TABLE stays (
        id uuid PRIMARY KEY,
        organization_id uuid NOT NULL,
        branch_id uuid NOT NULL,
        reservation_id uuid NOT NULL,
        status text NOT NULL
      );

      CREATE TABLE folios (
        id uuid PRIMARY KEY,
        organization_id uuid NOT NULL,
        branch_id uuid,
        stay_id uuid,
        reservation_id uuid,
        folio_type text NOT NULL
      );

      CREATE TABLE folio_lines (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        organization_id uuid NOT NULL,
        branch_id uuid,
        folio_id uuid,
        reservation_id uuid,
        operational_date date,
        category text,
        line_type text,
        status text
      );
      ${closeBusinessDaySql}
      ${auditFunctionSql}
    `);
    await db.exec(helperMigration);
    await db.exec(gateMigration);
  }, 60000);

  afterAll(async () => {
    await db?.close();
  });

  beforeEach(async () => {
    await db.exec(`
      TRUNCATE folio_lines, folios, stays, reservations, audit_logs, test_finance_exceptions, test_posting_queue,
        cash_refund_requests, rider_cash_remittances, pos_orders, pos_shifts,
        night_audit_runs, business_days, branches CASCADE
    `);
    await db.query("INSERT INTO branches(id, organization_id) VALUES ($1, $2)", [
      branchId,
      organizationId,
    ]);
    await db.query(
      `SELECT set_config('test.actor', $1, false),
              set_config('test.organization', $2, false),
              set_config('test.branch', $3, false),
              set_config('test.close_permission', 'on', false),
              set_config('test.admin', 'off', false)`,
      [actorId, organizationId, branchId],
    );
  });

  async function seedOpenDay(date = businessDate) {
    await db.query(
      `INSERT INTO business_days(organization_id, branch_id, business_date, status, opened_by)
       VALUES ($1, $2, $3, 'open', $4)`,
      [organizationId, branchId, date, actorId],
    );
  }

  async function seedSignedAudit(date = businessDate, blockingCount = 0) {
    await db.query(
      `INSERT INTO night_audit_runs(
        organization_id, branch_id, business_date, status, stage, result_digest, blocking_count, run_reference
      ) VALUES ($1, $2, $3, 'completed', 'signed', 'sha256:fixture', $4, 'AUDIT-FIXTURE')`,
      [organizationId, branchId, date, blockingCount],
    );
  }

  async function closeDay(date = businessDate) {
    const result = await db.query<{ result: Record<string, unknown> }>(
      "SELECT public.neo_close_business_day($1, $2, 'Synthetic day close') AS result",
      [branchId, date],
    );
    return result.rows[0]!.result;
  }

  it("requires an explicitly opened day and a signed completed audit", async () => {
    expect(await closeDay()).toMatchObject({ status: "not_open" });
    await seedOpenDay();
    expect(await closeDay()).toMatchObject({
      status: "exception",
      message: "Run and complete a signed End-of-Day audit before closing.",
    });

    await db.query(
      `INSERT INTO night_audit_runs(
        organization_id, branch_id, business_date, status, stage, result_digest, blocking_count
      ) VALUES ($1, $2, $3, 'completed', 'draft', 'sha256:fixture', 0)`,
      [organizationId, branchId, businessDate],
    );
    expect(await closeDay()).toMatchObject({ status: "exception" });
    expect(
      (
        await db.query<{ status: string }>(
          "SELECT status FROM business_days WHERE business_date = $1",
          [businessDate],
        )
      ).rows[0]!.status,
    ).toBe("open");
  });

  it("blocks closure while tills, POS orders, rider remittances, or refunds remain unresolved", async () => {
    await seedOpenDay();
    await seedSignedAudit();
    await db.exec(`
      INSERT INTO pos_shifts VALUES ('${organizationId}', '${branchId}', 'variance-review');
      INSERT INTO pos_orders VALUES ('${organizationId}', '${branchId}', '${businessDate} 12:00:00+00', 'served');
      INSERT INTO rider_cash_remittances VALUES ('${organizationId}', '${branchId}', '${businessDate} 12:00:00+00', 'submitted');
      INSERT INTO cash_refund_requests VALUES ('${organizationId}', '${branchId}', '${businessDate} 12:00:00+00', 'approved')
    `);

    expect(await closeDay()).toMatchObject({
      status: "exception",
      blocking: 4,
      open_shifts: 1,
      unclosed_pos_orders: 1,
      unreconciled_rider_cash: 1,
      unsettled_refunds: 1,
    });
    expect(
      (
        await db.query<{ status: string }>(
          "SELECT status FROM business_days WHERE business_date = $1",
          [businessDate],
        )
      ).rows[0]!.status,
    ).toBe("open");
  });

  it("blocks unresolved finance exceptions and eligible posting queue items", async () => {
    await seedOpenDay();
    await seedSignedAudit();
    await db.query("INSERT INTO test_finance_exceptions VALUES ($1, $2)", [branchId, businessDate]);
    await db.query("INSERT INTO test_posting_queue VALUES ($1, $2, true)", [
      branchId,
      businessDate,
    ]);

    expect(await closeDay()).toMatchObject({
      status: "exception",
      blocking: 2,
      message:
        "Reconciliation is unresolved. Resolve the canonical Finance exceptions before closing.",
    });
    expect(
      (
        await db.query<{ status: string }>(
          "SELECT status FROM business_days WHERE business_date = $1",
          [businessDate],
        )
      ).rows[0]!.status,
    ).toBe("open");
  });

  it("closes and locks a reconciled day, advances once, and makes retries idempotent", async () => {
    await seedOpenDay();
    await seedSignedAudit();

    expect(await closeDay()).toMatchObject({
      status: "closed",
      business_date: businessDate,
      next_business_date: "2099-12-31",
    });
    expect(
      (
        await db.query<{ status: string }>(
          "SELECT status FROM business_days WHERE business_date = $1",
          [businessDate],
        )
      ).rows[0]!.status,
    ).toBe("closed");
    expect(
      (
        await db.query<{ status: string }>(
          "SELECT status FROM business_days WHERE business_date = $1",
          ["2099-12-31"],
        )
      ).rows[0]!.status,
    ).toBe("open");
    expect(await closeDay()).toMatchObject({
      status: "already_closed",
      business_date: businessDate,
    });
    expect(
      (await db.query<{ count: number }>("SELECT count(*)::integer AS count FROM business_days"))
        .rows[0]!.count,
    ).toBe(2);
    expect(
      (
        await db.query<{ count: number }>(
          "SELECT count(*)::integer AS count FROM audit_logs WHERE action = 'finance.business_day_closed'",
        )
      ).rows[0]!.count,
    ).toBe(1);
  });

  async function seedMissingNight(
    reservation = "b3000000-0000-4000-8000-000000000001",
    stay = "b3000000-0000-4000-8000-000000000002",
    folio = "b3000000-0000-4000-8000-000000000003",
    property = branchId,
  ) {
    await db.query(
      `INSERT INTO reservations(
        id,organization_id,branch_id,arrival_date,departure_date,nightly_rate
      ) VALUES ($1,$2,$3,$4::date,($4::date + 1),12000)`,
      [reservation, organizationId, property, businessDate],
    );
    await db.query(
      `INSERT INTO stays(id,organization_id,branch_id,reservation_id,status)
       VALUES ($1,$2,$3,$4,'in-house')`,
      [stay, organizationId, property, reservation],
    );
    await db.query(
      `INSERT INTO folios(
        id,organization_id,branch_id,stay_id,reservation_id,folio_type
      ) VALUES ($1,$2,$3,$4,$5,'guest')`,
      [folio, organizationId, property, stay, reservation],
    );
  }

  it("installs both gates into the real reviewed functions", async () => {
    const result = await db.query<{
      name: string;
      definition: string;
    }>(`
      SELECT proname AS name, pg_get_functiondef(oid) AS definition
      FROM pg_proc
      WHERE oid IN (
        'public.neo_night_audit_run(uuid,date,text)'::regprocedure,
        'public.neo_close_business_day(uuid,date,text)'::regprocedure
      )
    `);

    expect(result.rows).toHaveLength(2);
    for (const row of result.rows) {
      expect(row.definition).toContain("neo_pms_missing_accommodation");
    }
    expect(result.rows.find(r => r.name === "neo_night_audit_run")
      ?.definition).toContain("'missing-accommodation','blocking'");
  });

  it("blocks closing when a signed audit missed a room night", async () => {
    await seedOpenDay();
    await seedSignedAudit();
    await seedMissingNight();

    const result = await closeDay();
    expect(result["status"]).toBe("exception");
    expect(result["blocking"]).toBe(1);

    const day = await db.query<{status:string}>(
      "SELECT status FROM business_days WHERE branch_id=$1 AND business_date=$2",
      [branchId,businessDate],
    );
    expect(day.rows[0]?.status).toBe("open");
  });

  it("allows closing after the correct accommodation charge is posted", async () => {
    await seedOpenDay();
    await seedSignedAudit();
    await seedMissingNight();

    await db.query(
      `INSERT INTO folio_lines(
        organization_id,branch_id,folio_id,reservation_id,
        operational_date,category,line_type,status
      ) VALUES ($1,$2,$3,$4,$5::date,'accommodation','charge','posted')`,
      [
        organizationId,branchId,
        "b3000000-0000-4000-8000-000000000003",
        "b3000000-0000-4000-8000-000000000001",
        businessDate,
      ],
    );

    expect((await closeDay())["status"]).toBe("closed");
  });

  it("does not block one property for another property's missing night", async () => {
    await seedOpenDay();
    await seedSignedAudit();
    const otherBranch = "b3000000-0000-4000-8000-000000000004";
    await seedMissingNight(
      "b3000000-0000-4000-8000-000000000005",
      "b3000000-0000-4000-8000-000000000006",
      "b3000000-0000-4000-8000-000000000007",
      otherBranch,
    );

    expect((await closeDay())["status"]).toBe("closed");
  });});
