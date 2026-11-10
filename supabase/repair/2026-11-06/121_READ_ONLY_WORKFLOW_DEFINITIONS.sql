BEGIN READ ONLY;
SELECT jsonb_build_object(
 'diagnostic_version','queue-readiness-laundry-routing-preflight-v1',
 'read_only',current_setting('transaction_read_only'),
 'functions',(SELECT jsonb_agg(jsonb_build_object('signature',p.oid::regprocedure::text,'definition',pg_get_functiondef(p.oid),'md5',md5(pg_get_functiondef(p.oid)),'security_definer',p.prosecdef,'settings',p.proconfig) ORDER BY p.oid::regprocedure::text)
  FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname IN (
   'neo_go_live_readiness','neo_menu_validation_states','laundry_post_charge','neo_laundry_retry_posting',
   'neo_laundry_order_advance','neo_laundry_autopost_after_delivery','neo_laundry_completion_guard','neo_laundry_order_create',
   'neo_pos_route_tickets_internal','neo_pos_order_is_kitchen_bound','neo_supplier_invoice_accept','neo_grn_post_accrual','neo_supplier_invoice_match')),
 'columns',(SELECT jsonb_agg(jsonb_build_object('table',table_name,'column',column_name,'type',data_type) ORDER BY table_name,ordinal_position)
  FROM information_schema.columns WHERE table_schema='public' AND table_name IN ('guest_laundry_orders','guest_laundry_items','laundry_batches','supplier_invoices','goods_receipts','supplier_invoice_lines','goods_receipt_lines')),
 'triggers',(SELECT jsonb_agg(jsonb_build_object('table',c.relname,'definition',pg_get_triggerdef(t.oid),'function',p.oid::regprocedure::text,'enabled',t.tgenabled) ORDER BY c.relname,t.tgname)
  FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace JOIN pg_proc p ON p.oid=t.tgfoid
  WHERE n.nspname='public' AND NOT t.tgisinternal AND c.relname IN ('guest_laundry_orders','laundry_batches')),
 'scope','Installed code, schema and trigger inspection only. No delivery, payment, stock movement, invoice acceptance, journal posting or historical retry is invoked.'
) AS diagnostic;
COMMIT;
