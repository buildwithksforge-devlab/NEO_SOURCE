import {PGlite} from "@electric-sql/pglite";
import {readFileSync} from "node:fs";
import assert from "node:assert/strict";
const id=n=>`00000000-0000-4000-8000-${String(n).padStart(12,"0")}`;
const db=new PGlite(),sql=readFileSync("supabase/repair/2026-11-19/RECONCILE-EXPLICIT-STATION-STORE-LINKS.sql","utf8");
try{
 await db.exec(`CREATE SCHEMA auth;CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql AS $$ SELECT NULL::uuid $$;
  CREATE TABLE operational_stations(id uuid PRIMARY KEY,organization_id uuid,branch_id uuid,active boolean);
  CREATE TABLE menu_items(station_id uuid,organization_id uuid,consumption_mode text);
  CREATE TABLE recipes(station_id uuid,organization_id uuid,status text);
  CREATE TABLE stock_locations(id uuid PRIMARY KEY,station_id uuid,organization_id uuid,branch_id uuid,active boolean,is_main boolean,location_type text);
  CREATE TABLE station_consumption_stores(organization_id uuid,branch_id uuid,station_id uuid UNIQUE,location_id uuid,created_by uuid);
  CREATE TABLE audit_logs(organization_id uuid,branch_id uuid,user_id uuid,user_name text,action text,module text,record_id text,previous_value jsonb,new_value jsonb,reason text,created_at timestamptz DEFAULT now());`);
 for(let n=10;n<=14;n++){
  await db.query("INSERT INTO operational_stations VALUES($1,$2,$3,true)",[id(n),id(1),id(2)]);
  await db.query("INSERT INTO menu_items VALUES($1,$2,'direct_stock')",[id(n),id(1)]);
 }
 const store=async(n,station,org=1,branch=2)=>db.query("INSERT INTO stock_locations VALUES($1,$2,$3,$4,true,false,'beverage')",[id(n),id(station),id(org),id(branch)]);
 await store(20,10); // Unique explicit link: repair it.
 await store(21,12,3,4); // Foreign store: never link it.
 await store(22,13);await store(23,13); // Ambiguous: skip both.
 await store(24,14);await store(25,14);
 await db.query("INSERT INTO station_consumption_stores VALUES($1,$2,$3,$4,NULL)",[id(1),id(2),id(14),id(25)]);
 await db.exec(sql);
 let rows=(await db.query("SELECT station_id,location_id FROM station_consumption_stores ORDER BY station_id")).rows;
 assert.deepEqual(rows,[{station_id:id(10),location_id:id(20)},{station_id:id(14),location_id:id(25)}]);
 assert.equal((await db.query("SELECT count(*)::int n FROM stock_locations")).rows[0].n,6);
 await db.exec(sql);
 assert.equal((await db.query("SELECT count(*)::int n FROM audit_logs")).rows[0].n,1);
 // Audit failure must roll back a newly reconciled mapping.
 await db.query("DELETE FROM station_consumption_stores WHERE station_id=$1",[id(10)]);
 await db.exec("CREATE FUNCTION audit_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'audit unavailable'; END $$;CREATE TRIGGER fail BEFORE INSERT ON audit_logs FOR EACH ROW EXECUTE FUNCTION audit_fail()");
 await assert.rejects(db.exec(sql),/audit unavailable/);await db.exec("ROLLBACK");
 assert.equal((await db.query("SELECT count(*)::int n FROM station_consumption_stores WHERE station_id=$1",[id(10)])).rows[0].n,0);
 console.log("Passed: unique explicit link, foreign/ambiguous/missing refusal, valid mapping preservation, no new stores, replay and audit rollback.");
}finally{await db.close();}
