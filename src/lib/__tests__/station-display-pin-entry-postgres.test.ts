import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";
import { expect, it } from "vitest";

it("uses a separate PIN on the paired device and revokes access when the station assignment changes", async () => {
  const db = new PGlite();
  const org = "41000000-0000-4000-8000-000000000001", branch = "41000000-0000-4000-8000-000000000002";
  const station = "41000000-0000-4000-8000-000000000003", worker = "41000000-0000-4000-8000-000000000004";
  const token = "a".repeat(64);
  try {
    await db.exec(`
      CREATE ROLE anon; CREATE ROLE authenticated; CREATE SCHEMA extensions;
      CREATE FUNCTION extensions.digest(bytea,text) RETURNS bytea LANGUAGE sql AS $$ SELECT decode(md5($1),'hex') $$;
      CREATE FUNCTION extensions.crypt(text,text) RETURNS text LANGUAGE sql AS $$ SELECT md5($1) $$;
      CREATE FUNCTION extensions.gen_salt(text,integer) RETURNS text LANGUAGE sql AS $$ SELECT 'fixture'::text $$;
      CREATE FUNCTION current_org_id() RETURNS uuid LANGUAGE sql AS $$ SELECT '${org}'::uuid $$;
      CREATE TABLE operational_stations(id uuid PRIMARY KEY);
      CREATE TABLE profiles(id uuid PRIMARY KEY,organization_id uuid,account_type text,account_status text);
      CREATE TABLE user_stations(organization_id uuid,station_id uuid,user_id uuid);
      CREATE TABLE neo_production_staff_codes(organization_id uuid,enabled boolean,pin_hash text);
      CREATE TABLE neo_production_display_sessions(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),organization_id uuid,branch_id uuid,
        station_ids uuid[],token_hash text,closed_at timestamptz,expires_at timestamptz DEFAULT now()+interval '1 hour',
        failed_attempts integer DEFAULT 0,blocked_until timestamptz,attempt_window timestamptz DEFAULT now());
      CREATE FUNCTION neo_station_login_admin(uuid,uuid) RETURNS jsonb LANGUAGE plpgsql AS $$ BEGIN
        IF current_setting('test.device_admin',true) IS DISTINCT FROM 'on' OR $1<>'${branch}' OR $2<>'${station}' THEN
          RAISE EXCEPTION 'Owner access required' USING ERRCODE='42501';
        END IF;
        RETURN jsonb_build_array(jsonb_build_object('id','${worker}'));
      END $$;
      INSERT INTO operational_stations VALUES ('${station}');
      INSERT INTO profiles VALUES ('${worker}','${org}','staff','active');
      INSERT INTO user_stations VALUES ('${org}','${station}','${worker}');
      INSERT INTO neo_production_staff_codes VALUES ('${org}',true,md5('246810'));
      INSERT INTO neo_production_display_sessions(organization_id,branch_id,station_ids,token_hash)
        VALUES('${org}','${branch}',ARRAY['${station}'::uuid],md5('${token}'));
    `);
    await db.exec(readFileSync("supabase/migrations/20261122164500_station_display_pin_entry.sql", "utf8"));
    const configure = (pin: string) => db.query("SELECT neo_station_display_pin_admin($1,$2,$3,$4)", [branch,station,worker,pin]);
    const enter = (pin: string | null) => db.query("SELECT neo_production_display_entry($1,$2) AS result", [token,pin]);
    await expect(configure("135790")).rejects.toThrow(/Owner access/);
    await db.exec("SET test.device_admin='on'");
    await expect(configure("246810")).rejects.toThrow(/different display PIN/);
    await configure("135790");
    const read = () => db.query("SELECT (neo_production_require_session($1)).id", [token]);
    await expect(read()).rejects.toThrow(/Display PIN required/);
    await db.exec("SET ROLE anon");
    await expect(configure("654321")).rejects.toThrow(/permission denied/);
    expect((await enter("246810")).rows).toMatchObject([{ result: { ready: false } }]);
    expect((await enter("135790")).rows).toMatchObject([{ result: { ready: true } }]);
    await db.exec("RESET ROLE");
    expect((await read()).rows).toHaveLength(1);
    await db.exec("DELETE FROM user_stations");
    await expect(read()).rejects.toThrow(/Display PIN required/);
  } finally {
    await db.close();
  }
}, 30000);
