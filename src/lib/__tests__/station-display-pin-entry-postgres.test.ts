import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";
import { expect, it } from "vitest";

it("routes personal and display PINs on authorised devices and revokes station access", async () => {
  const db = new PGlite();
  const org = "41000000-0000-4000-8000-000000000001", branch = "41000000-0000-4000-8000-000000000002";
  const station = "41000000-0000-4000-8000-000000000003", worker = "41000000-0000-4000-8000-000000000004";
  const token = "a".repeat(64);
  const deviceHash = "b".repeat(64);
  const otherStation = "41000000-0000-4000-8000-000000000005";
  try {
    await db.exec(`
      CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role; CREATE SCHEMA extensions; CREATE SCHEMA auth;
      CREATE FUNCTION extensions.digest(bytea,text) RETURNS bytea LANGUAGE sql AS $$ SELECT decode(md5($1),'hex') $$;
      CREATE FUNCTION extensions.gen_random_bytes(integer) RETURNS bytea LANGUAGE sql AS $$
        SELECT decode(replace(gen_random_uuid()::text || gen_random_uuid()::text,'-',''),'hex')
      $$;
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
        station_ids uuid[],token_hash text,label text,opened_by uuid,closed_at timestamptz,expires_at timestamptz DEFAULT now()+interval '1 hour',
        failed_attempts integer DEFAULT 0,blocked_until timestamptz,attempt_window timestamptz DEFAULT now());
      CREATE TABLE neo_staff_login_devices(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),organization_id uuid,branch_id uuid,
        token_hash text UNIQUE,paired_by uuid,revoked_at timestamptz,expires_at timestamptz DEFAULT now()+interval '30 days',
        failed_attempts integer DEFAULT 0,blocked_until timestamptz,attempt_window timestamptz DEFAULT now(),last_used_at timestamptz);
      CREATE FUNCTION neo_production_context(uuid) RETURNS void LANGUAGE plpgsql AS $$ BEGIN RETURN; END $$;
      CREATE FUNCTION neo_access_cache_bump() RETURNS void LANGUAGE plpgsql AS $$ BEGIN RETURN; END $$;
      CREATE FUNCTION neo_production_staff_pin(text,boolean) RETURNS jsonb LANGUAGE sql AS $$ SELECT '{}'::jsonb $$;
      CREATE FUNCTION neo_production_require_session(text) RETURNS neo_production_display_sessions LANGUAGE sql AS $$
        SELECT * FROM neo_production_display_sessions LIMIT 1
      $$;
      INSERT INTO operational_stations VALUES ('${station}','${org}','${branch}',true,NULL,'Main Bar','BAR','bar');
      INSERT INTO operational_stations VALUES ('${otherStation}','${org}','${branch}',true,NULL,'Grill','GRILL','grill');
      INSERT INTO profiles VALUES ('${worker}','${org}','staff','active','Assigned staff','staff@example.invalid','BAR-01');
      INSERT INTO user_stations VALUES ('${org}','${station}','${worker}');
      INSERT INTO user_stations VALUES ('${org}','${otherStation}','${worker}');
      INSERT INTO neo_production_staff_codes(organization_id,user_id,pin_hash,staff_code) VALUES ('${org}','${worker}',md5('246810'),'BAR-01');
      INSERT INTO neo_production_display_sessions(organization_id,branch_id,station_ids,token_hash)
        VALUES('${org}','${branch}',ARRAY['${station}'::uuid],md5('${token}'));
      INSERT INTO neo_staff_login_devices(organization_id,branch_id,token_hash,paired_by)
        VALUES('${org}','${branch}','${deviceHash}','${worker}');
    `);
    const deviceMigration = readFileSync("supabase/migrations/20261031230000_trusted_staff_pin_devices.sql", "utf8");
    await db.exec(deviceMigration.slice(deviceMigration.indexOf("CREATE OR REPLACE FUNCTION public.neo_staff_login_device_resolve(")));
    const installer = readFileSync("supabase/repair/2026-11-22/INSTALL-STATION-DISPLAY-SIGN-IN.sql", "utf8");
    for (const migration of ["20261121123800_station_account_entry", "20261122164500_station_display_pin_entry", "20261122170000_separate_production_pin_credentials", "20261122173000_route_display_pin_sign_in"]) {
      expect(installer.replaceAll("\r\n", "\n")).toContain(readFileSync(`supabase/migrations/${migration}.sql`, "utf8").replaceAll("\r\n", "\n").trim());
    }
    await db.exec(installer);
    await db.exec(installer);
    const configure = (pin: string) => db.query("SELECT neo_station_display_pin_admin($1,$2,$3,$4)", [branch,station,worker,pin]);
    const enter = (pin: string | null) => db.query("SELECT neo_production_display_entry($1,$2) AS result", [token,pin]);
    await expect(configure("135790")).rejects.toMatchObject({ code: "42501" });
    await db.exec("SET test.device_admin='on'");
    const list = () => db.query("SELECT neo_station_display_pin_admin($1,$2) AS accounts", [branch,station]);
    expect((await list()).rows).toMatchObject([{ accounts: [{ id: worker, display_pin_set: false, opens_station: false }] }]);
    await expect(configure("246810")).rejects.toThrow(/different display PIN/);
    await configure("135790");
    await expect(db.query("SELECT neo_station_display_pin_admin($1,$2,$3,$4)", [branch,otherStation,worker,"135790"]))
      .rejects.toThrow(/different display PIN/);
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

    const signIn = async (pin: string, hash = deviceHash) =>
      (await db.query<{ result: { kind?: string; branch_id?: string; display_token?: string; user_id?: string; reason?: string } }>(
        "SELECT neo_staff_pin_sign_in($1,$2) AS result", [hash,pin],
      )).rows[0]?.result;
    const stationFor = async (displayToken: string | undefined) =>
      (await db.query("SELECT (neo_production_require_session($1)).station_ids AS stations", [displayToken])).rows;
    await db.exec("SET ROLE anon");
    await expect(signIn("135790")).rejects.toThrow(/permission denied/);
    await db.exec("SET ROLE service_role");
    expect(await signIn("135790", "c".repeat(64))).toMatchObject({ reason: "device" });
    expect(await signIn("246810")).toEqual({ ok: true, user_id: worker, branch_id: branch });
    await db.exec("RESET ROLE");
    await db.exec(`INSERT INTO neo_station_entry_pins VALUES ('${org}','${branch}','${otherStation}','${worker}',md5('135790'))`);
    expect(await signIn("135790")).toMatchObject({ reason: "credentials" });
    await db.exec(`DELETE FROM neo_station_entry_pins WHERE station_id='${otherStation}'`);
    const otherDevice = "d".repeat(64);
    await db.exec(`INSERT INTO neo_staff_login_devices(organization_id,branch_id,token_hash,paired_by)
      VALUES('${org}',gen_random_uuid(),'${otherDevice}','${worker}')`);
    for (let attempt = 0; attempt < 5; attempt++) {
      expect(await signIn("135790", otherDevice)).toMatchObject({ reason: "credentials" });
    }
    expect(await signIn("135790", otherDevice)).toMatchObject({ reason: "locked" });
    await db.exec("SET ROLE service_role");
    const display = await signIn("135790");
    expect(display).toMatchObject({ kind: "display", branch_id: branch, display_token: expect.stringMatching(/^[a-f0-9]{64}$/) });
    expect(display).not.toHaveProperty("user_id");
    await db.exec("RESET ROLE");
    expect(await stationFor(display?.display_token)).toEqual([{ stations: [station] }]);
    await configure("135791");
    await expect(stationFor(display?.display_token)).rejects.toMatchObject({ code: "42501" });
    expect(await signIn("135790")).toMatchObject({ reason: "credentials" });
    const replaced = await signIn("135791");
    await db.exec("UPDATE neo_staff_login_devices SET revoked_at=now()");
    await expect(stationFor(replaced?.display_token)).rejects.toMatchObject({ code: "42501" });
    expect(await signIn("135791")).toMatchObject({ reason: "device" });

    await db.exec("DELETE FROM user_stations");
    expect((await list()).rows).toEqual([{ accounts: [] }]);
    await expect(read()).rejects.toThrow(/Display PIN required/);
  } finally {
    await db.close();
  }
}, 30000);
