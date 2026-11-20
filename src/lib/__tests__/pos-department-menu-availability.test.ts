import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const id = (value: number) => `00000000-0000-4000-8000-${String(value).padStart(12, "0")}`;
const [org, branch, bar, department, main, bottle, ingredient, direct, dish, service, recipe] =
  Array.from({ length: 11 }, (_, index) => id(index + 1));
const order = id(13), bottleLine = id(14), batchLine = id(15), localBatch = id(16), mainBatch = id(17);

describe("departmental POS menu stock", () => {
  let db: PGlite;

  beforeAll(async () => {
    db = new PGlite();
    await db.exec(`
      CREATE SCHEMA auth; CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
      CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql AS $$ SELECT '${id(12)}'::uuid $$;
      CREATE FUNCTION current_org_id() RETURNS uuid LANGUAGE sql AS $$ SELECT '${org}'::uuid $$;
      CREATE FUNCTION neo_branch_in_scope(uuid) RETURNS boolean LANGUAGE sql AS $$ SELECT $1='${branch}'::uuid $$;
      CREATE FUNCTION has_permission(text,text) RETURNS boolean LANGUAGE sql AS $$ SELECT true $$;
      CREATE FUNCTION has_permission(text,text,text) RETURNS boolean LANGUAGE sql AS $$ SELECT true $$;
      CREATE FUNCTION is_org_admin() RETURNS boolean LANGUAGE sql AS $$ SELECT false $$;
      CREATE FUNCTION neo_inventory_allows_negative(uuid,uuid) RETURNS boolean LANGUAGE sql AS $$ SELECT false $$;
      CREATE FUNCTION inventory_round_for_item(numeric,text,uuid) RETURNS numeric LANGUAGE sql AS $$ SELECT $1 $$;
      CREATE FUNCTION inventory_convert_strict(numeric,text,text) RETURNS numeric LANGUAGE sql AS $$ SELECT $1 $$;
      CREATE FUNCTION recipe_expand_to_stock_kinds(uuid,numeric,uuid)
       RETURNS TABLE(stock_item_id uuid,unit text,quantity numeric,kind text) LANGUAGE sql AS $$
        SELECT '${ingredient}'::uuid,'kg',0.25*$2,'use' $$;
      CREATE TABLE branches(id uuid,organization_id uuid);
      CREATE TABLE operational_stations(id uuid,organization_id uuid,branch_id uuid,active boolean,name text DEFAULT 'Bar');
      CREATE TABLE stock_locations(id uuid,organization_id uuid,branch_id uuid,name text,active boolean,is_main boolean);
      CREATE TABLE station_consumption_stores(organization_id uuid,branch_id uuid,station_id uuid,location_id uuid);
      CREATE TABLE menu_items(id uuid,organization_id uuid,branch_id uuid,publish_status text,consumption_channels text[],
       consumption_mode text,station_id uuid,stock_item_id uuid,stock_quantity_per_sale numeric,stock_unit text,name text DEFAULT 'Menu item');
      CREATE TABLE recipes(id uuid,organization_id uuid,branch_id uuid,menu_item_id uuid,status text,recipe_type text,
       station_id uuid,version integer,yield_quantity numeric,yield_unit text);
      CREATE TABLE production_batches(organization_id uuid,branch_id uuid,recipe_id uuid,remaining_quantity numeric,
       unit text,status text,posted_at timestamptz,use_by timestamptz,id uuid PRIMARY KEY,
       station_id uuid,output_location_id uuid,consumed_quantity numeric DEFAULT 0,updated_at timestamptz,
       prepared_at timestamptz,created_at timestamptz DEFAULT now(),batch_number text,posted_by uuid,
       posted_cost numeric,actual_quantity numeric,waste_quantity numeric);
      CREATE TABLE stock_items(id uuid,organization_id uuid,branch_id uuid,name text,base_unit text,
       tracking_method text,container_volume_ml numeric,average_cost numeric DEFAULT 1);
      CREATE TABLE stock_levels(organization_id uuid,stock_item_id uuid,location_id uuid,quantity_on_hand numeric);
      CREATE TABLE stock_open_containers(organization_id uuid,stock_item_id uuid,location_id uuid,open_volume_ml numeric);
      CREATE TABLE pos_orders(id uuid,organization_id uuid,branch_id uuid,status text,order_type text,order_number text);
      CREATE TABLE pos_order_items(id uuid,organization_id uuid,order_id uuid,menu_item_id uuid,station_id uuid,status text,quantity numeric);
      CREATE TABLE inventory_posting_events(organization_id uuid,branch_id uuid,order_id uuid,order_item_id uuid,
        recipe_id uuid,recipe_version integer,posting_type text,idempotency_key text UNIQUE,status text,cost_snapshot numeric,payload jsonb);
      CREATE TABLE station_ticket_items(order_item_id uuid,ticket_id uuid);
      CREATE TABLE station_tickets(id uuid,ticket_number text,created_at timestamptz);
      CREATE TABLE profiles(id uuid,full_name text,email text);
      CREATE TABLE audit_logs(organization_id uuid,branch_id uuid,user_id uuid,action text,module text,record_id text,new_value jsonb);
      CREATE FUNCTION inventory_apply_movement(uuid,uuid,numeric,text,text,numeric,text,uuid,text,text,text,date)
      RETURNS uuid LANGUAGE plpgsql AS $$ BEGIN
        UPDATE stock_levels SET quantity_on_hand=quantity_on_hand+$3 WHERE stock_item_id=$1 AND location_id=$2 AND quantity_on_hand+$3>=0;
        IF NOT FOUND THEN RAISE EXCEPTION 'Insufficient department stock'; END IF;
        RETURN $1;
      END $$;
      CREATE FUNCTION neo_evaluate_low_stock(uuid,uuid,uuid,text,uuid) RETURNS void LANGUAGE plpgsql AS $$ BEGIN END $$;
      INSERT INTO branches VALUES('${branch}','${org}');
      INSERT INTO operational_stations VALUES('${bar}','${org}','${branch}',true);
      INSERT INTO stock_locations VALUES
       ('${department}','${org}','${branch}','Department Store',true,false),('${main}','${org}','${branch}','Main Store',true,true);
      INSERT INTO station_consumption_stores VALUES('${org}','${branch}','${bar}','${department}');
      INSERT INTO stock_items VALUES
       ('${bottle}','${org}','${branch}','Bottle','unit','both',330),('${ingredient}','${org}','${branch}','Flour','kg','whole',NULL);
      INSERT INTO stock_levels VALUES ('${org}','${bottle}','${main}',100),('${org}','${ingredient}','${main}',100);
      INSERT INTO menu_items VALUES
       ('${direct}','${org}','${branch}','published',NULL,'direct_stock','${bar}','${bottle}',1,'unit'),
       ('${dish}','${org}','${branch}','published',NULL,'recipe','${bar}',NULL,NULL,NULL),
       ('${service}','${org}','${branch}','published',NULL,'none',NULL,NULL,NULL,NULL);
      INSERT INTO recipes VALUES ('${recipe}','${org}','${branch}','${dish}','active','menu_item','${bar}',1,1,'portion');
    `);
    const routing = readFileSync("supabase/migrations/20261105180000_workspace_station_store_integrity.sql", "utf8");
    await db.exec(routing.match(/CREATE OR REPLACE FUNCTION public\.neo_station_consumption_location[\s\S]*?\$function\$;/)![0]);
    await db.exec(readFileSync("supabase/migrations/20261119172000_pos_department_menu_availability.sql", "utf8"));
    const production = readFileSync("supabase/migrations/20261005123000_batch_operational_consumption.sql", "utf8");
    for (const name of ["neo_production_batch_post", "neo_consume_prepared_batch"]) {
      await db.exec(production.match(new RegExp(`CREATE OR REPLACE FUNCTION public\\.${name}[\\s\\S]*?\\n\\$\\$;`))![0]);
    }
    const sale = readFileSync("supabase/migrations/20261114013000_shared_workspace_workflows.sql", "utf8");
    await db.exec(sale.match(/CREATE OR REPLACE FUNCTION public\.inventory_consume_order_item_core[\s\S]*?\$function\$;/)![0]);
    await db.exec(readFileSync("supabase/migrations/20261120170000_department_batch_inventory_alignment.sql", "utf8"));
  }, 15000);

  afterAll(async () => db?.close());

  async function unavailable() {
    return (await db.query<{ menu_item_id: string; reason: string }>(
      "SELECT * FROM neo_pos_department_menu_availability($1,'dine-in') ORDER BY menu_item_id", [branch],
    )).rows;
  }

  it("flags zero departmental stock despite Main Store stock and leaves services available", async () => {
    expect(await unavailable()).toEqual([
      { menu_item_id: direct, available: false, reason: expect.stringContaining("Bottle in Department Store") },
      { menu_item_id: dish, available: false, reason: expect.stringContaining("Flour in Department Store") },
    ]);
  });

  it("clears shortages when the department is stocked and flags a route to Main Store", async () => {
    await db.exec(`BEGIN;
      INSERT INTO stock_levels VALUES ('${org}','${bottle}','${department}',2),('${org}','${ingredient}','${department}',1);`);
    try {
      expect(await unavailable()).toEqual([]);
      await db.exec(`UPDATE station_consumption_stores SET location_id='${main}'`);
      expect((await unavailable()).map((item) => item.reason)).toEqual([
        "No active departmental store is mapped to the production station",
        "No active departmental store is mapped to the production station",
      ]);
    } finally {
      await db.exec("ROLLBACK");
    }
  });

  it.each(["dine-in", "takeaway", "delivery", "room-service"])("deducts sealed bottles exactly once at service for %s", async (channel) => {
    await db.exec(`BEGIN; INSERT INTO stock_levels VALUES ('${org}','${bottle}','${department}',5);
      INSERT INTO pos_orders VALUES ('${order}','${org}','${branch}','sent','${channel}','Bottle order');
      INSERT INTO pos_order_items VALUES ('${bottleLine}','${org}','${order}','${direct}','${bar}','served',2);`);
    try {
      await db.query("SELECT inventory_consume_order_item_core($1)", [bottleLine]);
      await db.query("SELECT inventory_consume_order_item_core($1)", [bottleLine]);
      expect((await db.query("SELECT location_id,quantity_on_hand::float8 AS quantity FROM stock_levels WHERE stock_item_id=$1 ORDER BY location_id", [bottle])).rows)
        .toEqual([{ location_id: department, quantity: 3 }, { location_id: main, quantity: 100 }]);
    } finally { await db.exec("ROLLBACK"); }
  });

  it("records preparation without ingredient movement, then uses only the batch and ingredients in the station store", async () => {
    await db.exec(`BEGIN; INSERT INTO stock_levels VALUES ('${org}','${ingredient}','${department}',5);
      UPDATE menu_items SET consumption_mode='batch',stock_quantity_per_sale=2,stock_unit='portion' WHERE id='${dish}';
      UPDATE recipes SET yield_quantity=10 WHERE id='${recipe}';
      INSERT INTO production_batches(id,organization_id,branch_id,recipe_id,station_id,output_location_id,
        actual_quantity,remaining_quantity,unit,status,posted_at)
      VALUES ('${localBatch}','${org}','${branch}','${recipe}','${bar}',NULL,5,0,'portion','in-preparation',NULL),
        ('${mainBatch}','${org}','${branch}','${recipe}','${bar}','${main}',10,10,'portion','completed',now());
      INSERT INTO pos_orders VALUES ('${order}','${org}','${branch}','sent','delivery','Batch order');
      INSERT INTO pos_order_items VALUES ('${batchLine}','${org}','${order}','${dish}','${bar}','served',1);`);
    try {
      expect((await unavailable()).find((entry) => entry.menu_item_id === dish)?.reason).toMatch(/prepared batch/);
      const rejected = await db.query<{ result: object }>("SELECT neo_production_batch_post($1,$2) result", [localBatch, main]);
      expect(rejected.rows[0]?.result).toMatchObject({ ok: false, reason: "department_store_required" });
      await db.query("SELECT neo_production_batch_post($1, null)", [localBatch]);
      const balance = () => db.query("SELECT quantity_on_hand::float8 AS quantity FROM stock_levels WHERE stock_item_id=$1 AND location_id=$2", [ingredient, department]);
      expect((await balance()).rows).toEqual([{ quantity: 5 }]);
      await db.query("SELECT inventory_consume_order_item_core($1)", [batchLine]);
      await db.query("SELECT inventory_consume_order_item_core($1)", [batchLine]);
      expect((await balance()).rows).toEqual([{ quantity: 4.95 }]);
      expect((await db.query("SELECT id,remaining_quantity::float8 AS quantity FROM production_batches ORDER BY id")).rows)
        .toEqual([{ id: localBatch, quantity: 3 }, { id: mainBatch, quantity: 10 }]);
    } finally { await db.exec("ROLLBACK"); }
  });

  it("uses the sale property’s recipe even when an active version exists at another property", async () => {
    await db.exec(`BEGIN; INSERT INTO stock_levels VALUES ('${org}','${ingredient}','${department}',5);
      INSERT INTO recipes VALUES ('${id(19)}','${org}','${id(20)}','${dish}','active','menu_item','${bar}',99,50,'portion');
      INSERT INTO pos_orders VALUES ('${order}','${org}','${branch}','sent','room-service','Dish order');
      INSERT INTO pos_order_items VALUES ('${batchLine}','${org}','${order}','${dish}','${bar}','served',1);`);
    try {
      await db.query("SELECT inventory_consume_order_item_core($1)", [batchLine]);
      expect((await db.query("SELECT recipe_id FROM inventory_posting_events WHERE order_item_id=$1", [batchLine])).rows)
        .toEqual([{ recipe_id: recipe }]);
      expect((await db.query("SELECT location_id,quantity_on_hand::float8 AS quantity FROM stock_levels WHERE stock_item_id=$1 ORDER BY location_id", [ingredient])).rows)
        .toEqual([{ location_id: department, quantity: 4.75 }, { location_id: main, quantity: 100 }]);
    } finally { await db.exec("ROLLBACK"); }
  });
});
