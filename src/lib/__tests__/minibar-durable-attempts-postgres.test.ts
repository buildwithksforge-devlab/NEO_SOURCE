import {PGlite} from "@electric-sql/pglite";
import {readFileSync} from "node:fs";
import {afterAll,beforeAll,beforeEach,describe,expect,it} from "vitest";
const id=(n:number)=>`00000000-0000-4000-8000-${String(n).padStart(12,"0")}`;
const org=id(1),branch=id(2),other=id(3),folio=id(4),store=id(5),bar=id(6),menu=id(7),stock=id(8),stay=id(9),room=id(10),attempt=id(11);
const read=(path:string)=>readFileSync(path,"utf8");
const migration=read("supabase/migrations/20261118110000_minibar_durable_attempts.sql");
const baseline=read("supabase/migrations/20260924153000_front_office_connected_guards.sql").match(/CREATE OR REPLACE FUNCTION public\.neo_minibar_post\([\s\S]*?\$function\$;/)![0];
describe("actual minibar engine with durable request wrapper (controlled stock/charge boundaries)",()=>{
 let db:PGlite;
 beforeAll(async()=>{
  db=new PGlite();
  await db.exec(`
   CREATE SCHEMA auth; CREATE ROLE authenticated; CREATE ROLE anon;
   CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql AS $$ SELECT '${id(20)}'::uuid $$;
   CREATE FUNCTION current_org_id() RETURNS uuid LANGUAGE sql AS $$ SELECT '${org}'::uuid $$;
   CREATE FUNCTION has_permission(text,text,text) RETURNS boolean LANGUAGE sql AS $$ SELECT true $$;
   CREATE FUNCTION neo_branch_in_scope(uuid) RETURNS boolean LANGUAGE sql AS $$ SELECT $1='${branch}'::uuid $$;
   CREATE TABLE folios(id uuid,organization_id uuid,branch_id uuid,status text,currency text,folio_number text,stay_id uuid,reservation_id uuid);
   CREATE TABLE stays(id uuid,organization_id uuid,branch_id uuid,status text,room_id uuid,reservation_id uuid);
   CREATE TABLE rooms(id uuid,organization_id uuid,branch_id uuid);
   CREATE TABLE stock_locations(id uuid,organization_id uuid,branch_id uuid,active boolean,name text,location_type text);
   CREATE TABLE menu_items(id uuid,organization_id uuid,branch_id uuid,name text,base_price numeric,consumption_mode text,consumption_channels text[],stock_item_id uuid,stock_quantity_per_sale numeric,stock_unit text,issuing_location_id uuid);
   CREATE TABLE recipes(id uuid,organization_id uuid,menu_item_id uuid,recipe_type text,status text,version int,output_stock_item_id uuid,yield_unit text,yield_quantity numeric);
   CREATE TABLE stock_items(id uuid,organization_id uuid,name text,base_unit text,tracking_method text,container_volume_ml numeric,average_cost numeric);
   CREATE TABLE profiles(id uuid,full_name text,email text);
   CREATE TABLE minibar_postings(id uuid,organization_id uuid,branch_id uuid,posting_number text,folio_id uuid,room_id uuid,location_id uuid,currency text,notes text,posted_by uuid,total_amount numeric,updated_at timestamptz);
   CREATE TABLE minibar_posting_lines(organization_id uuid,posting_id uuid,menu_item_id uuid,stock_item_id uuid,description text,quantity numeric,unit text,unit_price numeric,amount numeric,folio_line_id uuid);
   CREATE TABLE audit_logs(organization_id uuid,branch_id uuid,user_id uuid,action text,module text,record_id text,new_value jsonb);
   CREATE TABLE test_movements(item uuid,location uuid,quantity numeric);
   CREATE TABLE test_charges(folio uuid,quantity numeric,price numeric);
   CREATE TABLE branches(id uuid,organization_id uuid,code text);
   CREATE TABLE number_sequences(organization_id uuid,doc_type text,branch_id uuid,prefix text,year int,padding int,next_number bigint,updated_at timestamptz);
   CREATE UNIQUE INDEX number_sequence_identity ON number_sequences(organization_id,doc_type,coalesce(branch_id,'00000000-0000-0000-0000-000000000000'::uuid));
   CREATE TABLE issued_document_numbers(organization_id uuid,branch_id uuid,doc_type text,document_number text,year int,source text,status text,issued_by uuid,UNIQUE(organization_id,document_number));
   CREATE FUNCTION my_customer_org_id() RETURNS uuid LANGUAGE sql AS $$ SELECT NULL::uuid $$;
   CREATE FUNCTION next_document_number(text,text DEFAULT NULL,uuid DEFAULT NULL) RETURNS text LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Legacy numbering overload must not be called'; END $$;
   CREATE FUNCTION inventory_round_for_item(numeric,text,uuid) RETURNS numeric LANGUAGE sql AS $$ SELECT $1 $$;
   CREATE FUNCTION neo_item_group_store(uuid,uuid,uuid) RETURNS uuid LANGUAGE sql AS $$ SELECT '${bar}'::uuid $$;
   CREATE FUNCTION recipe_expand_to_stock_kinds(uuid,numeric,uuid) RETURNS TABLE(stock_item_id uuid,kind text,quantity numeric,unit text) LANGUAGE sql AS $$ SELECT NULL::uuid,NULL::text,NULL::numeric,NULL::text WHERE false $$;
   CREATE FUNCTION inventory_apply_movement(uuid,uuid,numeric,text,text,numeric,text,uuid,text,text,text,date) RETURNS uuid LANGUAGE plpgsql AS $$ BEGIN INSERT INTO test_movements VALUES($1,$2,$3); RETURN gen_random_uuid(); END $$;
   CREATE FUNCTION inventory_consume_volume(uuid,uuid,numeric,text,text,text,uuid,text) RETURNS uuid LANGUAGE plpgsql AS $$ BEGIN INSERT INTO test_movements VALUES($1,$2,-$3); RETURN gen_random_uuid(); END $$;
   CREATE FUNCTION neo_evaluate_low_stock(uuid,uuid,uuid,text,uuid) RETURNS void LANGUAGE plpgsql AS $$ BEGIN END $$;
   CREATE FUNCTION folio_post_charge(uuid,text,text,numeric,numeric,numeric,numeric,numeric,text,uuid,text,text,uuid) RETURNS uuid LANGUAGE plpgsql AS $$ BEGIN
    IF current_setting('test.charge_failure',true)='on' THEN RAISE EXCEPTION 'controlled charge failure'; END IF;
    INSERT INTO test_charges VALUES($1,$4,$5); RETURN gen_random_uuid(); END $$;
  `);
  await db.exec(read("supabase/migrations/20260922175848_247e4194-c05f-414f-bddb-b52845f98e4d.sql").match(/CREATE OR REPLACE FUNCTION public\.next_document_number\([\s\S]*?\$function\$;/)![0]);
  await db.exec(baseline);
  await db.exec(`GRANT EXECUTE ON FUNCTION neo_minibar_post(uuid,uuid,jsonb,uuid,text) TO authenticated;`);
  await db.exec(read("supabase/migrations/20261116221500_minibar_property_store_guards.sql"));
  await db.exec(migration);
  await db.exec(read("supabase/repair/2026-11-18/pms-minibar-preflight.sql"));
 },30000);
 afterAll(async()=>db?.close());
 beforeEach(async()=>{
  await db.exec(`TRUNCATE folios,stays,rooms,stock_locations,menu_items,recipes,stock_items,profiles,minibar_postings,minibar_posting_lines,audit_logs,test_movements,test_charges,minibar_posting_attempts,branches,number_sequences,issued_document_numbers;
   SELECT set_config('test.charge_failure','off',false),set_config('neo.minibar_attempt','',false),set_config('neo.system_posting','off',false);
   INSERT INTO folios VALUES('${folio}','${org}','${branch}','open','KES','F-1','${stay}','${id(30)}');
   INSERT INTO stays VALUES('${stay}','${org}','${branch}','in-house','${room}','${id(30)}');
   INSERT INTO rooms VALUES('${room}','${org}','${branch}');
   INSERT INTO branches VALUES('${branch}','${org}','HTL');
   INSERT INTO stock_locations VALUES('${store}','${org}','${branch}',true,'Minibar','minibar'),('${bar}','${org}','${branch}',true,'Bar','bar');
   INSERT INTO menu_items VALUES('${menu}','${org}','${branch}','Water',100,'direct_stock',ARRAY['minibar'],'${stock}',1,'unit','${bar}');
   INSERT INTO stock_items VALUES('${stock}','${org}','Water','unit','whole',NULL,40);`);
 });
 const lines=(quantity=2)=>JSON.stringify([{menu_item_id:menu,quantity,unit_price:100}]);
 async function post(options:{quantity?:number;attempt?:string;room?:string;store?:string}={}){
  return (await db.query<{result:Record<string,unknown>}>(`SELECT neo_minibar_post_once($1,$2,$3::jsonb,$4,NULL,$5) result`,
   [folio,options.store??store,lines(options.quantity),options.room??room,options.attempt??attempt])).rows[0]!.result;
 }
 async function counts(){return (await db.query<{postings:number;movements:number;charges:number;attempts:number}>(`SELECT (SELECT count(*)::int FROM minibar_postings) postings,(SELECT count(*)::int FROM test_movements) movements,(SELECT count(*)::int FROM test_charges) charges,(SELECT count(*)::int FROM minibar_posting_attempts) attempts`)).rows[0];}
 it("saves one stock deduction, folio charge and exact result across uncertain retries",async()=>{
  const first=await post();expect(first).toMatchObject({ok:true,attempt_id:attempt,folio_id:folio,location_id:store,room_id:room,replayed:false,total:200});
  expect(await post()).toEqual({...first,replayed:true});
  expect(await counts()).toEqual({postings:1,movements:1,charges:1,attempts:1});
  expect((await db.query(`SELECT location,quantity FROM test_movements`)).rows).toEqual([{location:store,quantity:"-2"}]);
  expect((await db.query(`SELECT organization_id,branch_id,doc_type,document_number FROM issued_document_numbers`)).rows).toEqual([{organization_id:org,branch_id:branch,doc_type:"minibar_posting",document_number:first["posting_number"]}]);
 });
 it("rejects a changed draft under a saved identity",async()=>{
  await post();await expect(post({quantity:3})).rejects.toThrow(/different work/);
  expect(await counts()).toEqual({postings:1,movements:1,charges:1,attempts:1});
 });
 it("replays the original result even after checkout",async()=>{
  const first=await post();await db.exec("UPDATE folios SET status='closed';UPDATE stays SET status='checked-out'");
  expect(await post()).toEqual({...first,replayed:true});
 });
 it("requires an explicit separate request for separate consumption and unique numbering",async()=>{
  const first=await post();const second=await post({attempt:id(40)});
  expect(first["posting_number"]).not.toBe(second["posting_number"]);expect(first["posting_id"]).not.toBe(second["posting_id"]);
  expect(await counts()).toEqual({postings:2,movements:2,charges:2,attempts:2});
 });
 it.each(["bar","mini","store",null])("refuses store type %s even when its name says Minibar",async(type)=>{
  await db.query("UPDATE stock_locations SET location_type=$1 WHERE id=$2",[type,store]);
  await expect(post()).rejects.toThrow(/explicitly configured/);expect(await counts()).toEqual({postings:0,movements:0,charges:0,attempts:0});
 });
 it.each(["checked-out",null])("refuses stay status %s",async(status)=>{
  await db.query("UPDATE stays SET status=$1",[status]);await expect(post()).rejects.toThrow(/current in-house stay/);
 });
 it("refuses wrong room, mismatched reservation, foreign room or wrong property",async()=>{
  await expect(post({room:other})).rejects.toThrow(/current in-house stay/);
  await db.exec(`UPDATE stays SET reservation_id='${other}'`);await expect(post()).rejects.toThrow(/current in-house stay/);
  await db.exec(`UPDATE stays SET reservation_id='${id(30)}';UPDATE rooms SET organization_id='${other}'`);await expect(post()).rejects.toThrow(/current in-house stay/);
  await db.exec(`UPDATE folios SET branch_id='${other}'`);await expect(post()).rejects.toThrow(/property scope/);
  expect(await counts()).toEqual({postings:0,movements:0,charges:0,attempts:0});
 });
 it("rejects direct legacy calls, including spoofed context flags",async()=>{
  await db.exec(`SELECT set_config('neo.minibar_attempt','${attempt}',false)`);
  const result=await db.query(`SELECT neo_minibar_post($1,$2,$3::jsonb,$4,NULL) result`,[folio,store,lines(),room]);
  expect(result.rows[0]).toEqual({result:{ok:false,reason:"attempt_required"}});
  expect(await counts()).toEqual({postings:0,movements:0,charges:0,attempts:0});
 });
 it("rolls back stock, charge, posting and pending attempt together on a downstream failure",async()=>{
  await db.exec("SELECT set_config('test.charge_failure','on',false)");
  await expect(post()).rejects.toThrow(/controlled charge failure/);
  expect(await counts()).toEqual({postings:0,movements:0,charges:0,attempts:0});
  expect((await db.query(`SELECT count(*)::int n FROM issued_document_numbers`)).rows[0]).toEqual({n:0});
  await db.exec("SELECT set_config('test.charge_failure','off',false)");expect((await post())["ok"]).toBe(true);
 });
 it("restores surrounding system-posting and attempt context",async()=>{
  await db.exec(`BEGIN; SELECT set_config('neo.system_posting','on',true),set_config('neo.minibar_attempt','${id(45)}',true)`);
  await post();expect((await db.query(`SELECT current_setting('neo.system_posting') posting,current_setting('neo.minibar_attempt') attempt`)).rows[0]).toEqual({posting:"on",attempt:id(45)});
  await db.exec("COMMIT");
 });
 it("refuses replay when its saved posting evidence disappears",async()=>{
  await post();await db.exec("DELETE FROM minibar_postings");await expect(post()).rejects.toThrow(/evidence is missing/);
  expect((await counts())?.movements).toBe(1);
 });
 it("refuses changed saved amounts or missing posting lines without another stock deduction",async()=>{
  await post();await db.exec("UPDATE minibar_postings SET total_amount=0");await expect(post()).rejects.toThrow(/evidence is missing/);
  await db.exec("UPDATE minibar_postings SET total_amount=200;DELETE FROM minibar_posting_lines");await expect(post()).rejects.toThrow(/evidence is missing/);
  expect((await counts())?.movements).toBe(1);
 });
 it("reapplies without business writes and denies direct authenticated access to attempt data",async()=>{
  await db.exec(migration);
  expect((await db.query(`SELECT has_table_privilege('authenticated','minibar_posting_attempts','INSERT') write,has_table_privilege('authenticated','minibar_posting_attempts','SELECT') read,has_function_privilege('authenticated','neo_minibar_post_once(uuid,uuid,jsonb,uuid,text,uuid)','EXECUTE') execute,has_function_privilege('anon','neo_minibar_post_once(uuid,uuid,jsonb,uuid,text,uuid)','EXECUTE') anonymous`)).rows[0]).toEqual({write:false,read:false,execute:true,anonymous:false});
  expect(await counts()).toEqual({postings:0,movements:0,charges:0,attempts:0});
 });
 it("refuses unknown engine drift without replacing it",async()=>{
  await db.exec(`BEGIN;CREATE OR REPLACE FUNCTION neo_minibar_post(_folio uuid,_location uuid,_lines jsonb,_room uuid DEFAULT NULL,_notes text DEFAULT NULL) RETURNS jsonb LANGUAGE sql AS $$ SELECT '{}'::jsonb $$`);
  await expect(db.exec(migration)).rejects.toThrow(/differs from reviewed attempt source/);await db.exec("ROLLBACK");
 });
 it("refuses unexpected request-table schema drift without replacing it",async()=>{
  await db.exec("BEGIN;ALTER TABLE minibar_posting_attempts ADD COLUMN unexpected text");
  await expect(db.exec(migration)).rejects.toThrow(/differs from reviewed schema/);await db.exec("ROLLBACK");
 });
});
