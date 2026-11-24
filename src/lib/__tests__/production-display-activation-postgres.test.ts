import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";
import { expect, it } from "vitest";

const station = "00000000-0000-4000-8000-000000000001";
const branch = "00000000-0000-4000-8000-000000000002";

it("only issues activation codes through the pairing gate and consumes each code once", async () => {
  const db = new PGlite();
  try {
    await db.exec(`
      CREATE ROLE anon;
      CREATE ROLE authenticated;
      CREATE SCHEMA extensions;
      CREATE FUNCTION extensions.gen_random_bytes(integer) RETURNS bytea LANGUAGE sql AS $$
        SELECT substring(decode(replace(gen_random_uuid()::text,'-',''),'hex') FROM 1 FOR $1)
      $$;
      CREATE FUNCTION extensions.digest(text,text) RETURNS bytea LANGUAGE sql IMMUTABLE AS $$
        SELECT decode(md5($1),'hex')
      $$;
      CREATE TABLE neo_production_display_sessions(
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(), expires_at timestamptz NOT NULL, closed_at timestamptz,
        station_ids uuid[] NOT NULL
      );
      CREATE FUNCTION neo_production_display_pair(uuid,uuid[],text,boolean) RETURNS jsonb LANGUAGE plpgsql AS $$
      DECLARE session uuid;
      BEGIN
        IF $1 <> '${branch}' OR $2 <> ARRAY['${station}'::uuid] THEN
          RAISE EXCEPTION 'Station scope denied' USING ERRCODE='42501';
        END IF;
        INSERT INTO neo_production_display_sessions(expires_at,station_ids)
          VALUES (now()+interval '12 hours',$2) RETURNING id INTO session;
        RETURN jsonb_build_object('ok',true,'token',repeat('a',64),'expires_at',now()+interval '12 hours','session_id',session);
      END $$;
    `);
    await db.exec(readFileSync("supabase/migrations/20261121123100_production_display_activation_codes.sql","utf8"));
    const issue = "SELECT neo_production_display_activation_issue($1,ARRAY[$2::uuid],'Bar counter',false) AS result";
    await db.exec("SET ROLE anon");
    await expect(db.query(issue,[branch,station])).rejects.toThrow(/permission denied/i);
    await expect(db.query("SELECT * FROM neo_production_display_activation")).rejects.toThrow(/permission denied/i);
    await db.exec("RESET ROLE; SET ROLE authenticated");
    await expect(db.query(issue,[station,branch])).rejects.toThrow(/scope denied/i);
    const issued = (await db.query<{ result: { code: string; expires_at: string } }>(issue,[branch,station])).rows[0]?.result;
    expect(issued?.code).toMatch(/^neods_[0-9a-f]{32}$/);
    expect(issued).not.toHaveProperty("token");
    await db.exec("RESET ROLE; SET ROLE anon");
    const claim = "SELECT neo_production_display_activation_claim($1) AS result";
    const used = await db.query<{ result: { session_id: string } }>(claim,[issued?.code]);
    await expect(db.query(claim,[issued?.code])).rejects.toThrow(/already used/);
    await db.exec("RESET ROLE");
    expect((await db.query("SELECT station_ids FROM neo_production_display_sessions WHERE id=$1",
      [used.rows[0]?.result.session_id])).rows).toEqual([{ station_ids: [station] }]);
    const revoked = (await db.query<{ result: { code: string } }>(issue,[branch,station])).rows[0]?.result.code;
    await db.exec("UPDATE neo_production_display_sessions SET closed_at=now(); SET ROLE anon");
    await expect(db.query(claim,[revoked])).rejects.toThrow(/unavailable/i);
  } finally {
    await db.close();
  }
}, 20000);
