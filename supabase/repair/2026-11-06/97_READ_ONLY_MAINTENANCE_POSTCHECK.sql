-- READ ONLY. Schema/function proof only; no status transition or room release.
SELECT p.oid::regprocedure AS signature,p.prosecdef,p.proconfig,
 has_function_privilege('anon',p.oid,'EXECUTE') AS anon_execute,
 has_function_privilege('authenticated',p.oid,'EXECUTE') AS staff_execute,
 md5(replace(p.prosrc,E'\r\n',E'\n')) AS source_md5
FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public'
AND p.proname IN ('neo_maint_job_advance','wo_set_block','wo_track_status','neo_maintenance_lifecycle_guard');
SELECT tgname,tgenabled,pg_get_triggerdef(oid) AS definition FROM pg_trigger
WHERE tgrelid='public.maintenance_work_orders'::regclass AND NOT tgisinternal ORDER BY tgname;
