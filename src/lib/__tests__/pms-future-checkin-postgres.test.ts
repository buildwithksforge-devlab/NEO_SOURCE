import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const org = "00000000-0000-4000-8000-000000000201";
const guest = "00000000-0000-4000-8000-000000000202";
const tomorrow = "00000000-0000-4000-8000-000000000203";
const today = "00000000-0000-4000-8000-000000000204";
const yesterday = "00000000-0000-4000-8000-000000000205";

const originalSql = readFileSync(
  "supabase/migrations/20260830040148_a1812bd0-17aa-444a-bfff-c9ba5b8a0230.sql",
  "utf8"
);

const migration = readFileSync(
  "supabase/migrations/20261116190000_pms_future_checkin_guard.sql",
  "utf8"
);

const original = originalSql.match(
  /CREATE OR REPLACE FUNCTION public\.pms_check_in\([\s\S]*?\$function\$;/
)?.[0];

if (!original) {
  throw new Error("Original check-in SQL not found");
}

describe("Future-date check-in database enforcement", () => {
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
      AS $$ SELECT true $$;

      CREATE TABLE public.reservations (
        id uuid PRIMARY KEY,
        organization_id uuid NOT NULL,
        arrival_date date NOT NULL,
        departure_date date NOT NULL,
        status text NOT NULL DEFAULT 'confirmed',
        room_id uuid,
        customer_id uuid,
        branch_id uuid,
        rate_plan_id uuid,
        nightly_rate numeric,
        corporate_account_id uuid,
        group_booking_id uuid
      );

      CREATE TABLE public.rooms (
        id uuid PRIMARY KEY,
        room_condition text,
        room_number text,
        occupancy_status text
      );

      CREATE TABLE public.stays (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        reservation_id uuid,
        organization_id uuid
      );
    `);

    await db.exec(original);

    // Execute the actual staged database migration.
    await db.exec(migration);

    await db.exec(`
      INSERT INTO public.reservations(
        id,organization_id,arrival_date,departure_date
      ) VALUES
      (
        '${tomorrow}','${org}',
        (now() AT TIME ZONE 'Africa/Nairobi')::date + 1,
        (now() AT TIME ZONE 'Africa/Nairobi')::date + 3
      ),
      (
        '${today}','${org}',
        (now() AT TIME ZONE 'Africa/Nairobi')::date,
        (now() AT TIME ZONE 'Africa/Nairobi')::date + 2
      ),
      (
        '${yesterday}','${org}',
        (now() AT TIME ZONE 'Africa/Nairobi')::date - 1,
        (now() AT TIME ZONE 'Africa/Nairobi')::date + 1
      );
    `);
  }, 45000);

  afterAll(async () => {
    await db?.close();
  });

  const checkIn = (db: PGlite, reservation: string) =>
    db.query(
      "SELECT public.pms_check_in($1,1,'test')",
      [reservation]
    );

  it("installs the guard into the actual check-in function", async () => {
    const result = await db.query<{ definition: string }>(`
      SELECT pg_get_functiondef(
        'public.pms_check_in(uuid,integer,text)'::regprocedure
      ) AS definition
    `);

    expect(result.rows[0]?.definition).toContain(
      "Check-in is not permitted before the reservation arrival date"
    );
  });

  it("rejects tomorrow's reservation", async () => {
    await expect(checkIn(db,tomorrow)).rejects.toThrow(
      /not permitted before the reservation arrival date/i
    );
  });

  it("allows today's date through to normal room validation", async () => {
    await expect(checkIn(db,today)).rejects.toThrow(
      /Assign a room before check-in/i
    );
  });

  it("allows a past arrival through to normal room validation", async () => {
    await expect(checkIn(db,yesterday)).rejects.toThrow(
      /Assign a room before check-in/i
    );
  });

  it("does not alter reservations or create stays on refusal", async () => {
    const result = await db.query<{
      reservations_ok: boolean;
      stays_count: string;
    }>(`
      SELECT
        (SELECT count(*)=3
         FROM public.reservations
         WHERE status='confirmed') AS reservations_ok,
        (SELECT count(*)::text FROM public.stays) AS stays_count
    `);

    expect(result.rows[0]?.reservations_ok).toBe(true);
    expect(Number(result.rows[0]?.stays_count)).toBe(0);
  });
});