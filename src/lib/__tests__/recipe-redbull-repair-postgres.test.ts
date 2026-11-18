import {PGlite} from "@electric-sql/pglite";
import {readFileSync} from "node:fs";
import {afterAll,beforeAll,beforeEach,describe,expect,it} from "vitest";
const sql=readFileSync("supabase/repair/2026-11-18/REPAIR-CERT-RED-BULL-MENU.sql","utf8");
const org="aa17d427-f816-49bc-b02e-1a89e44806a2",branch="2addbd01-c643-406a-bd7d-fac1aa76b23c",
  recipe="2198d48b-4216-46a8-b037-0ca7c61dd2fb",menu="7670b1bc-846e-439b-b13d-af776ddfdb78",
  stock="249614b3-2e10-431f-bf9f-34f8b6a8e4a5",water="65b8f428-107c-5129-950d-6438a903f3a3";
describe("confirmed CERT Red Bull menu repair",()=>{
  let db:PGlite;
  beforeAll(async()=>{
    db=new PGlite();
    await db.exec(`CREATE SCHEMA auth; CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql AS $$ SELECT NULL::uuid $$;
      CREATE TABLE recipes(id uuid PRIMARY KEY,organization_id uuid,branch_id uuid,status text,recipe_type text,menu_item_id uuid,output_stock_item_id uuid,yield_quantity numeric,yield_unit text);
      CREATE TABLE menu_items(id uuid PRIMARY KEY,organization_id uuid,branch_id uuid,consumption_mode text,stock_item_id uuid,stock_quantity_per_sale numeric,stock_unit text);
      CREATE TABLE stock_items(id uuid PRIMARY KEY,organization_id uuid,branch_id uuid,sku text,base_unit text);
      CREATE TABLE audit_logs(organization_id uuid,branch_id uuid,user_id uuid,user_name text,action text,module text,record_id text,previous_value jsonb,new_value jsonb,reason text);
      CREATE FUNCTION audit_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF current_setting('test.audit_failure',true)='yes' THEN RAISE EXCEPTION 'Audit unavailable'; END IF; RETURN NEW; END $$;
      CREATE TRIGGER test_audit BEFORE INSERT ON audit_logs FOR EACH ROW EXECUTE FUNCTION audit_fail();`);
  },30000);
  afterAll(async()=>{await db?.close();});
  beforeEach(async()=>{
    await db.exec(`TRUNCATE recipes,menu_items,stock_items,audit_logs;
      SELECT set_config('test.audit_failure','no',false);
      INSERT INTO recipes VALUES('${recipe}','${org}','${branch}','active','direct_sale','${menu}','${stock}',1,'pc');
      INSERT INTO menu_items VALUES('${menu}','${org}','${branch}','direct_stock','${water}',1,'pc');
      INSERT INTO stock_items VALUES('${stock}','${org}','${branch}','CERT-SCN-REDBULL-250','pc');`);
  });
  async function repair(){try{await db.exec(sql);}catch(error){await db.exec("ROLLBACK");throw error;}}
  const mapping=async()=>(await db.query("SELECT stock_item_id FROM menu_items")).rows[0];
  it("corrects the water link and retains recipe history plus truthful before/after audit",async()=>{
    const original=(await db.query("SELECT to_jsonb(r) value FROM recipes r")).rows;
    await repair();
    expect(await mapping()).toEqual({stock_item_id:stock});
    expect((await db.query("SELECT to_jsonb(r) value FROM recipes r")).rows).toEqual(original);
    const audit=(await db.query<{previous_value:any;new_value:any;user_id:string|null}>("SELECT previous_value,new_value,user_id FROM audit_logs")).rows[0]!;
    expect(audit.previous_value.stock_item_id).toBe(water);
    expect(audit.new_value.stock_item_id).toBe(stock);
    expect(audit.user_id).toBeNull();
  });
  it("replays without another audit or business update",async()=>{
    await repair();await repair();
    expect((await db.query("SELECT count(*)::int n FROM audit_logs")).rows[0]).toEqual({n:1});
  });
  it("refuses changed ownership and preserves the existing link",async()=>{
    await db.query("UPDATE stock_items SET organization_id=$1",[branch]);
    await expect(repair()).rejects.toThrow("ownership/unit changed");
    expect(await mapping()).toEqual({stock_item_id:water});
  });
  it("refuses an unexpected menu mapping rather than overwriting newer work",async()=>{
    await db.exec("UPDATE menu_items SET stock_item_id=NULL");
    await expect(repair()).rejects.toThrow("no longer has the inspected water mapping");
    expect(await mapping()).toEqual({stock_item_id:null});
  });
  it("rolls back the stock link if its audit record cannot be written",async()=>{
    await db.exec("SELECT set_config('test.audit_failure','yes',false)");
    await expect(repair()).rejects.toThrow("Audit unavailable");
    expect(await mapping()).toEqual({stock_item_id:water});
  });
});
