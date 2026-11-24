-- READ ONLY. Schema/access evidence only; no search or print is initiated.
SELECT column_name,data_type FROM information_schema.columns WHERE table_schema='public' AND table_name='neo_print_agents'
AND column_name LIKE 'discovery_%' ORDER BY column_name;
SELECT p.oid::regprocedure AS signature,p.prosecdef,p.proconfig,
 has_function_privilege('anon',p.oid,'EXECUTE') AS anon_execute,
 has_function_privilege('authenticated',p.oid,'EXECUTE') AS staff_execute,
 has_function_privilege('service_role',p.oid,'EXECUTE') AS service_execute
FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
WHERE n.nspname='public' AND p.proname IN
('neo_print_discovery_authorize','neo_print_discovery_request','neo_print_discovery_status','neo_print_agent_discovery_poll','neo_print_agent_discovery_report') ORDER BY p.proname;
SELECT id,name,branch_id,active,last_seen_at FROM public.neo_print_agents ORDER BY created_at;
