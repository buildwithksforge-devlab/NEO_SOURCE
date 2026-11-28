import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const [org, branch, other, folio, store, bar, menu, stock] = [1, 2, 3, 4, 5, 6, 7, 8].map(id) as [
  string,
  string,
  string,
  string,
  string,
  string,
  string,
  string,
];
const migration = readFileSync(
  "supabase/migrations/20261116221500_minibar_property_store_guards.sql",
  "utf8",
);
const baseline = readFileSync(
  "supabase/migrations/20260924153000_front_office_connected_guards.sql",
  "utf8",
).match(/CREATE OR REPLACE FUNCTION public\.neo_minibar_post\([\s\S]*?\$function\$;/)![0];
describe("minibar property/store boundary using actual posting routine", () => {
  let db: PGlite;
  beforeAll(async () => {
    db = new PGlite();
    await db.exec(`
      CREATE SCHEMA auth; CREATE ROLE authenticated;
      CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql AS $$ SELECT '${id(10)}'::uuid $$;
      CREATE FUNCTION current_org_id() RETURNS uuid LANGUAGE sql AS $$ SELECT '${org}'::uuid $$;
      CREATE FUNCTION has_permission(text,text,text) RETURNS boolean LANGUAGE sql AS $$ SELECT true $$;
      CREATE FUNCTION neo_branch_in_scope(uuid) RETURNS boolean LANGUAGE sql AS $$ SELECT $1='${branch}'::uuid $$;
      CREATE TABLE folios(id uuid,organization_id uuid,branch_id uuid,status text,currency text,folio_number text);
      CREATE TABLE stock_locations(id uuid,organization_id uuid,branch_id uuid,active boolean,name text);
      CREATE TABLE menu_items(id uuid,organization_id uuid,branch_id uuid,name text,base_price numeric,consumption_mode text,consumption_channels text[],stock_item_id uuid,stock_quantity_per_sale numeric,stock_unit text,issuing_location_id uuid);
      CREATE TABLE recipes(id uuid,organization_id uuid,menu_item_id uuid,recipe_type text,status text,version int,output_stock_item_id uuid,yield_unit text,yield_quantity numeric);
      CREATE TABLE stock_items(id uuid,organization_id uuid,name text,base_unit text,tracking_method text,container_volume_ml numeric,average_cost numeric);
      CREATE TABLE profiles(id uuid,full_name text,email text);
      CREATE TABLE minibar_postings(id uuid,organization_id uuid,branch_id uuid,posting_number text,folio_id uuid,room_id uuid,location_id uuid,currency text,notes text,posted_by uuid,total_amount numeric,updated_at timestamptz);
      CREATE TABLE minibar_posting_lines(organization_id uuid,posting_id uuid,menu_item_id uuid,stock_item_id uuid,description text,quantity numeric,unit text,unit_price numeric,amount numeric,folio_line_id uuid);
      CREATE TABLE audit_logs(organization_id uuid,branch_id uuid,user_id uuid,action text,module text,record_id text,new_value jsonb);
      CREATE TABLE test_movements(item uuid,location uuid,quantity numeric);
      CREATE TABLE test_charges(folio uuid,quantity numeric,price numeric);
      CREATE FUNCTION inventory_round_for_item(numeric,text,uuid) RETURNS numeric LANGUAGE sql AS $$ SELECT $1 $$;
      CREATE FUNCTION neo_item_group_store(uuid,uuid,uuid) RETURNS uuid LANGUAGE sql AS $$ SELECT '${bar}'::uuid $$;
      CREATE FUNCTION recipe_expand_to_stock_kinds(uuid,numeric,uuid) RETURNS TABLE(stock_item_id uuid,kind text,quantity numeric,unit text) LANGUAGE sql AS $$ SELECT NULL::uuid,NULL::text,NULL::numeric,NULL::text WHERE false $$;
      CREATE FUNCTION inventory_apply_movement(uuid,uuid,numeric,text,text,numeric,text,uuid,text,text,text,date) RETURNS uuid LANGUAGE plpgsql AS $$ BEGIN INSERT INTO test_movements VALUES($1,$2,$3); RETURN gen_random_uuid(); END $$;
      CREATE FUNCTION inventory_consume_volume(uuid,uuid,numeric,text,text,text,uuid,text) RETURNS uuid LANGUAGE plpgsql AS $$ BEGIN INSERT INTO test_movements VALUES($1,$2,-$3); RETURN gen_random_uuid(); END $$;
      CREATE FUNCTION neo_evaluate_low_stock(uuid,uuid,uuid,text,uuid) RETURNS void LANGUAGE plpgsql AS $$ BEGIN END $$;
      CREATE FUNCTION folio_post_charge(uuid,text,text,numeric,numeric,numeric,numeric,numeric,text,uuid,text,text,uuid) RETURNS uuid LANGUAGE plpgsql AS $$ BEGIN INSERT INTO test_charges VALUES($1,$4,$5); RETURN gen_random_uuid(); END $$;
    `);
    await db.exec(baseline);
    await db.exec(
      `GRANT EXECUTE ON FUNCTION neo_minibar_post(uuid,uuid,jsonb,uuid,text) TO authenticated;`,
    );
    await db.exec(migration);
  }, 30_000);
  afterAll(async () => {
    await db?.close();
  });
  beforeEach(async () => {
    await db.exec(`TRUNCATE folios,stock_locations,menu_items,recipes,stock_items,profiles,minibar_postings,minibar_posting_lines,audit_logs,test_movements,test_charges;
      INSERT INTO folios VALUES('${folio}','${org}','${branch}','open','KES','FOL-1');
      INSERT INTO stock_locations VALUES('${store}','${org}','${branch}',true,'Minibar'),('${bar}','${org}','${branch}',true,'Main Bar');
      INSERT INTO menu_items VALUES('${menu}','${org}','${branch}','Water',100,'direct_stock',ARRAY['minibar'],'${stock}',1,'unit','${bar}');
      INSERT INTO stock_items VALUES('${stock}','${org}','Water','unit','whole',NULL,40);`);
  });
  async function post(quantity = "2", price = "100") {
    const rows = await db.query<{ result: { ok: boolean; reason?: string } }>(
      `SELECT neo_minibar_post('${folio}','${store}',jsonb_build_array(jsonb_build_object('menu_item_id','${menu}','quantity','${quantity}','unit_price','${price}'))) result`,
    );
    return rows.rows[0]!.result;
  }
  async function noWrites() {
    const result = await db.query<{ count: number }>(
      `SELECT (SELECT count(*) FROM test_movements)+(SELECT count(*) FROM test_charges)+(SELECT count(*) FROM minibar_postings) AS count`,
    );
    expect(Number(result.rows[0]!.count)).toBe(0);
  }
  it("deducts only the selected store despite a Bar menu default and group fallback", async () => {
    expect((await post()).ok).toBe(true);
    expect((await db.query(`SELECT location,quantity FROM test_movements`)).rows).toEqual([
      { location: store, quantity: "-2" },
    ]);
    expect((await db.query(`SELECT quantity,price FROM test_charges`)).rows).toEqual([
      { quantity: "2", price: "100" },
    ]);
  });
  it("refuses another property's store before any writes", async () => {
    await db.exec(`UPDATE stock_locations SET branch_id='${other}' WHERE id='${store}'`);
    expect(await post()).toMatchObject({ ok: false, reason: "location_not_found" });
    await noWrites();
  });
  it("refuses an inactive store", async () => {
    await db.exec(`UPDATE stock_locations SET active=false WHERE id='${store}'`);
    expect((await post()).ok).toBe(false);
    await noWrites();
  });
  it("refuses a folio outside operator property scope", async () => {
    await db.exec(`UPDATE folios SET branch_id='${other}'`);
    expect(await post()).toMatchObject({ ok: false, reason: "forbidden" });
    await noWrites();
  });
  it.each(["NaN", "Infinity", "-Infinity", "0", "-1"])(
    "rejects invalid quantity %s atomically",
    async (value) => {
      await expect(post(value)).rejects.toThrow();
      await noWrites();
    },
  );
  it.each(["NaN", "Infinity", "-Infinity", "-1", "99"])(
    "rejects invalid or changed price %s atomically",
    async (value) => {
      await expect(post("1", value)).rejects.toThrow();
      await noWrites();
    },
  );
  it("rejects another property's menu item", async () => {
    await db.exec(`UPDATE menu_items SET branch_id='${other}'`);
    await expect(post()).rejects.toThrow(/property and channel/);
    await noWrites();
  });
  it("rejects Bar-only channel items", async () => {
    await db.exec(`UPDATE menu_items SET consumption_channels=ARRAY['bar']`);
    await expect(post()).rejects.toThrow(/property and channel/);
    await noWrites();
  });
  it("rejects a malformed nonempty channel array containing only null", async () => {
    await db.exec("UPDATE menu_items SET consumption_channels=ARRAY[NULL]::text[]");
    await expect(post()).rejects.toThrow(/property and channel/);
    await noWrites();
  });
  it("does not charge a folio with missing open status", async () => {
    await db.exec("UPDATE folios SET status=NULL");
    expect(await post()).toMatchObject({ok:false,reason:"folio_not_open"});
    await noWrites();
  });
  it("reapplies without changing grants or posting any stock", async () => {
    await db.exec(migration);
    expect(
      (
        await db.query(
          `SELECT has_function_privilege('authenticated','neo_minibar_post(uuid,uuid,jsonb,uuid,text)','EXECUTE') allowed`,
        )
      ).rows[0],
    ).toEqual({ allowed: true });
    await noWrites();
  });
  it("refuses an unknown installed definition", async () => {
    await db.exec(
      `CREATE OR REPLACE FUNCTION neo_minibar_post(_folio uuid,_location uuid,_lines jsonb,_room uuid DEFAULT NULL,_notes text DEFAULT NULL) RETURNS jsonb LANGUAGE sql AS $$ SELECT '{}'::jsonb $$`,
    );
    await expect(db.exec(migration)).rejects.toThrow(/differs from reviewed source/);
    await db.exec("ROLLBACK");
  });
});
