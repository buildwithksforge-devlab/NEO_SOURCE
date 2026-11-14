BEGIN TRANSACTION READ ONLY;
SET LOCAL search_path=public;
SELECT jsonb_build_object(
 'diagnostic_version','reservation-folio-status-install-v1',
 'read_only',current_setting('transaction_read_only'),
 'definition_matches',coalesce(md5(pg_get_functiondef(to_regprocedure('public.tg_folio_sync_reservation_payment_status()')))='ce2c9bbed195311a903704ecc2f6a5ff',false),
 'trigger_matches',EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid=to_regclass('public.folios') AND tgname='folio_sync_reservation_payment_status'
   AND tgenabled IN ('O','A') AND md5(pg_get_triggerdef(oid))='10f8dc9c5804c831bdf68731aede8505'),
 'scope','Installed Savannah status code only. No historical status reconciliation, deposit, payment, balance or journal is created or rewritten. Valid other-organization behavior is preserved.'
) AS diagnostic;
COMMIT;
