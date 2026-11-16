import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

const org = "00000000-0000-4000-8000-000000000201";
const branch = "00000000-0000-4000-8000-000000000202";
const otherOrg = "00000000-0000-4000-8000-000000000203";
const otherBranch = "00000000-0000-4000-8000-000000000204";
const guest = "00000000-0000-4000-8000-000000000205";

const room = "00000000-0000-4000-8000-000000000206";
const foreignRoom = "00000000-0000-4000-8000-000000000207";
const branchRoom = "00000000-0000-4000-8000-000000000208";
const missingRoom = "00000000-0000-4000-8000-000000000209";

const valid = "00000000-0000-4000-8000-000000000210";
const wrongOrg = "00000000-0000-4000-8000-000000000211";
const wrongBranch = "00000000-0000-4000-8000-000000000212";
const missing = "00000000-0000-4000-8000-000000000213";
const future = "00000000-0000-4000-8000-000000000214";

const source = readFileSync(
  "supabase/migrations/20260830040148_a1812bd0-17aa-444a-bfff-c9ba5b8a0230.sql",
  "utf8"
);

const original = source.match(
  /CREATE OR REPLACE FUNCTION public\.pms_check_in\([\s\S]*?\$function\$;/
)?.[0];

if (!original) {
  throw new Error("Original check-in function missing");
}

describe("PMS check-in room ownership migration", () => {
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
        branch_id uuid,
        arrival_date date NOT NULL,
        departure_date date NOT NULL,
        status text NOT NULL DEFAULT 'confirmed',
        room_id uuid,
        customer_id uuid,
        rate_plan_id uuid,
        nightly_rate numeric,
        corporate_account_id uuid,
        group_booking_id uuid
      );

      CREATE TABLE public.rooms (
        id uuid PRIMARY KEY,
        organization_id uuid NOT NULL,
        branch_id uuid,
        room_condition text,
        room_number text,
        occupancy_status text
      );

      CREATE TABLE public.stays (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        organization_id uuid,
        branch_id uuid,
        reservation_id uuid,
        customer_id uuid,
        room_id uuid,
        checked_in_by uuid,
        expected_departure date
      );

      CREATE TABLE public.folios (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        stay_id uuid
      );

      CREATE FUNCTION public.test_checkin_boundary()
      RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        RAISE EXCEPTION 'room_validation_passed_fixture_boundary';
      END
      $$;

      CREATE TRIGGER test_checkin_boundary
      BEFORE INSERT ON public.stays
      FOR EACH ROW
      EXECUTE FUNCTION public.test_checkin_boundary();
    `);

    await db.exec(original);

    await db.exec(readFileSync(
      "supabase/migrations/20261116190000_pms_future_checkin_guard.sql",
      "utf8"
    ));

    await db.exec(readFileSync(
      "supabase/migrations/20261116232000_pms_checkin_room_property_guard.sql",
      "utf8"
    ));
  }, 45000);

  beforeEach(async () => {
    await db.exec(`
      TRUNCATE public.folios, public.stays,
               public.reservations, public.rooms;

      INSERT INTO public.rooms (
        id,organization_id,branch_id,
        room_condition,room_number,occupancy_status
      ) VALUES
        ('${room}','${org}','${branch}',
          'vacant-clean','101','vacant'),
        ('${foreignRoom}','${otherOrg}','${branch}',
          'vacant-clean','102','vacant'),
        ('${branchRoom}','${org}','${otherBranch}',
          'vacant-clean','103','vacant');

      INSERT INTO public.reservations (
        id,organization_id,branch_id,
        arrival_date,departure_date,status,room_id
      ) VALUES
        ('${valid}','${org}','${branch}',
          (now() AT TIME ZONE 'Africa/Nairobi')::date,
          (now() AT TIME ZONE 'Africa/Nairobi')::date+2,
          'confirmed','${room}'),
        ('${wrongOrg}','${org}','${branch}',
          (now() AT TIME ZONE 'Africa/Nairobi')::date,
          (now() AT TIME ZONE 'Africa/Nairobi')::date+2,
          'confirmed','${foreignRoom}'),
        ('${wrongBranch}','${org}','${branch}',
          (now() AT TIME ZONE 'Africa/Nairobi')::date,
          (now() AT TIME ZONE 'Africa/Nairobi')::date+2,
          'confirmed','${branchRoom}'),
        ('${missing}','${org}','${branch}',
          (now() AT TIME ZONE 'Africa/Nairobi')::date,
          (now() AT TIME ZONE 'Africa/Nairobi')::date+2,
          'confirmed','${missingRoom}'),
        ('${future}','${org}','${branch}',
          (now() AT TIME ZONE 'Africa/Nairobi')::date+1,
          (now() AT TIME ZONE 'Africa/Nairobi')::date+3,
          'confirmed','${room}');
    `);
  });

  afterAll(async () => {
    await db?.close();
  });

  async function checkIn(id: string) {
    return db.query(
      "SELECT public.pms_check_in($1,1,'property test')",
      [id]
    );
  }

  async function expectNoPartialStay() {
    const result = await db.query<{
      stays: string;
      folios: string;
    }>(`
      SELECT
        (SELECT count(*)::text FROM public.stays) AS stays,
        (SELECT count(*)::text FROM public.folios) AS folios
    `);

    expect(Number(result.rows[0]?.stays)).toBe(0);
    expect(Number(result.rows[0]?.folios)).toBe(0);
  }

  it("installs both guards in the real check-in function", async () => {
    const result = await db.query<{definition:string}>(`
      SELECT pg_get_functiondef(
        'public.pms_check_in(uuid,integer,text)'::regprocedure
      ) AS definition
    `);

    const definition = result.rows[0]?.definition ?? "";

    expect(definition).toContain(
      "Check-in is not permitted before the reservation arrival date"
    );
    expect(definition).toContain(
      "Assigned room is missing or belongs to another property"
    );
    expect(definition).toMatch(/\bAND\s+organization_id\s*=\s*_org\b/);
    expect(definition).toMatch(/\bAND\s+branch_id\s*=\s*_res\.branch_id\b/);
  });

  it("rejects another organisation's room", async () => {
    await expect(checkIn(wrongOrg)).rejects.toThrow(
      /belongs to another property/i
    );
    await expectNoPartialStay();
  });

  it("rejects another branch's room", async () => {
    await expect(checkIn(wrongBranch)).rejects.toThrow(
      /belongs to another property/i
    );
    await expectNoPartialStay();
  });

  it("rejects a room that does not exist", async () => {
    await expect(checkIn(missing)).rejects.toThrow(
      /assigned room is missing/i
    );
    await expectNoPartialStay();
  });

  it("preserves the future-arrival refusal", async () => {
    await expect(checkIn(future)).rejects.toThrow(
      /not permitted before the reservation arrival date/i
    );
    await expectNoPartialStay();
  });

  it("allows a same-property room past validation", async () => {
    // The intentionally incomplete test fixture stops at stay insertion.
    // This does not claim the complete check-in succeeds.
    await expect(checkIn(valid)).rejects.toThrow(
      /room_validation_passed_fixture_boundary/
    );
    await expectNoPartialStay();
  });
});