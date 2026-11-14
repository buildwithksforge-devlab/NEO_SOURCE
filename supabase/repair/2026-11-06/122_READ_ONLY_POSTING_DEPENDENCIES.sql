BEGIN READ ONLY;
SELECT jsonb_build_object(
 'diagnostic_version','queue-laundry-finance-dependencies-v1',
 'read_only',current_setting('transaction_read_only'),
 'functions',(SELECT jsonb_agg(jsonb_build_object('signature',p.oid::regprocedure::text,'definition',pg_get_functiondef(p.oid),'md5',md5(pg_get_functiondef(p.oid)),'security_definer',p.prosecdef,'settings',p.proconfig) ORDER BY p.oid::regprocedure::text)
  FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname IN ('neo_finance_post_source','neo_finance_post_txn','folio_post_charge','neo_autopost_on_finalise','neo_autopost_txn','neo_laundry_posting_invariant','neo_laundry_stamp_delivered','neo_record_posting_receipt','neo_receipt_resolve_journal','neo_pos_folio_journal_receipts','proc_three_way_match','neo_matching_policy','neo_branch_in_scope','current_access_scope','neo_kitchen_route_order_item','neo_station_consumption_location')),
 'columns',(SELECT jsonb_agg(jsonb_build_object('table',table_name,'column',column_name,'type',data_type) ORDER BY table_name,ordinal_position)
  FROM information_schema.columns WHERE table_schema='public' AND table_name IN ('guest_laundry_orders','guest_laundry_items','laundry_batches','supplier_invoices','goods_receipts','supplier_invoice_lines','goods_receipt_lines')),
 'triggers',(SELECT jsonb_agg(jsonb_build_object('table',c.relname,'definition',pg_get_triggerdef(t.oid),'function',p.oid::regprocedure::text,'enabled',t.tgenabled) ORDER BY c.relname,t.tgname)
  FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace JOIN pg_proc p ON p.oid=t.tgfoid
  WHERE n.nspname='public' AND NOT t.tgisinternal AND c.relname IN ('folio_lines','finance_posting_receipts')),
 'scope','Installed code, schema and trigger inspection only. No delivery, payment, stock movement, invoice acceptance, journal posting or historical retry is invoked.'
) AS diagnostic;
COMMIT;
