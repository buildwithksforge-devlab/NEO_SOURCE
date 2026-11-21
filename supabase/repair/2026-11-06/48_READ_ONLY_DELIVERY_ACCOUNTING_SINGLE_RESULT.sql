-- NEØ delivery M-PESA accounting integration preflight, ONE exportable row.
-- Read only: catalogue/definitions only; no operational payment/account rows.
-- The claims table and submit/queue/approve functions were confirmed absent.
-- Do not install historical drafts until the current accounting contract is reviewed.
BEGIN READ ONLY;
WITH functions AS (
 SELECT p.oid::regprocedure::text AS signature,
        pg_get_function_arguments(p.oid) AS arguments,
        pg_get_function_result(p.oid) AS returns,
        p.prosecdef AS security_definer,p.proconfig AS function_settings,
        md5(pg_get_functiondef(p.oid)) AS definition_md5,
        pg_get_functiondef(p.oid) AS definition
 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
 WHERE n.nspname='public' AND p.prokind='f'
 AND p.proname IN ('neo_delivery_record_payment','neo_delivery_record_payment_v2',
   'neo_delivery_can_record_payment','neo_assert_financial_account',
   'neo_gl_account_code','neo_gl_cash_code','fin_post_journal','next_document_number',
   'my_customer_id')
), columns AS (
 SELECT table_name,ordinal_position,column_name,data_type,is_nullable,column_default
 FROM information_schema.columns WHERE table_schema='public'
 AND table_name IN ('invoices','payments','pos_payments','journal_entries',
   'journal_entry_lines','financial_accounts','chart_of_accounts')
), triggers AS (
 SELECT c.relname AS table_name,t.tgname AS trigger_name,t.tgenabled AS enabled,
        pg_get_triggerdef(t.oid) AS definition,
        p.oid::regprocedure::text AS function_signature,
        md5(pg_get_functiondef(p.oid)) AS function_md5,
        pg_get_functiondef(p.oid) AS function_definition
 FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid
 JOIN pg_namespace n ON n.oid=c.relnamespace JOIN pg_proc p ON p.oid=t.tgfoid
 WHERE n.nspname='public' AND NOT t.tgisinternal
 AND c.relname IN ('invoices','payments','pos_payments','journal_entries',
   'journal_entry_lines','delivery_orders')
), constraints AS (
 SELECT c.relname AS table_name,k.conname AS constraint_name,
        pg_get_constraintdef(k.oid) AS definition
 FROM pg_constraint k JOIN pg_class c ON c.oid=k.conrelid
 JOIN pg_namespace n ON n.oid=c.relnamespace
 WHERE n.nspname='public' AND c.relname IN ('invoices','payments','pos_payments',
   'journal_entries','journal_entry_lines')
), indexes AS (
 SELECT tablename,indexname,indexdef FROM pg_indexes
 WHERE schemaname='public' AND tablename IN ('payments','pos_payments','journal_entries')
)
SELECT jsonb_build_object(
 'diagnostic_version','delivery-mpesa-accounting-v1',
 'read_only',current_setting('transaction_read_only'),
 'canonical_payment_present',to_regprocedure('public.neo_delivery_record_payment(uuid,numeric,text,text,text,text,uuid)') IS NOT NULL,
 'functions',coalesce((SELECT jsonb_agg(to_jsonb(f) ORDER BY f.signature) FROM functions f),'[]'::jsonb),
 'columns',coalesce((SELECT jsonb_agg(to_jsonb(c) ORDER BY c.table_name,c.ordinal_position) FROM columns c),'[]'::jsonb),
 'triggers',coalesce((SELECT jsonb_agg(to_jsonb(t) ORDER BY t.table_name,t.trigger_name) FROM triggers t),'[]'::jsonb),
 'constraints',coalesce((SELECT jsonb_agg(to_jsonb(c) ORDER BY c.table_name,c.constraint_name) FROM constraints c),'[]'::jsonb),
 'indexes',coalesce((SELECT jsonb_agg(to_jsonb(i) ORDER BY i.tablename,i.indexname) FROM indexes i),'[]'::jsonb)
) AS diagnostic;
COMMIT;
