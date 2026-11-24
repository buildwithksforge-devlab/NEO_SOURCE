BEGIN READ ONLY;
SET LOCAL search_path=public;
SELECT jsonb_build_object('diagnostic_version','stock-count-completeness-code-v1','read_only',current_setting('transaction_read_only'),
 'definition_matches',coalesce(md5(pg_get_functiondef(to_regprocedure('public.neo_stores_count_submit_variance(uuid,text)')))='c16e752accfd06c60527171ecfe685d6',false),
 'scope','Code only. No count, correction or stock row changed. Actual physical counts and independent correction approval remain separate acceptance work.') AS diagnostic;
COMMIT;
