import {PGlite} from '@electric-sql/pglite';
import {readFileSync} from 'node:fs';
import assert from 'node:assert/strict';
const db=new PGlite();let checks=0;const q=async(s,p=[])=>(await db.query(s,p)).rows;
const check=async(n,f)=>{await f();checks++;console.log('PASS '+n)};
const org='92000000-0000-4000-8000-000000000001',branch='92000000-0000-4000-8000-000000000002',booking='92000000-0000-4000-8000-000000000003',dept='92000000-0000-4000-8000-000000000004',shared='92000000-0000-4000-8000-000000000005',legacy='92000000-0000-4000-8000-000000000006';
const rollback=async f=>{await db.exec('begin');try{await f()}finally{await db.exec('rollback')}};
const insert=async(over={})=>{const v={organization_id:org,booking_id:booking,department_key:'KITC',requirement:'Prepare service',...over};const keys=Object.keys(v);return q(`insert into event_department_requirements(${keys.join(',')}) values(${keys.map((_,i)=>'$'+(i+1)).join(',')}) returning *`,Object.values(v))};
try{
 await db.exec(`create role anon;create role authenticated;create role service_role;create schema auth;
 create function auth.uid() returns uuid language sql as $$select '${org}'::uuid$$;
 create function current_org_id() returns uuid language sql as $$select '${org}'::uuid$$;
 create function neo_branch_in_scope(uuid) returns boolean language sql as $$select $1='${branch}'::uuid$$;
 create function has_permission(text,text) returns boolean language sql as $$select true$$;
 create function is_org_admin() returns boolean language sql as $$select false$$;
 create function neo_event_verified_collection_total(uuid) returns numeric language sql as $$select 0::numeric$$;
 create function next_document_number(text) returns text language sql as $$select gen_random_uuid()::text$$;
 create table departments(id uuid primary key,organization_id uuid,branch_id uuid,code text,name text,active boolean default true);
 create table event_bookings(id uuid primary key,organization_id uuid,branch_id uuid,status text,deposit_required numeric default 0,start_at timestamptz default now(),end_at timestamptz default now()+interval '2 hours',setup_at timestamptz,breakdown_at timestamptz,venue_id uuid,event_name text,event_date date default current_date,event_reference text,guaranteed_guests integer default 10,expected_guests integer default 10,seating_layout text,coordinator_id uuid,confirmed_at timestamptz,confirmed_by uuid,updated_by uuid);
 create table tasks(id uuid primary key default gen_random_uuid(),organization_id uuid,branch_id uuid,department_id uuid,reference text,title text,description text,due_at timestamptz,priority text,status text,created_by uuid);
 create table event_department_requirements(id uuid primary key default gen_random_uuid(),organization_id uuid,branch_id uuid,booking_id uuid,department_id uuid,department_key text,requirement text,required_by timestamptz,task_id uuid);
 create table venue_blocks(organization_id uuid,branch_id uuid,venue_id uuid,booking_id uuid,block_type text,starts_at timestamptz,ends_at timestamptz,status text,reason text,override_reason text,created_by uuid);
 create table event_milestones(organization_id uuid,booking_id uuid,key text,label text,due_at timestamptz,sort_order integer,completed_at timestamptz,unique(booking_id,key));
 create table banquet_event_orders(id uuid primary key default gen_random_uuid(),organization_id uuid,branch_id uuid,booking_id uuid,beo_number text,revision integer,setup_at timestamptz,guest_arrival_at timestamptz,start_at timestamptz,end_at timestamptz,breakdown_at timestamptz,guaranteed_guests integer,seating_layout text,status text,created_by uuid);
 create table notifications(organization_id uuid,branch_id uuid,user_id uuid,category text,title text,body text,link text,priority text);
 create table event_activity_logs(organization_id uuid,booking_id uuid,action text,detail jsonb,actor_id uuid);
 `);
 await q("insert into event_bookings(id,organization_id,branch_id,status,event_reference) values($1,$2,$3,'provisional-hold','FIXTURE')",[booking,org,branch]);
 await q("insert into departments(id,organization_id,branch_id,code,name) values($1,$2,$3,'KITC','Main Kitchen'),($4,$2,null,'KITC','Shared Kitchen')",[dept,org,branch,shared]);
 await insert({id:legacy});
 const sql=readFileSync(new URL('../supabase/repair/2026-11-06/85_APPLY_EVENT_REQUIREMENT_OWNERSHIP.sql',import.meta.url),'utf8');
 await db.exec(readFileSync(new URL('../supabase/migrations/20261025210000_e02e_secure_event_confirmation.sql',import.meta.url),'utf8'));
 const originalHash=(await q("select md5(pg_get_functiondef('events_confirm_booking(uuid,text)'::regprocedure)) as hash"))[0].hash;
 await db.exec(sql);
 await check('installation leaves historical requirements and bookings unchanged',async()=>{assert.equal((await q('select department_id from event_department_requirements where id=$1',[legacy]))[0].department_id,null);assert.equal((await q('select status from event_bookings'))[0].status,'provisional-hold');assert.equal((await q('select count(*) n from tasks'))[0].n,0)});
 await check('unambiguous property ownership wins over shared fallback',()=>rollback(async()=>{const [r]=await insert();assert.equal(r.department_id,dept);assert.equal(r.branch_id,branch)}));
 await check('explicit active shared department is retained',()=>rollback(async()=>assert.equal((await insert({department_id:shared}))[0].department_id,shared)));
 await check('unknown department is refused instead of creating ownerless work',async()=>assert.rejects(insert({department_key:'unknown'}),/configured department/));
 await check('ambiguous property departments require an explicit selection',()=>rollback(async()=>{await q("insert into departments values(gen_random_uuid(),$1,$2,'KITC','Other kitchen',true)",[org,branch]);await db.exec('savepoint denied');await assert.rejects(insert(),/ambiguous/);await db.exec('rollback to savepoint denied');assert.equal((await insert({department_id:dept}))[0].department_id,dept)}));
 await check('inactive department is refused',()=>rollback(async()=>{await q('update departments set active=false where id=$1',[dept]);await assert.rejects(insert({department_id:dept}),/active department/)}));
 await check('another property department is refused',()=>rollback(async()=>{await q('update departments set branch_id=$1 where id=$2',[shared,dept]);await assert.rejects(insert({department_id:dept}),/active department/)}));
 await check('another workspace department is refused',()=>rollback(async()=>{await q('update departments set organization_id=$1 where id=$2',[shared,dept]);await assert.rejects(insert({department_id:dept}),/active department/)}));
 await check('requirement cannot claim another workspace',async()=>assert.rejects(insert({organization_id:shared}),/workspace/));
 await check('requirement cannot claim another property',async()=>assert.rejects(insert({branch_id:shared}),/property/));
 await check('missing booking is refused',async()=>assert.rejects(insert({booking_id:shared}),/workspace/));
 await check('linked task must match department as well as booking scope',()=>rollback(async()=>{const [t]=await q('insert into tasks(organization_id,branch_id,department_id) values($1,$2,$3) returning id',[org,branch,shared]);await db.exec('savepoint denied');await assert.rejects(insert({task_id:t.id,department_id:dept}),/linked event task/);await db.exec('rollback to savepoint denied');await insert({task_id:t.id,department_id:shared})}));
 await check('missing linked task is refused',async()=>assert.rejects(insert({task_id:shared}),/linked event task/));
 await check('real confirmation rolls back legacy ownerless task instead of persisting it',async()=>{await assert.rejects(q('select events_confirm_booking($1)',[booking]),/linked event task/);assert.equal((await q('select count(*) n from tasks'))[0].n,0);assert.equal((await q('select status from event_bookings'))[0].status,'provisional-hold');assert.equal((await q('select count(*) n from event_milestones'))[0].n,0)});
 await check('explicit requirement correction enables original confirmation engine',async()=>{await q('update event_department_requirements set department_id=$1 where id=$2',[dept,legacy]);const [r]=await q('select events_confirm_booking($1) as result',[booking]);assert.equal(r.result.tasks_created,1);const [t]=await q('select * from tasks');assert.equal(t.department_id,dept);assert.equal(t.branch_id,branch);assert.equal(t.organization_id,org)});
 await check('confirmation replay creates no duplicate tasks or BEO',async()=>{await q('select events_confirm_booking($1)',[booking]);assert.equal((await q('select count(*) n from tasks'))[0].n,1);assert.equal((await q('select count(*) n from banquet_event_orders'))[0].n,1)});
 await check('private trigger helper cannot be called by client roles',async()=>{const [r]=await q("select has_function_privilege('authenticated','neo_event_requirement_ownership_guard()','execute') as staff,has_function_privilege('anon','neo_event_requirement_ownership_guard()','execute') as anon");assert.deepEqual(r,{staff:false,anon:false})});
 await check('existing confirmation function is unchanged by the guard',async()=>assert.equal((await q("select md5(pg_get_functiondef('events_confirm_booking(uuid,text)'::regprocedure)) as hash"))[0].hash,originalHash));
 console.log(JSON.stringify((await q("select md5(pg_get_functiondef('neo_event_requirement_ownership_guard()'::regprocedure)) as hash"))[0]));
 await check('read-only installation postcheck verifies definition, trigger and privileges',async()=>{const rows=await db.exec(readFileSync(new URL('../supabase/repair/2026-11-06/86_READ_ONLY_EVENT_OWNERSHIP_POSTCHECK.sql',import.meta.url),'utf8'));const result=rows.flatMap(r=>r.rows).find(r=>r.diagnostic)?.diagnostic;assert.equal(result.read_only,'on');assert.equal(result.definition_matches,true);assert.equal(result.trigger_enabled,true);assert.equal(result.helper_private,true)});
 await check('installation postcheck detects a disabled ownership trigger',async()=>{await db.exec('alter table event_department_requirements disable trigger neo_event_requirement_ownership');const rows=await db.exec(readFileSync(new URL('../supabase/repair/2026-11-06/86_READ_ONLY_EVENT_OWNERSHIP_POSTCHECK.sql',import.meta.url),'utf8'));assert.equal(rows.flatMap(r=>r.rows).find(r=>r.diagnostic)?.diagnostic.trigger_enabled,false);await db.exec('alter table event_department_requirements enable trigger neo_event_requirement_ownership')});
 await check('repeat installation refuses to overwrite existing guard',async()=>{await assert.rejects(db.exec(sql),/already exists/);await db.exec('rollback')});
 console.log(JSON.stringify({passed:true,checks,scope:'Isolated guard and actual existing event confirmation SQL. No operational connection or history rewrite.'}));
}catch(e){console.error(e);process.exitCode=1}finally{await db.close()}




