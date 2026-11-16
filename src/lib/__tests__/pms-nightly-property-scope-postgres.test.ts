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

describe("PMS nightly pricing parity PostgreSQL", () => {
  let db: PGlite;

  beforeAll(async () => {
    db = new PGlite();

    await db.exec(`
      CREATE SCHEMA auth;

      CREATE FUNCTION auth.uid() RETURNS uuid
      LANGUAGE sql STABLE
      AS $$ SELECT '${ids.user}'::uuid $$;

      CREATE FUNCTION public.current_org_id() RETURNS uuid
      LANGUAGE sql STABLE
      AS $$ SELECT '${ids.org}'::uuid $$;

      CREATE FUNCTION public.has_permission(text,text)
      RETURNS boolean LANGUAGE sql STABLE
      AS $$ SELECT true $$;

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
  }, 45000);

  beforeEach(async () => {
    await db.exec(`
      TRUNCATE public.folio_lines, public.folios, public.stays,
               public.reservations, public.rooms, public.rate_plans;

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
  });});