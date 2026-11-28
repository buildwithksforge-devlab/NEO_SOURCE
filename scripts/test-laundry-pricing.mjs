import {PGlite} from '@electric-sql/pglite';import {readFileSync} from 'node:fs';import assert from 'node:assert/strict';
const org='00000000-0000-0000-0000-000000000001',branch='00000000-0000-0000-0000-000000000002',room='00000000-0000-0000-0000-000000000205',stay='00000000-0000-0000-0000-000000000003',reservation='00000000-0000-0000-0000-000000000004',customer='00000000-0000-0000-0000-000000000005',folio='00000000-0000-0000-0000-000000000006',price='00000000-0000-0000-0000-000000000007',actor='00000000-0000-0000-0000-000000000008';
const db=new PGlite(),q=async(s,p=[])=>(await db.query(s,p)).rows;let checks=0;const check=async(n,f)=>{await db.exec('begin');try{await f();checks++;console.log('PASS '+n)}finally{await db.exec('rollback')}};
const read=p=>readFileSync(p,'utf8').replace(/^\uFEFF/,'').replaceAll('\r\n','\n');
function fn(file,name){const s=read(file),a=s.indexOf('CREATE OR REPLACE FUNCTION public.'+name+'('),b=s.indexOf('AS $$',a),e=s.indexOf('$$;',b+5);if(a<0||b<0||e<0)throw Error(name);return s.slice(a,e+3)}
try{await db.exec(`CREATE ROLE anon; CREATE ROLE authenticated; CREATE SCHEMA auth;
    CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql AS $$ SELECT '${actor}'::uuid $$;
    CREATE FUNCTION current_org_id() RETURNS uuid LANGUAGE sql AS $$ SELECT '${org}'::uuid $$;
    CREATE FUNCTION has_permission(text,text) RETURNS boolean LANGUAGE sql AS $$ SELECT coalesce(current_setting('neo.test_permission',true),'yes')<>'no' $$;
    CREATE FUNCTION has_permission(text,text,text) RETURNS boolean LANGUAGE sql AS $$ SELECT coalesce(current_setting('neo.test_permission',true),'yes')<>'no' $$;
    CREATE FUNCTION is_org_admin() RETURNS boolean LANGUAGE sql AS $$ SELECT false $$;
    CREATE FUNCTION neo_branch_in_scope(uuid) RETURNS boolean LANGUAGE sql AS $$ SELECT $1='${branch}'::uuid AND coalesce(current_setting('neo.test_scope',true),'yes')<>'no' $$;
    CREATE FUNCTION neo_system_posting() RETURNS boolean LANGUAGE sql AS $$ SELECT coalesce(current_setting('neo.system_posting',true),'off')='on' $$;
    CREATE SEQUENCE document_seq;
    CREATE FUNCTION next_document_number(text) RETURNS text LANGUAGE sql AS $$ SELECT 'LN-'||nextval('document_seq') $$;
    CREATE FUNCTION neo_fact_currency(uuid,uuid) RETURNS text LANGUAGE sql AS $$ SELECT 'KES'::text $$;
    CREATE FUNCTION neo_canonical_posting_module(text) RETURNS text LANGUAGE sql AS $$ SELECT $1 $$;
    CREATE TABLE rooms(id uuid,organization_id uuid,branch_id uuid);
    CREATE TABLE reservations(id uuid,organization_id uuid,branch_id uuid,customer_id uuid);
    CREATE TABLE stays(id uuid,organization_id uuid,branch_id uuid,room_id uuid,reservation_id uuid,customer_id uuid,status text,checked_out_at timestamptz);
    CREATE TABLE folios(id uuid,organization_id uuid,branch_id uuid,reservation_id uuid,stay_id uuid,customer_id uuid,corporate_account_id uuid,
      folio_type text DEFAULT 'guest',status text DEFAULT 'open',currency text DEFAULT 'KES',created_at timestamptz DEFAULT now(),total_charges numeric DEFAULT 0,
      total_discounts numeric DEFAULT 0,total_taxes numeric DEFAULT 0,balance numeric DEFAULT 0,updated_at timestamptz);
    CREATE TABLE laundry_price_items(id uuid,organization_id uuid,branch_id uuid,name text,service_type text,normal_price numeric,express_price numeric,tax_rate numeric,active boolean DEFAULT true);
    CREATE TABLE guest_laundry_orders(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),organization_id uuid,branch_id uuid,laundry_number text,customer_id uuid,
      reservation_id uuid,folio_id uuid,room_id uuid,service_type text,express boolean,express_charge numeric,special_instructions text,status text DEFAULT 'requested',
      created_by uuid,subtotal numeric DEFAULT 0,tax_amount numeric DEFAULT 0,total numeric DEFAULT 0,posting_status text DEFAULT 'unposted',folio_line_id uuid,
      discrepancy_notes text,posted_at timestamptz,delivered_at timestamptz,delivery_confirmed_by text,collected_at timestamptz,created_at timestamptz DEFAULT now(),updated_at timestamptz);
    CREATE TABLE guest_laundry_items(id uuid DEFAULT gen_random_uuid(),organization_id uuid,order_id uuid REFERENCES guest_laundry_orders(id) ON DELETE CASCADE,
      price_item_id uuid,description text,service_type text,quantity numeric,unit_price numeric,tax_rate numeric,line_total numeric);
    CREATE TABLE laundry_batches(id uuid DEFAULT gen_random_uuid(),organization_id uuid,branch_id uuid,guest_order_id uuid,batch_kind text,status text,created_at timestamptz DEFAULT now());
    CREATE TABLE audit_logs(id uuid DEFAULT gen_random_uuid(),organization_id uuid,user_id uuid,user_name text,action text,module text,record_id text,previous_value jsonb,new_value jsonb);
    CREATE FUNCTION log_audit_event(text,text,text,jsonb,jsonb,text,text,uuid,uuid,uuid,text,jsonb,text) RETURNS uuid LANGUAGE plpgsql AS $$
      DECLARE v_id uuid; BEGIN
      IF coalesce(current_setting('neo.test_audit_failure',true),'no')='yes' THEN RAISE EXCEPTION 'Controlled audit failure'; END IF;
      INSERT INTO audit_logs(organization_id,action,module,record_id,new_value) VALUES(current_org_id(),$1,$2,$3,$5) RETURNING id INTO v_id;
      RETURN v_id; END $$;
    CREATE FUNCTION log_audit_event(uuid,text,text,text,jsonb,jsonb,text) RETURNS uuid LANGUAGE sql AS $$
      SELECT public.log_audit_event($2,$3,$4,$5,$6,$7,NULL,NULL,NULL,NULL,NULL,NULL,NULL) $$;
    CREATE TABLE folio_lines(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),organization_id uuid,branch_id uuid,folio_id uuid,reservation_id uuid,customer_id uuid,
      line_type text,category text,revenue_centre text,reference text,source_module text,source_record_id text,source_record_uuid uuid,idempotency_key text,
      description text,quantity numeric,unit_price numeric,gross_amount numeric,discount_amount numeric,tax_amount numeric,service_charge_amount numeric,
      net_amount numeric,posted_by uuid,actor_id uuid,correlation_id uuid,status text,UNIQUE(organization_id,idempotency_key));
    CREATE TABLE finance_posting_receipts(id uuid DEFAULT gen_random_uuid(),organization_id uuid,branch_id uuid,source_module text,source_id uuid,
      source_reference text,idempotency_key text,status text,amount numeric,currency text,folio_line_id uuid,detail text,attempts int,last_error text,
      requested_by uuid,posted_at timestamptz,occurred_on date,UNIQUE(organization_id,idempotency_key));
    CREATE FUNCTION test_receipt_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF NEW.status='posted' AND coalesce(current_setting('neo.test_finance_failure',true),'no')='yes' THEN RAISE EXCEPTION 'Controlled financial receipt failure'; END IF;
      RETURN NEW; END $$;
    CREATE TRIGGER test_finance_failure BEFORE INSERT OR UPDATE ON finance_posting_receipts FOR EACH ROW EXECUTE FUNCTION test_receipt_failure();
`);
await db.exec("ALTER TABLE guest_laundry_orders ADD COLUMN resident boolean DEFAULT false,ADD COLUMN payment_intent text DEFAULT 'pay_now',ADD COLUMN requested_by_user uuid;ALTER TABLE guest_laundry_items ADD COLUMN counted_quantity numeric;CREATE FUNCTION next_document_number(text,text,uuid) RETURNS text LANGUAGE sql AS $$SELECT 'LN-'||nextval('document_seq')$$;");
for(const name of ['laundry_item_amounts','laundry_rollup_order'])await db.exec(fn('supabase/migrations/20260823160205_be98f3f8-fcc8-494e-b117-a10e24ca2fce.sql',name));
await db.exec('CREATE TRIGGER trg_laundry_item_amounts BEFORE INSERT OR UPDATE ON guest_laundry_items FOR EACH ROW EXECUTE FUNCTION laundry_item_amounts();CREATE TRIGGER trg_laundry_rollup_order AFTER INSERT OR UPDATE OR DELETE ON guest_laundry_items FOR EACH ROW EXECUTE FUNCTION laundry_rollup_order();');
console.log(await q("select p.oid::regprocedure::text as name,md5(pg_get_functiondef(p.oid)) as md5 from pg_proc p where proname in ('laundry_item_amounts','laundry_rollup_order')"));
await q('insert into rooms values($1,$2,$3)',[room,org,branch]);await q('insert into reservations values($1,$2,$3,$4)',[reservation,org,branch,customer]);await q("insert into stays values($1,$2,$3,$4,$5,$6,'checked-in',null)",[stay,org,branch,room,reservation,customer]);await q('insert into folios(id,organization_id,branch_id,reservation_id,stay_id,customer_id) values($1,$2,$3,$4,$5,$6)',[folio,org,branch,reservation,stay,customer]);await q("insert into laundry_price_items values($1,$2,$3,'Shirt','wash-iron',100,180,16,true)",[price,org,branch]);
await db.exec(read('supabase/repair/2026-11-06/151_APPLY_LAUNDRY_INTAKE_PRICING.sql'));
const create=async(express=false,key='test',quantity=2)=>(await q('select neo_laundry_order_create($1,$2,$3::jsonb,$5,$4,null) as result',[branch,room,JSON.stringify([{price_item_id:price,quantity}]),express,key]))[0].result;
await check('normal configured price and tax',async()=>{const x=await create();console.log(x);const row=(await q('select * from guest_laundry_orders'))[0];assert.equal(Number(row.total),232);assert.equal(row.payment_intent,'charge_to_room');assert.equal(row.resident,true)});
await check('express is configured unit price without second surcharge',async()=>{await create(true);assert.equal(Number((await q('select total from guest_laundry_orders'))[0].total),417.6)});
await check('counted quantity refreshes configured express and tax once',async()=>{await create(true);await q('update guest_laundry_items set counted_quantity=1');assert.equal(Number((await q('select total from guest_laundry_orders'))[0].total),208.8)});
await check('identical retry returns one order',async()=>{const a=await create(),b=await create();assert.deepEqual(a.order_id,b.order_id);assert.equal((await q('select * from guest_laundry_orders')).length,1)});
await check('changed retry is rejected',async()=>{await create();await assert.rejects(create(true),/different|changed|used/i)});
await check('missing express price is rejected',async()=>{await q('update laundry_price_items set express_price=0');await assert.rejects(create(true),/positive normal or express/)});
await check('captured express mode cannot silently change',async()=>{await create();await assert.rejects(q('update guest_laundry_orders set express=true'),/pricing cannot be changed/)});
await check('captured item cannot move into legacy order',async()=>{await create();const p=(await q("insert into guest_laundry_orders(organization_id,branch_id) values($1,$2) returning id",[org,branch]))[0];await assert.rejects(q('update guest_laundry_items set order_id=$1',[p.id]),/cannot be moved/)});
for(const val of ['NaN','Infinity',-1])await check('invalid counted quantity '+val,async()=>{await create();await assert.rejects(q('update guest_laundry_items set counted_quantity=$1',[val]),/finite amounts/)});
await check('posted garments remain immutable',async()=>{await create();await q("update guest_laundry_orders set posting_status='posted'");await assert.rejects(q('update guest_laundry_items set quantity=3'),/cannot be edited/)});
await check('withdrawn scope refuses intake',async()=>{await q("select set_config('neo.test_scope','no',true)");await assert.rejects(create(),/scope|property/i)});
await check('audit failure rolls back complete intake',async()=>{await q("select set_config('neo.test_audit_failure','yes',true)");await db.exec('savepoint before_intake');await assert.rejects(create(),/Controlled audit/);await db.exec('rollback to savepoint before_intake');assert.equal((await q('select * from guest_laundry_orders')).length,0);assert.equal((await q('select * from guest_laundry_items')).length,0)});
await check('unpriced garments cannot create an order',async()=>{await q('update laundry_price_items set normal_price=0');await assert.rejects(create(),/positive normal or express/)});
await check('zero quantity is rejected before intake persists',async()=>{await assert.rejects(create(false,'zero',0),/positive|quantity/i)});
await check('closed folio refuses intake',async()=>{await q("update folios set status='closed'");await assert.rejects(create(),/open.*folio|folio.*open/i)});
await check('withdrawn permission refuses intake',async()=>{await q("select set_config('neo.test_permission','no',true)");await assert.rejects(create(),/Not permitted/)});
await check('legacy express rows preserve historical pricing mode',async()=>{const p=(await q("insert into guest_laundry_orders(organization_id,branch_id,express) values($1,$2,true) returning id",[org,branch]))[0];await q("insert into guest_laundry_items(organization_id,order_id,quantity,unit_price,tax_rate) values($1,$2,2,100,16)",[org,p.id]);const row=(await q('select * from guest_laundry_orders'))[0];assert.equal(Number(row.total),332);assert.equal(row.intake_price_mode,null)});
console.log(JSON.stringify({installed:await q("select p.oid::regprocedure::text as signature,md5(pg_get_functiondef(p.oid)) as md5 from pg_proc p where p.proname in ('neo_laundry_order_create','laundry_rollup_order','neo_laundry_intake_item_price_guard','neo_laundry_intake_order_price_guard') order by p.proname")}));
console.log(JSON.stringify({passed:true,checks}));
}catch(e){console.error(e);process.exitCode=1}finally{await db.close()}
