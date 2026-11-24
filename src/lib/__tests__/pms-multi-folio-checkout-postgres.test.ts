import {PGlite} from "@electric-sql/pglite";
import {readFileSync} from "node:fs";
import {afterAll,beforeAll,beforeEach,describe,expect,it} from "vitest";
const read=(path:string)=>readFileSync(path,"utf8");
const extract=(path:string,name:string)=>read(path).match(new RegExp(`CREATE OR REPLACE FUNCTION public\\.${name}\\([\\s\\S]*?\\$function\\$;`))![0];
const id=(n:number)=>`00000000-0000-4000-8000-${String(n).padStart(12,"0")}`;
const org=id(1),branch=id(2),actor=id(3),reservation=id(4),stay=id(5),room=id(6),guest=id(10),corporate=id(11),group=id(12),master=id(13);
const repair=read("supabase/migrations/20261118100000_pms_multi_folio_checkout.sql");
describe("actual canonical multi-folio checkout and atomic room release",()=>{
 let db:PGlite;
 beforeAll(async()=>{
  db=new PGlite();
  await db.exec(`CREATE SCHEMA auth; CREATE ROLE authenticated; CREATE ROLE anon;
   CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('test.actor',true),'')::uuid $$;
   CREATE FUNCTION current_org_id() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT '${org}'::uuid $$;
   CREATE FUNCTION has_permission(text,text) RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT CASE WHEN $1='pms' AND $2='checkout.perform' THEN coalesce(current_setting('test.allowed',true),'true')='true' WHEN $1='pms' AND $2='folio.override' THEN coalesce(current_setting('test.override',true),'false')='true' ELSE false END $$;
   CREATE FUNCTION is_org_admin() RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT false $$;
   CREATE FUNCTION neo_branch_in_scope(uuid) RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT $1='${branch}'::uuid $$;
   CREATE TABLE rooms(id uuid PRIMARY KEY,organization_id uuid,branch_id uuid,occupancy_status text,housekeeping_status text,updated_at timestamptz,maintenance_status text DEFAULT 'operational');
   CREATE TABLE reservations(id uuid PRIMARY KEY,organization_id uuid,branch_id uuid,status text,payment_status text,updated_at timestamptz);
   CREATE TABLE stays(id uuid PRIMARY KEY,organization_id uuid,branch_id uuid,reservation_id uuid,room_id uuid,status text,checked_out_at timestamptz,checked_out_by uuid,updated_at timestamptz);
   CREATE TABLE folios(id uuid PRIMARY KEY,organization_id uuid,branch_id uuid,reservation_id uuid,stay_id uuid,folio_number text,folio_type text,currency text DEFAULT 'KES',status text DEFAULT 'open',total_charges numeric DEFAULT 999,total_payments numeric DEFAULT 0,balance numeric DEFAULT 999,closed_at timestamptz,updated_at timestamptz);
   CREATE TABLE folio_lines(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),organization_id uuid,folio_id uuid,status text DEFAULT 'posted',line_type text DEFAULT 'charge',category text DEFAULT 'accommodation',net_amount numeric DEFAULT 0,tax_amount numeric DEFAULT 0,service_charge_amount numeric DEFAULT 0,discount_amount numeric DEFAULT 0);
   CREATE TABLE payments(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),organization_id uuid,folio_id uuid,amount numeric,currency text DEFAULT 'KES',status text DEFAULT 'confirmed');
   CREATE TABLE payment_allocations(organization_id uuid,payment_id uuid,folio_id uuid,amount numeric);
   CREATE TABLE reservation_deposits(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),organization_id uuid,applied_folio_id uuid,applied_folio_line_id uuid,payment_id uuid,amount numeric,currency text DEFAULT 'KES',status text);
   CREATE TABLE room_assignments(organization_id uuid,reservation_id uuid,status text,updated_at timestamptz);
   CREATE TABLE pms_workflow_events(organization_id uuid,branch_id uuid,event_type text,reservation_id uuid,stay_id uuid,folio_id uuid,idempotency_key text,created_by uuid,UNIQUE(organization_id,idempotency_key));
   CREATE TABLE audit_logs(organization_id uuid,branch_id uuid,user_id uuid,user_name text,action text,module text,record_id text,new_value jsonb,reason text);
   CREATE FUNCTION ops_set_room_status(uuid,text,text,text,text,uuid,text) RETURNS void LANGUAGE plpgsql AS $$ BEGIN
    IF current_setting('test.room_failure',true)='true' THEN RAISE EXCEPTION 'Room update failed'; END IF;
    IF current_setting('test.room_silent',true)='true' THEN RETURN; END IF;
    UPDATE rooms SET housekeeping_status=$2,occupancy_status=$7,maintenance_status=coalesce($3,maintenance_status),updated_at=now() WHERE id=$1;
   END $$;
  `);
  await db.exec(extract("supabase/migrations/20261115013000_finance_checkout_ledger_parity.sql","neo_folio_financial_components"));
  await db.exec(read("supabase/migrations/20261116220000_pms_linked_deposit_projection.sql"));
  await db.exec(extract("supabase/migrations/20260914005249_756324e7-13ed-4ec4-96d5-26b6bec207c5.sql","pms_check_out"));
  await db.exec("REVOKE ALL ON FUNCTION pms_check_out(uuid,boolean,text) FROM PUBLIC; GRANT EXECUTE ON FUNCTION pms_check_out(uuid,boolean,text) TO authenticated");
  await db.exec(read("supabase/migrations/20261116210000_pms_checkout_canonical_balance.sql"));
  await db.exec(repair);
 },30_000);
 beforeEach(async()=>{
  await db.exec(`TRUNCATE audit_logs,pms_workflow_events,room_assignments,reservation_deposits,payment_allocations,payments,folio_lines,folios,stays,reservations,rooms;
   SELECT set_config('test.actor','${actor}',false),set_config('test.allowed','true',false),set_config('test.override','false',false),set_config('test.room_failure','false',false),set_config('test.room_silent','false',false),set_config('neo.system_posting','off',false);
   INSERT INTO rooms(id,organization_id,branch_id,occupancy_status,housekeeping_status,updated_at) VALUES('${room}','${org}','${branch}','occupied','occupied',null);
   INSERT INTO reservations VALUES('${reservation}','${org}','${branch}','checked-in','part-paid',null);
   INSERT INTO stays VALUES('${stay}','${org}','${branch}','${reservation}','${room}','in-house',null,null,null);
   INSERT INTO room_assignments VALUES('${org}','${reservation}','active',null);
   INSERT INTO folios(id,organization_id,branch_id,reservation_id,stay_id,folio_number,folio_type) VALUES
    ('${guest}','${org}','${branch}','${reservation}','${stay}','F-GUEST','guest'),
    ('${corporate}','${org}','${branch}','${reservation}','${stay}','F-CORP','corporate'),
    ('${group}','${org}','${branch}','${reservation}','${stay}','F-GROUP','group'),
    ('${master}','${org}','${branch}',null,null,'F-MASTER','group');
   INSERT INTO folio_lines(organization_id,folio_id,net_amount) VALUES('${org}','${guest}',100),('${org}','${corporate}',200),('${org}','${group}',50),('${org}','${master}',1000);
  `);
 });
 afterAll(async()=>{await db?.close();});
 async function pay(folio:string,amount:number,status="confirmed"){
  return (await db.query<{id:string}>("INSERT INTO payments(organization_id,folio_id,amount,status) VALUES($1,$2,$3,$4) RETURNING id",[org,folio,amount,status])).rows[0]!.id;
 }
 async function settle(){await pay(guest,100);await pay(corporate,200);await pay(group,50);}
 async function checkout(force=false,notes=""){return (await db.query<{value:any}>("SELECT pms_check_out($1,$2,$3) value",[reservation,force,notes])).rows[0]!.value;}
 async function snapshot(){return JSON.stringify((await db.query("SELECT (SELECT jsonb_agg(to_jsonb(f) ORDER BY id) FROM folios f) folios,(SELECT jsonb_agg(to_jsonb(s)) FROM stays s) stays,(SELECT jsonb_agg(to_jsonb(r)) FROM rooms r) rooms,(SELECT jsonb_agg(to_jsonb(r)) FROM reservations r) reservations,(SELECT count(*) FROM audit_logs) audits,(SELECT count(*) FROM pms_workflow_events) events")).rows);}
 it("settles every guest/corporate/group folio using its own canonical money and leaves the master group bill alone",async()=>{
  await settle();const result=await checkout();
  expect(result).toMatchObject({ok:true,stay_id:stay,folio_id:guest,folio_count:3,charges:350,collected:350,outstanding:0,room_state:"vacant-dirty"});
  expect(result.folios.map((f:any)=>({id:f.folio_id,charges:f.charges,collected:f.collected,status:f.status}))).toEqual([{id:guest,charges:100,collected:100,status:"settled"},{id:corporate,charges:200,collected:200,status:"settled"},{id:group,charges:50,collected:50,status:"settled"}]);
  expect((await db.query("SELECT total_charges::float8 charges,total_payments::float8 collected,balance::float8 balance,status FROM folios WHERE stay_id=$1 ORDER BY id",[stay])).rows).toEqual([{charges:100,collected:100,balance:0,status:"settled"},{charges:200,collected:200,balance:0,status:"settled"},{charges:50,collected:50,balance:0,status:"settled"}]);
  expect((await db.query("SELECT status FROM folios WHERE id=$1",[master])).rows[0]).toEqual({status:"open"});
  expect((await db.query("SELECT occupancy_status,housekeeping_status FROM rooms")).rows[0]).toEqual({occupancy_status:"vacant",housekeeping_status:"dirty"});
  expect((await db.query<{value:string}>("SELECT current_setting('neo.system_posting') value")).rows[0]!.value).toBe("off");
 });
 it("refuses an unpaid secondary folio and makes no partial summary/room changes",async()=>{
  await pay(guest,100);await pay(group,50);const before=await snapshot();
  await expect(checkout()).rejects.toThrow(/not settled/);expect(await snapshot()).toBe(before);
 });
 it("refuses an unknown stay status or missing assigned room before reporting a released room",async()=>{
  await settle();await db.exec("UPDATE stays SET status=null");const before=await snapshot();
  await expect(checkout()).rejects.toThrow(/cannot check out/);expect(await snapshot()).toBe(before);
  await db.exec("UPDATE stays SET status='in-house',room_id=null");const missingRoom=await snapshot();
  await expect(checkout()).rejects.toThrow(/Assigned room/);expect(await snapshot()).toBe(missingRoom);
 });
 it("does not net a guest credit against corporate debt",async()=>{
  await pay(guest,150);await pay(corporate,150);await pay(group,50);const before=await snapshot();
  await expect(checkout()).rejects.toThrow(/has a credit/);expect(await snapshot()).toBe(before);
 });
 it("refuses debt override without authority or a written reason",async()=>{
  await expect(checkout(true,"Requested override")).rejects.toThrow(/override authority/);
  await db.exec("SELECT set_config('test.override','true',false)");
  await expect(checkout(true," ")).rejects.toThrow(/written reason/);
  expect((await db.query("SELECT status FROM stays")).rows[0]).toEqual({status:"in-house"});
 });
 it("keeps each unpaid folio under review on an authorized exception and records per-folio audit evidence",async()=>{
  await pay(guest,100);await pay(group,50);await db.exec("SELECT set_config('test.override','true',false)");
  const result=await checkout(true,"Approved credit departure");
  expect(result).toMatchObject({forced:true,outstanding:200});
  expect((await db.query("SELECT status,balance::float8 balance,closed_at IS NULL unclosed FROM folios WHERE id=$1",[corporate])).rows[0]).toEqual({status:"under-review",balance:200,unclosed:true});
  expect((await db.query("SELECT jsonb_array_length(new_value->'folios') count,reason FROM audit_logs")).rows[0]).toEqual({count:3,reason:"Approved credit departure"});
 });
 it("replays the saved per-folio result without duplicate audit, events, charges or collections",async()=>{
  await settle();const first=await checkout();const before=await snapshot();const again=await checkout();
  expect(again).toEqual({...first,idempotent:true});expect(await snapshot()).toBe(before);
  expect((await db.query("SELECT count(*)::int n FROM payments")).rows[0]).toEqual({n:3});
 });
 it("rolls all folio/stay/reservation changes back if room release fails",async()=>{
  await settle();await db.exec("SELECT set_config('test.room_failure','true',false)");const before=await snapshot();
  await expect(checkout()).rejects.toThrow(/Room update failed/);expect(await snapshot()).toBe(before);
 });
 it("preserves an independent maintenance hold while handing the vacant room to cleaning",async()=>{
  await settle();await db.exec("UPDATE rooms SET maintenance_status='under-maintenance'");await checkout();
  expect((await db.query("SELECT occupancy_status,housekeeping_status,maintenance_status FROM rooms")).rows[0]).toEqual({occupancy_status:"vacant",housekeeping_status:"dirty",maintenance_status:"under-maintenance"});
 });
 it("refuses a silently unsaved room transition and rolls checkout back",async()=>{
  await settle();await db.exec("SELECT set_config('test.room_silent','true',false)");const before=await snapshot();
  await expect(checkout()).rejects.toThrow(/room release was not saved/);expect(await snapshot()).toBe(before);
 });
 it("refuses foreign property, organization, room or reservation ownership",async()=>{
  await settle();
  for(const update of [`UPDATE folios SET branch_id='${id(90)}' WHERE id='${corporate}'`,`UPDATE folios SET organization_id='${id(90)}' WHERE id='${corporate}'`,`UPDATE rooms SET branch_id='${id(90)}'`,`UPDATE reservations SET branch_id='${id(90)}'`]){
   await db.exec("BEGIN");await db.exec(update);await expect(checkout()).rejects.toThrow(/ownership|property/);await db.exec("ROLLBACK");
  }
 });
 it("refuses mixed currencies even when all individual balances are zero",async()=>{
  await settle();await db.exec(`UPDATE folios SET currency='USD' WHERE id='${corporate}'; UPDATE payments SET currency='USD' WHERE folio_id='${corporate}'`);
  await expect(checkout()).rejects.toThrow(/mixed-currency/);
 });
 it("counts an allocated payment once and refuses ambiguous cross-folio allocations",async()=>{
  const payment=await pay(guest,100);await pay(corporate,200);await pay(group,50);
  await db.query("INSERT INTO payment_allocations VALUES($1,$2,$3,100)",[org,payment,guest]);
  expect((await checkout()).outstanding).toBe(0);
  await db.exec(`UPDATE stays SET status='in-house'; UPDATE payment_allocations SET folio_id='${corporate}'`);
  await expect(checkout()).rejects.toThrow(/per-folio reconciliation/);
 });
 it("does not count pending collections or treat corrupt values as settled",async()=>{
  await pay(guest,100,"pending");await pay(corporate,200);await pay(group,50);
  await expect(checkout()).rejects.toThrow(/not settled/);
  await db.exec(`UPDATE payments SET status='confirmed'; UPDATE folio_lines SET net_amount='NaN'::numeric WHERE folio_id='${corporate}'`);
  await expect(checkout()).rejects.toThrow(/not finite/);
 });
 it("preserves an earlier closed folio date and refuses null confirmed collections",async()=>{
  await settle();await db.exec(`UPDATE folios SET status='closed',closed_at='2026-11-17T12:00:00Z' WHERE id='${guest}'`);
  await checkout();
  expect((await db.query<{closed_at:Date}>("SELECT closed_at FROM folios WHERE id=$1",[guest])).rows[0]!.closed_at.toISOString()).toBe("2026-11-17T12:00:00.000Z");
  await db.exec("UPDATE stays SET status='in-house'; UPDATE payments SET amount=null");
  await expect(checkout()).rejects.toThrow(/Confirmed folio collections/);
 });
 it("retains authentication, property and checkout capability checks",async()=>{
  await db.exec("SELECT set_config('test.actor','',false)");await expect(checkout()).rejects.toThrow(/Not permitted/);
  await db.exec(`SELECT set_config('test.actor','${actor}',false),set_config('test.allowed','false',false)`);await expect(checkout()).rejects.toThrow(/Not permitted/);
  await db.exec(`SELECT set_config('test.allowed','true',false); UPDATE stays SET branch_id='${id(90)}'`);await expect(checkout()).rejects.toThrow(/authorized property/);
 });
 it("refuses a missing folio and preserves installed owner/grants on replay",async()=>{
  await db.exec("DELETE FROM folios WHERE stay_id IS NOT NULL");await expect(checkout()).rejects.toThrow(/No financial folio/);
  await db.exec(repair);
  expect((await db.query("SELECT has_function_privilege('authenticated','pms_check_out(uuid,boolean,text)','EXECUTE') allowed")).rows[0]).toEqual({allowed:true});
 });
 it("refuses unknown installed checkout code without replacing it",async()=>{
  const original=(await db.query<{body:string}>("SELECT pg_get_functiondef('pms_check_out(uuid,boolean,text)'::regprocedure) body")).rows[0]!.body;
  await db.exec(original.replace("total_outstanding numeric := 0","total_outstanding numeric := 5"));
  await expect(db.exec(repair)).rejects.toThrow(/differs from reviewed source/);await db.exec("ROLLBACK");await db.exec(original);
 });
});
