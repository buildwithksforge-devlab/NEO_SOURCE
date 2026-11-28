import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const org = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const otherOrg = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const branch = "11111111-1111-4111-8111-111111111111";
const otherBranch = "22222222-2222-4222-8222-222222222222";
const foreignBranch = "33333333-3333-4333-8333-333333333333";
const user = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

// Install the production guard definition into a local database with only
// the session, staff and assignment functions it depends on. No production
// credentials or hotel records enter this test.
const migration = readFileSync(
  join(process.cwd(), "supabase/migrations/20260825141224_f4f0bdbb-d70f-4034-b40e-950f97055913.sql"),
  "utf8",
);
const guard = migration.match(
  /CREATE OR REPLACE FUNCTION public\.neo_assert_reporting_scope\(_branch uuid, _from date DEFAULT NULL::date, _to date DEFAULT NULL::date\)[\s\S]*?\$function\$;/,
)?.[0];

describe("reporting RPC property and date boundary", () => {
  let db: PGlite;

  beforeAll(async () => {
    if (!guard) throw new Error("The production reporting guard definition is missing");
    db = new PGlite();
    await db.exec(`
      CREATE SCHEMA auth;
      CREATE TABLE public.branches (id uuid PRIMARY KEY, organization_id uuid NOT NULL);
      INSERT INTO public.branches VALUES
        ('${branch}', '${org}'), ('${otherBranch}', '${org}'), ('${foreignBranch}', '${otherOrg}');
      CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$
        SELECT nullif(current_setting('test.actor', true), '')::uuid
      $$;
      CREATE FUNCTION public.current_org_id() RETURNS uuid LANGUAGE sql STABLE AS $$
        SELECT nullif(current_setting('test.org', true), '')::uuid
      $$;
      CREATE FUNCTION public.is_active_staff() RETURNS boolean LANGUAGE sql STABLE AS $$
        SELECT current_setting('test.active', true) = 'true'
      $$;
      CREATE FUNCTION public.current_access_scope() RETURNS text LANGUAGE sql STABLE AS $$
        SELECT current_setting('test.scope', true)
      $$;
      CREATE FUNCTION public.neo_branch_in_scope(_branch uuid) RETURNS boolean
        LANGUAGE sql STABLE AS $$
        SELECT current_setting('test.scope', true) IN ('organisation', 'technical')
          OR _branch = nullif(current_setting('test.branch', true), '')::uuid
      $$;
    `);
    await db.exec(guard);
    await db.exec(`
      SET test.actor = '${user}'; SET test.org = '${org}';
      SET test.active = 'true'; SET test.scope = 'branch'; SET test.branch = '${branch}';
    `);
  }, 60_000);

  afterAll(async () => { await db?.close(); });

  it("rejects unassigned and foreign-tenant properties before reading figures", async () => {
    for (const denied of [otherBranch, foreignBranch]) {
      await expect(db.query("SELECT public.neo_assert_reporting_scope($1::uuid)", [denied]))
        .rejects.toThrow("property_out_of_scope");
    }
    await expect(db.query("SELECT public.neo_assert_reporting_scope($1::uuid)", [branch]))
      .resolves.toBeDefined();
  });

  it("requires a selected property for branch staff but permits organisation-wide roles", async () => {
    await expect(db.query("SELECT public.neo_assert_reporting_scope(NULL::uuid)"))
      .rejects.toThrow("explicit_property_required_for_scoped_user");
    for (const scope of ["organisation", "technical"]) {
      await db.exec(`SET test.scope = '${scope}'`);
      await expect(db.query("SELECT public.neo_assert_reporting_scope(NULL::uuid)"))
        .resolves.toBeDefined();
    }
    await db.exec("SET test.scope = 'branch'");
  });

  it("rejects inactive or missing staff sessions", async () => {
    await db.exec("SET test.active = 'false'");
    await expect(db.query("SELECT public.neo_assert_reporting_scope($1::uuid)", [branch]))
      .rejects.toThrow("reporting_session_required");
    await db.exec("SET test.active = 'true'");
  });

  it("rejects reversed and oversized reporting windows", async () => {
    await expect(db.query("SELECT public.neo_assert_reporting_scope($1::uuid,$2::date,$3::date)",
      [branch, "2026-11-08", "2026-11-01"]))
      .rejects.toThrow("invalid_report_period");
    await expect(db.query("SELECT public.neo_assert_reporting_scope($1::uuid,$2::date,$3::date)",
      [branch, "2020-01-01", "2026-11-01"]))
      .rejects.toThrow("report_period_too_large");
  });
});
