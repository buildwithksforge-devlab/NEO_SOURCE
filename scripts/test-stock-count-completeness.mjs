import {PGlite} from '@electric-sql/pglite';import {readFileSync} from 'node:fs';import assert from 'node:assert/strict';
const db=new PGlite(),q=async(s,p=[])=>(await db.query(s,p)).rows,read=n=>readFileSync(new URL('./fixtures/stock-count-completeness/'+n,import.meta.url),'utf8');
const org='aa17d427-f816-49bc-b02e-1a89e44806a2',id=n=>'98000000-0000-4000-8000-'+String(n).padStart(12,'0'),branch=id(1),take=id(2),store=id(3),a=id(4),b=id(5),other=id(99),signature='neo_stores_count_submit_variance(uuid,text)';
let checks=0;const check=async(n,f)=>{await f();checks++;console.log('PASS '+n)},rollback=async f=>{await db.exec('begin');try{await f()}finally{await db.exec('rollback')}};
const submit=async()=>(await q('select neo_stores_count_submit_variance($1,null) as result',[take]))[0].result;
const snapshot=async()=>JSON.stringify({takes:await q('select * from stock_takes order by id'),lines:await q('select * from stock_take_lines order by id'),adjustments:await q('select * from stock_adjustments'),corrections:await q('select * from stock_adjustment_lines'),ledger:await q('select * from stock_levels')});
const reject=async pattern=>{const before=await snapshot();await db.exec('savepoint bad_count');await assert.rejects(submit(),pattern);await db.exec('rollback to savepoint bad_count');assert.equal(await snapshot(),before)};
const hash=async()=>(await q('select md5(pg_get_functiondef(to_regprocedure($1))) as hash',[signature]))[0].hash;
try{
await db.exec(`create role anon;create role authenticated;create schema auth;create function auth.uid() returns uuid language sql stable as $$select null::uuid$$;
create function current_org_id() returns uuid language sql stable as $$select nullif(current_setting('test.org',true),'')::uuid$$;
create function neo_branch_in_scope(uuid) returns boolean language sql stable as $$select $1::text=current_setting('test.branch',true)$$;
create function has_permission(text,text) returns boolean language sql stable as $$select current_setting('test.allowed',true)='on'$$;
create function is_org_admin() returns boolean language sql stable as $$select false$$;
create function next_document_number(text) returns text language sql volatile as $$select 'SYN-'||gen_random_uuid()::text$$;
create table stock_takes(id uuid primary key,organization_id uuid,branch_id uuid,location_id uuid,status text,reference text,completed_at timestamptz,variance_value numeric,counted_by uuid);
create table stock_take_lines(id uuid primary key,organization_id uuid,stock_take_id uuid,stock_item_id uuid,counted_quantity numeric,system_quantity numeric,variance numeric,unit text,unit_cost numeric);
create table stock_adjustments(id uuid primary key default gen_random_uuid(),organization_id uuid,branch_id uuid,adjustment_number text,location_id uuid,reason text,status text,notes text,requested_by uuid,total_value numeric);
create table stock_adjustment_lines(organization_id uuid,adjustment_id uuid,stock_item_id uuid,quantity numeric,unit text,unit_cost numeric,reason text);
create table stock_levels(id uuid,quantity_on_hand numeric);`);
await q("select set_config('test.org',$1,false),set_config('test.branch',$2,false),set_config('test.allowed','on',false)",[org,branch]);
await q("insert into stock_takes(id,organization_id,branch_id,location_id,status,reference) values($1,$2,$3,$4,'in-progress','SYN-COUNT')",[take,org,branch,store]);
await q("insert into stock_take_lines values($1,$2,$3,$1,5,5,null,'unit',2),($4,$2,$3,$4,null,8,null,'unit',2)",[a,org,take,b]);await q('insert into stock_levels values($1,100)',[store]);
await db.exec(read('original.sql'));await db.exec('revoke all on function neo_stores_count_submit_variance(uuid,text) from public,anon;grant execute on function neo_stores_count_submit_variance(uuid,text) to authenticated');const originalHash=await hash();
await check('reproduces partial no-variance count closing with an uncounted line',()=>rollback(async()=>{assert.equal((await submit()).status,'closed');assert.equal((await q('select counted_quantity from stock_take_lines where id=$1',[b]))[0].counted_quantity,null)}));
const before=await snapshot();const candidateMode=process.argv.includes('--candidate');const install=candidateMode?read('candidate.sql'):readFileSync(new URL('../supabase/repair/2026-11-06/97_APPLY_STOCK_COUNT_COMPLETENESS.sql',import.meta.url),'utf8');await db.exec(install);
await check('code installation does not change existing count, correction or stock rows',async()=>assert.equal(await snapshot(),before));
await check('partial count is refused atomically before close',()=>rollback(()=>reject(/count_incomplete/)));
await check('complete no-variance count closes without stock adjustments',()=>rollback(async()=>{await q('update stock_take_lines set counted_quantity=system_quantity');assert.equal((await submit()).status,'closed');assert.equal((await q('select * from stock_adjustments')).length,0);assert.equal(Number((await q('select quantity_on_hand from stock_levels'))[0].quantity_on_hand),100)}));
await check('count variance creates one pending independent correction, not a stock movement',()=>rollback(async()=>{await q('update stock_take_lines set counted_quantity=system_quantity-1');const result=await submit();assert.equal(result.status,'awaiting-approval');assert.equal(result.lines,2);assert.equal((await q('select status from stock_adjustments'))[0].status,'pending');assert.equal((await q('select * from stock_adjustment_lines')).length,2);assert.equal(Number((await q('select quantity_on_hand from stock_levels'))[0].quantity_on_hand),100);await submit();assert.equal((await q('select * from stock_adjustments')).length,1)}));
for(const value of ['NaN','Infinity','-Infinity'])for(const column of ['counted_quantity','system_quantity','unit_cost'])await check(column+' '+value+' cannot close or generate a correction',()=>rollback(async()=>{await q('update stock_take_lines set counted_quantity=system_quantity');await q(`update stock_take_lines set ${column}=$1 where id=$2`,[value,b]);await reject(/count_line_invalid/)}));
await check('a genuine zero physical count remains valid and creates a shortage correction',()=>rollback(async()=>{await q('update stock_take_lines set counted_quantity=0');assert.equal((await submit()).status,'awaiting-approval')}));
await check('negative physical count still fails the retained guard',()=>rollback(async()=>{await q('update stock_take_lines set counted_quantity=-1');await reject(/count_line_invalid/)}));
await check('missing snapshot is not silently assumed to be zero',()=>rollback(async()=>{await q('update stock_take_lines set counted_quantity=5,system_quantity=null');await reject(/snapshot must be present/)}));
await check('foreign organization lines cannot be used to complete a count',()=>rollback(async()=>{await q('update stock_take_lines set counted_quantity=system_quantity,organization_id=$1',[other]);await reject(/count_incomplete/)}));
await check('property denial applies before closed-count replay',()=>rollback(async()=>{await q("update stock_takes set status='closed'");await q("select set_config('test.branch',$1,true)",[other]);await reject(/property scope/)}));
await check('permission denial remains enforced',()=>rollback(async()=>{await q("select set_config('test.allowed','off',true)");await reject(/Not permitted/)}));
await check('foreign organization cannot submit this count',()=>rollback(async()=>{await q("select set_config('test.org',$1,true)",[other]);await reject(/Stock take not found/)}));
await check('empty count cannot certify that inventory was physically counted',()=>rollback(async()=>{await q('delete from stock_take_lines');await reject(/count_empty/)}));
await check('cancelled count cannot re-enter submission',()=>rollback(async()=>{await q("update stock_takes set status='cancelled'");await reject(/cannot be submitted/)}));
await check('valid existing awaiting-approval replay stays compatible',()=>rollback(async()=>{await q("update stock_takes set status='awaiting-approval'");assert.deepEqual(await submit(),{status:'awaiting-approval',adjustment:null})}));
await check('valid protected other-organization behavior is unchanged',()=>rollback(async()=>{await q('update stock_takes set organization_id=$1',[other]);await q('update stock_take_lines set organization_id=$1',[other]);await q("select set_config('test.org',$1,true)",[other]);assert.equal((await submit()).status,'closed')}));
await check('execute permissions are preserved',async()=>{assert.equal((await q("select has_function_privilege('anon',$1,'execute') as allowed",[signature]))[0].allowed,false);assert.equal((await q("select has_function_privilege('authenticated',$1,'execute') as allowed",[signature]))[0].allowed,true)});
await check('negative valuation cannot generate a stock correction',()=>rollback(async()=>{await q('update stock_take_lines set counted_quantity=system_quantity,unit_cost=-1');await reject(/count_line_invalid/)}));
if(!candidateMode){
await check('read-only postcheck confirms the repaired definition',async()=>{const result=(await db.exec(readFileSync(new URL('../supabase/repair/2026-11-06/98_READ_ONLY_STOCK_COUNT_POSTCHECK.sql',import.meta.url),'utf8'))).flatMap(r=>r.rows).find(r=>r.diagnostic)?.diagnostic;assert.equal(result.read_only,'on');assert.equal(result.definition_matches,true)});
await check('installer refuses changed or already repaired source',async()=>{await assert.rejects(db.exec(install),/definition differs/);await db.exec('rollback')});}
console.log(JSON.stringify({passed:true,checks,originalHash,installedHash:await hash(),scope:'Actual count-submission function with synthetic count/adjustment tables and modeled identity, permissions and numbering. No operational stock data accessed.'}));
}catch(e){console.error(e);process.exitCode=1}finally{await db.close()}

