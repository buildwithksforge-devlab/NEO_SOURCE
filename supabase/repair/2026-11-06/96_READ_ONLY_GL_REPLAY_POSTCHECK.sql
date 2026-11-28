BEGIN READ ONLY;
SET LOCAL search_path=public;
SELECT jsonb_build_object('diagnostic_version','gl-replay-code-postcheck-v1','read_only',current_setting('transaction_read_only'),
 'definition_matches',coalesce(md5(pg_get_functiondef(to_regprocedure('public.neo_gl_post(uuid,uuid,text,text,uuid,text,date,text,text,jsonb,uuid,uuid)')))='08e96545d8fc2cfe60b3839131c4ee08',false),
 'posting_engine_unchanged',coalesce(md5(pg_get_functiondef(to_regprocedure('public.fin_post_journal(uuid)')))='4162e3e7a44d05a75389087945abe2b2',false),
 'scope','Code only. No historical journal, payment, receipt or period is changed. Future explicit retries still require valid lines, accounts and periods.') AS diagnostic;
COMMIT;
