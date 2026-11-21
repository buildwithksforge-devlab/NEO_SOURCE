import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

const org = "00000000-0000-4000-8000-000000000301";
const branch = "00000000-0000-4000-8000-000000000302";
const otherOrg = "00000000-0000-4000-8000-000000000303";
const otherBranch = "00000000-0000-4000-8000-000000000304";
const reservation = "00000000-0000-4000-8000-000000000305";
const anotherReservation = "00000000-0000-4000-8000-000000000306";
const actor = "00000000-0000-4000-8000-000000000307";

const source = readFileSync(
  "supabase/migrations/20260831043706_a114fd29-7595-4771-b0de-57407fb6c220.sql",
  "utf8",
);

const original = source.match(
  /CREATE OR REPLACE FUNCTION public\.pms_apply_deposits_to_folio\(\)[\s\S]*?\$function\$;/,
)?.[0];

if (!original) throw new Error("Original deposit application function missing");

const migration = readFileSync(
  "supabase/migrations/20261116233000_pms_deposit_property_scope.sql",
  "utf8",
);

describe("PMS deposit application property scope", () => {
  let db: PGlite;

  beforeAll(async () => {
    db = new PGlite();

    await db.exec(`
      CREATE SCHEMA auth;
      CREATE FUNCTION auth.uid() RETURNS uuid
      LANGUAGE sql AS $$ SELECT '${actor}'::uuid $$;

      CREATE TABLE public.reservation_deposits (
        id uuid PRIMARY KEY,
        organization_id uuid NOT NULL,
        branch_id uuid,
        reservation_id uuid NOT NULL,
        status text NOT NULL,
        amount numeric NOT NULL,
        reference text,
        applied_folio_id uuid,
        applied_folio_line_id uuid,
        applied_at timestamptz
      );

      CREATE TABLE public.folios (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        organization_id uuid NOT NULL,
        branch_id uuid,
        reservation_id uuid,
        total_payments numeric DEFAULT 0,
        balance numeric DEFAULT 12000,
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
        net_amount numeric,
        posted_by uuid
      );
    `);

    await db.exec(original);
    await db.exec(migration);

    await db.exec(`
      CREATE TRIGGER apply_deposits_test
      AFTER INSERT ON public.folios
      FOR EACH ROW
      EXECUTE FUNCTION public.pms_apply_deposits_to_folio();

      CREATE FUNCTION public.reject_test_deposit()
      RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.status = 'applied'
           AND OLD.status = 'held'
           AND NEW.reference = 'FORCE-FAIL' THEN
          RAISE EXCEPTION 'test_deposit_application_failure';
        END IF;
        RETURN NEW;
      END
      $$;

      CREATE TRIGGER reject_test_deposit
      BEFORE UPDATE OF status ON public.reservation_deposits
      FOR EACH ROW
      EXECUTE FUNCTION public.reject_test_deposit();
    `);
  }, 45000);

  beforeEach(async () => {
    await db.exec(`
      TRUNCATE public.folio_lines,
               public.folios,
               public.reservation_deposits;
    `);
  });

  afterAll(async () => {
    await db?.close();
  });

  async function deposit(
    id: string,
    organization = org,
    property: string | null = branch,
    booking = reservation,
    status = "held",
    reference = "TEST",
  ) {
    await db.query(
      `INSERT INTO public.reservation_deposits
       (id,organization_id,branch_id,reservation_id,
        status,amount,reference)
       VALUES ($1,$2,$3,$4,$5,4000,$6)`,
      [id, organization, property, booking, status, reference],
    );
  }

  async function createFolio(property: string | null = branch) {
    return db.query<{id: string}>(
      `INSERT INTO public.folios
       (organization_id,branch_id,reservation_id)
       VALUES ($1,$2,$3)
       RETURNING id`,
      [org, property, reservation],
    );
  }

  async function snapshot() {
    const r = await db.query<{
      lines: number;
      applied: number;
      held: number;
      folios: number;
    }>(`
      SELECT
        (SELECT count(*)::int FROM public.folio_lines) AS lines,
        (SELECT count(*)::int FROM public.reservation_deposits
         WHERE status='applied') AS applied,
        (SELECT count(*)::int FROM public.reservation_deposits
         WHERE status='held') AS held,
        (SELECT count(*)::int FROM public.folios) AS folios
    `);
    return r.rows[0];
  }

  it("installs an organisation- and branch-scoped selector", async () => {
    const r = await db.query<{definition: string}>(`
      SELECT pg_get_functiondef(
        'public.pms_apply_deposits_to_folio()'::regprocedure
      ) AS definition
    `);
    expect(r.rows[0]?.definition).toMatch(
      /organization_id\s*=\s*NEW\.organization_id/,
    );
    expect(r.rows[0]?.definition).toMatch(
      /branch_id\s+IS\s+NOT\s+DISTINCT\s+FROM\s+NEW\.branch_id/,
    );
  });

  it("applies a matching held deposit once and reduces balance", async () => {
    await deposit("00000000-0000-4000-8000-000000000311");
    const r = await createFolio();
    expect(r.rows).toHaveLength(1);
    expect(await snapshot()).toMatchObject({
      lines: 1, applied: 1, held: 0, folios: 1,
    });

    const f = await db.query<{total_payments: string; balance: string}>(
      `SELECT total_payments,balance FROM public.folios WHERE id=$1`,
      [r.rows[0]?.id],
    );
    expect(Number(f.rows[0]?.total_payments)).toBe(4000);
    expect(Number(f.rows[0]?.balance)).toBe(8000);
  });

  it("ignores deposits from another organisation", async () => {
    await deposit("00000000-0000-4000-8000-000000000312", otherOrg);
    await createFolio();
    expect(await snapshot()).toMatchObject({
      lines: 0, applied: 0, held: 1, folios: 1,
    });
  });

  it("ignores deposits from another branch", async () => {
    await deposit(
      "00000000-0000-4000-8000-000000000313",
      org, otherBranch,
    );
    await createFolio();
    expect(await snapshot()).toMatchObject({
      lines: 0, applied: 0, held: 1, folios: 1,
    });
  });

  it("ignores a deposit from another reservation", async () => {
    await deposit(
      "00000000-0000-4000-8000-000000000314",
      org, branch, anotherReservation,
    );
    await createFolio();
    expect(await snapshot()).toMatchObject({
      lines: 0, applied: 0, held: 1, folios: 1,
    });
  });

  it("ignores deposits that are not held", async () => {
    await deposit(
      "00000000-0000-4000-8000-000000000315",
      org, branch, reservation, "cancelled",
    );
    await createFolio();
    expect(await snapshot()).toMatchObject({
      lines: 0, applied: 0, held: 0, folios: 1,
    });
  });

  it("applies only the matching deposit in a mixed set", async () => {
    await deposit("00000000-0000-4000-8000-000000000316");
    await deposit(
      "00000000-0000-4000-8000-000000000317",
      otherOrg,
    );
    await deposit(
      "00000000-0000-4000-8000-000000000318",
      org, otherBranch,
    );
    await createFolio();
    expect(await snapshot()).toMatchObject({
      lines: 1, applied: 1, held: 2, folios: 1,
    });
  });

  it("does not reapply a deposit on a second folio insert", async () => {
    await deposit("00000000-0000-4000-8000-000000000319");
    await createFolio();
    await createFolio();
    expect(await snapshot()).toMatchObject({
      lines: 1, applied: 1, held: 0, folios: 2,
    });
  });

  it("matches nullable branches only when both are null", async () => {
    await deposit(
      "00000000-0000-4000-8000-000000000320",
      org, null,
    );
    await createFolio(null);
    expect(await snapshot()).toMatchObject({
      lines: 1, applied: 1, held: 0, folios: 1,
    });
  });

  it("rolls back folio and payment line if deposit update fails", async () => {
    await deposit(
      "00000000-0000-4000-8000-000000000321",
      org, branch, reservation, "held", "FORCE-FAIL",
    );

    await expect(createFolio()).rejects.toThrow(
      /test_deposit_application_failure/,
    );

    expect(await snapshot()).toMatchObject({
      lines: 0, applied: 0, held: 1, folios: 0,
    });
  });
});