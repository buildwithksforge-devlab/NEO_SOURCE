import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const org = "10000000-0000-4000-8000-000000000001";
const first = "10000000-0000-4000-8000-000000000002";
const second = "10000000-0000-4000-8000-000000000003";
const dormant = "10000000-0000-4000-8000-000000000004";
const otherOrg = "10000000-0000-4000-8000-000000000005";

describe("published Delivery projection in PostgreSQL", () => {
  let db: PGlite;
  beforeAll(async () => {
    db = new PGlite();
    await db.exec(`
      CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
      CREATE SCHEMA auth;
      CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql AS $$ SELECT CASE WHEN current_user <> 'anon' THEN '${org}'::uuid END $$;
      CREATE FUNCTION current_org_id() RETURNS uuid LANGUAGE sql AS $$ SELECT '${org}'::uuid $$;
      CREATE FUNCTION neo_branch_in_scope(uuid) RETURNS boolean LANGUAGE sql AS $$ SELECT $1 = '${first}'::uuid $$;
      CREATE FUNCTION is_org_admin() RETURNS boolean LANGUAGE sql AS $$ SELECT false $$;
      CREATE FUNCTION has_permission(text,text,text) RETURNS boolean LANGUAGE sql AS $$ SELECT $2 = 'quality' $$;
      CREATE FUNCTION neo_platform_tenant_active(uuid) RETURNS boolean LANGUAGE sql AS $$ SELECT true $$;
      CREATE TABLE branches(id uuid PRIMARY KEY, organization_id uuid, active boolean, currency text);
      CREATE TABLE neo_public_experience(branch_id uuid, organization_id uuid, public_slug text);
      CREATE TABLE organizations(id uuid PRIMARY KEY);
      INSERT INTO organizations VALUES ('${org}'),('${otherOrg}');
      INSERT INTO branches VALUES ('${first}','${org}',true,'KES'),('${second}','${otherOrg}',true,'USD'),('${dormant}','${org}',false,'KES');
      INSERT INTO neo_public_experience VALUES ('${first}','${org}','harbour'),('${second}','${otherOrg}','garden'),('${dormant}','${org}','closed');
      CREATE FUNCTION neo_public_property(text) RETURNS jsonb LANGUAGE sql AS $$
        SELECT jsonb_build_object('branch_id',b.id,'organization_id',b.organization_id,'public_slug',e.public_slug,
          'publicly_listed', true,'doors', jsonb_build_object('stay_dine',true),'brand', jsonb_build_object('primary','#228888'))
        FROM neo_public_experience e JOIN branches b ON b.id=e.branch_id WHERE lower(e.public_slug)=lower(btrim($1)) AND b.active $$;
    `);
    const workspaceDDL = readFileSync("supabase/migrations/20260815124819_a0d5aa23-9714-473c-96cf-380af1b04310.sql", "utf8").split("CREATE INDEX")[0];
    await db.exec(workspaceDDL!);
    await db.exec(`INSERT INTO public_workspaces(organization_id, branch_id, app_key, slug, published, settings, created_by) VALUES
      ('${org}','${first}','delivery','harbour-orders',true,'{"private":"fixture"}','${org}'),
      ('${otherOrg}','${second}','delivery','garden-orders',false,'{}',null),
      ('${org}','${dormant}','delivery','closed-orders',true,'{}',null);`);
    await db.exec(readFileSync("supabase/migrations/20261120100000_public_delivery_and_readiness_links.sql", "utf8"));
  }, 120_000);
  afterAll(async () => db?.close());

  it("allows anonymous access to both forms of a published link and only returns public fields", async () => {
    await db.exec("SET ROLE anon");
    try {
      for (const slug of ["harbour", "HARBOUR-ORDERS"]) {
        const result = await db.query<{ data: Record<string, unknown> }>("SELECT neo_public_delivery_workspace($1) AS data", [slug]);
        const payload = result.rows[0]?.data;
        expect(payload).toMatchObject({ slug: "harbour-orders", guest_slug: "harbour", currency: "KES", branch_id: first });
        expect(payload).not.toHaveProperty("settings");
        expect(payload).not.toHaveProperty("created_by");
      }
      await expect(db.query("SELECT id FROM public_workspaces")).rejects.toThrow(/permission denied/);
      await expect(db.query("SELECT neo_platform_public_app_targets($1)", [first])).rejects.toThrow(/permission denied/);
    } finally {
      await db.exec("RESET ROLE");
    }
  });

  it("refuses unpublished, inactive and cross-property aliases", async () => {
    for (const slug of ["garden", "garden-orders", "closed-orders", ""]) {
      expect((await db.query("SELECT neo_public_delivery_workspace($1) AS data", [slug])).rows).toEqual([{ data: null }]);
    }
    await db.exec(`INSERT INTO public_workspaces(organization_id,branch_id,app_key,slug,published) VALUES ('${otherOrg}','${second}','delivery','harbour',true)`);
    expect((await db.query("SELECT neo_public_delivery_workspace('harbour')->>'branch_id' AS branch")).rows).toEqual([{ branch: first }]);
  });

  it("only returns monitoring targets for the authorised property", async () => {
    await db.exec("SET ROLE authenticated");
    try {
      const result = await db.query("SELECT neo_platform_public_app_targets($1) AS targets", [first]);
      expect(result.rows).toEqual([{ targets: [
        { app: "guest", slug: "harbour", state: "published" },
        { app: "delivery", slug: "harbour-orders", state: "published" },
      ] }]);
      await expect(db.query("SELECT neo_platform_public_app_targets($1)", [second])).rejects.toThrow(/Not permitted/);
    } finally {
      await db.exec("RESET ROLE");
    }
  });
});
