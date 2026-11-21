-- One scoped, read-only result. Does not retry, collect payment or change service status.
BEGIN READ ONLY;
WITH target AS (
 SELECT o.* FROM public.pos_orders o
 WHERE o.id='c1d9c37b-a862-44af-983b-443701434dc9'::uuid
 AND o.organization_id='aa17d427-f816-49bc-b02e-1a89e44806a2'::uuid
 AND o.branch_id='2addbd01-c643-406a-bd7d-fac1aa76b23c'::uuid
), tender AS (
 SELECT to_jsonb(p) AS obj FROM public.pos_payments p JOIN target o ON p.order_id=o.id
), receipt AS (
 SELECT to_jsonb(r) AS obj FROM public.finance_posting_receipts r JOIN target o
 ON r.organization_id=o.organization_id AND r.source_id=o.id
), journals AS (
 SELECT j.* FROM public.journal_entries j JOIN target o ON j.organization_id=o.organization_id
 WHERE j.source_document_id=o.id
 OR j.id IN (SELECT (obj->>'journal_id')::uuid FROM receipt WHERE obj->>'journal_id' IS NOT NULL)
 OR j.idempotency_key LIKE 'pos_order:'||o.id::text||':%'
), evidence AS (
 SELECT 'payments' AS kind,(SELECT jsonb_object_agg(e.key,e.value) FROM jsonb_each(t.obj)e
 WHERE e.key IN ('id','organization_id','branch_id','order_id','amount','currency','method','status',
 'destination_account_id','created_at','paid_at','confirmed_at','voided_at','refunded_at')) AS obj FROM tender t
 UNION ALL SELECT 'receipts',(SELECT jsonb_object_agg(e.key,e.value) FROM jsonb_each(r.obj)e
 WHERE e.key IN ('id','organization_id','branch_id','source_module','source_id','status','amount',
 'currency','journal_id','attempts','last_error','posting_type','idempotency_key','updated_at')) FROM receipt r
)
SELECT jsonb_build_object(
 'diagnostic_version','catering-recovery-preflight-v1','read_only',current_setting('transaction_read_only'),
 'order_count',(SELECT count(*) FROM target),
 'order',(SELECT jsonb_build_object('id',id,'reference',order_number,'status',status,
 'order_type',order_type,'payment_status',payment_status,'amount',grand_total,'paid_total',paid_total,
 'subtotal',subtotal,'discount',discount_total,'tax',tax_total,'service',service_charge_total,
 'currency',currency,'folio_id',folio_id,'created_at',created_at,'closed_at',closed_at) FROM target),
 'payments',coalesce((SELECT jsonb_agg(obj) FROM evidence WHERE kind='payments'),'[]'::jsonb),
 'receipts',coalesce((SELECT jsonb_agg(obj) FROM evidence WHERE kind='receipts'),'[]'::jsonb),
 'journals',coalesce((SELECT jsonb_agg(jsonb_build_object('id',j.id,'status',j.status,
 'source_type',j.source_document_type,'branch_id',j.branch_id,'currency',j.currency,
 'idempotency_key',j.idempotency_key,'total_debit',j.total_debit,'total_credit',j.total_credit,
 'reversed_by',j.reversed_by_journal_id,'reverses',j.reverses_journal_id,
 'actual_lines',(SELECT jsonb_build_object('count',count(*),'debit',sum(l.debit),'credit',sum(l.credit))
 FROM public.journal_entry_lines l WHERE l.journal_id=j.id))) FROM journals j),'[]'::jsonb),
 'accounts',coalesce((SELECT jsonb_agg(jsonb_build_object('code',a.code,'name',a.name,
 'active',a.active,'postable',a.postable,'header',a.is_header)) FROM public.chart_of_accounts a
 JOIN target o ON a.organization_id=o.organization_id WHERE a.code IN ('1010','2040','2050','4050')),'[]'::jsonb),
 'settlement_mapping_definitions',(SELECT jsonb_agg(jsonb_build_object('signature',p.oid::regprocedure::text,
 'definition',pg_get_functiondef(p.oid))) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
 WHERE n.nspname='public' AND p.proname IN ('neo_gl_account_code','neo_gl_settlement_code_for')),
 'scope','Evidence only. Paid service items are still in preparation in the UI; no service transition or financial retry performed.'
) AS diagnostic;
COMMIT;
