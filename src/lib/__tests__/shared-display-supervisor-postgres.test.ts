import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";
import { expect, it } from "vitest";

it("requires a supervisor in scope, limits attempts, and revokes the token only on authorized logout", async () => {
  const db = new PGlite();
  try {
    await db.exec(`
      CREATE ROLE anon; CREATE ROLE authenticated; CREATE SCHEMA extensions; CREATE SCHEMA auth;
      CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql AS $$
        SELECT nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
      CREATE TABLE roles(id uuid,organization_id uuid,normalized_role_key text,name text,active boolean,role_status text);
      CREATE TABLE user_roles(user_id uuid,organization_id uuid,role_id uuid);
      CREATE TABLE operational_stations(id uuid,organization_id uuid,branch_id uuid,department_id uuid,
        supervisor_user_id uuid,active boolean);
      CREATE TABLE user_stations(organization_id uuid,station_id uuid,user_id uuid);
      CREATE FUNCTION neo_resolve_role_template_key(text,text) RETURNS text LANGUAGE sql AS $$ SELECT $1 $$;
      CREATE FUNCTION is_active_staff() RETURNS boolean LANGUAGE sql AS $$ SELECT auth.uid() IS NOT NULL $$;
      CREATE FUNCTION neo_device_admin_allowed() RETURNS boolean LANGUAGE sql AS $$
        SELECT auth.uid() IN ('10000000-0000-4000-8000-000000000015','10000000-0000-4000-8000-000000000018') $$;
      CREATE FUNCTION current_department_ids() RETURNS uuid[] LANGUAGE sql AS $$
        SELECT CASE WHEN auth.uid()='10000000-0000-4000-8000-000000000014'
          THEN ARRAY['10000000-0000-4000-8000-000000000008'::uuid] ELSE ARRAY[]::uuid[] END $$;
      CREATE TABLE neo_production_display_sessions (id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        organization_id uuid, branch_id uuid, station_ids uuid[], closed_at timestamptz,
        expires_at timestamptz DEFAULT now()+interval '1 hour', failed_attempts int DEFAULT 0,
        attempt_window timestamptz DEFAULT now(), blocked_until timestamptz);
      CREATE TABLE neo_production_staff_codes (organization_id uuid,user_id uuid,enabled boolean,blocked_until timestamptz,pin_hash text);
      CREATE FUNCTION neo_production_require_session(text) RETURNS neo_production_display_sessions LANGUAGE plpgsql AS $$
      DECLARE s neo_production_display_sessions; BEGIN
        SELECT * INTO s FROM neo_production_display_sessions WHERE $1='paired-token' AND closed_at IS NULL;
        IF NOT FOUND THEN RAISE EXCEPTION 'Display session unavailable' USING ERRCODE='42501'; END IF;
        RETURN s;
      END $$;
      CREATE FUNCTION extensions.crypt(text,text) RETURNS text LANGUAGE sql AS $$ SELECT md5($1) $$;
      CREATE FUNCTION neo_production_context(uuid) RETURNS void LANGUAGE sql AS $$
        SELECT set_config('request.jwt.claim.sub',$1::text,true)::void $$;
      CREATE FUNCTION neo_access_cache_bump() RETURNS void LANGUAGE plpgsql AS $$ BEGIN END $$;
      CREATE FUNCTION current_org_id() RETURNS uuid LANGUAGE sql AS $$ SELECT '10000000-0000-4000-8000-000000000001'::uuid $$;
      CREATE FUNCTION neo_branch_in_scope(uuid) RETURNS boolean LANGUAGE sql AS $$
        SELECT auth.uid() NOT IN ('10000000-0000-4000-8000-000000000015','10000000-0000-4000-8000-000000000017',
          '10000000-0000-4000-8000-000000000018') $$;
      CREATE FUNCTION neo_production_can_manage() RETURNS boolean LANGUAGE sql AS $$
        SELECT auth.uid() IN ('10000000-0000-4000-8000-000000000011','10000000-0000-4000-8000-000000000012') $$;
      CREATE FUNCTION neo_kitchen_visible_station_ids() RETURNS uuid[] LANGUAGE sql AS $$
        SELECT CASE WHEN current_setting('request.jwt.claim.sub',true)='10000000-0000-4000-8000-000000000012'
          THEN ARRAY[]::uuid[] ELSE ARRAY['10000000-0000-4000-8000-000000000003'::uuid] END $$;
      INSERT INTO neo_production_display_sessions (organization_id,branch_id,station_ids) VALUES
        ('10000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000002',ARRAY['10000000-0000-4000-8000-000000000003'::uuid]);
      INSERT INTO operational_stations VALUES
        ('10000000-0000-4000-8000-000000000003','10000000-0000-4000-8000-000000000001',
          '10000000-0000-4000-8000-000000000002','10000000-0000-4000-8000-000000000008',
          '10000000-0000-4000-8000-000000000013',true);
      INSERT INTO roles VALUES
        ('10000000-0000-4000-8000-000000000021','10000000-0000-4000-8000-000000000001','head-chef','Head chef',true,'active'),
        ('10000000-0000-4000-8000-000000000022','10000000-0000-4000-8000-000000000001','operations-manager','Operations manager',true,'active');
      INSERT INTO user_roles (user_id,organization_id,role_id) VALUES
        ('10000000-0000-4000-8000-000000000014','10000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000021'),
        ('10000000-0000-4000-8000-000000000016','10000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000022'),
        ('10000000-0000-4000-8000-000000000017','10000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000022');
      INSERT INTO neo_production_staff_codes VALUES
        ('10000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000010',true,NULL,md5('123456')),
        ('10000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000011',true,NULL,md5('345678')),
        ('10000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000012',true,NULL,md5('456789')),
        ('10000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000013',true,NULL,md5('111111')),
        ('10000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000014',true,NULL,md5('222222')),
        ('10000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000015',true,NULL,md5('333333')),
        ('10000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000016',true,NULL,md5('444444')),
        ('10000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000017',true,NULL,md5('555555')),
        ('10000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000018',true,NULL,md5('666666'));
    `);
    await db.exec(readFileSync("supabase/migrations/20261123090000_scope_shared_display_supervisor_approval.sql", "utf8"));
    const approve = (pin: string, action: string) => db.query("SELECT neo_production_display_supervisor('paired-token',$1,$2) AS result", [pin, action]);
    await db.exec("SET ROLE anon");
    expect((await approve("123456", "tools")).rows).toMatchObject([{ result: { ok: false } }]);
    expect((await approve("456789", "logout")).rows).toMatchObject([{ result: { ok: false } }]);
    expect((await approve("555555", "tools")).rows).toMatchObject([{ result: { ok: false } }]);
    for (let i = 0; i < 2; i++) await approve("000000", "tools");
    expect((await approve("345678", "tools")).rows).toMatchObject([{ result: { ok: false, message: expect.stringContaining("Too many PIN attempts") } }]);
    await db.exec("RESET ROLE; UPDATE neo_production_display_sessions SET blocked_until=now()-interval '1 second', attempt_window=now()-interval '16 minutes'; SET ROLE anon");
    for (const pin of ["345678", "111111", "222222", "333333", "444444", "666666"]) {
      expect((await approve(pin, "tools")).rows).toMatchObject([{ result: { ok: true, action: "tools" } }]);
    }
    expect((await approve("666666", "logout")).rows).toMatchObject([{ result: { ok: true, action: "logout" } }]);
    await expect(approve("345678", "tools")).rejects.toThrow(/unavailable/);
  } finally {
    await db.close();
  }
}, 30_000);
