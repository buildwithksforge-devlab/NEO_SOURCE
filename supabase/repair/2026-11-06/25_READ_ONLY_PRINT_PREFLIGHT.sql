-- READ ONLY. Verify the SQL Editor project is zlrrmrcqlerafptkgucl.
-- Save every result. Do not apply older full printing migrations blindly.
SELECT current_database(),current_user,current_setting('TimeZone');
SELECT to_regclass('public.neo_print_agents') AS agents,to_regclass('public.printer_profiles') AS profiles,to_regclass('public.print_jobs') AS jobs;
SELECT p.oid::regprocedure AS signature,pg_get_function_result(p.oid) AS result,p.proargnames,
 md5(replace(p.prosrc,E'\r\n',E'\n')) AS source_md5,pg_get_functiondef(p.oid) AS definition
FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
WHERE n.nspname='public' AND p.proname IN
 ('neo_print_agent_printers','neo_print_agent_claim','neo_print_agent_finish','neo_print_agent_register','neo_print_agent_revoke','neo_print_enqueue','neo_print_retry','neo_print_queue_station_tickets')
ORDER BY p.proname;
SELECT table_name,column_name,data_type FROM information_schema.columns WHERE table_schema='public'
AND table_name IN ('neo_print_agents','printer_profiles','print_jobs') ORDER BY table_name,ordinal_position;
SELECT schemaname,tablename,policyname,roles,cmd,qual,with_check FROM pg_policies
WHERE schemaname='public' AND tablename IN ('neo_print_agents','printer_profiles','print_jobs');
SELECT version FROM supabase_migrations.schema_migrations
WHERE version IN ('20261101123000','20261106092000') ORDER BY version;
