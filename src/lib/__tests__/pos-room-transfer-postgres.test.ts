import {PGlite} from "@electric-sql/pglite";
import {readFileSync} from "node:fs";
import {afterAll,beforeAll,beforeEach,describe,expect,it} from "vitest";
const read=(p:string)=>readFileSync(p,"utf8");
const extract=(p:string,name:string)=>read(p).match(new RegExp(`CREATE OR REPLACE FUNCTION public\\.${name}\\([\\s\\S]*?\\$function\\$\\s*;`))![0];
const id=(n:number)=>`00000000-0000-4000-8000-${String(n).padStart(12,"0")}`;
const org=id(1),branch=id(2),order=id(3),folio=id(4),stay=id(5),room=id(6),reservation=id(7),staff=id(8);
const key=`pos-room-charge:${order}`;
const migration=read("supabase/migrations/20261119140000_pos_room_transfer_money_integrity.sql");
const partialMigration=read("supabase/migrations/20261119170000_pos_partial_room_transfer.sql");
describe("POS room transfer: actual transfer and folio-posting routines",()=>{
 let db:PGlite;
 beforeAll(async()=>{
  db=new PGlite();await db.exec(`
   CREATE SCHEMA auth;CREATE ROLE authenticated;CREATE ROLE anon;
   CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql AS $$ SELECT nullif(current_setting('test.actor',true),'')::uuid $$;
   CREATE FUNCTION current_org_id() RETURNS uuid LANGUAGE sql AS $$ SELECT '${org}'::uuid $$;
   CREATE FUNCTION has_permission(text,text) RETURNS boolean LANGUAGE sql AS $$ SELECT current_setting('test.permission',true)='on' $$;
   CREATE FUNCTION neo_branch_in_scope(uuid) RETURNS boolean LANGUAGE sql AS $$ SELECT $1='${branch}'::uuid $$;
   CREATE FUNCTION neo_system_posting() RETURNS boolean LANGUAGE sql AS $$ SELECT current_setting('neo.system_posting',true)='on' $$;
   CREATE TABLE pos_orders(id uuid PRIMARY KEY,organization_id uuid,branch_id uuid,folio_id uuid,folio_post_status text,status text,payment_status text,
    order_number text,order_type text,currency text,subtotal numeric,grand_total numeric,tax_total numeric,service_charge_total numeric,discount_total numeric,
    paid_total numeric,delivery_fee numeric,tip_amount numeric,customer_id uuid,closed_at timestamptz,station_id uuid);
   CREATE TABLE pos_order_status_history(id bigserial,organization_id uuid,order_id uuid,previous_status text,new_status text,station_id uuid,changed_by uuid);
   CREATE TABLE folios(id uuid PRIMARY KEY,organization_id uuid,branch_id uuid,reservation_id uuid,stay_id uuid,status text,currency text,customer_id uuid,corporate_account_id uuid,
    total_charges numeric DEFAULT 0,total_discounts numeric DEFAULT 0,total_taxes numeric DEFAULT 0,balance numeric DEFAULT 0,updated_at timestamptz);
   CREATE TABLE stays(id uuid PRIMARY KEY,organization_id uuid,branch_id uuid,reservation_id uuid,room_id uuid,status text);
   CREATE TABLE rooms(id uuid PRIMARY KEY,organization_id uuid,branch_id uuid);
   CREATE TABLE folio_lines(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),organization_id uuid,branch_id uuid,folio_id uuid,reservation_id uuid,customer_id uuid,
    line_type text,category text,revenue_centre text,reference text,source_module text,source_record_id text,source_record_uuid uuid,idempotency_key text,
    description text,quantity numeric,unit_price numeric,gross_amount numeric,discount_amount numeric,tax_amount numeric,service_charge_amount numeric,
    net_amount numeric,posted_by uuid,actor_id uuid,correlation_id uuid,status text);
   CREATE TABLE pos_payments(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),organization_id uuid,order_id uuid,amount numeric,status text);
   CREATE TABLE cash_payment_requests(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),organization_id uuid,source_module text,source_record_id uuid,status text);
   CREATE TABLE mpesa_transactions(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),organization_id uuid,source_module text,source_record_id uuid,payment_table text,payment_id uuid,status text,result_code integer);
   ALTER TABLE mpesa_transactions ADD COLUMN branch_id uuid, ADD COLUMN amount numeric,
    ADD COLUMN mpesa_receipt_number text, ADD COLUMN applied_at timestamptz;
   CREATE TABLE approval_requests(organization_id uuid,source_record_id uuid,approval_type text,status text);
   CREATE TABLE audit_logs(organization_id uuid,branch_id uuid,user_id uuid,user_name text,action text,module text,record_id text,new_value jsonb);
   CREATE TABLE test_events(organization_id uuid,source_id uuid,payload jsonb);
   ALTER TABLE folios ADD COLUMN total_payments numeric DEFAULT 0;
   ALTER TABLE pos_payments ADD COLUMN branch_id uuid, ADD COLUMN currency text, ADD COLUMN paid_at timestamptz,
    ADD COLUMN receipt_number text, ADD COLUMN method text, ADD COLUMN shift_id uuid, ADD COLUMN cashier_id uuid,
    ADD COLUMN external_reference text, ADD COLUMN destination_account_id uuid;
   ALTER TABLE cash_payment_requests ADD COLUMN payment_id uuid, ADD COLUMN amount numeric,
    ADD COLUMN branch_id uuid, ADD COLUMN currency text;
   CREATE TABLE payments(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),organization_id uuid,branch_id uuid,folio_id uuid,
    reservation_id uuid,customer_id uuid,receipt_number text,amount numeric,currency text,method text,external_reference text,
    status text,paid_at timestamptz,received_by uuid,notes text,source_module text,source_record_id uuid,
    idempotency_key text,destination_account_id uuid,shift_id uuid,posted_journal_id uuid);
   CREATE TABLE payment_attempts(organization_id uuid,payment_table text,payment_id uuid,posted_journal_id uuid,updated_at timestamptz);
   CREATE TABLE test_payment_events(payment_id uuid);
   CREATE FUNCTION trg_payment_attempt_payments() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
    INSERT INTO payment_attempts(organization_id,payment_table,payment_id) VALUES(NEW.organization_id,'payments',NEW.id);
    RETURN NEW;
   END $$;
   CREATE FUNCTION tg_payment_events() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
    INSERT INTO test_payment_events VALUES(NEW.id);RETURN NEW;
   END $$;
   CREATE TRIGGER payment_attempt_sync AFTER INSERT OR UPDATE ON payments FOR EACH ROW EXECUTE FUNCTION trg_payment_attempt_payments();
   CREATE TRIGGER payments_domain_events AFTER INSERT OR UPDATE ON payments FOR EACH ROW EXECUTE FUNCTION tg_payment_events();
   CREATE TABLE payment_allocations(organization_id uuid,payment_id uuid,folio_id uuid,amount numeric,created_by uuid);
   CREATE TABLE pos_refund_requests(order_id uuid,payment_id uuid,status text);
   CREATE TABLE cash_refund_requests(pos_payment_id uuid,status text);
   CREATE TABLE journal_entries(id uuid DEFAULT gen_random_uuid(),organization_id uuid,status text,reversed_by_journal_id uuid,
    journal_type text,source_document_id uuid,source_document_type text);
   CREATE TABLE bank_accounts(id uuid,organization_id uuid,gl_account_id uuid,branch_id uuid,active boolean);
   CREATE TABLE chart_of_accounts(id uuid,organization_id uuid,active boolean,postable boolean,is_header boolean);
   ALTER TABLE audit_logs ADD COLUMN reason text;
   ALTER TABLE folios ADD COLUMN folio_number text, ADD COLUMN folio_type text, ADD COLUMN closed_at timestamptz;
   ALTER TABLE stays ADD COLUMN checked_out_at timestamptz, ADD COLUMN checked_out_by uuid, ADD COLUMN updated_at timestamptz;
   ALTER TABLE rooms ADD COLUMN occupancy_status text, ADD COLUMN housekeeping_status text;
   CREATE TABLE reservations(id uuid,organization_id uuid,branch_id uuid,status text,payment_status text,updated_at timestamptz);
   CREATE TABLE reservation_deposits(organization_id uuid,applied_folio_id uuid,applied_folio_line_id uuid,payment_id uuid,amount numeric,currency text,status text);
   CREATE TABLE room_assignments(organization_id uuid,reservation_id uuid,status text,updated_at timestamptz);
   CREATE TABLE pms_workflow_events(organization_id uuid,branch_id uuid,event_type text,reservation_id uuid,stay_id uuid,
    folio_id uuid,idempotency_key text,created_by uuid,UNIQUE(organization_id,idempotency_key));
   CREATE FUNCTION is_org_admin() RETURNS boolean LANGUAGE sql AS $$ SELECT false $$;
   CREATE FUNCTION ops_set_room_status(uuid,text,text,text,text,uuid,text) RETURNS void LANGUAGE sql AS $$
    UPDATE rooms SET housekeeping_status=$2,occupancy_status=$7 WHERE id=$1 $$;
   CREATE FUNCTION neo_finance_post_txn(text,uuid,boolean) RETURNS jsonb LANGUAGE plpgsql AS $$ BEGIN
    RETURN jsonb_build_object('ok',current_setting('test.finance_failure',true) IS DISTINCT FROM 'on','journal_id',gen_random_uuid());
   END $$;
   CREATE FUNCTION corp_assert_credit(uuid,uuid,uuid,numeric) RETURNS void LANGUAGE plpgsql AS $$ BEGIN END $$;
   CREATE FUNCTION emit_domain_event(uuid,uuid,text,text,uuid,jsonb,text,uuid) RETURNS uuid LANGUAGE plpgsql AS $$ BEGIN
    IF current_setting('test.event_failure',true)='on' THEN RAISE EXCEPTION 'controlled event failure'; END IF;
    INSERT INTO test_events VALUES($1,$5,$6);RETURN gen_random_uuid(); END $$;
  `);
  await db.exec(extract("supabase/migrations/20260824095554_c176e87a-63cc-434e-b00e-59a8eb693ff7.sql","folio_post_charge"));
  await db.exec(extract("supabase/repair/2026-11-19/pos-room-transfer-reviewed-installed.sql","pos_post_room_charge"));
  await db.exec(extract("src/lib/__tests__/fixtures/pos-status-rules.sql","neo_pos_status_rules"));
  await db.exec(extract("src/lib/__tests__/fixtures/pos-status-rules.sql","pos_enforce_order_status"));
  await db.exec("CREATE TRIGGER actual_pos_status_guard BEFORE UPDATE ON pos_orders FOR EACH ROW EXECUTE FUNCTION pos_enforce_order_status()");
  await db.exec("REVOKE ALL ON FUNCTION pos_post_room_charge(uuid,uuid,text) FROM PUBLIC;GRANT EXECUTE ON FUNCTION pos_post_room_charge(uuid,uuid,text) TO authenticated");
  await db.exec(migration);
  await db.exec(migration);
  await db.exec(partialMigration);
  await db.exec(read("supabase/migrations/20261119174000_pms_manual_stock_sale_boundary.sql"));
  await db.exec(extract("supabase/migrations/20261115013000_finance_checkout_ledger_parity.sql","neo_folio_financial_components"));
  await db.exec(read("supabase/migrations/20261116220000_pms_linked_deposit_projection.sql"));
  await db.exec(extract("supabase/migrations/20261118100000_pms_multi_folio_checkout.sql","pms_check_out"));
 },30000);
 beforeEach(async()=>{
  await db.exec(`TRUNCATE pos_orders,pos_order_status_history,folios,stays,rooms,folio_lines,pos_payments,cash_payment_requests,mpesa_transactions,approval_requests,audit_logs,test_events,
   payments,payment_allocations,payment_attempts,test_payment_events,pos_refund_requests,cash_refund_requests,
   journal_entries,reservations,reservation_deposits,room_assignments,pms_workflow_events;
   SELECT set_config('test.actor','${staff}',false),set_config('test.permission','on',false),set_config('test.event_failure','off',false),set_config('test.finance_failure','off',false),set_config('neo.system_posting','off',false);
   INSERT INTO pos_orders VALUES('${order}','${org}','${branch}',NULL,'not-posted','served','unpaid','POS-EXISTING','dine-in','KES',7050,7261.5,889.66,211.5,0,0,0,0,NULL,NULL,NULL);
   INSERT INTO stays VALUES('${stay}','${org}','${branch}','${reservation}','${room}','in-house');
   INSERT INTO rooms VALUES('${room}','${org}','${branch}');
   INSERT INTO folios(id,organization_id,branch_id,reservation_id,stay_id,status,currency) VALUES('${folio}','${org}','${branch}','${reservation}','${stay}','open','KES');
   INSERT INTO reservations VALUES('${reservation}','${org}','${branch}','checked-in','part-paid',null);
  `);
 });
 afterAll(async()=>db?.close());
 async function post(target=folio,attempt=key){return (await db.query<{line:string}>("SELECT pos_post_room_charge($1,$2,$3) line",[order,target,attempt])).rows[0]!.line;}
 async function snapshot(){return JSON.stringify((await db.query("SELECT (SELECT jsonb_agg(to_jsonb(o)) FROM pos_orders o) orders,(SELECT jsonb_agg(to_jsonb(f)) FROM folios f) folios,(SELECT count(*) FROM folio_lines) lines,(SELECT count(*) FROM test_events) events,(SELECT count(*) FROM audit_logs) audits,(SELECT count(*) FROM pos_order_status_history) transitions,(SELECT count(*) FROM payments) payments,(SELECT count(*) FROM payment_allocations) allocations")).rows);}
 it("posts the full unpaid inclusive-tax bill once, with the exact original source and component amounts",async()=>{
  const line=await post();expect((await db.query("SELECT folio_id,source_record_uuid,net_amount::float8 amount,tax_amount::float8 tax,service_charge_amount::float8 service,unit_price::float8 base FROM folio_lines WHERE id=$1",[line])).rows[0])
   .toEqual({folio_id:folio,source_record_uuid:order,amount:7261.5,tax:889.66,service:211.5,base:6160.34});
  expect((await db.query("SELECT status,folio_id,paid_total::float8 paid FROM pos_orders")).rows[0]).toEqual({status:"charged-to-room",folio_id:folio,paid:0});
  expect((await db.query("SELECT new_status FROM pos_order_status_history ORDER BY id")).rows).toEqual([{new_status:"awaiting-payment"},{new_status:"charged-to-room"}]);
  const saved=await snapshot();expect(await post()).toBe(line);expect(await snapshot()).toBe(saved);
 });
 it("replays a valid original transfer after the guest folio closes",async()=>{
  const line=await post();await db.exec("UPDATE folios SET status='settled';UPDATE stays SET status='checked-out'");expect(await post()).toBe(line);
 });
 it("refuses changing destination or attempt identity after transfer",async()=>{
  await post();await db.exec(`INSERT INTO folios(id,organization_id,branch_id,reservation_id,stay_id,status,currency) VALUES('${id(20)}','${org}','${branch}','${reservation}','${stay}','open','KES')`);
  const saved=await snapshot();await expect(post(id(20))).rejects.toThrow(/does not match/);await expect(post(folio,"different-key")).rejects.toThrow(/does not match/);expect(await snapshot()).toBe(saved);
 });
 it("refuses a confirmed receipt when the cached paid total is wrong",async()=>{
  await db.exec(`INSERT INTO pos_payments(organization_id,order_id,amount,status) VALUES('${org}','${order}',2000,'confirmed')`);
  const saved=await snapshot();await expect(post()).rejects.toThrow(/recorded or unresolved money/);expect(await snapshot()).toBe(saved);
 });
 async function partialTender() {
  await db.exec(`UPDATE pos_orders SET paid_total=2000,payment_status='partial';
   INSERT INTO pos_payments(id,organization_id,order_id,branch_id,currency,amount,status,paid_at,receipt_number,method,shift_id)
   VALUES('${id(90)}','${org}','${order}','${branch}','KES',2000,'confirmed',now(),'POS-TENDER','cash','${id(91)}');
   INSERT INTO cash_payment_requests(organization_id,source_module,source_record_id,status,payment_id,amount,branch_id,currency)
   VALUES('${org}','pos','${order}','confirmed','${id(90)}',2000,'${branch}','KES');
   INSERT INTO payment_attempts(organization_id,payment_table,payment_id) VALUES('${org}','pos_payments','${id(90)}');`);
 }
 it("posts full revenue once and applies the original tender without adding a second till entry",async()=>{
  await partialTender();
  const line=await post();
  expect((await db.query("SELECT balance::float8,total_payments::float8 FROM folios")).rows).toEqual([{balance:5261.5,total_payments:2000}]);
  expect((await db.query("SELECT p.source_record_id,p.receipt_number,p.shift_id,p.amount::float8,a.folio_id FROM payments p JOIN payment_allocations a ON a.payment_id=p.id")).rows)
   .toEqual([{source_record_id:id(90),receipt_number:"POS-TENDER",shift_id:null,amount:2000,folio_id:folio}]);
  expect((await db.query("SELECT payment_table,posted_journal_id IS NOT NULL backed FROM payment_attempts")).rows)
   .toEqual([{payment_table:"pos_payments",backed:true}]);
  expect((await db.query("SELECT * FROM test_payment_events")).rows).toEqual([]);
  const saved=await snapshot();
  expect(await post()).toBe(line);
  expect(await snapshot()).toBe(saved);
  await expect(db.exec("UPDATE pos_payments SET status='refunded'")).rejects.toThrow(/applied to a guest folio/);
 });
 it("rolls back the folio and tender allocation if Finance cannot post",async()=>{
  await partialTender();
  await db.exec("SELECT set_config('test.finance_failure','on',false)");
  const saved=await snapshot();
  await expect(post()).rejects.toThrow(/could not be reconciled/);
  expect(await snapshot()).toBe(saved);
 });
 it("accepts matching provider confirmation alongside cash and keeps both receipts separate",async()=>{
  await partialTender();
  await db.exec(`UPDATE pos_orders SET paid_total=2500;
   INSERT INTO pos_payments(id,organization_id,order_id,branch_id,currency,amount,status,paid_at,receipt_number,method,external_reference)
   VALUES('${id(92)}','${org}','${order}','${branch}','KES',500,'confirmed',now(),NULL,'mpesa','CONFIRMED-REFERENCE');
   INSERT INTO mpesa_transactions(organization_id,source_module,source_record_id,payment_table,payment_id,status,result_code,
    branch_id,amount,mpesa_receipt_number,applied_at)
   VALUES('${org}','pos_order','${order}','pos_payments','${id(92)}','success',0,'${branch}',500,'CONFIRMED-REFERENCE',now());`);
  const line=await post();
  expect((await db.query("SELECT p.method,p.amount::float8,p.receipt_number FROM payments p ORDER BY p.method")).rows)
   .toEqual([{method:"cash",amount:2000,receipt_number:"POS-TENDER"},{method:"mpesa",amount:500,receipt_number:"CONFIRMED-REFERENCE"}]);
  expect((await db.query("SELECT balance::float8 FROM folios")).rows).toEqual([{balance:4761.5}]);
  expect(await post()).toBe(line);
 });
 it("combines room and service charges with POS and settles only after the true remainder is paid",async()=>{
  await db.exec(`UPDATE rooms SET occupancy_status='occupied',housekeeping_status='occupied';
   INSERT INTO folio_lines(organization_id,folio_id,status,line_type,category,net_amount) VALUES
    ('${org}','${folio}','posted','charge','accommodation',1000),('${org}','${folio}','posted','charge','laundry',300);`);
  await partialTender();
  const line=await post();
  await expect(db.query("SELECT pms_check_out($1,false,'')",[reservation])).rejects.toThrow(/outstanding balance 6561.50/);
  await db.exec(`INSERT INTO payments(organization_id,folio_id,amount,currency,status)
   VALUES('${org}','${folio}',6561.50,'KES','confirmed')`);
  const result=(await db.query<{result:unknown}>("SELECT pms_check_out($1,false,'') result",[reservation])).rows[0]!.result;
  expect(result).toMatchObject({ok:true,charges:8561.50,collected:8561.50,outstanding:0,room_state:"vacant-dirty"});
  expect(await post()).toBe(line);
 });
 it("routes stocked sales away from the front desk's manual folio charge form",async()=>{
  const charge=(category:string)=>db.query(
   "SELECT folio_post_charge($1,$2,'Desk charge',1,100,0,0,0,'pms.folio',NULL,'rooms',$3,NULL)",
   [folio,category,`desk:${category}`],
  );
  await expect(charge("bar")).rejects.toThrow(/Post this stock sale from POS or Minibar/);
  await expect(charge("laundry")).resolves.toBeTruthy();
  expect((await db.query("SELECT category FROM folio_lines")).rows).toEqual([{category:"laundry"}]);
 });
 it.each(["initiated","pending","processing","unknown"])("refuses payment attempt %s before creating a folio charge",async(status)=>{
  await db.query("INSERT INTO pos_payments(organization_id,order_id,amount,status) VALUES($1,$2,2000,$3)",[org,order,status]);const saved=await snapshot();
  await expect(post()).rejects.toThrow(/unresolved money/);expect(await snapshot()).toBe(saved);
 });
 it("refuses a pending routed cash request even without a POS payment row",async()=>{
  await db.exec(`INSERT INTO cash_payment_requests(organization_id,source_module,source_record_id,status) VALUES('${org}','pos','${order}','pending')`);
  await expect(post()).rejects.toThrow(/unresolved money/);
 });
 it("refuses receipt-review and late-provider evidence linked to a failed attempt",async()=>{
  await db.exec(`INSERT INTO pos_payments(id,organization_id,order_id,amount,status) VALUES('${id(30)}','${org}','${order}',2000,'failed');
   INSERT INTO approval_requests VALUES('${org}','${id(30)}','mpesa-receipt-review','execution_failed')`);
  await expect(post()).rejects.toThrow(/unresolved money/);await db.exec("DELETE FROM approval_requests");
  await db.exec(`INSERT INTO mpesa_transactions(organization_id,source_module,source_record_id,payment_table,payment_id,status,result_code) VALUES('${org}','pos_order','${order}','pos_payments','${id(30)}','failed',0)`);
  await expect(post()).rejects.toThrow(/unresolved money/);
 });
 it("allows genuinely final failed/cancelled requests without inventing a payment",async()=>{
  await db.exec(`INSERT INTO pos_payments(organization_id,order_id,amount,status) VALUES('${org}','${order}',2000,'failed');
   INSERT INTO cash_payment_requests(organization_id,source_module,source_record_id,status) VALUES('${org}','pos','${order}','cancelled')`);expect(await post()).toBeTruthy();
 });
 it("blocks a new routed cash collection after room transfer but permits cancellation",async()=>{
  await post();await expect(db.exec(`INSERT INTO cash_payment_requests(organization_id,source_module,source_record_id,status) VALUES('${org}','pos','${order}','pending')`)).rejects.toThrow(/already transferred/);
  await db.exec(`INSERT INTO cash_payment_requests(organization_id,source_module,source_record_id,status) VALUES('${org}','pos','${order}','cancelled')`);
 });
 it("blocks new POS money and late confirmation after transfer while allowing non-monetary review metadata",async()=>{
  await db.exec(`INSERT INTO pos_payments(id,organization_id,order_id,amount,status) VALUES('${id(40)}','${org}','${order}',2000,'failed')`);
  await post();const saved=await snapshot();
  await expect(db.exec(`INSERT INTO pos_payments(organization_id,order_id,amount,status) VALUES('${org}','${order}',2000,'confirmed')`)).rejects.toThrow(/already transferred/);
  await expect(db.exec(`UPDATE pos_payments SET status='confirmed' WHERE id='${id(40)}'`)).rejects.toThrow(/already transferred/);
  await db.exec("UPDATE pos_payments SET amount=amount");expect(await snapshot()).toBe(saved);
 });
 it("refuses reuse of an existing source key from a different unpaid order",async()=>{
  await post();await db.exec(`INSERT INTO pos_orders SELECT '${id(41)}',organization_id,branch_id,NULL,'not-posted','served','unpaid','POS-OTHER',order_type,currency,subtotal,grand_total,tax_total,service_charge_total,discount_total,0,0,0,customer_id,NULL,station_id FROM pos_orders`);
  await expect(db.query("SELECT pos_post_room_charge($1,$2,$3)",[id(41),folio,key])).rejects.toThrow(/does not match/);
 });
 it("refuses cross-property/currency, missing stay, missing room and departed targets",async()=>{
  for(const update of [`UPDATE folios SET branch_id='${id(90)}'`,`UPDATE folios SET currency='USD'`,"UPDATE folios SET stay_id=null","UPDATE stays SET room_id=null","UPDATE stays SET status='checked-out'"]){
   await db.exec("BEGIN");await db.exec(update);await expect(post()).rejects.toThrow(/property|currency|current in-house/);await db.exec("ROLLBACK");
  }
 });
 it("does not move an order preassigned to another guest account",async()=>{
  await db.exec(`UPDATE pos_orders SET folio_id='${id(80)}'`);const before=await snapshot();
  await expect(post()).rejects.toThrow(/already assigned/);expect(await snapshot()).toBe(before);
 });
 it.each(["grand_total=8151.16","grand_total='NaN'","tip_amount=50","delivery_fee=50","paid_total=null","status=null"])("refuses invalid or unallocated source %s",async(change)=>{
  await db.exec(`UPDATE pos_orders SET ${change}`);const saved=await snapshot();await expect(post()).rejects.toThrow();expect(await snapshot()).toBe(saved);
 });
 it("refuses saved line drift instead of replaying another charge",async()=>{
  await post();await db.exec("UPDATE folio_lines SET net_amount=1");const saved=await snapshot();await expect(post()).rejects.toThrow(/does not match/);expect(await snapshot()).toBe(saved);
 });
 it("rolls the actual charge, folio totals, source state and audits back when a downstream event fails",async()=>{
  await db.exec("SELECT set_config('test.event_failure','on',false)");const before=await snapshot();await expect(post()).rejects.toThrow(/controlled event failure/);expect(await snapshot()).toBe(before);
  expect((await db.query("SELECT current_setting('neo.system_posting') context")).rows[0]).toEqual({context:"off"});
 });
 it("preserves an outer system-posting context and denies missing authentication/permission",async()=>{
  await db.exec("BEGIN;SELECT set_config('neo.system_posting','on',true)");await post();expect((await db.query("SELECT current_setting('neo.system_posting') context")).rows[0]).toEqual({context:"on"});await db.exec("ROLLBACK");
  await db.exec("SELECT set_config('test.actor','',false)");await expect(post()).rejects.toThrow(/Not permitted/);
  await db.exec(`SELECT set_config('test.actor','${staff}',false),set_config('test.permission','off',false)`);await expect(post()).rejects.toThrow(/Not permitted/);
 });
 it("retains the existing execute grants after both migrations",async()=>{
  expect((await db.query("SELECT has_function_privilege('authenticated','pos_post_room_charge(uuid,uuid,text)','EXECUTE') allowed,has_function_privilege('anon','pos_post_room_charge(uuid,uuid,text)','EXECUTE') anonymous")).rows[0]).toEqual({allowed:true,anonymous:false});
 });
 it("executes the installed-definition preflight read-only without calling the transfer",async()=>{
  const before=await snapshot();await db.exec("BEGIN READ ONLY");
  try {
   const result=(await db.query<{pos_room_transfer_preflight:any}>(read("supabase/repair/2026-11-19/POS-ROOM-TRANSFER-PREFLIGHT.sql"))).rows[0]!.pos_room_transfer_preflight;
   expect(result.installed_transfer.authenticated_execute).toBe(true);expect(result.installed_transfer.anonymous_execute).toBe(false);
   expect(result.existing_money_guards).toHaveLength(3);
  } finally {await db.exec("ROLLBACK");}
  expect(await snapshot()).toBe(before);
 });
 it("refuses unknown installed source rather than overwriting a newer repair",async()=>{
  await db.exec("BEGIN;CREATE OR REPLACE FUNCTION pos_post_room_charge(_order_id uuid,_folio_id uuid,_idempotency_key text) RETURNS uuid LANGUAGE sql AS $$ SELECT NULL::uuid $$");
  await expect(db.exec(partialMigration)).rejects.toThrow(/differs from the reviewed predecessor/);await db.exec("ROLLBACK");
 });
});
