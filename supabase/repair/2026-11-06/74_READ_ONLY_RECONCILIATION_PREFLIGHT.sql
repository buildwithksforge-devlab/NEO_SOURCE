-- Diagnostic only. No posting, backfill, status change, grants or financial writes.
BEGIN READ ONLY;
WITH scope AS (
 SELECT 'aa17d427-f816-49bc-b02e-1a89e44806a2'::uuid AS org,
 '2addbd01-c643-406a-bd7d-fac1aa76b23c'::uuid AS branch
), states AS (
 SELECT s.source_module,s.operational_state,s.financial_state,s.currency,
 count(*) AS records,sum(s.amount) AS gross_state_amount
 FROM public.canonical_transaction_states s JOIN scope c ON s.organization_id=c.org AND s.branch_id=c.branch
 WHERE s.occurred_at::date BETWEEN DATE '2026-11-01' AND DATE '2026-11-07'
 GROUP BY 1,2,3,4
), receipts AS (
 SELECT r.source_module,r.posting_type,r.status,r.currency,count(*) AS records,sum(r.amount) AS amount
 FROM public.finance_posting_receipts r JOIN scope c ON r.organization_id=c.org AND r.branch_id=c.branch
 WHERE coalesce(r.occurred_on,r.created_at::date) BETWEEN DATE '2026-11-01' AND DATE '2026-11-07'
 GROUP BY 1,2,3,4
)
SELECT jsonb_build_object('diagnostic_version','reconciliation-lifecycle-preflight-v1',
 'read_only',current_setting('transaction_read_only'),
 'functions',(SELECT jsonb_agg(jsonb_build_object('signature',p.oid::regprocedure::text,
 'definition_md5',md5(pg_get_functiondef(p.oid)),'definition',pg_get_functiondef(p.oid)))
 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public'
 AND p.proname IN ('neo_revenue_reconciliation','neo_finance_posting_queue',
 'neo_module_label','neo_canonical_posting_module','neo_fact_timezone','neo_reconciliation_export')),
 'state_totals',coalesce((SELECT jsonb_agg(to_jsonb(s)) FROM states s),'[]'::jsonb),
 'receipt_totals',coalesce((SELECT jsonb_agg(to_jsonb(r)) FROM receipts r),'[]'::jsonb),
 'source_columns',(SELECT jsonb_agg(jsonb_build_object('table',table_name,'column',column_name,'type',data_type))
 FROM information_schema.columns WHERE table_schema='public' AND table_name IN
 ('pos_orders','folio_lines','guest_laundry_orders','event_bookings','invoices','delivery_orders')
 AND column_name IN ('organization_id','branch_id','status','order_status','payment_status',
 'grand_total','subtotal','discount_total','tax_total','service_charge_total','total_amount','amount',
 'gross_amount','net_amount','discount_amount','tax_amount','service_charge_amount','total',
 'currency','closed_at','created_at','operational_date','posting_date','line_type','source_module','folio_id')),
 'scope','Aggregate lifecycle evidence and installed definitions; open/draft queue amounts are not assumed to be earned revenue.'
) AS diagnostic;
COMMIT;
