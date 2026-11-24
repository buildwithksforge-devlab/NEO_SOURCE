-- Read-only detail for the November 2026 Savanna Crown review.
-- This query returns internal references, values and statuses without contact details.
WITH scope AS (
  SELECT organization_id AS org, DATE '2026-11-01' AS first_day, DATE '2026-12-01' AS end_day
  FROM public.branches WHERE id='2addbd01-c643-406a-bd7d-fac1aa76b23c'::uuid
), orders AS (
  SELECT o.id,o.branch_id,o.order_number,o.currency,o.grand_total,o.paid_total,
    coalesce(p.confirmed,0) AS confirmed,coalesce(p.pending,0) AS electronic_pending,
    coalesce(c.pending,0) AS cash_pending,c.requests
  FROM scope s JOIN public.pos_orders o ON o.organization_id=s.org
  LEFT JOIN LATERAL (
    SELECT sum(amount) FILTER (WHERE status='confirmed') AS confirmed,
      sum(amount) FILTER (WHERE status IN ('pending','initiated')) AS pending
    FROM public.pos_payments WHERE organization_id=s.org AND order_id=o.id
  ) p ON true
  LEFT JOIN LATERAL (
    SELECT sum(amount) AS pending,jsonb_agg(jsonb_build_object('id',r.id,'amount',r.amount,'created_at',r.created_at)
      ORDER BY r.created_at) AS requests
    FROM public.cash_payment_requests r
    WHERE r.organization_id=s.org AND r.source_module='pos' AND r.source_record_id=o.id AND r.status='pending'
  ) c ON true
  WHERE (o.created_at AT TIME ZONE 'Africa/Nairobi')::date>=s.first_day
    AND (o.created_at AT TIME ZONE 'Africa/Nairobi')::date<s.end_day
    AND o.status NOT IN ('cancelled','voided','charged-to-room') AND o.folio_post_status IS DISTINCT FROM 'posted'
), detail AS (
  SELECT '01 POS reservation overlap' AS review,o.branch_id,o.id AS record_id,
    jsonb_build_object('bill',o.order_number,'currency',o.currency,'total',o.grand_total,'paid_total',o.paid_total,
      'confirmed',o.confirmed,'electronic_pending',o.electronic_pending,'cash_pending',o.cash_pending,
      'overlap',o.confirmed+o.electronic_pending+o.cash_pending-o.grand_total,'pending_cash_requests',o.requests) AS evidence
  FROM orders o WHERE o.confirmed+o.electronic_pending+o.cash_pending>o.grand_total+0.005
  UNION ALL
  SELECT '02 Inventory accrual',r.branch_id,r.id,
    jsonb_build_object('source_id',r.source_id,'posting_amount',r.amount,'currency',r.currency,
      'grn',g.grn_number,'grn_value',g.total_value,'purchase_order',p.order_number,'purchase_order_total',p.total_amount,
      'journal_id',j.id,'journal_status',j.status,'debit',j.total_debit,'credit',j.total_credit,
      'journal_accounts',accounts.lines,'grn_lines',receipt_lines.lines)
  FROM scope s JOIN public.finance_posting_receipts r ON r.organization_id=s.org
    AND r.source_module='inventory' AND r.posting_type='accrual' AND r.status='posted'
  LEFT JOIN public.journal_entries j ON j.id=r.journal_id AND j.organization_id=s.org
  LEFT JOIN public.goods_receipts g ON g.organization_id=s.org AND g.id IN (r.source_id,j.source_document_id)
  LEFT JOIN public.purchase_orders p ON p.id=g.order_id AND p.organization_id=s.org
  LEFT JOIN LATERAL (
    SELECT jsonb_agg(jsonb_build_object('account',a.code,'debit',l.debit,'credit',l.credit) ORDER BY l.line_number) AS lines
    FROM public.journal_entry_lines l LEFT JOIN public.chart_of_accounts a ON a.id=l.account_id AND a.organization_id=s.org
    WHERE l.journal_id=j.id AND l.organization_id=s.org
  ) accounts ON true
  LEFT JOIN LATERAL (
    SELECT jsonb_agg(jsonb_build_object('stock_item_id',l.stock_item_id,'unit',l.unit,
      'received',l.quantity_received,'accepted',l.quantity_accepted,'unit_price',l.unit_price) ORDER BY l.created_at) AS lines
    FROM public.goods_receipt_lines l WHERE l.receipt_id=g.id AND l.organization_id=s.org
  ) receipt_lines ON true
  WHERE coalesce(r.occurred_on,(r.created_at AT TIME ZONE 'Africa/Nairobi')::date)>=s.first_day
    AND coalesce(r.occurred_on,(r.created_at AT TIME ZONE 'Africa/Nairobi')::date)<s.end_day
  UNION ALL
  SELECT '03 Posting exception or pending payment link',r.branch_id,r.id,
    jsonb_build_object('source_id',r.source_id,'source_module',r.source_module,'posting_type',r.posting_type,
      'posting_status',r.status,'posting_amount',r.amount,'currency',r.currency,'journal_id',r.journal_id,
      'posting_detail',r.detail,'last_error',r.last_error,'linked_payment_id',p.id,'payment_status',p.status,
      'payment_amount',p.amount,'payment_journal_id',p.posted_journal_id)
  FROM scope s JOIN public.finance_posting_receipts r ON r.organization_id=s.org
  LEFT JOIN public.payments p ON r.source_module='payment' AND p.id=r.source_id AND p.organization_id=s.org
  WHERE coalesce(r.occurred_on,(r.created_at AT TIME ZONE 'Africa/Nairobi')::date)>=s.first_day
    AND coalesce(r.occurred_on,(r.created_at AT TIME ZONE 'Africa/Nairobi')::date)<s.end_day
    AND (r.status IN ('blocked','failed') OR (r.status='posted' AND p.status='pending'))
  UNION ALL
  SELECT '04 Closed till variance',t.branch_id,t.id,
    jsonb_build_object('shift',t.shift_number,'expected',t.expected_cash,'counted',t.counted_cash,
      'difference',t.counted_cash-t.expected_cash,'journal_id',t.posted_journal_id,'closed_at',t.closed_at)
  FROM scope s JOIN public.pos_shifts t ON t.organization_id=s.org
  WHERE (t.closed_at AT TIME ZONE 'Africa/Nairobi')::date>=s.first_day AND (t.closed_at AT TIME ZONE 'Africa/Nairobi')::date<s.end_day
    AND (t.counted_cash IS NULL OR abs(t.counted_cash-t.expected_cash)>0.005)
  UNION ALL
  SELECT '05 Inventory property evidence',m.branch_id,m.id,
    jsonb_build_object('movement',m.movement_type,'location_id',m.location_id,'location_property',l.branch_id,
      'reference_type',m.reference_type,'reference_id',m.reference_id,'quantity',m.quantity,'unit',m.unit)
  FROM scope s JOIN public.stock_movements m ON m.organization_id=s.org
  LEFT JOIN public.stock_locations l ON l.id=m.location_id AND l.organization_id=s.org
  WHERE (m.created_at AT TIME ZONE 'Africa/Nairobi')::date>=s.first_day
    AND (m.created_at AT TIME ZONE 'Africa/Nairobi')::date<s.end_day
    AND (m.branch_id IS NULL OR (l.branch_id IS NOT NULL AND l.branch_id IS DISTINCT FROM m.branch_id))
)
SELECT review,branch_id,record_id,evidence FROM detail ORDER BY review,branch_id,record_id;
