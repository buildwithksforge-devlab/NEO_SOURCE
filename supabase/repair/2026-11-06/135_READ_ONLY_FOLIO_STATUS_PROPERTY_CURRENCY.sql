BEGIN READ ONLY;
SELECT jsonb_build_object('diagnostic_version','folio-status-property-currency-install-v1','read_only',current_setting('transaction_read_only'),
 'definition_matches',coalesce(md5(pg_get_functiondef(to_regprocedure('public.tg_folio_sync_reservation_payment_status()')))='55418aec7f0773bafaf29ad7836bad2f',false),
 'trigger_unchanged',EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid=to_regclass('public.folios') AND tgname='folio_sync_reservation_payment_status' AND tgenabled IN ('O','A') AND md5(pg_get_triggerdef(oid))='10f8dc9c5804c831bdf68731aede8505'),
 'checkin_unchanged',coalesce(md5(pg_get_functiondef(to_regprocedure('public.pms_check_in(uuid,integer,text)')))='e1b9f2a87464b3389ac5a146bdd7b459',false),
 'currency_provider_unchanged',coalesce(md5(pg_get_functiondef(to_regprocedure('public.neo_fact_currency(uuid,uuid)')))='3984f441e328cd003673b39f3f858ef5',false),
 'scope','One trigger-function correction only. No guest check-in, deposit application, payment, reservation status or balance is executed or rewritten.') AS diagnostic;
COMMIT;
