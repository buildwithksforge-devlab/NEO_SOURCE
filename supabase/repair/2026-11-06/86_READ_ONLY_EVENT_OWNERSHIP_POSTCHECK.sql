-- Installation evidence only; no requirement/task is created or rewritten.
BEGIN TRANSACTION READ ONLY;
SELECT jsonb_build_object(
 'diagnostic_version','event-requirement-ownership-install-v1',
 'read_only',current_setting('transaction_read_only'),
 'definition_matches',coalesce(md5(pg_get_functiondef(to_regprocedure('public.neo_event_requirement_ownership_guard()')))='f4370deb89cf9c129a0c8c804c60ed42',false),
 'trigger_enabled',EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid=to_regclass('public.event_department_requirements') AND tgname='neo_event_requirement_ownership' AND tgenabled='O'),
 'helper_private',CASE WHEN to_regprocedure('public.neo_event_requirement_ownership_guard()') IS NULL THEN false ELSE
  NOT has_function_privilege('anon','public.neo_event_requirement_ownership_guard()','execute')
  AND NOT has_function_privilege('authenticated','public.neo_event_requirement_ownership_guard()','execute') END,
 'scope','Code installation only. Existing requirements/tasks are not rewritten; historical null ownership requires explicit review. Full BEO handoffs remain separate.'
) AS diagnostic;
COMMIT;
