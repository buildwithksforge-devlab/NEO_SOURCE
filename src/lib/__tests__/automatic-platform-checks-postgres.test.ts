import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { beforeAll, beforeEach, afterAll, describe, it, expect } from 'vitest';
const sql = readFileSync('supabase/migrations/20261119160000_automatic_platform_checks.sql', 'utf8');
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
describe('automatic platform evidence and defects', () => {
 let db: PGlite;
 beforeAll(async () => {
  db = new PGlite();
  await db.exec(`CREATE SCHEMA auth; CREATE ROLE authenticated; CREATE ROLE anon; CREATE ROLE service_role;
   CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql AS $$ SELECT nullif(current_setting('test.actor',true),'')::uuid $$;
   CREATE FUNCTION current_org_id() RETURNS uuid LANGUAGE sql AS $$ SELECT nullif(current_setting('test.org',true),'')::uuid $$;
   CREATE FUNCTION is_org_admin() RETURNS boolean LANGUAGE sql AS $$ SELECT coalesce(current_setting('test.allow',true),'true')='true' $$;
   CREATE FUNCTION has_permission(text,text,text) RETURNS boolean LANGUAGE sql AS $$ SELECT false $$;
   CREATE FUNCTION neo_branch_in_scope(uuid) RETURNS boolean LANGUAGE sql AS $$ SELECT $1='${id(2)}'::uuid $$;
   CREATE TABLE branches(id uuid PRIMARY KEY,organization_id uuid,active boolean);
   CREATE TABLE test_runs(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),organization_id uuid,environment text,status text,passed int DEFAULT 0,failed int DEFAULT 0,blocked int DEFAULT 0,evidence_reference text,notes text,started_at timestamptz,finished_at timestamptz);
   CREATE TABLE test_case_results(id uuid DEFAULT gen_random_uuid(),organization_id uuid,run_id uuid,status text,actual_result text,evidence_reference text,tested_at timestamptz);
   CREATE TABLE defects(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),organization_id uuid,branch_id uuid,reference text,environment text,module text,summary text,actual_result text,severity text,status text,release_blocking boolean,evidence_reference text,updated_at timestamptz,retest_status text,resolved_at timestamptz);
   CREATE TABLE neo_test_runs(id uuid PRIMARY KEY,control_org_id uuid,status text,started_at timestamptz DEFAULT now(),finished_at timestamptz,failure_detail text);
   CREATE TABLE neo_test_results(id uuid PRIMARY KEY,run_id uuid,control_org_id uuid,suite text,case_key text,name text,status text,detail text,assertions jsonb DEFAULT '[]');
   CREATE TABLE neo_blind_receiving_counts(id uuid,organization_id uuid,branch_id uuid,status text,posted_grn_id uuid,purchase_order_id uuid);
   CREATE TABLE goods_receipts(id uuid,organization_id uuid,branch_id uuid,order_id uuid);
   CREATE TABLE purchase_orders(id uuid,organization_id uuid,branch_id uuid);
   CREATE TABLE menu_items(id uuid,organization_id uuid,branch_id uuid,consumption_mode text,stock_item_id uuid,station_id uuid);
   CREATE TABLE stock_items(id uuid,organization_id uuid,branch_id uuid);
   CREATE TABLE operational_stations(id uuid,organization_id uuid,branch_id uuid,active boolean);
   CREATE TABLE station_consumption_stores(station_id uuid,organization_id uuid,branch_id uuid,location_id uuid);
   CREATE TABLE stock_locations(id uuid,organization_id uuid,branch_id uuid,active boolean,is_main boolean,location_type text);`);
  await db.exec(sql);
 }, 60000);
 afterAll(async () => db?.close());
 beforeEach(async () => {
  await db.exec(`RESET ROLE; TRUNCATE branches,test_runs,test_case_results,defects,neo_test_runs,neo_test_results,neo_blind_receiving_counts,goods_receipts,purchase_orders,menu_items,stock_items,operational_stations,station_consumption_stores,stock_locations;
   INSERT INTO branches VALUES('${id(2)}','${id(1)}',true),('${id(4)}','${id(3)}',true);
   SELECT set_config('test.org','${id(1)}',false),set_config('test.actor','${id(10)}',false),set_config('test.allow','true',false);`);
 });
 const run = async () => (await db.query<{r:any}>(`SELECT neo_platform_run_checks('${id(2)}') r`)).rows[0].r;
 it('saves real checks and reuses a recent run without duplicates', async () => {
  expect(await run()).toMatchObject({passed:4,failed:0,blocked:0,cached:false});
  expect(await run()).toMatchObject({cached:true});
  expect((await db.query('SELECT * FROM test_case_results')).rows).toHaveLength(4);
 });
 it('finds a disappearing GRN and does not manufacture a replacement or stock movement', async () => {
  await db.exec(`INSERT INTO neo_blind_receiving_counts VALUES('${id(20)}','${id(1)}','${id(2)}','posted','${id(21)}','${id(22)}');`);
  expect(await run()).toMatchObject({failed:1});
  expect((await db.query('SELECT * FROM defects')).rows).toHaveLength(1);
  expect((await db.query('SELECT * FROM goods_receipts')).rows).toHaveLength(0);
 });
 it('deduplicates recurring failures, retains manual triage and records a passed retest', async () => {
  await db.exec(`INSERT INTO neo_blind_receiving_counts VALUES('${id(20)}','${id(1)}','${id(2)}','posted','${id(21)}','${id(22)}');`);
  await run(); await db.exec(`UPDATE defects SET status='in_progress'; UPDATE test_runs SET finished_at=now()-interval '16 minutes';`);
  await run(); expect((await db.query('SELECT * FROM defects')).rows).toHaveLength(1);
  await db.exec(`INSERT INTO goods_receipts VALUES('${id(21)}','${id(1)}','${id(2)}','${id(22)}'); INSERT INTO purchase_orders VALUES('${id(22)}','${id(1)}','${id(2)}'); UPDATE test_runs SET finished_at=now()-interval '16 minutes';`);
  await run(); expect((await db.query('SELECT status,retest_status FROM defects')).rows[0]).toMatchObject({status:'in_progress',retest_status:'passed'});
 });
 it('records a broken check as blocked with a defect instead of green or lost evidence', async () => {
  await db.exec('DROP TABLE stock_items'); expect(await run()).toMatchObject({blocked:1});
  expect((await db.query(`SELECT * FROM defects WHERE release_blocking=false`)).rows).toHaveLength(1);
  await db.exec('CREATE TABLE stock_items(id uuid,organization_id uuid,branch_id uuid)');
 });
 it('denies anonymous, unauthorized and foreign-property runs', async () => {
  await db.exec(`SELECT set_config('test.actor','',false)`); await expect(run()).rejects.toThrow('Not permitted');
  await db.exec(`SELECT set_config('test.actor','${id(10)}',false),set_config('test.allow','false',false)`); await expect(run()).rejects.toThrow('Not permitted');
  await db.exec(`SELECT set_config('test.allow','true',false)`); await expect(db.query(`SELECT neo_platform_run_checks('${id(4)}')`)).rejects.toThrow('Not permitted');
 });
 it('does not let staff bypass the scoped wrapper or invoke the all-property scheduler', async () => {
  await db.exec('SET ROLE authenticated');
  await expect(db.query(`SELECT neo_platform_checks_internal('${id(3)}','${id(4)}')`)).rejects.toThrow('permission denied');
  await expect(db.query('SELECT neo_platform_checks_scheduled()')).rejects.toThrow('permission denied');
  await db.exec('RESET ROLE');
 });
 it('scheduled checks cover each organisation without crossing their saved evidence', async () => {
  await db.query('SELECT neo_platform_checks_scheduled()');
  expect((await db.query('SELECT DISTINCT organization_id FROM test_runs')).rows).toHaveLength(2);
 });
 it('projects simulation cases into Quality and records failure before the run finishes', async () => {
  await db.exec(`INSERT INTO neo_test_runs(id,control_org_id,status) VALUES('${id(30)}','${id(1)}','running');
   INSERT INTO neo_test_results(id,run_id,control_org_id,suite,case_key,name,status,detail) VALUES('${id(31)}','${id(30)}','${id(1)}','receiving','grn','Saved GRN','fail','GRN missing');`);
  expect((await db.query('SELECT status,failed FROM test_runs')).rows[0]).toMatchObject({status:'running',failed:1});
  expect((await db.query('SELECT * FROM defects')).rows).toHaveLength(1);
  await db.exec(`UPDATE neo_test_runs SET status='failed',finished_at=now() WHERE id='${id(30)}'`);
  expect((await db.query('SELECT status FROM test_runs')).rows[0]).toMatchObject({status:'failed'});
 });
 it('logs a runner failure with no completed cases', async () => {
  await db.exec(`INSERT INTO neo_test_runs(id,control_org_id,status) VALUES('${id(30)}','${id(1)}','running'); UPDATE neo_test_runs SET status='failed',finished_at=now(),failure_detail='Runner lost connection' WHERE id='${id(30)}'`);
  expect((await db.query('SELECT status,failed FROM test_runs')).rows[0]).toMatchObject({status:'failed',failed:1});
  expect((await db.query('SELECT * FROM defects')).rows).toHaveLength(1);
 });
});
