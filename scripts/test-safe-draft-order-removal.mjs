import {PGlite} from '@electric-sql/pglite';
import {readFileSync,writeFileSync} from 'node:fs';
import assert from 'node:assert/strict';
const db=new PGlite();let checks=0;
const q=async(s,p=[])=>(await db.query(s,p)).rows;
const check=async(n,f)=>{await f();checks++;console.log('PASS '+n)};
const org='90000000-0000-4000-8000-000000000001',branch='90000000-0000-4000-8000-000000000002',actor='90000000-0000-4000-8000-000000000003';
const first='90000000-0000-4000-8000-000000000010',fresh='90000000-0000-4000-8000-000000000011',item='90000000-0000-4000-8000-000000000012';
const remove=async(id=fresh,reason='Duplicate draft')=>(await q('select neo_pos_remove_draft($1,$2) as result',[id,reason]))[0].result;
const rollback=async f=>{await db.exec('begin');try{await f()}finally{await db.exec('rollback')}};
try{
 await db.exec(`create role anon;create role authenticated;create role service_role;create schema auth;
 create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('test.actor',true),'')::uuid$$;
 create function current_org_id() returns uuid language sql stable as $$select nullif(current_setting('test.org',true),'')::uuid$$;
 create function current_access_scope() returns text language sql stable as $$select current_setting('test.scope',true)$$;
 create function neo_branch_in_scope(uuid) returns boolean language sql stable as $$select $1=nullif(current_setting('test.branch',true),'')::uuid$$;
 create function is_org_admin() returns boolean language sql stable as $$select false$$;
 create function has_permission(text,text) returns boolean language sql stable as $$select current_setting('test.void',true)='on'$$;
 create table pos_orders(id uuid primary key,organization_id uuid,branch_id uuid,order_number text,status text,paid_total numeric,payment_status text,folio_id uuid,folio_post_status text,updated_at timestamptz,grand_total numeric default 100,discount_total numeric default 0);
 create table pos_order_items(id uuid primary key default gen_random_uuid(),order_id uuid,status text,updated_at timestamptz);
 create table pos_payments(id uuid default gen_random_uuid(),order_id uuid,status text,amount numeric);
 create table cash_payment_requests(id uuid default gen_random_uuid(),source_module text,source_record_id uuid,status text);
 create table station_tickets(id uuid default gen_random_uuid(),order_id uuid);
 create table station_ticket_items(id uuid default gen_random_uuid(),order_item_id uuid);
 create table inventory_posting_events(id uuid default gen_random_uuid(),order_id uuid);
 create table finance_posting_receipts(id uuid default gen_random_uuid(),organization_id uuid,source_id uuid);
 create table journal_entries(id uuid default gen_random_uuid(),organization_id uuid,source_document_id uuid);
 create table folio_lines(id uuid default gen_random_uuid(),organization_id uuid,source_record_uuid uuid,source_module text,source_record_id text);
 create table delivery_orders(id uuid default gen_random_uuid(),pos_order_id uuid);
 create table audit_logs(id uuid default gen_random_uuid(),organization_id uuid,branch_id uuid,user_id uuid,user_name text,action text,module text,record_id text,previous_value jsonb,new_value jsonb,reason text);
 create table canonical_transaction_states(organization_id uuid,source_module text,source_id uuid,operational_state text,financial_state text,next_action text,blocking_reason text,updated_at timestamptz,version int default 1);
 create table financial_states(organization_id uuid,source_module text,source_id uuid,operational_status text,financial_status text,reason text,last_error text,updated_at timestamptz);
 `);
 const neighbors=JSON.parse(readFileSync(new URL('./fixtures/pos-draft-removal/reviewed-neighbors.json',import.meta.url),'utf8'));
 for(const f of neighbors)await db.exec(f.definition);
 await db.exec(`create trigger original_void_authority before update on pos_orders for each row execute function neo_pos_guard_void_discount();
 create trigger original_lifecycle before update on pos_orders for each row execute function neo_pos_lifecycle_guard();`);
 await q("select set_config('test.org',$1,false),set_config('test.branch',$2,false),set_config('test.actor',$3,false),set_config('test.scope','property',false),set_config('test.void','on',false)",[org,branch,actor]);
 for(const id of [first,fresh]){
  await q("insert into pos_orders(id,organization_id,branch_id,order_number,status,paid_total,payment_status,folio_post_status) values($1,$2,$3,'FIXTURE-DRAFT','draft',0,'unpaid','not-posted')",[id,org,branch]);
  await q("insert into canonical_transaction_states(organization_id,source_module,source_id,operational_state,financial_state) values($1,'pos',$2,'draft','pending')",[org,id]);
  await q("insert into financial_states(organization_id,source_module,source_id,operational_status,financial_status) values($1,'pos',$2,'draft','pending')",[org,id]);
 }
 await q("insert into pos_order_items(id,order_id,status) values($1,$2,'draft')",[item,fresh]);
 await q("insert into pos_order_items(id,order_id,status) values('90000000-0000-4000-8000-000000000013',$1,'draft')",[first]);
 const before=await q('select to_jsonb(o) as row from pos_orders o order by id');
 const sql=readFileSync(new URL('../supabase/repair/2026-11-06/83_APPLY_SAFE_DRAFT_ORDER_REMOVAL.sql',import.meta.url),'utf8');
 await db.exec(sql);
 await check('installation does not remove or alter existing drafts',async()=>assert.deepEqual(await q('select to_jsonb(o) as row from pos_orders o order by id'),before));
 await check('unused draft is cancelled with one actor/reason removal audit and retained rows',async()=>{const r=await remove(first);assert.equal(r.ok,true);assert.equal(r.history_retained,true);assert.equal((await q('select count(*) as n from pos_orders'))[0].n,2);const [audit]=await q("select * from audit_logs where action='pos.order.draft_removed'");assert.equal(audit.user_id,actor);assert.equal(audit.reason,'Duplicate draft');assert.equal((await q('select status from pos_orders where id=$1',[first]))[0].status,'cancelled')});
 await check('same removal retry reuses its existing removal without another audit',async()=>{assert.equal((await remove(first)).already_removed,true);assert.equal((await q("select count(*) as n from audit_logs where action='pos.order.draft_removed'"))[0].n,1)});
 await check('removed draft leaves active financial queues without creating a posting',async()=>{assert.equal((await q('select financial_state from canonical_transaction_states where source_id=$1',[first]))[0].financial_state,'not-applicable');assert.equal((await q('select financial_status from financial_states where source_id=$1',[first]))[0].financial_status,'not-applicable');assert.equal((await q('select count(*) as n from journal_entries'))[0].n,0)});
 await check('private removal marker cannot be written/read directly by staff',async()=>{assert.equal((await q("select has_table_privilege('authenticated','neo_pos_draft_removals','SELECT,INSERT,UPDATE,DELETE') as allowed"))[0].allowed,false)});
 await check('audit text alone cannot forge an order-removal marker',()=>rollback(async()=>{await q("insert into audit_logs(organization_id,module,record_id,action) values($1,'pos',$2,'pos.order.draft_removed')",[org,fresh]);await q("insert into pos_payments(order_id,status,amount) values($1,'pending',1)",[fresh])}));
 await check('late ticket lines cannot revive a removed draft',async()=>assert.rejects(q("insert into station_ticket_items(order_item_id) values('90000000-0000-4000-8000-000000000013')"),/draft order was removed/));
 await check('removed draft records cannot be physically deleted through their marker FK',async()=>assert.rejects(q('delete from pos_orders where id=$1',[first]),/foreign key|violates/));
 await check('draft items become cancelled while line records remain',()=>rollback(async()=>{await remove();assert.equal((await q('select status from pos_order_items where id=$1',[item]))[0].status,'cancelled')}));
 for(const status of ['paid','closed','sent','preparing',null])await check(`rejects ${status??'unknown'} order lifecycle`,()=>rollback(async()=>{await q('update pos_orders set status=$1,payment_status=$3,paid_total=$4 where id=$2',[status,fresh,['paid','closed'].includes(status)?'paid':'unpaid',['paid','closed'].includes(status)?100:0]);await assert.rejects(remove,/Only unpaid/)}));
 for(const [setting,value] of [['test.void','off'],['test.scope','technical'],['test.actor',''],['test.org',''],['test.branch','90000000-0000-4000-8000-000000000099']])await check(`denies invalid authority/scope ${setting}`,()=>rollback(async()=>{await q('select set_config($1,$2,true)',[setting,value]);await assert.rejects(remove,/Not permitted|void authority|outside your access/)}));
 for(const reason of ['', ' x ', 'x'.repeat(501)])await check('rejects missing/invalid removal reason',async()=>assert.rejects(remove(fresh,reason),/reason/));
 const blockers=[
  ["update pos_orders set paid_total=1 where id=$1",'Only unpaid'],
  ["update pos_orders set payment_status='pending' where id=$1",'Only unpaid'],
  ["update pos_orders set folio_id=gen_random_uuid() where id=$1",'Only unpaid'],
  ["update pos_order_items set status='sent' where order_id=$1",'history'],
  ["insert into pos_payments(order_id,status,amount) values($1,'failed',0)",'history'],
  ["insert into cash_payment_requests(source_module,source_record_id,status) values('pos',$1,'pending')",'history'],
  ['insert into station_tickets(order_id) values($1)','history'],
  ['insert into inventory_posting_events(order_id) values($1)','history'],
  ["insert into finance_posting_receipts(organization_id,source_id) select organization_id,id from pos_orders where id=$1",'history'],
  ["insert into journal_entries(organization_id,source_document_id) select organization_id,id from pos_orders where id=$1",'history'],
  ["insert into folio_lines(organization_id,source_record_uuid) select organization_id,id from pos_orders where id=$1",'history'],
  ['insert into delivery_orders(pos_order_id) values($1)','history'],
 ];
 for(const [setup,message] of blockers)await check('refuses draft with existing financial/production/downstream evidence',()=>rollback(async()=>{await db.exec('alter table pos_orders disable trigger original_lifecycle');await q(setup,[fresh]);await db.exec('alter table pos_orders enable trigger original_lifecycle');await assert.rejects(remove,new RegExp(message))}));
 await check('station ticket lines alone also prevent removal',()=>rollback(async()=>{await q('insert into station_ticket_items(order_item_id) values($1)',[item]);await assert.rejects(remove,/history/)}));
 for(const insert of ["insert into pos_payments(order_id,status,amount) values($1,'pending',10)","insert into cash_payment_requests(source_module,source_record_id,status) values('pos',$1,'pending')","insert into pos_order_items(order_id,status) values($1,'draft')",'insert into station_tickets(order_id) values($1)','insert into inventory_posting_events(order_id) values($1)'])await check('late writes cannot revive a removed draft',async()=>assert.rejects(q(insert,[first]),/draft order was removed/));
 await check('ordinary untouched order still accepts normal downstream writes',()=>rollback(async()=>{await q("insert into pos_payments(order_id,status,amount) values($1,'pending',10)",[fresh]);assert.equal((await q('select count(*) as n from pos_payments where order_id=$1',[fresh]))[0].n,1)}));
 await check('non-POS cash requests keep their existing path',()=>rollback(async()=>{await q("insert into cash_payment_requests(source_module,source_record_id,status) values('pms',$1,'pending')",[first]);assert.equal((await q('select count(*) as n from cash_payment_requests'))[0].n,1)}));
 await check('RPC and private trigger helper keep intended execute grants',async()=>{const [r]=await q("select has_function_privilege('anon','neo_pos_remove_draft(uuid,text)','EXECUTE') as anon,has_function_privilege('authenticated','neo_pos_remove_draft(uuid,text)','EXECUTE') as staff,has_function_privilege('authenticated','neo_pos_removed_draft_write_guard()','EXECUTE') as helper");assert.deepEqual(r,{anon:false,staff:true,helper:false})});
 await check('repeat feature installation refuses to replace installed functions',async()=>{await assert.rejects(db.exec(sql),/already exist/);await db.exec('rollback')});
 const hashes=await q("select p.oid::regprocedure::text as signature,md5(pg_get_functiondef(p.oid)) as hash from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname in ('neo_pos_remove_draft','neo_pos_removed_draft_write_guard')");
 console.log(JSON.stringify({functionHashes:hashes}));
 console.log(JSON.stringify({passed:true,checks,operationalConnection:false,scope:'Isolated draft removal and late-write guard fixtures; Two reviewed existing guards exercised; full deployed trigger graph and parallel PostgreSQL sessions remain separate review gates.'}));
}catch(error){console.error('FAIL '+error.message);process.exitCode=1}finally{await db.close()}

