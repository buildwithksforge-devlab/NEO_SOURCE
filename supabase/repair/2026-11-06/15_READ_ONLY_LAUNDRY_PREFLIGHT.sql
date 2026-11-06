-- Read-only: save every result before considering the laundry transaction.
SELECT current_database(),current_user;
SELECT n.nspname,p.proname,pg_get_function_identity_arguments(p.oid) AS arguments,
       md5(replace(p.prosrc,E'\r\n',E'\n')) AS source_md5,pg_get_functiondef(p.oid) AS definition
FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
WHERE n.nspname='public' AND p.proname IN
('neo_laundry_retry_posting','neo_laundry_autopost_after_delivery','neo_laundry_order_advance',
 'neo_finance_post_source','laundry_post_charge','folio_post_charge','neo_laundry_completion_guard',
 'neo_sync_guest_laundry_from_batch','neo_branch_in_scope','neo_fact_currency','log_audit_event','next_document_number');
SELECT table_name,column_name,data_type,is_nullable,column_default
FROM information_schema.columns WHERE table_schema='public' AND table_name IN
('guest_laundry_orders','guest_laundry_items','laundry_price_items','folios','stays','reservations','finance_posting_receipts')
ORDER BY table_name,ordinal_position;
SELECT c.relname,t.tgname,pg_get_triggerdef(t.oid) AS definition
FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace
WHERE n.nspname='public' AND c.relname IN ('guest_laundry_orders','laundry_batches','folio_lines') AND NOT t.tgisinternal;
SELECT version FROM supabase_migrations.schema_migrations
WHERE version IN ('20261106091000','20261106091100','20261106091200') ORDER BY version;
