import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
const read = (file: string) =>
  readFileSync(`supabase/migrations/${file}`, "utf8").replace(/\r\n/g, "\n");
function fn(file: string, name: string, tag = "$$") {
  const sql = read(file),
    start = sql.indexOf(`CREATE OR REPLACE FUNCTION public.${name}(`),
    body = sql.indexOf(`AS ${tag}`, start),
    end = sql.indexOf(`${tag};`, body + 3 + tag.length);
  if (start < 0 || body < 0 || end < 0) throw Error(name);
  return sql.slice(start, end + tag.length + 1);
}
const org = "00000000-0000-0000-0000-000000000001",
  branch = "00000000-0000-0000-0000-000000000002",
  room = "00000000-0000-0000-0000-000000000003",
  wo = "00000000-0000-0000-0000-000000000004",
  tech = "00000000-0000-0000-0000-000000000005",
  manager = "00000000-0000-0000-0000-000000000006",
  other = "00000000-0000-0000-0000-000000000007";
const legacyRelease = fn("20260813140649_0ebfde60-9b8a-40a1-a294-925d19eae371.sql", "wo_set_block");
const lifecycle = fn(
  "20261025140000_o07_maintenance_verification_closure.sql",
  "neo_maint_job_advance",
);
let db: PGlite;
beforeAll(async () => {
  db = new PGlite();
  await db.exec(`CREATE ROLE anon;CREATE ROLE authenticated;CREATE SCHEMA auth;
 CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql AS $$ SELECT coalesce(nullif(current_setting('neo.test_actor',true),''),'${manager}')::uuid $$;
 CREATE FUNCTION current_org_id() RETURNS uuid LANGUAGE sql AS $$ SELECT '${org}'::uuid $$;
 CREATE FUNCTION has_permission(text,text) RETURNS boolean LANGUAGE sql AS $$ SELECT coalesce(current_setting('neo.test_permission',true),'yes')='yes' $$;
 CREATE FUNCTION has_permission(text,text,text) RETURNS boolean LANGUAGE sql AS $$ SELECT coalesce(current_setting('neo.test_supervisor',true),'yes')='yes' $$;
 CREATE FUNCTION is_org_admin() RETURNS boolean LANGUAGE sql AS $$ SELECT coalesce(current_setting('neo.test_admin',true),'no')='yes' $$;
 CREATE FUNCTION neo_branch_in_scope(uuid) RETURNS boolean LANGUAGE sql AS $$ SELECT $1='${branch}'::uuid AND coalesce(current_setting('neo.test_scope',true),'yes')='yes' $$;
 CREATE TABLE rooms(id uuid PRIMARY KEY,organization_id uuid,branch_id uuid,room_number text,status text DEFAULT 'active',housekeeping_status text,maintenance_status text,occupancy_status text,inspection_status text,room_condition text,sellable boolean,out_of_order_reason text,out_of_order_from timestamptz,out_of_order_to timestamptz,last_cleaned_at timestamptz,last_inspected_at timestamptz,updated_at timestamptz);
 CREATE TABLE stays(organization_id uuid,room_id uuid,checked_out_at timestamptz,status text);
 CREATE TABLE maintenance_work_orders(id uuid PRIMARY KEY,organization_id uuid,branch_id uuid,room_id uuid,work_order_number text,description text,status text,assigned_to uuid,blocks_room boolean,block_status text,diagnosis text,completion_notes text,accepted_at timestamptz,completed_at timestamptz,verified_by uuid,verified_at timestamptz,closed_at timestamptz,updated_at timestamptz);
 CREATE TABLE work_order_status_history(id uuid DEFAULT gen_random_uuid(),organization_id uuid,work_order_id uuid,previous_status text,new_status text,reason text,changed_by uuid);
 CREATE TABLE room_status_history(id uuid DEFAULT gen_random_uuid(),organization_id uuid,branch_id uuid,room_id uuid,field text,previous_value text,new_value text,reason text,changed_by uuid);
 CREATE TABLE audit_logs(id uuid DEFAULT gen_random_uuid(),action text,record_id text,new_value jsonb);
 CREATE FUNCTION log_audit_event(text,text,text,jsonb,jsonb,text,text,uuid,uuid,uuid,text,jsonb,text) RETURNS uuid LANGUAGE plpgsql AS $$ DECLARE v_id uuid;BEGIN
 IF current_setting('neo.test_audit_failure',true)='yes' THEN RAISE EXCEPTION 'Controlled audit failure';END IF;
 INSERT INTO audit_logs(action,record_id,new_value) VALUES($1,$3,$5) RETURNING id INTO v_id;RETURN v_id;END $$;
 `);
  await db.exec(
    fn("20261026120000_p03_active_stay_occupancy_guard.sql", "rooms_derive_state", "$function$"),
  );
  await db.exec(
    "CREATE TRIGGER room_state BEFORE INSERT OR UPDATE ON rooms FOR EACH ROW EXECUTE FUNCTION rooms_derive_state()",
  );
  await db.exec(
    fn("20260819061953_aef1d910-92f8-43b1-a15c-d69ceb25b339.sql", "ops_set_room_status"),
  );
  await db.exec(fn("20260813140649_0ebfde60-9b8a-40a1-a294-925d19eae371.sql", "wo_track_status"));
  await db.exec(
    "CREATE TRIGGER trg_wo_status AFTER INSERT OR UPDATE ON maintenance_work_orders FOR EACH ROW EXECUTE FUNCTION wo_track_status()",
  );
  await db.exec(lifecycle);
  await db.exec(legacyRelease);
  await db.exec(legacyRelease.replace("public.wo_set_block(", "public.test_legacy_release("));
  const packageDirectory = process.env["NEO_MAINTENANCE_SQL_PACKAGE_DIRECTORY"];
  if (packageDirectory) {
    await db.exec(
      "CREATE SCHEMA supabase_migrations;CREATE TABLE supabase_migrations.schema_migrations(version text)",
    );
    await db.exec(
      readFileSync(`${packageDirectory}/35_READ_ONLY_MAINTENANCE_PREFLIGHT.sql`, "utf8"),
    );
    await db.exec(readFileSync(`${packageDirectory}/40_APPLY_VERIFIED_MAINTENANCE.sql`, "utf8"));
    await db.exec(
      readFileSync(`${packageDirectory}/97_READ_ONLY_MAINTENANCE_POSTCHECK.sql`, "utf8"),
    );
  } else await db.exec(read("20261106093000_maintenance_verified_room_release.sql"));
}, 60000);
afterAll(async () => {
  await db?.close();
});
beforeEach(async () => {
  await db.exec(`TRUNCATE maintenance_work_orders,rooms,stays,work_order_status_history,room_status_history,audit_logs;
 SELECT set_config('neo.test_actor','${manager}',false),set_config('neo.test_permission','yes',false),set_config('neo.test_supervisor','yes',false),set_config('neo.test_admin','no',false),set_config('neo.test_scope','yes',false),set_config('neo.test_audit_failure','no',false);
 INSERT INTO rooms(id,organization_id,branch_id,room_number,housekeeping_status,maintenance_status,occupancy_status,inspection_status) VALUES('${room}','${org}','${branch}','205','inspected','out-of-order','occupied','passed');
 INSERT INTO stays VALUES('${org}','${room}',NULL,'checked-in');
 INSERT INTO maintenance_work_orders(id,organization_id,branch_id,room_id,work_order_number,description,status,assigned_to,blocks_room,block_status) VALUES('${wo}','${org}','${branch}','${room}','WO-TEST','Labelled repair','assigned','${tech}',true,'out-of-order');`);
});
async function row() {
  return (
    await db.query<Record<string, unknown>>("SELECT * FROM maintenance_work_orders WHERE id=$1", [
      wo,
    ])
  ).rows[0]!;
}
async function state() {
  return (await db.query<Record<string, unknown>>("SELECT * FROM rooms WHERE id=$1", [room]))
    .rows[0]!;
}
async function actor(id: string, supervisor = false) {
  await db.query(
    "SELECT set_config('neo.test_actor',$1,false),set_config('neo.test_supervisor',$2,false)",
    [id, supervisor ? "yes" : "no"],
  );
}
async function advance(status: string, note = "") {
  return (await db.query("SELECT * FROM neo_maint_job_advance($1,$2,$3,'')", [wo, status, note]))
    .rows[0];
}
async function release(id = wo, block = false) {
  return (
    await db.query<{ result: Record<string, unknown> }>(
      "SELECT wo_set_block($1,$2,'out-of-order',NULL) AS result",
      [id, block],
    )
  ).rows[0]!.result;
}
async function complete() {
  await actor(tech);
  for (const status of ["accepted", "in-progress", "completed"]) await advance(status);
  await actor(manager, true);
}
async function close() {
  await complete();
  await advance("awaiting-verification");
  await advance("closed", "Tested repair independently");
}
describe("maintenance closure and room release PostgreSQL boundary", () => {
  it("records each lifecycle transition once when the real status-history trigger is enabled", async () => {
    await close();
    const history = (
      await db.query<{ new_status: string }>("SELECT new_status FROM work_order_status_history")
    ).rows;
    expect(history.map((item) => item.new_status)).toEqual([
      "assigned",
      "accepted",
      "in-progress",
      "completed",
      "awaiting-verification",
      "closed",
    ]);
    const closure=(await db.query<{reason:string}>("SELECT reason FROM work_order_status_history WHERE new_status='closed'")).rows[0];
    expect(closure?.reason).toBe("Tested repair independently");
    expect((await db.query<{note:string}>("SELECT current_setting('neo.maintenance_transition_note',true) AS note")).rows[0]?.note??"").toBe("");
    await advance("closed", "Same saved verification");
    expect((await db.query("SELECT * FROM work_order_status_history")).rows).toHaveLength(6);
  });
  it("reproduces the old release-before-verification bug", async () => {
    await db.query("SELECT test_legacy_release($1,false)", [wo]);
    expect(await state()).toMatchObject({
      maintenance_status: "operational",
      housekeeping_status: "dirty",
    });
    expect(await row()).toMatchObject({ status: "assigned", verified_at: null });
  });
  it.each(["assigned", "completed", "awaiting-verification"])(
    "refuses room release at %s",
    async (status) => {
      if (status !== "assigned") await complete();
      if (status === "awaiting-verification") await advance(status);
      await expect(release()).rejects.toThrow("Independent verification");
      expect(await state()).toMatchObject({ maintenance_status: "out-of-order", sellable: false });
      expect((await row())["blocks_room"]).toBe(true);
    },
  );
  it("keeps review pending until independent closure and returns the room dirty without vacating it", async () => {
    await complete();
    await advance("awaiting-verification");
    expect(await row()).toMatchObject({ verified_by: null, verified_at: null, closed_at: null });
    await advance("closed", "Tested repair independently");
    expect(await row()).toMatchObject({ verified_by: manager, status: "closed" });
    const result = await release();
    expect(result).toMatchObject({
      ok: true,
      blocked: false,
      room_released: true,
      work_order_id: wo,
      room_id: room,
    });
    expect(result["audit_id"]).toBeTruthy();
    expect(await state()).toMatchObject({
      housekeeping_status: "dirty",
      maintenance_status: "operational",
      occupancy_status: "occupied",
      sellable: false,
    });
  });
  it("requires a real closure note and prior completed repair", async () => {
    await complete();
    await advance("awaiting-verification");
    await expect(advance("closed")).rejects.toThrow("verification note");
    expect((await row())["status"]).toBe("awaiting-verification");
  });
  it("rejects self-verification even for an administrator", async () => {
    await complete();
    await advance("awaiting-verification");
    await actor(tech, true);
    await db.exec("SELECT set_config('neo.test_admin','yes',false)");
    await expect(advance("closed", "I checked it myself")).rejects.toThrow("cannot verify");
  });
  it("denies cross-property transition and release before idempotent success", async () => {
    await close();
    await db.exec("SELECT set_config('neo.test_scope','no',false)");
    await expect(advance("closed", "Repeat")).rejects.toThrow("outside authorised property");
    await expect(release()).rejects.toThrow("outside authorised property");
  });
  it("does not let a direct table update bypass transition or verification evidence", async () => {
    await expect(
      db.query(
        "UPDATE maintenance_work_orders SET status='closed',verified_by=$1,verified_at=now() WHERE id=$2",
        [manager, wo],
      ),
    ).rejects.toThrow("Cannot move");
    await expect(
      db.query("UPDATE maintenance_work_orders SET verified_by=$1,verified_at=now() WHERE id=$2", [
        manager,
        wo,
      ]),
    ).rejects.toThrow("Lifecycle evidence");
  });
  it("keeps the room blocked until the final verified repair hold is removed", async () => {
    await close();
    await db.query(
      "INSERT INTO maintenance_work_orders SELECT $1,organization_id,branch_id,room_id,'WO-OTHER',description,status,assigned_to,blocks_room,block_status,diagnosis,completion_notes,accepted_at,completed_at,verified_by,verified_at,closed_at,updated_at FROM maintenance_work_orders WHERE id=$2",
      [other, wo],
    );
    expect(await release()).toMatchObject({
      blocked: false,
      room_released: false,
      remaining_holds: 1,
    });
    expect((await state())["maintenance_status"]).toBe("out-of-order");
    expect(await release(other)).toMatchObject({ room_released: true, remaining_holds: 0 });
    expect((await state())["maintenance_status"]).toBe("operational");
  });
  it("does not make a duplicate release dirty an already cleaned room or create another audit", async () => {
    await close();
    await release();
    await db.exec(
      "DELETE FROM stays;UPDATE rooms SET housekeeping_status='inspected',inspection_status='passed',occupancy_status='vacant',room_condition='vacant-clean'",
    );
    const cleaned = await state();
    const before = (
      await db.query<{ count: number }>("SELECT count(*)::int AS count FROM audit_logs")
    ).rows[0]!.count;
    expect(await release()).toMatchObject({ idempotent: true, blocked: false });
    expect(await state()).toEqual(cleaned);
    expect(
      (await db.query<{ count: number }>("SELECT count(*)::int AS count FROM audit_logs")).rows[0]!
        .count,
    ).toBe(before);
  });
  it("rolls back both the room and hold if its audit fails", async () => {
    await close();
    await db.exec("SELECT set_config('neo.test_audit_failure','yes',false)");
    await expect(release()).rejects.toThrow("Controlled audit failure");
    expect((await row())["blocks_room"]).toBe(true);
    expect((await state())["maintenance_status"]).toBe("out-of-order");
  });
  it("keeps other-property and mismatched room links rejected", async () => {
    await db.exec(`UPDATE rooms SET branch_id='${other}'`);
    await expect(release()).rejects.toThrow("does not match");
  });
  it("does not let a closed repair be reblocked without reopening", async () => {
    await close();
    await expect(release(wo, true)).rejects.toThrow("Reopen");
  });
  it("stamps completion at the server and refuses later evidence tampering", async () => {
    await complete();
    expect((await row())["completed_at"]).toBeTruthy();
    await expect(
      db.query(
        "UPDATE maintenance_work_orders SET completed_at=now()+interval '1 day' WHERE id=$1",
        [wo],
      ),
    ).rejects.toThrow("Lifecycle evidence");
  });
  it("requires supervisor review and does not let technicians close directly", async () => {
    await complete();
    await actor(tech);
    await expect(advance("awaiting-verification")).rejects.toThrow("supervisor");
  });
  it("refuses a differing deployed function before partial migration writes", async () => {
    await expect(
      db.exec(read("20261106093000_maintenance_verified_room_release.sql")),
    ).rejects.toThrow("differs from reviewed source");
    await db.exec("ROLLBACK");
    expect((await row())["status"]).toBe("assigned");
  });
});
