import {PGlite} from "@electric-sql/pglite";
import {readFileSync} from "node:fs";
import {afterAll,beforeAll,beforeEach,describe,expect,it} from "vitest";
const sql=readFileSync("supabase/repair/2026-11-18/REPAIR-MAWIMBI-EXISTING-MENU-STOCK.sql","utf8");
const entries=JSON.parse(readFileSync("supabase/repair/2026-11-18/mawimbi-menu-stock-map.json","utf8")) as {
 recipe_id:string;menu_item_id:string;old_recipe_stock_id:string;old_menu_stock_id:string;old_unit:string;
 new_stock_id:string;new_name:string;new_unit:string}[];
const org="c10e5d20-dc04-4959-9db4-4c2afb9d2f8c",branch="c6169bc5-2123-4f2e-a660-c2aa81b83df2";
describe("reviewed existing Mawimbi menu stock batch",()=>{
 let db:PGlite;
 beforeAll(async()=>{
  db=new PGlite();
  await db.exec(`CREATE SCHEMA auth;CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql AS $$ SELECT NULL::uuid $$;
   CREATE TABLE recipes(id uuid PRIMARY KEY,organization_id uuid,branch_id uuid,status text,recipe_type text,menu_item_id uuid,output_stock_item_id uuid,yield_quantity numeric);
   CREATE TABLE menu_items(id uuid PRIMARY KEY,organization_id uuid,branch_id uuid,name text,consumption_mode text,stock_item_id uuid,stock_quantity_per_sale numeric,stock_unit text);
   CREATE TABLE stock_items(id uuid PRIMARY KEY,organization_id uuid,branch_id uuid,name text,base_unit text);
   CREATE TABLE audit_logs(organization_id uuid,branch_id uuid,user_id uuid,user_name text,action text,module text,record_id text,previous_value jsonb,new_value jsonb,reason text);
   CREATE FUNCTION audit_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF current_setting('test.audit_fail',true)='yes' THEN RAISE EXCEPTION 'Audit unavailable'; END IF; RETURN NEW; END $$;
   CREATE TRIGGER test_audit BEFORE INSERT ON audit_logs FOR EACH ROW EXECUTE FUNCTION audit_fail();`);
 },30000);
 afterAll(async()=>{await db?.close();});
 beforeEach(async()=>{
  await db.exec("TRUNCATE recipes,menu_items,stock_items,audit_logs; SELECT set_config('test.audit_fail','no',false)");
  for(const entry of entries){
   await db.query("INSERT INTO recipes VALUES($1,$2,$3,'active','direct_sale',$4,$5,1)",[entry.recipe_id,org,branch,entry.menu_item_id,entry.old_recipe_stock_id]);
   await db.query("INSERT INTO menu_items VALUES($1,$2,$3,'Old label','direct_stock',$4,1,$5)",[entry.menu_item_id,org,branch,entry.old_menu_stock_id,entry.old_unit]);
   await db.query("INSERT INTO stock_items VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING",[entry.new_stock_id,org,branch,entry.new_name,entry.new_unit]);
  }
 });
 const snapshot=async(table:string)=>(await db.query(`SELECT jsonb_agg(to_jsonb(t) ORDER BY id) rows FROM ${table} t`)).rows[0];
 async function repair(){try{await db.exec(sql);}catch(error){await db.exec("ROLLBACK");throw error;}}
 it("updates the 21 existing menus to owned stock, actual labels and units with audit while retaining recipe/stock rows",async()=>{
  const recipes=await snapshot("recipes"),stock=await snapshot("stock_items");
  await repair();
  expect(await snapshot("recipes")).toEqual(recipes);expect(await snapshot("stock_items")).toEqual(stock);
  const menus=(await db.query<{id:string;name:string;stock_item_id:string;stock_unit:string}>("SELECT id,name,stock_item_id,stock_unit FROM menu_items ORDER BY id")).rows;
  expect(menus).toHaveLength(21);
  for(const entry of entries)expect(menus.find(m=>m.id===entry.menu_item_id)).toEqual({id:entry.menu_item_id,name:entry.new_name,stock_item_id:entry.new_stock_id,stock_unit:entry.new_unit});
  expect((await db.query("SELECT count(*)::int n FROM audit_logs")).rows[0]).toEqual({n:21});
 });
 it("replays without duplicate audits",async()=>{
  await repair();await repair();expect((await db.query("SELECT count(*)::int n FROM audit_logs")).rows[0]).toEqual({n:21});
 });
 it("rolls back earlier updates when the last menu has changed",async()=>{
  await db.query("UPDATE menu_items SET stock_item_id=NULL WHERE id=$1",[entries.at(-1)!.menu_item_id]);
  const before=await snapshot("menu_items");
  await expect(repair()).rejects.toThrow("mapping changed since inspection");
  expect(await snapshot("menu_items")).toEqual(before);
  expect((await db.query("SELECT count(*)::int n FROM audit_logs")).rows[0]).toEqual({n:0});
 });
 it("refuses a target stock item whose ownership changed",async()=>{
  await db.query("UPDATE stock_items SET organization_id=$1 WHERE id=$2",[branch,entries[0]!.new_stock_id]);
  const before=await snapshot("menu_items");await expect(repair()).rejects.toThrow("identity/owner/unit changed");
  expect(await snapshot("menu_items")).toEqual(before);
 });
 it("rolls back when the audit write fails",async()=>{
  await db.exec("SELECT set_config('test.audit_fail','yes',false)");const before=await snapshot("menu_items");
  await expect(repair()).rejects.toThrow("Audit unavailable");expect(await snapshot("menu_items")).toEqual(before);
 });
});
