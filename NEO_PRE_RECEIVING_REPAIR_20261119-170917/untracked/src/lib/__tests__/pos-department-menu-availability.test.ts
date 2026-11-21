import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const id = (value: number) => `00000000-0000-4000-8000-${String(value).padStart(12, "0")}`;
const [org, branch, bar, department, main, bottle, ingredient, direct, dish, service, recipe] =
  Array.from({ length: 11 }, (_, index) => id(index + 1));

describe("departmental POS menu stock", () => {
  let db: PGlite;

  beforeAll(async () => {
    db = new PGlite();
    await db.exec(`
      CREATE SCHEMA auth; CREATE ROLE anon; CREATE ROLE authenticated;
      CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql AS $$ SELECT '${id(12)}'::uuid $$;
      CREATE FUNCTION current_org_id() RETURNS uuid LANGUAGE sql AS $$ SELECT '${org}'::uuid $$;
      CREATE FUNCTION neo_branch_in_scope(uuid) RETURNS boolean LANGUAGE sql AS $$ SELECT $1='${branch}'::uuid $$;
      CREATE FUNCTION has_permission(text,text) RETURNS boolean LANGUAGE sql AS $$ SELECT true $$;
      CREATE FUNCTION is_org_admin() RETURNS boolean LANGUAGE sql AS $$ SELECT false $$;
      CREATE FUNCTION neo_inventory_allows_negative(uuid,uuid) RETURNS boolean LANGUAGE sql AS $$ SELECT false $$;
      CREATE FUNCTION inventory_round_for_item(numeric,text,uuid) RETURNS numeric LANGUAGE sql AS $$ SELECT $1 $$;
      CREATE FUNCTION inventory_convert_strict(numeric,text,text) RETURNS numeric LANGUAGE sql AS $$ SELECT $1 $$;
      CREATE FUNCTION recipe_expand_to_stock_kinds(uuid,numeric,uuid)
       RETURNS TABLE(stock_item_id uuid,unit text,quantity numeric) LANGUAGE sql AS $$
        SELECT '${ingredient}'::uuid,'kg',0.25*$2 $$;
      CREATE TABLE branches(id uuid,organization_id uuid);
      CREATE TABLE operational_stations(id uuid,organization_id uuid,branch_id uuid,active boolean);
      CREATE TABLE stock_locations(id uuid,organization_id uuid,branch_id uuid,name text,active boolean,is_main boolean);
      CREATE TABLE station_consumption_stores(organization_id uuid,branch_id uuid,station_id uuid,location_id uuid);
      CREATE TABLE menu_items(id uuid,organization_id uuid,branch_id uuid,publish_status text,consumption_channels text[],
       consumption_mode text,station_id uuid,stock_item_id uuid,stock_quantity_per_sale numeric,stock_unit text);
      CREATE TABLE recipes(id uuid,organization_id uuid,branch_id uuid,menu_item_id uuid,status text,recipe_type text,
       station_id uuid,version integer,yield_quantity numeric,yield_unit text);
      CREATE TABLE production_batches(organization_id uuid,branch_id uuid,recipe_id uuid,remaining_quantity numeric,
       unit text,status text,posted_at timestamptz,use_by timestamptz);
      CREATE TABLE stock_items(id uuid,organization_id uuid,branch_id uuid,name text,base_unit text,
       tracking_method text,container_volume_ml numeric);
      CREATE TABLE stock_levels(organization_id uuid,stock_item_id uuid,location_id uuid,quantity_on_hand numeric);
      CREATE TABLE stock_open_containers(organization_id uuid,stock_item_id uuid,location_id uuid,open_volume_ml numeric);
      INSERT INTO branches VALUES('${branch}','${org}');
      INSERT INTO operational_stations VALUES('${bar}','${org}','${branch}',true);
      INSERT INTO stock_locations VALUES
       ('${department}','${org}','${branch}','Department Store',true,false),('${main}','${org}','${branch}','Main Store',true,true);
      INSERT INTO station_consumption_stores VALUES('${org}','${branch}','${bar}','${department}');
      INSERT INTO stock_items VALUES
       ('${bottle}','${org}','${branch}','Bottle','unit','whole',NULL),('${ingredient}','${org}','${branch}','Flour','kg','whole',NULL);
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
});
