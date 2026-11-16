import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

const ids = {
  org: "00000000-0000-4000-8000-000000000601",
  branch: "00000000-0000-4000-8000-000000000602",
  otherOrg: "00000000-0000-4000-8000-000000000603",
  otherBranch: "00000000-0000-4000-8000-000000000604",
  reservation: "00000000-0000-4000-8000-000000000605",
  stay: "00000000-0000-4000-8000-000000000606",
  folio: "00000000-0000-4000-8000-000000000607",
  otherFolio: "00000000-0000-4000-8000-000000000608",
  otherReservation: "00000000-0000-4000-8000-000000000609",
  otherStay: "00000000-0000-4000-8000-000000000610",
};

const migration = readFileSync(
  "supabase/migrations/20261117000000_pms_missing_accommodation_reconciliation.sql",
  "utf8",
);

type Missing = {
  stay_id: string;
  reservation_id: string;
  reference: string;
  amount: string | number | null;
};

describe("PMS missing accommodation reconciliation PostgreSQL", () => {
  let db: PGlite;

  beforeAll(async () => {
    db = new PGlite();

    await db.exec(`
      DO $$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN
          CREATE ROLE anon;
        END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN
          CREATE ROLE authenticated;
        END IF;
      END $$;

      CREATE TABLE public.reservations (
        id uuid PRIMARY KEY,
        organization_id uuid NOT NULL,
        branch_id uuid NOT NULL,
        arrival_date date NOT NULL,
        departure_date date NOT NULL,
        nightly_rate numeric NOT NULL
      );

      CREATE TABLE public.stays (
        id uuid PRIMARY KEY,
        organization_id uuid NOT NULL,
        branch_id uuid NOT NULL,
        reservation_id uuid NOT NULL,
        status text NOT NULL
      );

      CREATE TABLE public.folios (
        id uuid PRIMARY KEY,
        organization_id uuid NOT NULL,
        branch_id uuid,
        stay_id uuid,
        reservation_id uuid,
        folio_type text NOT NULL
      );

      CREATE TABLE public.folio_lines (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        organization_id uuid NOT NULL,
        branch_id uuid,
        folio_id uuid,
        reservation_id uuid,
        operational_date date,
        category text,
        line_type text,
        status text,
        net_amount numeric
      );

      CREATE UNIQUE INDEX folio_lines_nightly_once_idx
      ON public.folio_lines(reservation_id, operational_date)
      WHERE category='accommodation'
        AND line_type='charge'
        AND status='posted';
    `);

    await db.exec(migration);
  }, 45000);

  beforeEach(async () => {
    await db.exec(`
      TRUNCATE public.folio_lines, public.folios,
               public.stays, public.reservations;

      INSERT INTO public.reservations (
        id, organization_id, branch_id,
        arrival_date, departure_date, nightly_rate
      ) VALUES (
        '${ids.reservation}', '${ids.org}', '${ids.branch}',
        DATE '2026-11-16', DATE '2026-11-19', 12000
      );

      INSERT INTO public.stays (
        id, organization_id, branch_id, reservation_id, status
      ) VALUES (
        '${ids.stay}', '${ids.org}', '${ids.branch}',
        '${ids.reservation}', 'in-house'
      );

      INSERT INTO public.folios (
        id, organization_id, branch_id,
        stay_id, reservation_id, folio_type
      ) VALUES (
        '${ids.folio}', '${ids.org}', '${ids.branch}',
        '${ids.stay}', '${ids.reservation}', 'guest'
      );
    `);
  });

  afterAll(async () => {
    await db?.close();
  });

  async function missing(
    org = ids.org,
    branch = ids.branch,
    day = "2026-11-17",
  ): Promise<Missing[]> {
    const result = await db.query<Missing>(
      `SELECT * FROM public.neo_pms_missing_accommodation(
        $1::uuid, $2::uuid, $3::date
      ) ORDER BY stay_id`,
      [org, branch, day],
    );
    return result.rows;
  }

  async function addLine(
    options: {
      folio?: string;
      branch?: string;
      reservation?: string;
      category?: string;
      status?: string;
    } = {},
  ) {
    await db.query(
      `INSERT INTO public.folio_lines (
        organization_id, branch_id, folio_id, reservation_id,
        operational_date, category, line_type, status, net_amount
      ) VALUES (
        $1, $2, $3, $4, DATE '2026-11-17',
        $5, 'charge', $6, 12000
      )`,
      [
        ids.org,
        options.branch ?? ids.branch,
        options.folio ?? ids.folio,
        options.reservation ?? ids.reservation,
        options.category ?? "accommodation",
        options.status ?? "posted",
      ],
    );
  }

  it("detects an in-house stay missing its charge", async () => {
    const rows = await missing();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.stay_id).toBe(ids.stay);
    expect(Number(rows[0]?.amount)).toBe(12000);
  });

  it("does not flag the night after a valid posted charge", async () => {
    await addLine();
    expect(await missing()).toHaveLength(0);
  });

  it("does not accept a charge linked to another folio", async () => {
    await db.query(
      `INSERT INTO public.folios (
        id, organization_id, branch_id,
        stay_id, reservation_id, folio_type
      ) VALUES ($1,$2,$3,$4,$5,'guest')`,
      [
        ids.otherFolio, ids.org, ids.otherBranch,
        ids.otherStay, ids.otherReservation,
      ],
    );
    await addLine({ folio: ids.otherFolio });
    expect(await missing()).toHaveLength(1);
  });

  it("does not accept a charge from another branch", async () => {
    await addLine({ branch: ids.otherBranch });
    expect(await missing()).toHaveLength(1);
  });

  it("does not accept a non-posted accommodation line", async () => {
    await addLine({ status: "draft" });
    expect(await missing()).toHaveLength(1);
  });

  it("does not accept unrelated charge categories", async () => {
    await addLine({ category: "restaurant" });
    expect(await missing()).toHaveLength(1);
  });

  it("does not return another organisation's stays", async () => {
    expect(await missing(ids.otherOrg, ids.branch)).toHaveLength(0);
  });

  it("excludes departure day and complimentary accommodation", async () => {
    expect(await missing(ids.org, ids.branch, "2026-11-19")).toHaveLength(0);

    await db.query(
      "UPDATE public.reservations SET nightly_rate=0 WHERE id=$1",
      [ids.reservation],
    );

    expect(await missing()).toHaveLength(0);
  });

  it("is read-only and does not change charges or folio balances", async () => {
    const before = await db.query<{n: number}>(
      "SELECT count(*)::int AS n FROM public.folio_lines",
    );

    expect(await missing()).toHaveLength(1);
    expect(await missing()).toHaveLength(1);

    const after = await db.query<{n: number}>(
      "SELECT count(*)::int AS n FROM public.folio_lines",
    );

    expect(after.rows[0]?.n).toBe(before.rows[0]?.n);

    const definition = await db.query<{definition: string}>(
      `SELECT pg_get_functiondef(
        'public.neo_pms_missing_accommodation(uuid,uuid,date)'::regprocedure
      ) AS definition`,
    );

    expect(definition.rows[0]?.definition).toContain("STABLE");
    const security = await db.query<{security_definer: boolean}>(`
      SELECT prosecdef AS security_definer
      FROM pg_proc
      WHERE oid =
        'public.neo_pms_missing_accommodation(uuid,uuid,date)'::regprocedure
    `);
    expect(security.rows[0]?.security_definer).toBe(false);

    const privileges = await db.query<{
      anon_execute: boolean;
      authenticated_execute: boolean;
    }>(`
      SELECT
        has_function_privilege(
          'anon',
          'public.neo_pms_missing_accommodation(uuid,uuid,date)',
          'EXECUTE'
        ) AS anon_execute,
        has_function_privilege(
          'authenticated',
          'public.neo_pms_missing_accommodation(uuid,uuid,date)',
          'EXECUTE'
        ) AS authenticated_execute
    `);
    expect(privileges.rows[0]?.anon_execute).toBe(false);
    expect(privileges.rows[0]?.authenticated_execute).toBe(false);
  });
});