BEGIN READ ONLY;
SET LOCAL search_path=public;
SELECT jsonb_build_object('diagnostic_version','store-movement-boundaries-code-v1','read_only',current_setting('transaction_read_only'),
 'definition_matches',coalesce(md5(pg_get_functiondef(to_regprocedure('public.neo_stores_issue(uuid,jsonb,uuid,uuid,text,text)')))='2cde096a47ff1adcd880fbc36d2b9352',false),
 'scope','Code only. No historical stock, movement, journal or attempt changed. Physical inventory and complete requisition/return/replacement acceptance remain separate.') AS diagnostic;
COMMIT;
