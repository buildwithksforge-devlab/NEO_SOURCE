-- Read-only installation evidence; business figures are reviewed in the signed-in finance screen.
BEGIN READ ONLY;
SELECT jsonb_build_object(
 'diagnostic_version','pos-folio-reporting-install-v1','read_only',current_setting('transaction_read_only'),
 'report_definition_matches',md5(pg_get_functiondef('public.neo_revenue_reconciliation(uuid,date,date)'::regprocedure))='18b839422b51de507a25fbea284f9417',
 'queue_unchanged',md5(pg_get_functiondef('public.neo_finance_posting_queue(uuid,date,date)'::regprocedure))='06e9f84092e8c40e6dcc1e159b503d08',
 'module_labels_unchanged',md5(pg_get_functiondef('public.neo_module_label(text)'::regprocedure))='e6312572eccc754986d64709417bd5bd',
 'timezone_unchanged',md5(pg_get_functiondef('public.neo_fact_timezone(uuid,uuid)'::regprocedure))='4c145132e437e9a1a4f28029840fe85e',
 'export_unchanged',md5(pg_get_functiondef('public.neo_reconciliation_export(uuid,date,date)'::regprocedure))='6b8185725999d25e672541c5278df5ec',
 'scope','Installed reporting code only. POS/folio figures require live review; other streams remain explicitly uncertified. No financial rows changed by installation.'
) AS diagnostic;
COMMIT;