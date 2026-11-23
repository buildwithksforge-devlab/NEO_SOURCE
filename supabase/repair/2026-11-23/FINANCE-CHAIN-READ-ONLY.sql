-- The configured property identifies the Savanna Crown workspace. All of its
-- properties are included. Edit the date range as needed. End date is exclusive.
-- Results contain aggregate counts and amounts only. A review flag is not proof of a loss.
WITH settings AS (
  SELECT '2addbd01-c643-406a-bd7d-fac1aa76b23c'::uuid AS anchor_property,
    DATE '2026-11-01' AS first_day, DATE '2026-12-01' AS end_day
), scope AS (
  SELECT b.organization_id AS org,g.first_day,g.end_day
  FROM settings g JOIN public.branches b ON b.id=g.anchor_property
  WHERE g.first_day<g.end_day
), orders AS (
  SELECT o.id,o.organization_id,o.branch_id,o.currency,o.grand_total,o.paid_total,
    coalesce(p.confirmed,0) AS confirmed,coalesce(p.pending,0)+coalesce(c.pending,0) AS pending
  FROM scope s JOIN public.pos_orders o ON o.organization_id=s.org
  LEFT JOIN LATERAL (
    SELECT sum(amount) FILTER (WHERE status='confirmed') AS confirmed,
      sum(amount) FILTER (WHERE status IN ('pending','initiated')) AS pending
    FROM public.pos_payments p WHERE p.organization_id=s.org AND p.order_id=o.id
  ) p ON true
  LEFT JOIN LATERAL (
    SELECT sum(amount) AS pending FROM public.cash_payment_requests r
    WHERE r.organization_id=s.org AND r.source_module='pos' AND r.source_record_id=o.id AND r.status='pending'
  ) c ON true
  WHERE (o.created_at AT TIME ZONE 'Africa/Nairobi')::date>=s.first_day AND (o.created_at AT TIME ZONE 'Africa/Nairobi')::date<s.end_day
    AND o.status NOT IN ('cancelled','voided','charged-to-room')
    AND o.folio_post_status IS DISTINCT FROM 'posted'
), journal_check AS (
  SELECT j.branch_id,j.currency,j.total_debit,j.total_credit,
    count(l.id) AS lines,coalesce(sum(l.debit),0) AS line_debit,coalesce(sum(l.credit),0) AS line_credit
  FROM scope s JOIN public.journal_entries j ON j.organization_id=s.org
  LEFT JOIN public.journal_entry_lines l ON l.journal_id=j.id AND l.organization_id=s.org
  WHERE j.accounting_date>=s.first_day AND j.accounting_date<s.end_day AND j.status='posted'
  GROUP BY j.id,j.branch_id,j.currency,j.total_debit,j.total_credit
), results AS (
  SELECT '00 Review scope'::text AS check_name,g.anchor_property AS branch_id,NULL::text AS currency,
    CASE WHEN s.org IS NULL THEN 'Review did not run: check the property and date range'
      ELSE format('Workspace %s | %s through %s',s.org,s.first_day,s.end_day-1) END AS status,
    NULL::bigint AS records,NULL::numeric AS amount
  FROM settings g LEFT JOIN scope s ON true
  UNION ALL
  SELECT 'POS confirmed tenders',p.branch_id,p.currency,p.method,count(*),sum(p.amount)
  FROM scope s JOIN public.pos_payments p ON p.organization_id=s.org AND p.status='confirmed'
  WHERE (coalesce(p.paid_at,p.created_at) AT TIME ZONE 'Africa/Nairobi')::date>=s.first_day AND (coalesce(p.paid_at,p.created_at) AT TIME ZONE 'Africa/Nairobi')::date<s.end_day
  GROUP BY p.branch_id,p.currency,p.method
  UNION ALL
  SELECT 'POS bills over-reserved',branch_id,currency,'review',count(*),sum(confirmed+pending-grand_total)
  FROM orders WHERE confirmed+pending>grand_total+0.005 GROUP BY branch_id,currency
  UNION ALL
  SELECT 'POS paid total differs from confirmed tenders',branch_id,currency,'review',count(*),sum(abs(paid_total-confirmed))
  FROM orders WHERE paid_total IS NULL OR abs(paid_total-confirmed)>0.005 GROUP BY branch_id,currency
  UNION ALL
  SELECT 'Cash requests',r.branch_id,r.currency,r.source_module||' / '||r.status,count(*),sum(r.amount)
  FROM scope s JOIN public.cash_payment_requests r ON r.organization_id=s.org
  WHERE (r.created_at AT TIME ZONE 'Africa/Nairobi')::date>=s.first_day AND (r.created_at AT TIME ZONE 'Africa/Nairobi')::date<s.end_day GROUP BY r.branch_id,r.currency,r.source_module,r.status
  UNION ALL
  SELECT 'Confirmed cash missing matching POS receipt',r.branch_id,r.currency,'review',count(*),sum(r.amount)
  FROM scope s JOIN public.cash_payment_requests r ON r.organization_id=s.org AND r.source_module='pos' AND r.status='confirmed'
  LEFT JOIN public.pos_payments p ON p.id=r.payment_id AND p.organization_id=s.org AND p.order_id=r.source_record_id
    AND p.amount=r.amount AND p.currency=r.currency AND p.receipt_number=r.receipt_number
  WHERE (r.confirmed_at AT TIME ZONE 'Africa/Nairobi')::date>=s.first_day AND (r.confirmed_at AT TIME ZONE 'Africa/Nairobi')::date<s.end_day AND p.id IS NULL
  GROUP BY r.branch_id,r.currency
  UNION ALL
  SELECT 'Closed till variance',t.branch_id,NULL,'review',count(*),NULL
  FROM scope s JOIN public.pos_shifts t ON t.organization_id=s.org
  WHERE (t.closed_at AT TIME ZONE 'Africa/Nairobi')::date>=s.first_day AND (t.closed_at AT TIME ZONE 'Africa/Nairobi')::date<s.end_day
    AND (t.counted_cash IS NULL OR abs(t.counted_cash-t.expected_cash)>0.005) GROUP BY t.branch_id
  UNION ALL
  SELECT 'Cash transfers',t.branch_id,NULL,t.status,count(*),NULL
  FROM scope s JOIN public.cash_transfers t ON t.organization_id=s.org
  WHERE (t.sent_at AT TIME ZONE 'Africa/Nairobi')::date>=s.first_day AND (t.sent_at AT TIME ZONE 'Africa/Nairobi')::date<s.end_day GROUP BY t.branch_id,t.status
  UNION ALL
  SELECT 'Bank statement lines',a.branch_id,a.currency,b.direction||' / '||b.status,count(*),sum(b.amount)
  FROM scope s JOIN public.bank_statement_entries b ON b.organization_id=s.org
  JOIN public.bank_accounts a ON a.id=b.bank_account_id AND a.organization_id=s.org
  WHERE b.value_date>=s.first_day AND b.value_date<s.end_day GROUP BY a.branch_id,a.currency,b.direction,b.status
  UNION ALL
  SELECT 'M-Pesa provider activity',m.branch_id,NULL,m.environment||' / '||m.status,count(*),NULL
  FROM scope s JOIN public.mpesa_transactions m ON m.organization_id=s.org
  WHERE (m.created_at AT TIME ZONE 'Africa/Nairobi')::date>=s.first_day AND (m.created_at AT TIME ZONE 'Africa/Nairobi')::date<s.end_day
  GROUP BY m.branch_id,m.environment,m.status
  UNION ALL
  SELECT 'Folio and other receipts',p.branch_id,p.currency,p.source_module||' / '||p.status,count(*),sum(p.amount)
  FROM scope s JOIN public.payments p ON p.organization_id=s.org
  WHERE (p.paid_at AT TIME ZONE 'Africa/Nairobi')::date>=s.first_day AND (p.paid_at AT TIME ZONE 'Africa/Nairobi')::date<s.end_day GROUP BY p.branch_id,p.currency,p.source_module,p.status
  UNION ALL
  SELECT 'Customer invoices issued in period',i.branch_id,i.currency,i.status,count(*),sum(i.balance)
  FROM scope s JOIN public.invoices i ON i.organization_id=s.org
  WHERE i.issue_date>=s.first_day AND i.issue_date<s.end_day GROUP BY i.branch_id,i.currency,i.status
  UNION ALL
  SELECT 'Department requisitions',r.branch_id,NULL,r.status,count(*),NULL
  FROM scope s JOIN public.internal_requisitions r ON r.organization_id=s.org
  WHERE r.request_date>=s.first_day AND r.request_date<s.end_day GROUP BY r.branch_id,r.status
  UNION ALL
  SELECT 'Purchase orders',p.branch_id,p.currency,p.status,count(*),sum(p.total_amount)
  FROM scope s JOIN public.purchase_orders p ON p.organization_id=s.org
  WHERE (p.created_at AT TIME ZONE 'Africa/Nairobi')::date>=s.first_day AND (p.created_at AT TIME ZONE 'Africa/Nairobi')::date<s.end_day GROUP BY p.branch_id,p.currency,p.status
  UNION ALL
  SELECT 'Goods receipts',r.branch_id,NULL,r.status,count(*),NULL
  FROM scope s JOIN public.goods_receipts r ON r.organization_id=s.org
  WHERE (r.received_at AT TIME ZONE 'Africa/Nairobi')::date>=s.first_day AND (r.received_at AT TIME ZONE 'Africa/Nairobi')::date<s.end_day GROUP BY r.branch_id,r.status
  UNION ALL
  SELECT 'Posted valued receipts missing a matching accrual journal',r.branch_id,p.currency,'review',count(*),NULL
  FROM scope s JOIN public.goods_receipts r ON r.organization_id=s.org AND r.status='posted' AND r.total_value>0
  LEFT JOIN public.purchase_orders p ON p.id=r.order_id AND p.organization_id=s.org
  LEFT JOIN public.journal_entries j ON j.id=r.accrual_journal_id AND j.organization_id=s.org
    AND j.branch_id IS NOT DISTINCT FROM r.branch_id AND j.status='posted'
    AND j.source_document_id=r.id AND j.source_document_type='goods_receipt:accrual'
  WHERE (r.posted_at AT TIME ZONE 'Africa/Nairobi')::date>=s.first_day AND (r.posted_at AT TIME ZONE 'Africa/Nairobi')::date<s.end_day AND j.id IS NULL
  GROUP BY r.branch_id,p.currency
  UNION ALL
  SELECT 'Inventory movements',m.branch_id,NULL,m.movement_type,count(*),NULL
  FROM scope s JOIN public.stock_movements m ON m.organization_id=s.org
  WHERE (m.created_at AT TIME ZONE 'Africa/Nairobi')::date>=s.first_day AND (m.created_at AT TIME ZONE 'Africa/Nairobi')::date<s.end_day GROUP BY m.branch_id,m.movement_type
  UNION ALL
  SELECT 'Supplier invoice matching',i.branch_id,NULL,i.status||' / '||i.match_status,count(*),NULL
  FROM scope s JOIN public.supplier_invoices i ON i.organization_id=s.org
  WHERE coalesce(i.invoice_date,(i.created_at AT TIME ZONE 'Africa/Nairobi')::date)>=s.first_day AND coalesce(i.invoice_date,(i.created_at AT TIME ZONE 'Africa/Nairobi')::date)<s.end_day
  GROUP BY i.branch_id,i.status,i.match_status
  UNION ALL
  SELECT 'Supplier payments',p.branch_id,p.currency,p.status,count(*),sum(p.amount)
  FROM scope s JOIN public.supplier_payments p ON p.organization_id=s.org
  WHERE p.paid_on>=s.first_day AND p.paid_on<s.end_day GROUP BY p.branch_id,p.currency,p.status
  UNION ALL
  SELECT 'Posting receipts',r.branch_id,r.currency,r.source_module||' / '||r.posting_type||' / '||r.status,count(*),sum(r.amount)
  FROM scope s JOIN public.finance_posting_receipts r ON r.organization_id=s.org
  WHERE coalesce(r.occurred_on,(r.created_at AT TIME ZONE 'Africa/Nairobi')::date)>=s.first_day AND coalesce(r.occurred_on,(r.created_at AT TIME ZONE 'Africa/Nairobi')::date)<s.end_day
  GROUP BY r.branch_id,r.currency,r.source_module,r.posting_type,r.status
  UNION ALL
  SELECT 'Posted journal line or header mismatch',branch_id,currency,'review',count(*),sum(abs(line_debit-line_credit))
  FROM journal_check WHERE lines<2 OR abs(line_debit-line_credit)>0.005
    OR abs(total_debit-line_debit)>0.005 OR abs(total_credit-line_credit)>0.005 GROUP BY branch_id,currency
  UNION ALL
  SELECT 'Tax transactions',t.branch_id,NULL,t.direction,count(*),NULL
  FROM scope s JOIN public.tax_transactions t ON t.organization_id=s.org
  WHERE t.transaction_date>=s.first_day AND t.transaction_date<s.end_day GROUP BY t.branch_id,t.direction
  UNION ALL
  SELECT 'Fiscal submissions',e.branch_id,NULL,e.status,count(*),NULL
  FROM scope s JOIN public.etims_submissions e ON e.organization_id=s.org
  WHERE (e.created_at AT TIME ZONE 'Africa/Nairobi')::date>=s.first_day AND (e.created_at AT TIME ZONE 'Africa/Nairobi')::date<s.end_day GROUP BY e.branch_id,e.status
)
SELECT check_name,branch_id,currency,status,records,amount
FROM results ORDER BY check_name,branch_id,currency,status;
