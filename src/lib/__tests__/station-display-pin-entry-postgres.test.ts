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
      CREATE ROLE anon; CREATE ROLE authenticated; CREATE SCHEMA extensions; CREATE SCHEMA auth;
      CREATE FUNCTION extensions.digest(bytea,text) RETURNS bytea LANGUAGE sql AS $$ SELECT decode(md5($1),'hex') $$;
      CREATE FUNCTION extensions.crypt(text,text) RETURNS text LANGUAGE sql AS $$ SELECT md5($1) $$;
      CREATE FUNCTION extensions.gen_salt(text,integer) RETURNS text LANGUAGE sql AS $$ SELECT 'fixture'::text $$;
      CREATE FUNCTION current_org_id() RETURNS uuid LANGUAGE sql AS $$ SELECT '${org}'::uuid $$;
      CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql AS $$ SELECT '${worker}'::uuid $$;
      CREATE FUNCTION is_active_staff() RETURNS boolean LANGUAGE sql AS $$ SELECT true $$;
      CREATE FUNCTION neo_device_admin_allowed() RETURNS boolean LANGUAGE sql AS $$ SELECT current_setting('test.device_admin',true) = 'on' $$;
      CREATE FUNCTION neo_branch_in_scope(uuid) RETURNS boolean LANGUAGE sql AS $$ SELECT $1 = '${branch}'::uuid $$;
      CREATE FUNCTION neo_kitchen_visible_station_ids() RETURNS uuid[] LANGUAGE sql AS $$ SELECT ARRAY['${station}'::uuid] $$;
      CREATE TABLE operational_stations(id uuid PRIMARY KEY,organization_id uuid,branch_id uuid,active boolean,department_id uuid,name text,code text,station_type text);
      CREATE TABLE departments(id uuid,organization_id uuid,catalogue_key text);
      CREATE TABLE profiles(id uuid PRIMARY KEY,organization_id uuid,account_type text,account_status text,full_name text,email text,staff_id text);
      CREATE TABLE user_stations(organization_id uuid,station_id uuid,user_id uuid);
      CREATE TABLE neo_production_staff_codes(organization_id uuid,user_id uuid,enabled boolean DEFAULT true,pin_hash text,staff_code text,
        updated_at timestamptz,failed_attempts integer,blocked_until timestamptz,PRIMARY KEY(organization_id,user_id));
      CREATE TABLE neo_production_display_sessions(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),organization_id uuid,branch_id uuid,
        station_ids uuid[],token_hash text,closed_at timestamptz,expires_at timestamptz DEFAULT now()+interval '1 hour',
        failed_attempts integer DEFAULT 0,blocked_until timestamptz,attempt_window timestamptz DEFAULT now());
      INSERT INTO operational_stations VALUES ('${station}','${org}','${branch}',true,NULL,'Main Bar','BAR','bar');
      INSERT INTO profiles VALUES ('${worker}','${org}','staff','active','Assigned staff','staff@example.invalid','BAR-01');
      INSERT INTO user_stations VALUES ('${org}','${station}','${worker}');
      INSERT INTO neo_production_staff_codes(organization_id,user_id,pin_hash,staff_code) VALUES ('${org}','${worker}',md5('246810'),'BAR-01');
      INSERT INTO neo_production_display_sessions(organization_id,branch_id,station_ids,token_hash)
        VALUES('${org}','${branch}',ARRAY['${station}'::uuid],md5('${token}'));
    `);
    for (const migration of ["20261121123800_station_account_entry", "20261122164500_station_display_pin_entry", "20261122170000_separate_production_pin_credentials"]) {
      await db.exec(readFileSync(`supabase/migrations/${migration}.sql`, "utf8"));
    }
    const configure = (pin: string) => db.query("SELECT neo_station_display_pin_admin($1,$2,$3,$4)", [branch,station,worker,pin]);
    const enter = (pin: string | null) => db.query("SELECT neo_production_display_entry($1,$2) AS result", [token,pin]);
    await expect(configure("135790")).rejects.toMatchObject({ code: "42501" });
    await db.exec("SET test.device_admin='on'");
    const list = () => db.query("SELECT neo_station_display_pin_admin($1,$2) AS accounts", [branch,station]);
    expect((await list()).rows).toMatchObject([{ accounts: [{ id: worker, display_pin_set: false, opens_station: false }] }]);
    await expect(configure("246810")).rejects.toThrow(/different display PIN/);
    await configure("135790");
    expect((await list()).rows).toMatchObject([{ accounts: [{ id: worker, display_pin_set: true, opens_station: false }] }]);
    await expect(db.query("SELECT neo_production_staff_pin($1)", ["135790"])).rejects.toMatchObject({ code: "23505" });
    const read = () => db.query("SELECT (neo_production_require_session($1)).id", [token]);
    await expect(read()).rejects.toThrow(/Display PIN required/);
    await db.exec("SET ROLE anon");
    await expect(configure("654321")).rejects.toThrow(/permission denied/);
    expect((await enter("246810")).rows).toMatchObject([{ result: { ready: false } }]);
    expect((await enter("135790")).rows).toMatchObject([{ result: { ready: true } }]);
    await db.exec("RESET ROLE");
    expect((await read()).rows).toHaveLength(1);
    await db.exec("DELETE FROM user_stations");
    expect((await list()).rows).toEqual([{ accounts: [] }]);
    await expect(read()).rejects.toThrow(/Display PIN required/);
  } finally {
    await db.close();
  }
}, 30000);
