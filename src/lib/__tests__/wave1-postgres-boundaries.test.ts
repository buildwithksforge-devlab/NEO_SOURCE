import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const read = (name: string) =>
  readFileSync(`supabase/migrations/${name}`, "utf8")
    .replace(/^\uFEFF/, "")
    .replace(/\r\n/g, "\n");
const originalSql = read("20260920202959_726c22f0-fe87-4b5c-93e0-17cb73611001.sql");
const original = originalSql.match(
  /CREATE OR REPLACE FUNCTION public\.hk_raise_cleaning_task\([\s\S]*?END \$function\$;/,
)![0];
const triggerSql = read("20261026120000_p03_active_stay_occupancy_guard.sql");
const trigger = triggerSql.slice(
  0,
  triggerSql.indexOf("$function$;", triggerSql.indexOf("AS $function$")) + "$function$;".length,
);
const migration = read("20261106090000_housekeeping_preserve_occupancy.sql");
const roomId = "00000000-0000-0000-0000-000000000205";
type Room = {
  occupancy_status: string;
  sellable: boolean;
  maintenance_status: string;
  housekeeping_status: string;
};

describe("Wave 1 housekeeping PostgreSQL boundary", () => {
  let db: PGlite;
  let fixedUpdate: string;
  const legacyUpdate = original.match(
    /UPDATE public\.rooms SET housekeeping_status=[\s\S]*?WHERE id=_room;/,
  )![0];
  beforeAll(async () => {
    db = new PGlite();
    await db.exec(`CREATE TABLE rooms (
      id uuid PRIMARY KEY, organization_id uuid, housekeeping_status text, maintenance_status text,
      occupancy_status text, inspection_status text, room_condition text,
      status text DEFAULT 'active', sellable boolean, updated_at timestamptz,
      out_of_order_reason text, out_of_order_from timestamptz, out_of_order_to timestamptz
    ); CREATE TABLE housekeeping_jobs(id uuid); CREATE TABLE stays(organization_id uuid,room_id uuid,checked_out_at timestamptz,status text); ${trigger}
    CREATE TRIGGER rooms_derive_state BEFORE INSERT OR UPDATE ON rooms
    FOR EACH ROW EXECUTE FUNCTION rooms_derive_state(); ${original}`);
    await db.exec(migration);
    const result = await db.query<{ prosrc: string }>(
      "SELECT prosrc FROM pg_proc WHERE proname='hk_raise_cleaning_task'",
    );
    fixedUpdate = result.rows[0]!.prosrc.match(
      /UPDATE public\.rooms SET housekeeping_status=[\s\S]*?WHERE id=_room;/,
    )![0];
  }, 60000);
  afterAll(async () => {
    await db?.close();
  });
  async function seed(occupancy = "occupied", maintenance = "operational") {
    await db.exec("DELETE FROM stays; DELETE FROM rooms");
    await db.query(
      "INSERT INTO rooms(id,organization_id,occupancy_status,housekeeping_status,inspection_status,maintenance_status) VALUES ($1,$1,$2,'inspected','passed',$3)",
      [roomId, occupancy, maintenance],
    );
  }
  async function room() {
    return (await db.query<Room>("SELECT * FROM rooms WHERE id=$1", [roomId])).rows[0]!;
  }
  async function apply(sql: string, job = "stayover-cleaning") {
    await db.query(sql.replaceAll("_room", "$1").replaceAll("_job_type", "$2"), [roomId, job]);
  }
  it("reproduces the original occupied-to-vacant corruption", async () => {
    await seed();
    await apply(legacyUpdate);
    expect((await room()).occupancy_status).toBe("vacant");
  });
  it.each(["stayover-cleaning", "deep-cleaning", "touch-up", "rework", "recovery", "turndown"])(
    "preserves occupancy through %s, completion and inspection",
    async (job) => {
      await seed();
      await apply(fixedUpdate, job);
      expect(await room()).toMatchObject({ occupancy_status: "occupied", sellable: false });
      for (const status of ["in-progress", "awaiting-inspection", "inspected"]) {
        await db.query("UPDATE rooms SET housekeeping_status=$1 WHERE id=$2", [status, roomId]);
        expect(await room()).toMatchObject({ occupancy_status: "occupied", sellable: false });
      }
    },
  );
  it("retains authorized check-in and checkout; vacant turnover requires inspection", async () => {
    await seed("vacant");
    expect((await room()).sellable).toBe(true);
    await db.query(
      "UPDATE rooms SET occupancy_status='occupied',room_condition='occupied-clean' WHERE id=$1",
      [roomId],
    );
    expect(await room()).toMatchObject({ occupancy_status: "occupied", sellable: false });
    await db.query(
      "UPDATE rooms SET occupancy_status='vacant',room_condition='vacant-dirty',housekeeping_status='dirty' WHERE id=$1",
      [roomId],
    );
    expect(await room()).toMatchObject({ occupancy_status: "vacant", sellable: false });
    await apply(fixedUpdate, "checkout-cleaning");
    await db.query("UPDATE rooms SET housekeeping_status='awaiting-inspection' WHERE id=$1", [
      roomId,
    ]);
    expect((await room()).sellable).toBe(false);
    await db.query("UPDATE rooms SET housekeeping_status='inspected' WHERE id=$1", [roomId]);
    expect((await room()).sellable).toBe(true);
  });
  it("never releases a maintenance-blocked room", async () => {
    await seed("vacant", "out-of-service");
    await apply(fixedUpdate);
    await db.query("UPDATE rooms SET housekeeping_status='inspected' WHERE id=$1", [roomId]);
    expect(await room()).toMatchObject({ maintenance_status: "out-of-service", sellable: false });
  });
  it("retains the checkout protection in the newer active-stay trigger", async () => {
    await seed();
    await db.query("INSERT INTO stays(organization_id,room_id,status) VALUES($1,$1,'checked-in')", [
      roomId,
    ]);
    await apply(legacyUpdate);
    expect((await room()).occupancy_status).toBe("occupied");
    await db.query("UPDATE stays SET checked_out_at=now(),status='checked-out'");
    await db.query(
      "UPDATE rooms SET occupancy_status='vacant',room_condition='vacant-dirty' WHERE id=$1",
      [roomId],
    );
    expect((await room()).occupancy_status).toBe("vacant");
  });
  it("preserves maintenance blocking even when an active stay already protects occupancy", async () => {
    await seed("occupied", "out-of-service");
    await db.query("INSERT INTO stays(organization_id,room_id,status) VALUES($1,$1,'checked-in')", [
      roomId,
    ]);
    await apply(fixedUpdate);
    expect(await room()).toMatchObject({
      occupancy_status: "occupied",
      maintenance_status: "out-of-service",
      sellable: false,
    });
  });
  it("preserves every other statement in the function", async () => {
    const before = original.match(/AS \$function\$([\s\S]*?)\$function\$;/)![1]!;
    const result = await db.query<{ prosrc: string }>(
      "SELECT prosrc FROM pg_proc WHERE proname='hk_raise_cleaning_task'",
    );
    expect(result.rows[0]!.prosrc).toBe(before.replace(" room_condition='vacant-dirty',", ""));
  });
  it("refuses deployment drift without overwriting the current function", async () => {
    await expect(db.exec(migration)).rejects.toThrow(/differs from reviewed/);
    await db.exec("ROLLBACK");
  });
});

describe("Wave 1 GRN retry PostgreSQL boundary", () => {
  let db: PGlite;
  const id = "00000000-0000-0000-0000-000000000002";
  const journal = "00000000-0000-0000-0000-000000000003";
  const grnOriginal = read("20260920040600_74e76da2-efc3-4ab7-846e-fd9aa4a6d2e8.sql").match(
    /CREATE OR REPLACE FUNCTION public\.neo_grn_retry_accrual\([\s\S]*?END \$function\$;/,
  )![0];
  const grnMigration = read("20261106090100_grn_retry_confirm_posting.sql");
  beforeAll(async () => {
    db = new PGlite();
    await db.exec(`CREATE TABLE goods_receipts(id uuid,organization_id uuid,branch_id uuid,accrual_journal_id uuid);
      CREATE FUNCTION current_org_id() RETURNS uuid LANGUAGE sql AS $$ SELECT '${id}'::uuid $$;
      CREATE FUNCTION neo_branch_in_scope(uuid) RETURNS boolean LANGUAGE sql AS $$ SELECT coalesce(current_setting('neo.scope',true),'yes') <> 'no' $$;
      CREATE FUNCTION has_permission(text,text) RETURNS boolean LANGUAGE sql AS $$ SELECT coalesce(current_setting('neo.permission',true),'yes') <> 'no' $$;
      CREATE FUNCTION is_org_admin() RETURNS boolean LANGUAGE sql AS $$ SELECT false $$;
      CREATE FUNCTION neo_grn_post_accrual(uuid) RETURNS jsonb LANGUAGE sql AS $$ SELECT current_setting('neo.test_accrual')::jsonb $$;
      INSERT INTO goods_receipts(id,organization_id) VALUES ('${id}','${id}'); ${grnOriginal}`);
    await db.query("SELECT set_config('neo.test_accrual',$1,false)", [
      JSON.stringify({ ok: false, error: "Controlled failure" }),
    ]);
    const before = await db.query<{ result: { ok: boolean } }>(
      "SELECT neo_grn_retry_accrual($1) AS result",
      [id],
    );
    expect(before.rows[0]!.result.ok).toBe(true);
    await db.exec(grnMigration);
  }, 60000);
  afterAll(async () => {
    await db?.close();
  });
  async function response(value: unknown) {
    await db.exec("UPDATE goods_receipts SET accrual_journal_id=NULL");
    await db.query("SELECT set_config('neo.test_accrual',$1,false)", [JSON.stringify(value)]);
    return db.query<{ result: Record<string, unknown> }>(
      "SELECT neo_grn_retry_accrual($1) AS result",
      [id],
    );
  }
  it.each([
    null,
    {},
    { ok: false, error: "Controlled failure" },
    { ok: true },
    { ok: true, journal_id: "" },
  ])("rejects a non-posting result %j", async (value) => {
    await expect(response(value)).rejects.toThrow("was not posted");
  });
  it("retains successful postings and legitimate zero-value skips", async () => {
    expect((await response({ ok: true, journal_id: journal })).rows[0]!.result["journal_id"]).toBe(
      journal,
    );
    expect((await response({ ok: true, skipped: "zero_value" })).rows[0]!.result["skipped"]).toBe(
      "zero_value",
    );
  });
  it("returns the original journal for an already-posted retry", async () => {
    await db.query("UPDATE goods_receipts SET accrual_journal_id=$1", [journal]);
    const result = await db.query<{ result: Record<string, unknown> }>(
      "SELECT neo_grn_retry_accrual($1) AS result",
      [id],
    );
    expect(result.rows[0]!.result).toMatchObject({ already_posted: true, journal_id: journal });
  });
  it.each(["neo.scope", "neo.permission"])("retains the denial boundary %s", async (setting) => {
    await db.query("SELECT set_config($1,'no',false)", [setting]);
    try {
      await expect(db.query("SELECT neo_grn_retry_accrual($1)", [id])).rejects.toThrow(
        /another property|Not permitted/,
      );
    } finally {
      await db.query("SELECT set_config($1,'yes',false)", [setting]);
    }
  });
});
