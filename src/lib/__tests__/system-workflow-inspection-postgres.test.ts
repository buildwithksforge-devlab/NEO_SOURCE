import {PGlite} from "@electric-sql/pglite";
import {readFileSync} from "node:fs";
import {afterAll,beforeAll,describe,expect,it} from "vitest";
const sql=readFileSync("supabase/repair/2026-11-18/SYSTEM-WIDE-WORKFLOW-INSPECTION.sql","utf8");
const details=readFileSync("supabase/repair/2026-11-18/SYSTEM-ROLLOUT-DETAILS.sql","utf8");
describe("read-only system workflow inspection",()=>{
 let db:PGlite;
 beforeAll(async()=>{
  db=new PGlite();
  await db.exec(`CREATE ROLE authenticated;CREATE ROLE anon;
   CREATE TABLE organizations(id uuid,name text);
   CREATE TABLE recipes(organization_id uuid,branch_id uuid,status text,recipe_type text,output_stock_item_id uuid,station_id uuid);
   CREATE TABLE menu_items(organization_id uuid,branch_id uuid,consumption_mode text,stock_item_id uuid,station_id uuid);
   CREATE TABLE stock_items(id uuid,organization_id uuid,branch_id uuid);
   CREATE TABLE operational_stations(id uuid,name text,organization_id uuid,branch_id uuid,active boolean);
   CREATE TABLE stock_locations(id uuid,organization_id uuid,branch_id uuid,active boolean,is_main boolean);
   CREATE TABLE station_consumption_stores(station_id uuid,organization_id uuid,branch_id uuid,location_id uuid);
   INSERT INTO organizations VALUES('00000000-0000-4000-8000-000000000001','Tenant Alpha'),('00000000-0000-4000-8000-000000000002','Tenant Beta');
   INSERT INTO stock_items VALUES('00000000-0000-4000-8000-000000000010','00000000-0000-4000-8000-000000000001',NULL);
   INSERT INTO recipes(organization_id,branch_id,status,recipe_type,output_stock_item_id) VALUES('00000000-0000-4000-8000-000000000001',NULL,'active','direct_sale','00000000-0000-4000-8000-000000000010'),
    ('00000000-0000-4000-8000-000000000002',NULL,'active','direct_sale','00000000-0000-4000-8000-000000000010');
   INSERT INTO menu_items(organization_id,branch_id,consumption_mode,stock_item_id) SELECT organization_id,branch_id,'direct_stock',output_stock_item_id FROM recipes;
   INSERT INTO operational_stations SELECT id,'Station '||name,id,id,true FROM organizations;
   UPDATE menu_items SET station_id=organization_id;
   INSERT INTO stock_locations VALUES('00000000-0000-4000-8000-000000000020','00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000001',true,false);
   INSERT INTO station_consumption_stores SELECT id,id,id,'00000000-0000-4000-8000-000000000020'::uuid FROM organizations;
   CREATE FUNCTION inventory_consume_order_item_core(uuid) RETURNS jsonb LANGUAGE sql AS $$ SELECT jsonb_build_object('legacy_gate','aa17d427-f816-49bc-b02e-1a89e44806a2') $$;`);
 },30000);
 afterAll(async()=>{await db?.close();});
 it("reports ownership gaps for arbitrary tenants, missing routines and embedded tenant markers without writes",async()=>{
  await db.exec("BEGIN READ ONLY");
  const result=(await db.query<{system_workflow_inspection:any}>(sql)).rows[0]!.system_workflow_inspection;
  await db.exec("COMMIT");
  expect(result.shared_workflow_checks).toHaveLength(23);
  expect(result.shared_workflow_checks.find((r:any)=>r.signature==="public.inventory_consume_order_item_core(uuid)")).toMatchObject({installed:true,contains_known_tenant_gate:true,review_status:"different_or_newer_definition_review_required"});
  expect(result.shared_workflow_checks.some((r:any)=>r.review_status==="missing")).toBe(true);
  expect(result.organisation_mapping_checks.map((r:any)=>[r.organization_name,r.invalid_active_direct_sale_outputs,r.invalid_direct_stock_menu_ownership]))
    .toEqual([["Tenant Alpha",0,0],["Tenant Beta",1,1]]);
  expect((await db.query("SELECT count(*)::int n FROM recipes")).rows[0]).toEqual({n:2});
 });
 it("uses canonical mappings and reports only stock-consuming stations with invalid stores",async()=>{
  await db.exec("BEGIN READ ONLY");
  const report=(await db.query<{system_rollout_details:any}>(details)).rows[0]!.system_rollout_details;
  await db.exec("COMMIT");
  expect(report.stock_consuming_stations_needing_review).toEqual([expect.objectContaining({organization_id:"00000000-0000-4000-8000-000000000002",valid_store_count:0})]);
  expect(report.checkout_minibar_installation).toHaveLength(5);
 });
});
