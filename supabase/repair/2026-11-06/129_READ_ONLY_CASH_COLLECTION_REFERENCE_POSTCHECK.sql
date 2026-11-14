BEGIN READ ONLY;
SELECT jsonb_build_object('diagnostic_version','cash-collection-reference-install-v1','read_only',current_setting('transaction_read_only'),'definition_matches',md5(pg_get_functiondef(to_regprocedure('public.neo_cash_settle_request(uuid)')))='c38bd26dca6fc57ae0bf4a8a3b3fb87b','scope','Code only. No historical payment, receipt, order, till or journal changed; fresh collection workflow acceptance remains separate.') AS diagnostic;
COMMIT;
