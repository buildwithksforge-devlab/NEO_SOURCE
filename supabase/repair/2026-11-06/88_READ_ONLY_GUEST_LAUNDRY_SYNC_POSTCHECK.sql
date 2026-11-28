BEGIN TRANSACTION READ ONLY;
WITH expected(signature,hash,table_name) AS (VALUES
 ('public.neo_laundry_completion_guard()','540a6b0d0bab50fa93a2b00e2fe923d2','public.guest_laundry_orders'),
 ('public.neo_sync_guest_laundry_from_batch()','953323beb987b7f9eeab678c74745697','public.laundry_batches')
), checks AS (
 SELECT signature,coalesce(md5(pg_get_functiondef(to_regprocedure(signature)))=hash,false) AS definition_matches,
 EXISTS(SELECT 1 FROM pg_trigger t WHERE t.tgrelid=to_regclass(table_name) AND t.tgfoid=to_regprocedure(signature) AND t.tgenabled IN ('O','A')) AS trigger_enabled
 FROM expected
)
SELECT jsonb_build_object('diagnostic_version','guest-laundry-sync-install-v1','read_only',current_setting('transaction_read_only'),
 'checks',(SELECT jsonb_agg(to_jsonb(c)) FROM checks c),
 'code_verified',(SELECT bool_and(definition_matches AND trigger_enabled) FROM checks),
 'scope','Code installation only. No laundry status, delivery, charge or historical order was changed by this check.') AS diagnostic;
COMMIT;
