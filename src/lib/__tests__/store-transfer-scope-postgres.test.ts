import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
const read = (path: string) => readFileSync(path, "utf8");
const source = read("supabase/migrations/20260919051525_feb17559-e7b1-43aa-87ff-c5a20b5ee274.sql");
const migration = read("supabase/migrations/20261116235000_store_transfer_scope_and_replay.sql");
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const org = id(1), branch = id(2), from = id(3), to = id(4), stock = id(5), actor = id(6), attempt = id(7);
describe("store transfer property, replay and state guards", () => {
  let db: PGlite;
  beforeAll(async () => {
    db = new PGlite();
    await db.exec(`CREATE ROLE authenticated; CREATE SCHEMA auth;
      CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('test.actor',true),'')::uuid $$;
      CREATE FUNCTION current_org_id() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT '${org}'::uuid $$;
      CREATE FUNCTION neo_can_transfer_stock() RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT coalesce(current_setting('test.allowed',true),'false')='true' $$;
      CREATE FUNCTION neo_branch_in_scope(uuid) RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT $1='${branch}'::uuid $$;
      CREATE FUNCTION current_branch_ids() RETURNS uuid[] LANGUAGE sql STABLE AS $$ SELECT ARRAY['${branch}'::uuid] $$;
      CREATE SEQUENCE transfer_number_seq;
      CREATE FUNCTION next_document_number(text) RETURNS text LANGUAGE sql VOLATILE AS $$ SELECT 'TR-'||nextval('transfer_number_seq') $$;
      CREATE TABLE stock_transfers(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),organization_id uuid,branch_id uuid,transfer_number text,from_location_id uuid,to_location_id uuid,status text,reason text,notes text,attempt_key text,requested_by uuid,dispatched_by uuid,dispatched_at timestamptz,received_by uuid,received_at timestamptz,cancelled_by uuid,cancelled_at timestamptz,updated_at timestamptz);
      CREATE UNIQUE INDEX transfer_attempt ON stock_transfers(organization_id,attempt_key);
      CREATE TABLE stock_transfer_lines(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),organization_id uuid,transfer_id uuid,stock_item_id uuid,quantity numeric,received_quantity numeric,unit text,updated_at timestamptz);
      CREATE TABLE stock_locations(id uuid PRIMARY KEY,organization_id uuid,branch_id uuid,active boolean);
      CREATE TABLE stock_items(id uuid PRIMARY KEY,organization_id uuid,branch_id uuid,base_unit text,active boolean);
      CREATE TABLE stock_levels(stock_item_id uuid,location_id uuid,quantity_on_hand numeric,PRIMARY KEY(stock_item_id,location_id));
      CREATE TABLE movement_evidence(stock_item_id uuid,location_id uuid,quantity numeric,kind text,key text UNIQUE);
      CREATE FUNCTION inventory_apply_movement(uuid,uuid,numeric,text,text,uuid,text,uuid,text,text,uuid,uuid) RETURNS uuid LANGUAGE plpgsql AS $$
      DECLARE saved uuid := gen_random_uuid(); BEGIN
        INSERT INTO movement_evidence VALUES($1,$2,$3,$5,$10);
        INSERT INTO stock_levels VALUES($1,$2,$3) ON CONFLICT(stock_item_id,location_id)
          DO UPDATE SET quantity_on_hand=stock_levels.quantity_on_hand+excluded.quantity_on_hand;
        RETURN saved;
      END $$;
    `);
    for (const name of ["neo_stores_transfer_create", "neo_stores_transfer_receive", "neo_stores_transfer_cancel"]) {
      await db.exec(source.match(new RegExp(`CREATE OR REPLACE FUNCTION public\\.${name}\\([\\s\\S]*?END \\$function\\$;`))![0]);
    }
    await db.exec(`REVOKE ALL ON FUNCTION neo_stores_transfer_create(uuid,uuid,uuid,jsonb,text,uuid),neo_stores_transfer_receive(uuid),neo_stores_transfer_cancel(uuid,text) FROM PUBLIC;
      GRANT EXECUTE ON FUNCTION neo_stores_transfer_create(uuid,uuid,uuid,jsonb,text,uuid),neo_stores_transfer_receive(uuid),neo_stores_transfer_cancel(uuid,text) TO authenticated;`);
    await db.exec(migration);
  }, 30_000);
  beforeEach(async () => {
    await db.exec(`TRUNCATE stock_transfers,stock_transfer_lines,stock_locations,stock_items,stock_levels,movement_evidence;
      SELECT set_config('test.actor','${actor}',false),set_config('test.allowed','true',false);
      INSERT INTO stock_locations VALUES('${from}','${org}','${branch}',true),('${to}','${org}','${branch}',true);
      INSERT INTO stock_items VALUES('${stock}','${org}',null,'kg',true);
      INSERT INTO stock_levels VALUES('${stock}','${from}',20),('${stock}','${to}',0);`);
  });
  afterAll(async () => { await db?.close(); });
  async function create(lines = [{ stock_item_id: stock, quantity: 5 }], key: string | null = attempt, reason = "Kitchen top-up") {
    return (await db.query<{ value: Record<string, any> }>("SELECT neo_stores_transfer_create($1,$2,$3,$4::jsonb,$5,$6) value", [branch,from,to,JSON.stringify(lines),reason,key])).rows[0]!.value;
  }
  async function act(name: "receive" | "cancel", transfer: string) {
    return (await db.query<{ value: Record<string, any> }>(`SELECT neo_stores_transfer_${name}($1${name === "cancel" ? ",$2" : ""}) value`, name === "cancel" ? [transfer,"Returned before arrival"] : [transfer])).rows[0]!.value;
  }
  async function balances() { return (await db.query("SELECT location_id,quantity_on_hand::float8 quantity FROM stock_levels ORDER BY location_id")).rows; }
  it("dispatches from main store, receives in mini-store and replays both without double movement", async () => {
    const first = await create();
    expect(first).toMatchObject({ ok: true, status: "in-transit", lines: 1 });
    expect(await balances()).toEqual([{ location_id: from, quantity: 15 },{ location_id: to, quantity: 0 }]);
    expect(await create()).toMatchObject({ transfer_id: first["transfer_id"], replayed: true });
    expect(await act("receive", first["transfer_id"])).toMatchObject({ transfer_id: first["transfer_id"], status: "completed" });
    expect(await act("receive", first["transfer_id"])).toMatchObject({ replayed: true, status: "completed" });
    expect(await balances()).toEqual([{ location_id: from, quantity: 15 },{ location_id: to, quantity: 5 }]);
    expect((await db.query("SELECT count(*)::int n FROM movement_evidence")).rows[0]).toEqual({ n: 2 });
  });
  it("cancels only in transit, returning stock once to source and preserving history", async () => {
    const first = await create();
    expect(await act("cancel", first["transfer_id"])).toMatchObject({ transfer_id: first["transfer_id"], status: "cancelled" });
    expect(await act("cancel", first["transfer_id"])).toMatchObject({ replayed: true });
    expect(await balances()).toEqual([{ location_id: from, quantity: 20 },{ location_id: to, quantity: 0 }]);
    await expect(act("receive", first["transfer_id"])).rejects.toThrow(/cancelled/);
    expect(await create()).toMatchObject({ replayed: true, status: "cancelled" });
  });
  it.each(["receive", "cancel"] as const)("refuses %s outside the authorized property before replay or stock effects", async (action) => {
    const first = await create();
    await db.exec(`UPDATE stock_transfers SET branch_id='${id(20)}'`);
    await expect(act(action, first["transfer_id"])).rejects.toThrow(/outside your property scope/);
    expect((await db.query("SELECT count(*)::int n FROM movement_evidence")).rows[0]).toEqual({ n: 1 });
  });
  it.each(["receive", "cancel"] as const)("refuses %s for a draft transfer without moving stock", async (action) => {
    const first = await create();
    await db.exec("UPDATE stock_transfers SET status='draft'");
    await expect(act(action, first["transfer_id"])).rejects.toThrow(/Only an in-transit transfer/);
  });
  it("refuses attempt-key reuse for changed quantities, reason or property", async () => {
    await create();
    await expect(create([{ stock_item_id: stock, quantity: 6 }])).rejects.toThrow(/different work/);
    await expect(create(undefined,attempt,"Different purpose")).rejects.toThrow(/different work/);
    await db.exec(`UPDATE stock_transfers SET branch_id='${id(20)}'`);
    await expect(create()).rejects.toThrow(/different work/);
    expect((await db.query("SELECT count(*)::int n FROM movement_evidence")).rows[0]).toEqual({ n: 1 });
  });
  it("normalizes omitted units for a retry and preserves completed replay status", async () => {
    const first = await create();
    await act("receive", first["transfer_id"]);
    expect(await create()).toMatchObject({ transfer_id: first["transfer_id"], replayed: true, status: "completed" });
    await expect(act("cancel", first["transfer_id"])).rejects.toThrow(/already been received/);
  });
  it("refuses inactive stores/items, missing attempt, missing reason and non-finite quantities", async () => {
    await expect(create(undefined,null)).rejects.toThrow(/attempt key/);
    await expect(create(undefined,attempt," ")).rejects.toThrow(/reason/);
    for (const quantity of ["NaN","Infinity","-Infinity",0,-1]) {
      await expect(create([{ stock_item_id: stock, quantity: quantity as any }])).rejects.toThrow(/quantity/);
    }
    await db.exec(`UPDATE stock_locations SET active=false WHERE id='${to}'`);
    await expect(create()).rejects.toThrow(/destination store/);
    await db.exec("UPDATE stock_locations SET active=true; UPDATE stock_items SET active=false");
    await expect(create()).rejects.toThrow(/catalogue/);
    expect((await db.query("SELECT count(*)::int n FROM stock_transfers")).rows[0]).toEqual({ n: 0 });
  });
  it("rolls back the whole transfer if a later duplicate line exceeds source stock", async () => {
    await expect(create([{ stock_item_id: stock, quantity: 15 },{ stock_item_id: stock, quantity: 15 }])).rejects.toThrow(/source store holds only/);
    expect(await balances()).toEqual([{ location_id: from, quantity: 20 },{ location_id: to, quantity: 0 }]);
    expect((await db.query("SELECT count(*)::int n FROM movement_evidence")).rows[0]).toEqual({ n: 0 });
  });
  it("requires authenticated transfer authority", async () => {
    await db.exec("SELECT set_config('test.actor','',false)");
    await expect(create()).rejects.toThrow(/organisation context/);
    await db.exec(`SELECT set_config('test.actor','${actor}',false),set_config('test.allowed','false',false)`);
    await expect(create()).rejects.toThrow(/Not permitted/);
  });
  it("reapplies without changing grants or posting stock", async () => {
    await create(); await db.exec(migration);
    expect((await db.query("SELECT has_function_privilege('authenticated','neo_stores_transfer_receive(uuid)','EXECUTE') allowed")).rows[0]).toEqual({ allowed: true });
    expect((await db.query("SELECT count(*)::int n FROM movement_evidence")).rows[0]).toEqual({ n: 1 });
  });
  it("refuses source drift before replacing any transfer routine", async () => {
    const original = (await db.query<{ body: string }>("SELECT pg_get_functiondef('neo_stores_transfer_receive(uuid)'::regprocedure) body")).rows[0]!.body;
    await db.exec(original.replace("v_count integer := 0", "v_count integer := 10"));
    await expect(db.exec(migration)).rejects.toThrow(/differs from reviewed source/);
    await db.exec("ROLLBACK");
    expect((await db.query<{ body: string }>("SELECT pg_get_functiondef('neo_stores_transfer_receive(uuid)'::regprocedure) body")).rows[0]!.body).toContain("v_count integer := 10");
    await db.exec(original);
  });
});
