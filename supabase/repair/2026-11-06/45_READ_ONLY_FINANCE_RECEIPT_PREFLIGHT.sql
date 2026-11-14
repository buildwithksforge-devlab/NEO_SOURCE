-- NEØ existing-project finance/receipt inventory.
-- Read-only: no financial rows, company settings, functions or history are changed.
-- Run in the SAME operational project already used by NEØ. Do not create/move a database.
-- Keep returned function definitions in the private repair evidence folder.
BEGIN READ ONLY;

SELECT current_database() AS database_name,
       current_user AS inspection_role,
       current_setting('TimeZone') AS timezone,
       current_setting('transaction_read_only') AS read_only;

-- Establish the actual deployed definitions before changing financial calculations.
SELECT p.oid::regprocedure::text AS signature,
       md5(pg_get_functiondef(p.oid)) AS definition_md5,
       pg_get_functiondef(p.oid) AS definition
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public'
  AND p.prokind = 'f'
  AND p.proname IN (
    'pos_recalc_order_totals',
    'tg_pos_order_totals_authoritative',
    'tg_pos_recalc_order_totals',
    'neo_pos_apply_discount',
    'pos_reconcile_settlement_internal',
    'neo_pos_settlement_evidence',
    'neo_document_payload'
  )
ORDER BY p.proname, signature;

-- Schema only: no prices, payment instructions, personal details or credentials.
SELECT table_name, ordinal_position, column_name, data_type,
       is_nullable, column_default
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name IN (
    'pos_orders', 'pos_order_items', 'pos_payments', 'pos_discounts',
    'menu_items', 'tax_codes', 'tax_transactions', 'invoices',
    'invoice_lines', 'journal_entries', 'journal_lines', 'cashier_sessions'
  )
ORDER BY table_name, ordinal_position;

SELECT c.relname AS table_name, t.tgname AS trigger_name,
       t.tgenabled AS enabled, pg_get_triggerdef(t.oid) AS definition
FROM pg_trigger t
JOIN pg_class c ON c.oid = t.tgrelid
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public'
  AND NOT t.tgisinternal
  AND c.relname IN ('pos_orders', 'pos_order_items', 'pos_payments', 'tax_codes')
ORDER BY c.relname, t.tgname;

SELECT tablename, policyname, roles, cmd, qual, with_check
FROM pg_policies
WHERE schemaname = 'public'
  AND tablename IN ('pos_orders', 'pos_order_items', 'pos_payments',
                    'pos_discounts', 'menu_items', 'tax_codes')
ORDER BY tablename, policyname;

COMMIT;
