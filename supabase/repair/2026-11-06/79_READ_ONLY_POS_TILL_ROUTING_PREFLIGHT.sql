-- Read-only installed routing contracts and aggregate integrity signals. No payment/shift action.
BEGIN READ ONLY;
WITH scope AS (
 SELECT 'aa17d427-f816-49bc-b02e-1a89e44806a2'::uuid AS org,
 '2addbd01-c643-406a-bd7d-fac1aa76b23c'::uuid AS branch
), payment_scope AS (
 SELECT p.*,s.organization_id AS shift_org,s.branch_id AS shift_branch,
 s.status AS shift_status,s.opened_at AS shift_opened_at,to_jsonb(s)->>'closed_at' AS shift_closed_at
 FROM public.pos_payments p JOIN scope c ON p.organization_id=c.org AND p.branch_id=c.branch
 LEFT JOIN public.pos_shifts s ON s.id=p.shift_id
 WHERE coalesce(p.paid_at,p.created_at) >= TIMESTAMPTZ '2026-11-01 00:00:00+03'
 AND coalesce(p.paid_at,p.created_at) < TIMESTAMPTZ '2026-11-08 00:00:00+03'
)
SELECT jsonb_build_object('diagnostic_version','pos-till-routing-preflight-v1',
 'read_only',current_setting('transaction_read_only'),
 'functions',(SELECT jsonb_agg(jsonb_build_object('signature',p.oid::regprocedure::text,
 'definition_md5',md5(pg_get_functiondef(p.oid)),'definition',pg_get_functiondef(p.oid),
 'security_definer',p.prosecdef,'settings',p.proconfig))
 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
 WHERE n.nspname='public' AND p.proname IN ('neo_cash_till_context','neo_cash_request_pos_payment',
 'neo_cash_settle_request','neo_cash_confirm_request','neo_cash_request_payment',
 'pos_record_payment_attempt','pos_reconcile_settlement_internal','pos_reconcile_order_settlement',
 'neo_branch_in_scope','neo_pos_shift_close','neo_pos_shift_open')),
 'payment_shift_signals',(SELECT jsonb_build_object('payments',count(*),
 'confirmed_cash_without_shift',count(*) FILTER(WHERE status='confirmed' AND method='cash' AND shift_id IS NULL),
 'missing_shift_record',count(*) FILTER(WHERE shift_id IS NOT NULL AND shift_org IS NULL),
 'cross_org_shift',count(*) FILTER(WHERE shift_org IS NOT NULL AND shift_org<>organization_id),
 'cross_property_shift',count(*) FILTER(WHERE shift_branch IS NOT NULL AND shift_branch<>branch_id),
 'paid_before_shift_open',count(*) FILTER(WHERE paid_at<shift_opened_at),
 'paid_after_shift_closed',count(*) FILTER(WHERE shift_closed_at IS NOT NULL AND paid_at>shift_closed_at::timestamptz))
 FROM payment_scope),
 'shift_totals',(SELECT jsonb_agg(to_jsonb(t)) FROM (
 SELECT s.status,count(*) AS records,min(s.opened_at) AS oldest_opened_at,max(s.opened_at) AS newest_opened_at
 FROM public.pos_shifts s JOIN scope c ON s.organization_id=c.org AND s.branch_id=c.branch GROUP BY s.status)t),
 'columns',(SELECT jsonb_agg(jsonb_build_object('table',table_name,'column',column_name,'type',data_type))
 FROM information_schema.columns WHERE table_schema='public' AND table_name IN
 ('pos_shifts','cash_payment_requests','pos_payments','pos_orders')),
 'scope','Historical signals require interpretation; a shift closed today is not proof it was closed when a payment was received. No historical attribution is rewritten.'
) AS diagnostic;
COMMIT;
