-- READ ONLY. Confirm SQL Editor project zlrrmrcqlerafptkgucl before running.
SELECT current_database(),current_user,current_setting('TimeZone');
SELECT p.oid::regprocedure AS signature,p.proargnames,md5(replace(p.prosrc,E'\r\n',E'\n')) AS source_md5,
 pg_get_functiondef(p.oid) AS definition FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
WHERE n.nspname='public' AND p.proname IN ('neo_maint_job_advance','wo_set_block','ops_set_room_status','rooms_derive_state','wo_track_status','neo_guard_maintenance_assignee','neo_maintenance_technician_eligible','neo_maint_asset_service_record','log_audit_event') ORDER BY p.proname;
SELECT c.relname,t.tgname,t.tgenabled,pg_get_triggerdef(t.oid) AS definition
FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace
WHERE n.nspname='public' AND c.relname IN ('maintenance_work_orders','rooms') AND NOT t.tgisinternal;
SELECT table_name,column_name,data_type FROM information_schema.columns WHERE table_schema='public'
AND table_name IN ('maintenance_work_orders','rooms','work_order_status_history') ORDER BY table_name,ordinal_position;
SELECT schemaname,tablename,policyname,cmd,qual,with_check FROM pg_policies WHERE schemaname='public'
AND tablename IN ('maintenance_work_orders','rooms');
SELECT version FROM supabase_migrations.schema_migrations WHERE version IN ('20261025140000','20261106093000') ORDER BY version;
