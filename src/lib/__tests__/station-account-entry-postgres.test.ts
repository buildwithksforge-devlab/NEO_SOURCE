import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";

const fixture = (number: number) => `00000000-0000-4000-8000-${String(number).padStart(12, "0")}`;
const [org, branch, station, staff, owner, otherBranch, unassigned] = [1, 2, 3, 4, 5, 6, 7].map(fixture);
let db: PGlite;

beforeAll(async () => {
  db = new PGlite();
  await db.exec(`
    CREATE ROLE anon;
    CREATE ROLE authenticated;
    CREATE SCHEMA auth;
    CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql AS $$ SELECT current_setting('test.actor')::uuid $$;
    CREATE FUNCTION current_org_id() RETURNS uuid LANGUAGE sql AS $$ SELECT '${org}'::uuid $$;
    CREATE FUNCTION neo_device_admin_allowed() RETURNS boolean LANGUAGE sql AS $$ SELECT auth.uid()='${owner}'::uuid $$;
    CREATE FUNCTION neo_branch_in_scope(uuid) RETURNS boolean LANGUAGE sql AS $$ SELECT $1='${branch}'::uuid $$;
    CREATE FUNCTION neo_kitchen_visible_station_ids() RETURNS uuid[] LANGUAGE sql AS $$ SELECT ARRAY['${station}'::uuid] $$;
    CREATE TABLE profiles (id uuid PRIMARY KEY, organization_id uuid, full_name text, email text, account_type text, account_status text);
    CREATE TABLE departments (id uuid PRIMARY KEY, organization_id uuid, catalogue_key text);
    CREATE TABLE operational_stations (id uuid PRIMARY KEY, organization_id uuid, branch_id uuid, department_id uuid, active boolean, name text, code text, station_type text);
    CREATE TABLE user_stations (organization_id uuid, user_id uuid, station_id uuid);
    CREATE TABLE neo_production_staff_codes (organization_id uuid, user_id uuid, enabled boolean);
    INSERT INTO profiles VALUES ('${staff}', '${org}', 'Test Barista', 'staff@example.invalid', 'staff', 'active'),
      ('${unassigned}', '${org}', 'Unassigned', NULL, 'staff', 'active');
    INSERT INTO operational_stations VALUES ('${station}', '${org}', '${branch}', NULL, true, 'Coffee Station', 'CF', 'coffee');
    INSERT INTO neo_production_staff_codes VALUES ('${org}', '${staff}', true);
  `);
  await db.exec(readFileSync("supabase/migrations/20261121123800_station_account_entry.sql", "utf8"));
});

beforeEach(async () => {
  await db.exec(`TRUNCATE neo_station_account_entry, user_stations;
    INSERT INTO user_stations VALUES ('${org}', '${staff}', '${station}'); SET test.actor='${owner}';`);
});
afterAll(async () => db?.close());

const configure = (id = staff, property = branch, remove = false) =>
  db.query(`SELECT neo_station_login_admin($1, $2, $3, $4) AS value`, [property, station, id, remove]);
const landing = (property: string | null = null) =>
  db.query(`SELECT neo_station_login_destination($1) AS value`, [property]);

it("lets the owner link an assigned account and resolves it for PIN and email sign-in", async () => {
  expect((await configure()).rows).toEqual([{ value: { ok: true } }]);
  const accounts = await db.query(`SELECT neo_station_login_admin($1,$2) AS value`, [branch, station]);
  expect(accounts.rows).toMatchObject([{ value: [{ id: staff, email: "staff@example.invalid", pin_set: true, opens_station: true }] }]);
  await db.exec(`SET test.actor='${staff}';`);
  expect((await landing(branch!)).rows).toMatchObject([{ value: { id: station, branch_id: branch, station_type: "coffee" } }]);
  expect((await landing()).rows).toEqual((await landing(branch!)).rows);
  expect((await landing(otherBranch!)).rows).toEqual([{ value: null }]);
});

it("rejects unassigned accounts, other properties and non-admin changes", async () => {
  await expect(configure(unassigned)).rejects.toMatchObject({ code: "42501" });
  await expect(configure(staff, otherBranch)).rejects.toMatchObject({ code: "42501" });
  await db.exec(`SET test.actor='${staff}';`);
  await expect(configure()).rejects.toMatchObject({ code: "42501" });
  expect((await landing()).rows).toEqual([{ value: null }]);
});

it("stops redirecting after an assignment or the configured destination is removed", async () => {
  await configure();
  await db.exec(`DELETE FROM user_stations; SET test.actor='${staff}';`);
  expect((await landing()).rows).toEqual([{ value: null }]);
  await db.exec(`SET test.actor='${owner}'; INSERT INTO user_stations VALUES ('${org}', '${staff}', '${station}');`);
  await configure(staff, branch, true);
  await db.exec(`SET test.actor='${staff}';`);
  expect((await landing()).rows).toEqual([{ value: null }]);
});
