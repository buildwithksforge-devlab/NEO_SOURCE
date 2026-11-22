import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";
import { expect, it } from "vitest";

it("requires a supervisor in scope, limits attempts, and revokes the token only on authorized logout", async () => {
  const db = new PGlite();
  try {
    await db.exec(`
      CREATE ROLE anon; CREATE ROLE authenticated; CREATE SCHEMA extensions;
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
      CREATE FUNCTION neo_branch_in_scope(uuid) RETURNS boolean LANGUAGE sql AS $$ SELECT true $$;
      CREATE FUNCTION neo_production_can_manage() RETURNS boolean LANGUAGE sql AS $$
        SELECT current_setting('request.jwt.claim.sub',true) <> '10000000-0000-4000-8000-000000000010' $$;
      CREATE FUNCTION neo_kitchen_visible_station_ids() RETURNS uuid[] LANGUAGE sql AS $$
        SELECT CASE WHEN current_setting('request.jwt.claim.sub',true)='10000000-0000-4000-8000-000000000012'
          THEN ARRAY[]::uuid[] ELSE ARRAY['10000000-0000-4000-8000-000000000003'::uuid] END $$;
      INSERT INTO neo_production_display_sessions (organization_id,branch_id,station_ids) VALUES
        ('10000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000002',ARRAY['10000000-0000-4000-8000-000000000003'::uuid]);
      INSERT INTO neo_production_staff_codes VALUES
        ('10000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000010',true,NULL,md5('123456')),
        ('10000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000011',true,NULL,md5('345678')),
        ('10000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000012',true,NULL,md5('456789'));
    `);
    await db.exec(readFileSync("supabase/migrations/20261122164000_shared_display_supervisor_pin.sql", "utf8"));
    const approve = (pin: string, action: string) => db.query("SELECT neo_production_display_supervisor('paired-token',$1,$2) AS result", [pin, action]);
    await db.exec("SET ROLE anon");
    expect((await approve("123456", "tools")).rows).toMatchObject([{ result: { ok: false } }]);
    expect((await approve("456789", "logout")).rows).toMatchObject([{ result: { ok: false } }]);
    for (let i = 0; i < 3; i++) await approve("000000", "tools");
    expect((await approve("345678", "tools")).rows).toMatchObject([{ result: { ok: false } }]);
    await db.exec("RESET ROLE; UPDATE neo_production_display_sessions SET blocked_until=now()-interval '1 second', attempt_window=now()-interval '16 minutes'; SET ROLE anon");
    expect((await approve("345678", "tools")).rows).toMatchObject([{ result: { ok: true, action: "tools" } }]);
    expect((await approve("345678", "logout")).rows).toMatchObject([{ result: { ok: true, action: "logout" } }]);
    await expect(approve("345678", "tools")).rejects.toThrow(/unavailable/);
  } finally {
    await db.close();
  }
}, 30_000);
