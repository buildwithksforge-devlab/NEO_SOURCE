import {PGlite} from '@electric-sql/pglite';
import {readFileSync,writeFileSync} from 'node:fs';
import assert from 'node:assert/strict';

const input=JSON.parse(readFileSync(new URL('./fixtures/till-routing/reviewed-till-contracts.json',import.meta.url),'utf8').replace(/^\uFEFF/,''));
const db=new PGlite();let checks=0;
const query=async(s,p=[])=>(await db.query(s,p)).rows;
const check=async(name,fn)=>{await fn();checks++;console.log('PASS '+name)};
const id='90000000-0000-4000-8000-000000000001';
try{
 await db.exec('create schema auth;create function auth.uid() returns uuid language sql stable as $$select null::uuid$$;');
 for(const table of ['pos_orders','pos_payments','pos_shifts','cash_payment_requests']){
  const cols=input.columns.filter(c=>c.table===table);
  await db.exec(`create table ${table}(${cols.map(c=>`${c.column} ${c.type}${c.column==='id'?' primary key default gen_random_uuid()':''}`).join(',')})`);
 }
 await db.exec(`create table folios(id uuid,organization_id uuid,branch_id uuid,status text);
 create table profiles(id uuid,full_name text);
 create table pos_order_items(id uuid default gen_random_uuid(),order_id uuid,status text);
 create function current_access_scope() returns text language sql as $$select 'organisation'::text$$;
 create function current_branch_ids() returns uuid[] language sql as $$select '{}'::uuid[]$$;
 create function current_org_id() returns uuid language sql as $$select null::uuid$$;
 create function has_permission(text,text) returns boolean language sql as $$select false$$;
 create function has_permission(text,text,text) returns boolean language sql as $$select false$$;`);
 for(const f of input.functions)await db.exec(f.definition);
 await check('all nine supplied deployed definitions reproduce exactly',async()=>{
  for(const f of input.functions){const [r]=await query('select md5(pg_get_functiondef(to_regprocedure($1))) as hash',['public.'+f.signature]);assert.equal(r.hash,f.definition_md5,f.signature)}
 });
 await query("insert into pos_orders(id,status,grand_total,paid_total,payment_status) values($1,'paid',100,100,'paid')",[id]);
 await query("insert into pos_payments(order_id,amount,status) values($1,100,'confirmed')",[id]);
 await query("insert into pos_order_items(order_id,status) values($1,'served')",[id]);
 const reconcile=async()=>(await query('select pos_reconcile_settlement_internal($1) as r',[id]))[0].r;
 await check('reproduces already-paid fully-served order remaining unclosed',async()=>{assert.equal((await reconcile()).closed,false);assert.equal((await query('select status from pos_orders where id=$1',[id]))[0].status,'paid')});
 const sql=readFileSync(new URL('../supabase/repair/2026-11-06/80_APPLY_PREPAID_SERVICE_CLOSURE.sql',import.meta.url),'utf8');
 const before=(await query('select to_jsonb(p) as p from pos_payments p'));
 await db.exec(sql);
 await check('installation leaves order/payment data untouched',async()=>{assert.equal((await query('select status from pos_orders where id=$1',[id]))[0].status,'paid');assert.deepEqual(await query('select to_jsonb(p) as p from pos_payments p'),before)});
 await check('fully-served prepaid order closes without another payment',async()=>{assert.equal((await reconcile()).closed,true);assert.equal((await query('select status,closed_at from pos_orders where id=$1',[id]))[0].status,'closed');assert.deepEqual(await query('select to_jsonb(p) as p from pos_payments p'),before)});
 await check('repeat reconciliation does not change the payment or closure timestamp',async()=>{const [beforeOrder]=await query('select * from pos_orders where id=$1',[id]);await reconcile();assert.deepEqual((await query('select * from pos_orders where id=$1',[id]))[0],beforeOrder);assert.deepEqual(await query('select to_jsonb(p) as p from pos_payments p'),before)});
 async function rollback(fn){await db.exec('begin');try{await fn()}finally{await db.exec('rollback')}}
 for(const state of ['sent','preparing',null])await check(`unfinished ${state??'NULL'} service item prevents closure`,()=>rollback(async()=>{await query("update pos_orders set status='paid',closed_at=null where id=$1",[id]);await query('update pos_order_items set status=$1',[state]);assert.equal((await reconcile()).closed,false);assert.equal((await query('select status from pos_orders where id=$1',[id]))[0].status,'paid')}));
 await check('partial payment remains partial and does not close',()=>rollback(async()=>{await query("update pos_orders set status='served',closed_at=null where id=$1",[id]);await db.exec('update pos_payments set amount=50');const r=await reconcile();assert.equal(r.closed,false);assert.equal(Number(r.balance),50);assert.equal(r.payment_status,'partial')}));
 await check('pending provider attempt is not treated as confirmed cash',()=>rollback(async()=>{await query("update pos_orders set status='served',closed_at=null where id=$1",[id]);await db.exec("update pos_payments set status='pending'");const r=await reconcile();assert.equal(r.closed,false);assert.equal(r.payment_status,'pending')}));
 for(const state of ['cancelled','voided','charged-to-room','credit'])await check(`${state} lifecycle remains protected`,()=>rollback(async()=>{await query('update pos_orders set status=$1,closed_at=null where id=$2',[state,id]);assert.equal((await reconcile()).closed,false);assert.equal((await query('select status from pos_orders where id=$1',[id]))[0].status,state)}));
 await check('served ordinary order retains its normal paid-to-closed sequence',()=>rollback(async()=>{await query("update pos_orders set status='served',closed_at=null where id=$1",[id]);assert.equal((await reconcile()).closed,true)}));
 await check('all eight neighboring function definitions remain unchanged',async()=>{for(const f of input.functions.filter(f=>f.signature!=='pos_reconcile_settlement_internal(uuid)')){assert.equal((await query('select md5(pg_get_functiondef(to_regprocedure($1))) as hash',['public.'+f.signature]))[0].hash,f.definition_md5)}});
 await check('reapplying an already changed definition is refused',async()=>{await assert.rejects(db.exec(sql),/Installed function changed/);await db.exec('rollback')});
 const [hash]=await query("select md5(pg_get_functiondef('pos_reconcile_settlement_internal(uuid)'::regprocedure)) as hash");assert.equal(hash.hash.length,32);
 console.log(JSON.stringify({checks,passed:true,operationalConnection:false,scope:'Real supplied definitions in isolated PostgreSQL fixture; no deployed trigger/inventory/journal integration claimed'}));
}catch(e){console.error('FAIL '+e.message);process.exitCode=1}finally{await db.close()}
