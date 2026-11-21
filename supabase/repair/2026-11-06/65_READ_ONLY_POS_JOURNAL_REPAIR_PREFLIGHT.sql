-- NEØ POS journal/revenue repair preflight. ONE exportable result.
-- READ ONLY: no posting, retry, backfill, reversal, state transition or grant change.
-- Scope is the Nairobi organisation/property observed in the user's live review.
-- Exports accounting evidence for only the four reported POS references, without guest/staff contacts.
BEGIN READ ONLY;
WITH scope AS (
 SELECT 'aa17d427-f816-49bc-b02e-1a89e44806a2'::text AS org,
        '2addbd01-c643-406a-bd7d-fac1aa76b23c'::text AS branch
), orders AS (
 SELECT to_jsonb(o) AS obj FROM public.pos_orders o CROSS JOIN scope s
 WHERE to_jsonb(o)->>'organization_id'=s.org AND to_jsonb(o)->>'branch_id'=s.branch
 AND to_jsonb(o)->>'order_number' IN ('POS-20261002-QGIV7','POS-20261104-09ZFT',
  'POS-20261102-EON7D','POS-20261102-XP3WR')
), receipts AS (
 SELECT to_jsonb(r) AS obj FROM public.finance_posting_receipts r CROSS JOIN scope s
 WHERE to_jsonb(r)->>'organization_id'=s.org AND to_jsonb(r)->>'branch_id'=s.branch
 AND to_jsonb(r)->>'source_id' IN (SELECT obj->>'id' FROM orders)
), folio AS (
 SELECT to_jsonb(f) AS obj FROM public.folio_lines f CROSS JOIN scope s
 WHERE to_jsonb(f)->>'organization_id'=s.org AND to_jsonb(f)->>'branch_id'=s.branch
 AND (to_jsonb(f)->>'id' IN (SELECT obj->>'folio_line_id' FROM receipts)
   OR to_jsonb(f)->>'source_record_uuid' IN (SELECT obj->>'id' FROM orders))
), journals AS (
 SELECT to_jsonb(j) AS obj FROM public.journal_entries j CROSS JOIN scope s
 WHERE to_jsonb(j)->>'organization_id'=s.org AND to_jsonb(j)->>'branch_id'=s.branch
 AND (to_jsonb(j)->>'id' IN (SELECT obj->>'journal_id' FROM receipts)
   OR to_jsonb(j)->>'source_document_id' IN (SELECT obj->>'id' FROM orders UNION SELECT obj->>'id' FROM folio))
), evidence AS (
 SELECT 'orders' AS kind,(SELECT jsonb_object_agg(e.key,e.value) FROM jsonb_each(o.obj)e
  WHERE e.key IN ('id','organization_id','branch_id','order_number','order_type','status','payment_status',
  'grand_total','subtotal','discount_total','tax_total','service_charge_total','paid_total','folio_id',
  'folio_line_id','folio_post_status','currency','created_at','closed_at')) AS row FROM orders o
 UNION ALL SELECT 'receipts',(SELECT jsonb_object_agg(e.key,e.value) FROM jsonb_each(r.obj)e
  WHERE e.key IN ('id','organization_id','branch_id','source_module','source_id','source_reference','status',
  'amount','currency','folio_line_id','journal_id','posting_type','idempotency_key','attempts','last_error',
  'detail','occurred_on','updated_at')) FROM receipts r
 UNION ALL SELECT 'folio_lines',(SELECT jsonb_object_agg(e.key,e.value) FROM jsonb_each(f.obj)e
  WHERE e.key IN ('id','organization_id','branch_id','folio_id','source_module','source_record_uuid','status',
  'line_type','category','revenue_centre','gross_amount','tax_amount','service_charge_amount','discount_amount',
  'journal_id','posted_journal_id','currency','operational_date','posting_date')) FROM folio f
 UNION ALL SELECT 'journals',(SELECT jsonb_object_agg(e.key,e.value) FROM jsonb_each(j.obj)e
  WHERE e.key IN ('id','organization_id','branch_id','journal_number','source_module','source_document_type',
  'source_document_id','document_number','idempotency_key','journal_type','accounting_date','status','currency',
  'total_debit','total_credit','reversed_by_journal_id','reverses_journal_id','posted_at','created_at')) FROM journals j
), functions AS (
 SELECT p.oid::regprocedure::text AS signature,p.prosecdef AS security_definer,p.proconfig AS settings,
  md5(pg_get_functiondef(p.oid)) AS definition_md5,pg_get_functiondef(p.oid) AS definition
 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
 WHERE n.nspname='public' AND p.prokind='f' AND p.proname IN (
  'neo_gl_revenue_code_scoped','neo_gl_revenue_code','neo_gl_post','neo_finance_post_txn',
  'neo_post_pos_order','neo_record_posting_receipt','neo_financial_state_from_receipt',
  'neo_pos_room_charge_receipt_link','neo_receipt_resolve_journal','neo_finance_exception_register',
  'neo_finance_post_family','neo_finance_posting_queue','neo_financial_state_set',
  'neo_finance_canonical_mark_posted','neo_journal_canonical_sync','fin_post_journal')
), columns AS (
 SELECT table_name,ordinal_position,column_name,data_type,is_nullable,column_default
 FROM information_schema.columns WHERE table_schema='public' AND table_name IN ('pos_orders',
  'finance_posting_receipts','folio_lines','journal_entries','journal_entry_lines','chart_of_accounts',
  'canonical_transaction_states','financial_states')
), triggers AS (
 SELECT c.relname AS table_name,t.tgname AS trigger_name,t.tgenabled AS enabled,
  pg_get_triggerdef(t.oid) AS definition,p.oid::regprocedure::text AS function_signature,
  md5(pg_get_functiondef(p.oid)) AS function_md5,pg_get_functiondef(p.oid) AS function_definition
 FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace
 JOIN pg_proc p ON p.oid=t.tgfoid WHERE n.nspname='public' AND NOT t.tgisinternal
 AND c.relname IN ('finance_posting_receipts','folio_lines','pos_orders','journal_entries')
), accounts AS (
 SELECT (SELECT jsonb_object_agg(e.key,e.value) FROM jsonb_each(to_jsonb(a))e
  WHERE e.key IN ('id','organization_id','code','name','category','active','postable','is_header')) AS row
 FROM public.chart_of_accounts a CROSS JOIN scope s
 WHERE to_jsonb(a)->>'organization_id'=s.org
 AND to_jsonb(a)->>'code' IN ('4000','4010','4020','4030','4040','4050','4060','4070','4080','4090')
), lines AS (
 SELECT (SELECT jsonb_object_agg(e.key,e.value) FROM jsonb_each(to_jsonb(l))e
  WHERE e.key IN ('id','organization_id','branch_id','journal_id','line_number','account_id','debit','credit',
  'revenue_centre','payment_method','tax_code_id')) AS row
 FROM public.journal_entry_lines l CROSS JOIN scope s
 WHERE to_jsonb(l)->>'journal_id' IN (SELECT obj->>'id' FROM journals)
)
SELECT jsonb_build_object('diagnostic_version','pos-journal-repair-v1',
 'read_only',current_setting('transaction_read_only'),'scope',(SELECT to_jsonb(s) FROM scope s),
 'order_count',(SELECT count(*) FROM orders),
 'functions',coalesce((SELECT jsonb_agg(to_jsonb(f) ORDER BY signature) FROM functions f),'[]'::jsonb),
 'columns',coalesce((SELECT jsonb_agg(to_jsonb(c) ORDER BY table_name,ordinal_position) FROM columns c),'[]'::jsonb),
 'triggers',coalesce((SELECT jsonb_agg(to_jsonb(t) ORDER BY table_name,trigger_name) FROM triggers t),'[]'::jsonb),
 'orders',coalesce((SELECT jsonb_agg(row) FROM evidence WHERE kind='orders'),'[]'::jsonb),
 'receipts',coalesce((SELECT jsonb_agg(row) FROM evidence WHERE kind='receipts'),'[]'::jsonb),
 'folio_lines',coalesce((SELECT jsonb_agg(row) FROM evidence WHERE kind='folio_lines'),'[]'::jsonb),
 'journals',coalesce((SELECT jsonb_agg(row) FROM evidence WHERE kind='journals'),'[]'::jsonb),
 'journal_lines',coalesce((SELECT jsonb_agg(row) FROM lines),'[]'::jsonb),
 'revenue_accounts',coalesce((SELECT jsonb_agg(row) FROM accounts),'[]'::jsonb)) AS diagnostic;
COMMIT;
