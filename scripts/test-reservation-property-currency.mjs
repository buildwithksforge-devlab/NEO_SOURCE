import {PGlite} from '@electric-sql/pglite';
import {readFileSync} from 'node:fs';
import assert from 'node:assert/strict';
const db=new PGlite();let checks=0;const q=async(s,p=[])=>(await db.query(s,p)).rows;
const check=async(n,f)=>{await f();checks++;console.log('PASS '+n)};
const org='aa17d427-f816-49bc-b02e-1a89e44806a2',branch='94000000-0000-4000-8000-000000000002',reservation='94000000-0000-4000-8000-000000000003',a='94000000-0000-4000-8000-000000000004',b='94000000-0000-4000-8000-000000000005';
const status=async()=> (await q('select payment_status from reservations where id=$1',[reservation]))[0].payment_status;
const recalc=()=>q('update folios set total_payments=total_payments where id=$1',[b]);
const rollback=async f=>{await db.exec('begin');try{await f()}finally{await db.exec('rollback')}};
try{
 await db.exec(`create role anon;create role authenticated;
 create table reservations(id uuid primary key,organization_id uuid,branch_id uuid,currency text default 'KES',status text default 'confirmed',total_amount numeric default 15000,payment_status text default 'unpaid',updated_at timestamptz);
 create table folios(id uuid primary key,reservation_id uuid,organization_id uuid,branch_id uuid,currency text default 'KES',status text default 'open',total_payments numeric default 0,balance numeric default 0);`);
 const original=readFileSync(new URL('../supabase/migrations/20260823143201_881b1779-7df6-4a84-874a-be00e03f8598.sql',import.meta.url),'utf8').replaceAll('\r\n','\n');
 const start=original.indexOf('CREATE OR REPLACE FUNCTION'),end=original.indexOf('END; $$;',start);
 await db.exec(original.slice(start,end+8));
 await db.exec('revoke all on function tg_folio_sync_reservation_payment_status() from public,anon; create trigger folio_sync_reservation_payment_status after update of total_payments,balance on folios for each row execute function tg_folio_sync_reservation_payment_status()');
 const hash=(await q("select md5(pg_get_functiondef('tg_folio_sync_reservation_payment_status()'::regprocedure)) as hash"))[0].hash;
 const triggerHash=(await q("select md5(pg_get_triggerdef(oid)) as hash from pg_trigger where tgname='folio_sync_reservation_payment_status' and tgrelid='public.folios'::regclass"))[0].hash;
 if(process.argv.includes('--fingerprint'))console.log(JSON.stringify({hash,triggerHash}));else{
 await q('insert into reservations(id,organization_id,branch_id) values($1,$2,$3)',[reservation,org,branch]);
 await q('insert into folios(id,reservation_id,organization_id,branch_id,total_payments,balance) values($1,$2,$3,$4,5000,0)',[a,reservation,org,branch]);
 await check('reproduces partial deposit incorrectly labelled paid against an uncharged folio',async()=>{await q('update folios set balance=0 where id=$1',[a]);assert.equal(await status(),'paid')});
 await q('insert into folios(id,reservation_id,organization_id,branch_id,total_payments,balance) values($1,$2,$3,$4,1000,0)',[b,reservation,org,branch]);
 await check('reproduces last-folio overwrite despite another outstanding folio',async()=>{await q('update folios set balance=10000 where id=$1',[a]);assert.equal(await status(),'part-paid');await recalc();assert.equal(await status(),'paid')});
 const before=JSON.stringify(await q('select * from reservations'));const foliosBefore=JSON.stringify(await q('select * from folios order by id'));
 const sql=readFileSync(new URL('../supabase/repair/2026-11-06/89_APPLY_RESERVATION_FOLIO_STATUS.sql',import.meta.url),'utf8');await db.exec(sql);
 await check('code installation changes no historical reservation or folio amounts/statuses',async()=>{assert.equal(JSON.stringify(await q('select * from reservations')),before);assert.equal(JSON.stringify(await q('select * from folios order by id')),foliosBefore)});
 await db.exec("alter table reservations drop column currency; create function neo_fact_currency(uuid,uuid) returns text language sql stable as $$select coalesce(nullif(current_setting('test.currency',true),''),'KES')$$;");
 await check('reproduces check-in folio status error on actual reservation schema without currency',async()=>{await assert.rejects(recalc(),/has no field \"currency\"/)});
 const priorRows=JSON.stringify({reservations:await q('select * from reservations'),folios:await q('select * from folios order by id')});
 const correction=readFileSync(new URL('../supabase/repair/2026-11-06/134_APPLY_FOLIO_STATUS_PROPERTY_CURRENCY.sql',import.meta.url),'utf8');await db.exec(correction);
 await check('currency correction changes no existing reservation or folio records',async()=>assert.equal(JSON.stringify({reservations:await q('select * from reservations'),folios:await q('select * from folios order by id')}),priorRows));
 await check('all active linked folios contribute to the payment label',async()=>{await recalc();assert.equal(await status(),'part-paid')});
 await check('deposit below the quote remains partial before arrival even with zero posted folio balances',()=>rollback(async()=>{await q('update folios set balance=0');assert.equal(await status(),'part-paid')}));
 await check('full quoted pre-arrival payment can be labelled paid',()=>rollback(async()=>{await q('update folios set balance=0,total_payments=case when id=$1 then 15000 else 0 end',[a]);assert.equal(await status(),'paid')}));
 await check('zero net collections remain unpaid',()=>rollback(async()=>{await q('update folios set total_payments=0');assert.equal(await status(),'unpaid')}));
 await check('an unpriced pre-arrival quote cannot be declared paid from a credit balance',()=>rollback(async()=>{await q('update reservations set total_amount=0');await q('update folios set balance=0');assert.equal(await status(),'part-paid')}));
 await check('posted folio settlement behavior is retained after arrival',()=>rollback(async()=>{await q("update reservations set status='checked-in'");await q('update folios set balance=0');assert.equal(await status(),'paid')}));
 await check('a second outstanding folio prevents paid after arrival',()=>rollback(async()=>{await q("update reservations set status='checked-in'");await recalc();assert.equal(await status(),'part-paid')}));
 await check('voided folios cannot count as received money',()=>rollback(async()=>{await q("update folios set status='voided',balance=0,total_payments=99999");await recalc();assert.equal(await status(),'unpaid')}));
 await check('other-workspace linked records do not influence this reservation',()=>rollback(async()=>{await q('insert into folios values(gen_random_uuid(),$1,$2,$3,\'KES\',\'open\',999999,0)',[reservation,branch,branch]);await recalc();assert.equal(await status(),'part-paid')}));
 await check('other-property linked records do not influence this reservation',()=>rollback(async()=>{await q('insert into folios values(gen_random_uuid(),$1,$2,$3,\'KES\',\'open\',999999,0)',[reservation,org,org]);await recalc();assert.equal(await status(),'part-paid')}));
 await check('foreign workspace trigger row cannot update another reservation',()=>rollback(async()=>{await q('update folios set organization_id=$1 where id=$2',[branch,b]);await q("update reservations set payment_status='unpaid'");await recalc();assert.equal(await status(),'unpaid')}));
 await check('mixed currencies are refused without silently converting',()=>rollback(async()=>{await assert.rejects(q("update folios set currency='USD' where id=$1",[b]),/currencies differ/)}));
 await check('nonfinite cached money is refused',async()=>assert.rejects(q("update folios set total_payments='NaN' where id=$1",[b]),/not finite/));
 await check('same status replay does not change reservation timestamps',async()=>{const before=(await q('select updated_at from reservations'))[0].updated_at;await recalc();assert.deepEqual((await q('select updated_at from reservations'))[0].updated_at,before)});
 await check('existing trigger function execute privileges remain private',async()=>{const [r]=await q("select has_function_privilege('anon','tg_folio_sync_reservation_payment_status()','execute') as anon,has_function_privilege('authenticated','tg_folio_sync_reservation_payment_status()','execute') as staff");assert.deepEqual(r,{anon:false,staff:false})});
 await check('voiding a folio refreshes the label even without a money-column update',()=>rollback(async()=>{await q("update folios set status='voided' where id=$1",[b]);await q("update folios set status='voided' where id=$1",[a]);assert.equal(await status(),'unpaid')}));
 await check('missing active folio amounts cannot be treated as settled',async()=>assert.rejects(q('update folios set balance=null where id=$1',[b]),/incomplete/));
 await check('nonfinite pre-arrival quote cannot produce a paid label',()=>rollback(async()=>{await q("update reservations set total_amount='NaN'");await assert.rejects(recalc(),/quote is not finite/)}));
 await check('valid other organizations retain their installed behavior',()=>rollback(async()=>{const other='94000000-0000-4000-8000-000000000020',folio='94000000-0000-4000-8000-000000000021';await q('insert into reservations(id,organization_id,branch_id) values($1,$2,$3)',[other,branch,branch]);await q('insert into folios(id,reservation_id,organization_id,branch_id,total_payments,balance) values($1,$2,$3,$3,5000,0)',[folio,other,branch]);await q('update folios set balance=0 where id=$1',[folio]);assert.equal((await q('select payment_status from reservations where id=$1',[other]))[0].payment_status,'paid')}));
 await check('repeat installation refuses unknown or already changed code',async()=>{await assert.rejects(db.exec(sql),/definition differs/);await db.exec('rollback')});
await check('configured property currency is used instead of a missing reservation currency field',()=>rollback(async()=>{await q("update folios set status='voided'");await q("update folios set currency='USD'");await q("select set_config('test.currency','USD',true)");await q("update folios set status='open'");await recalc();assert.equal(await status(),'part-paid')}));
 await db.exec(`create schema auth;create function auth.uid() returns uuid language sql as $$select null::uuid$$;
 create table reservation_deposits(id uuid primary key default gen_random_uuid(),reservation_id uuid,status text,reference text,amount numeric,applied_folio_id uuid,applied_folio_line_id uuid,applied_at timestamptz);
 create table folio_lines(id uuid primary key default gen_random_uuid(),organization_id uuid,branch_id uuid,folio_id uuid,reservation_id uuid,line_type text,category text,source_module text,description text,operational_date date,quantity numeric,unit_price numeric,gross_amount numeric,net_amount numeric,posted_by uuid);alter table folios add column updated_at timestamptz;
 `);
 const deposits=readFileSync(new URL('../supabase/migrations/20260831043706_a114fd29-7595-4771-b0de-57407fb6c220.sql',import.meta.url),'utf8');const ds=deposits.indexOf('CREATE OR REPLACE FUNCTION public.pms_apply_deposits_to_folio()'),de=deposits.indexOf('$function$;',deposits.indexOf('AS $function$',ds))+11;await db.exec(deposits.slice(ds,de));
 await db.exec('create trigger pms_apply_deposits after insert on folios for each row when(new.reservation_id is not null) execute function pms_apply_deposits_to_folio()');
 await check('actual deposit-application trigger can create a folio without reservation.currency',()=>rollback(async()=>{await q('insert into reservation_deposits(reservation_id,status,reference,amount) values($1,$2,$3,5000)',[reservation,'held','SYN-DEPOSIT']);const f='94000000-0000-4000-8000-000000000031';await q('insert into folios(id,reservation_id,organization_id,branch_id) values($1,$2,$3,$4)',[f,reservation,org,branch]);const row=(await q('select total_payments,balance from folios where id=$1',[f]))[0];assert.equal(Number(row.total_payments),5000);assert.equal(Number(row.balance),-5000);assert.equal((await q('select status from reservation_deposits'))[0].status,'applied');assert.equal((await q('select * from folio_lines')).length,1)}));
  console.log(JSON.stringify({passed:true,checks,scope:'Isolated existing folio trigger; no operational reservation, deposit, payment, balance or journal changed.'}));
 console.log(JSON.stringify({functionHash:(await q("select md5(pg_get_functiondef('tg_folio_sync_reservation_payment_status()'::regprocedure)) as hash"))[0].hash,triggerHash:(await q("select md5(pg_get_triggerdef(oid)) as hash from pg_trigger where tgname='folio_sync_reservation_payment_status' and tgrelid='public.folios'::regclass"))[0].hash}));
 }
}catch(e){console.error(e);process.exitCode=1}finally{await db.close()}



