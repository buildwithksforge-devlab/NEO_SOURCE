import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { join } from "node:path";

const { PGlite } = await import(pathToFileURL(join((process.argv[2] || process.cwd()), "node_modules/@electric-sql/pglite/dist/index.js")));
const db = new PGlite();
const id = (number) => `00000000-0000-4000-8000-${String(number).padStart(12, "0")}`;
const [org, branch, dept, clerk, manager, item, foreignItem, otherBranch, outsider] =
  Array.from({ length: 9 }, (_, index) => id(index + 1));
try {
  await db.exec(`
    CREATE ROLE authenticated; CREATE ROLE anon; CREATE ROLE service_role; CREATE SCHEMA auth;
    CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql AS $$ SELECT current_setting('test.actor')::uuid $$;
    CREATE FUNCTION current_org_id() RETURNS uuid LANGUAGE sql AS $$ SELECT '${org}'::uuid $$;
    CREATE FUNCTION is_org_admin() RETURNS boolean LANGUAGE sql AS $$ SELECT false $$;
    CREATE FUNCTION is_active_staff() RETURNS boolean LANGUAGE sql AS $$ SELECT true $$;
    CREATE FUNCTION has_permission(text,text) RETURNS boolean LANGUAGE sql AS $$ SELECT $2='stock_needs.create' $$;
    CREATE FUNCTION has_permission(text,text,text) RETURNS boolean LANGUAGE sql AS $$ SELECT $2='stock_needs' AND $3='create' $$;
    CREATE FUNCTION neo_branch_in_scope(uuid) RETURNS boolean LANGUAGE sql AS $$ SELECT $1='${branch}'::uuid $$;
    CREATE FUNCTION neo_notify(uuid,uuid,uuid,text,text,text,text,text,boolean,text,uuid,text,text)
      RETURNS uuid LANGUAGE sql AS $$ SELECT gen_random_uuid() $$;
    CREATE TABLE departments(id uuid, organization_id uuid, active boolean, branch_id uuid, manager_id uuid, catalogue_key text, code text, name text);
    CREATE TABLE profiles(id uuid, organization_id uuid, account_status text, branch_id uuid, department_id uuid);
    CREATE TABLE user_branches(user_id uuid,organization_id uuid,branch_id uuid);
    CREATE TABLE user_departments(user_id uuid,organization_id uuid,department_id uuid);
    CREATE TABLE roles(id uuid,organization_id uuid,active boolean,name text,normalized_role_key text);
    CREATE TABLE user_roles(user_id uuid,organization_id uuid,role_id uuid);
    CREATE TABLE stock_items(id uuid,organization_id uuid,branch_id uuid,active boolean,name text,base_unit text);
    CREATE TABLE stock_locations(id uuid,organization_id uuid,department_id uuid,branch_id uuid,is_mini_store boolean,active boolean,created_at timestamptz);
    CREATE TABLE department_stock_needs(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),organization_id uuid,branch_id uuid,department_id uuid,module text,
      stock_item_id uuid,item text,quantity numeric,unit text,priority text,notes text,requested_by uuid,status text,requisition_id uuid,
      reviewed_by uuid,reviewed_at timestamptz,updated_at timestamptz);
    CREATE TABLE internal_requisitions(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),organization_id uuid,branch_id uuid,request_number text,department_id uuid,
      destination_location_id uuid,fulfilment_model text,requested_by uuid,request_date date,priority text,reason text,status text,
      supervisor_approved_by uuid,supervisor_approved_at timestamptz);
    CREATE TABLE internal_requisition_lines(organization_id uuid,requisition_id uuid,stock_item_id uuid,description text,unit text,quantity_requested numeric,notes text);
    INSERT INTO departments VALUES('${dept}','${org}',true,'${branch}',NULL,'front-office','FO','Front Office');
    INSERT INTO profiles VALUES ('${clerk}','${org}','active','${branch}','${dept}'),
      ('${manager}','${org}','active','${branch}','${dept}'),('${outsider}','${org}','active','${otherBranch}','${dept}');
    INSERT INTO roles VALUES ('${id(20)}','${org}',true,'Reception leadership','front-office-manager');
    INSERT INTO user_roles VALUES ('${manager}','${org}','${id(20)}'),('${outsider}','${org}','${id(20)}');
    INSERT INTO stock_items VALUES ('${item}','${org}','${branch}',true,'Receipt rolls','unit'),
      ('${foreignItem}','${org}','${otherBranch}',true,'Receipt rolls','unit');
    INSERT INTO department_stock_needs(id,organization_id,branch_id,department_id,module,item,quantity,unit,priority,requested_by,status)
      VALUES('${id(30)}','${org}','${branch}','${dept}','front-office','Receipt rolls',100,'unit','high','${clerk}','reported');
  `);
  await db.exec(readFileSync(join(process.argv[2] || process.cwd(), "supabase/migrations/20261120120000_front_office_catalogue_stock_handoff.sql"), "utf8"));
  const query = (sql, values) => db.query(sql, values).then((result) => result.rows);
  const actor = (user) => query("SELECT set_config('test.actor',$1,false)", [user]);
  const report = (stock = item, quantity = 100, property = branch) =>
    query("SELECT neo_front_office_report_catalogue_need($1,$2,$3,$4,'high','Narrow white rolls') result", [property, dept, stock, quantity])
      .then(([row]) => row.result);
  const forward = (need, stock = item) =>
    query("SELECT neo_front_office_requisition_need($1,$2) result", [need, stock])
      .then(([row]) => row.result);

  await actor(clerk);
  assert.deepEqual(await query("SELECT id FROM neo_front_office_need_catalogue($1)", [branch]), [{id:item}]);
  assert.deepEqual(await query("SELECT id FROM neo_front_office_need_catalogue($1)", [otherBranch]), []);
  await assert.rejects(report(foreignItem), /active inventory catalogue/);
  await assert.rejects(report(id(99)), /active inventory catalogue/);
  await assert.rejects(report(item, 0), /Quantity must be finite/);
  await assert.rejects(report(item, 1, otherBranch), /permission required/);
  const need = await report();
  assert.equal(need.status, "reported");
  assert.equal((await query("SELECT count(*)::int n FROM internal_requisitions"))[0].n, 0);
  await assert.rejects(forward(need.id), /assigned Front Office manager/);

  await actor(manager);
  const linked = await forward(need.id);
  assert.equal(linked.status, "requisitioned");
  assert.equal((await forward(need.id)).requisition_id, linked.requisition_id);
  assert.deepEqual(await query("SELECT requested_by,status,supervisor_approved_by FROM internal_requisitions WHERE id=$1", [linked.requisition_id]),
    [{requested_by:clerk,status:"awaiting-stores",supervisor_approved_by:manager}]);
  assert.deepEqual(await query("SELECT stock_item_id,quantity_requested::int quantity,notes FROM internal_requisition_lines WHERE requisition_id=$1", [linked.requisition_id]),
    [{stock_item_id:item,quantity:100,notes:"Narrow white rolls"}]);
  assert.equal((await report()).status, "requisitioned");
  assert.equal((await forward(id(30))).status,"requisitioned");
  await assert.rejects(query("INSERT INTO department_stock_needs(organization_id,branch_id,module,item,unit) VALUES($1,$2,'front-office','Unknown item','unit')",
    [org,branch]), /existing inventory catalogue/);
  await assert.rejects(query("INSERT INTO internal_requisition_lines VALUES($1,$2,NULL,'Unknown item','unit',1,NULL)", [org,linked.requisition_id]), /catalogue item/);
  await assert.rejects(query("INSERT INTO internal_requisition_lines VALUES($1,$2,$3,'Receipt rolls','unit',1,NULL)", [org,linked.requisition_id,foreignItem]), /active inventory catalogue/);

  await query("UPDATE profiles SET account_status='suspended' WHERE id=$1",[manager]);
  await actor(clerk);
  const direct = await report();
  assert.equal(direct.status, "requisitioned");
  assert.deepEqual(await query("SELECT status,supervisor_approved_by FROM internal_requisitions WHERE id=$1", [direct.requisition_id]),
    [{status:"awaiting-stores",supervisor_approved_by:null}]);
  assert.deepEqual(await query("SELECT has_function_privilege('authenticated','neo_front_office_stock_need_to_stores(uuid,uuid)','EXECUTE') internal, has_function_privilege('anon','neo_front_office_report_catalogue_need(uuid,uuid,uuid,numeric,text,text)','EXECUTE') anon"),
    [{internal:false,anon:false}]);
  await query("INSERT INTO departments VALUES($1,$2,true,$3,NULL,'kitchen','KIT','Kitchen')",[id(40),org,branch]);
  await query("INSERT INTO internal_requisitions(organization_id,branch_id,department_id,requested_by,status) VALUES($1,$2,$3,$4,'pending-supervisor')",[org,branch,id(40),clerk]);
  assert.equal((await query("SELECT status FROM internal_requisitions WHERE department_id=$1",[id(40)]))[0].status,"awaiting-stores");
  await query("UPDATE profiles SET account_status='active',department_id=$1 WHERE id=$2",[id(40),manager]);
  await query("UPDATE roles SET normalized_role_key='kitchen-manager',name='Kitchen Manager'");
  await query("INSERT INTO internal_requisitions(organization_id,branch_id,department_id,requested_by,status) VALUES($1,$2,$3,$4,'awaiting-stores')",[org,branch,id(40),clerk]);
  assert.equal((await query("SELECT count(*)::int n FROM internal_requisitions WHERE department_id=$1 AND status='pending-supervisor'",[id(40)]))[0].n,1);
  console.log("Passed catalogue, scoped manager, linked handoff, replay, legacy mapping, and no-manager routing assertions.");
} finally {
  await db.close();
}
