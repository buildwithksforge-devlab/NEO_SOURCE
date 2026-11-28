-- READ ONLY. Run in the original project's authorized SQL console.
-- The supplied POS ID selects its existing organization. No guessed reservation ID,
-- account credentials, guest/contact details, writes or business RPCs are used.
-- Findings are review candidates, not instructions to overwrite saved balances.
-- Reconstruction follows the reviewed folio projection; installed-definition and
-- historical policy differences must be reconciled before calling a difference a defect.
WITH seed AS (
 SELECT o.id,o.organization_id,o.folio_id,to_jsonb(o) AS record
 FROM public.pos_orders o WHERE o.id='1b6b23aa-c4d8-4ded-830e-4f432e972175'::uuid
), bookings AS (
 SELECT r.* FROM public.reservations r WHERE r.organization_id IN (SELECT organization_id FROM seed)
), stay_rows AS (
 SELECT s.* FROM public.stays s WHERE s.organization_id IN (SELECT organization_id FROM seed)
), folios AS (
 SELECT f.* FROM public.folios f WHERE f.organization_id IN (SELECT organization_id FROM seed)
), payments AS (
 SELECT p.* FROM public.payments p WHERE p.organization_id IN (SELECT organization_id FROM seed)
  OR p.folio_id IN (SELECT id FROM folios) OR p.reservation_id IN (SELECT id FROM bookings)
), deposits AS (
 SELECT d.* FROM public.reservation_deposits d WHERE d.organization_id IN (SELECT organization_id FROM seed)
  OR d.reservation_id IN (SELECT id FROM bookings) OR d.applied_folio_id IN (SELECT id FROM folios)
), lines AS (
 SELECT l.* FROM public.folio_lines l WHERE l.folio_id IN (SELECT id FROM folios)
), allocations AS (
 SELECT a.* FROM public.payment_allocations a WHERE a.payment_id IN (SELECT id FROM payments)
  OR a.folio_id IN (SELECT id FROM folios)
), totals AS (
 SELECT f.id,
  coalesce((SELECT sum(l.net_amount) FROM lines l WHERE l.folio_id=f.id AND l.organization_id=f.organization_id
   AND coalesce(l.status,'posted') NOT IN ('void','voided','reversed')
   AND coalesce(l.line_type,'charge') NOT IN ('payment','deposit','refund')),0) AS posted_charges,
  coalesce((SELECT sum(p.amount) FROM payments p WHERE p.folio_id=f.id AND p.organization_id=f.organization_id
   AND p.status IN ('confirmed','posted','completed')),0)
  +coalesce((SELECT sum(d.amount) FROM deposits d WHERE d.applied_folio_id=f.id AND d.organization_id=f.organization_id
    AND d.status='applied' AND d.currency=f.currency AND d.amount>0
    AND (d.payment_id IS NULL OR EXISTS(SELECT 1 FROM payments p WHERE p.id=d.payment_id
      AND p.organization_id=f.organization_id AND p.currency=f.currency AND p.amount=d.amount
      AND p.status IN ('confirmed','posted','completed') AND p.folio_id IS NULL
      AND NOT EXISTS(SELECT 1 FROM allocations a WHERE a.payment_id=p.id)))
    AND EXISTS(SELECT 1 FROM lines l WHERE l.id=d.applied_folio_line_id AND l.folio_id=f.id
      AND l.organization_id=f.organization_id AND l.line_type IN ('payment','deposit')
      AND coalesce(l.status,'posted') NOT IN ('void','voided','reversed') AND l.net_amount=d.amount)),0) AS applied_money
 FROM folios f
), findings AS (
 SELECT 'folio_summary_difference'::text AS issue,f.reservation_id,f.id AS folio_id,NULL::uuid AS payment_id,NULL::uuid AS deposit_id,
  jsonb_build_object('saved_charges',f.total_charges,'saved_payments',f.total_payments,'saved_balance',f.balance,
    'reviewed_posted_charges',t.posted_charges,'reviewed_applied_money',t.applied_money,
    'reviewed_balance',t.posted_charges-t.applied_money,'status',f.status) AS evidence
 FROM folios f JOIN totals t ON t.id=f.id WHERE f.status NOT IN ('void','voided','cancelled')
  AND (round(f.total_charges,2) IS DISTINCT FROM round(t.posted_charges,2)
    OR round(f.total_payments,2) IS DISTINCT FROM round(t.applied_money,2)
    OR round(f.balance,2) IS DISTINCT FROM round(t.posted_charges-t.applied_money,2))
 UNION ALL
 SELECT 'applied_deposit_evidence_mismatch',d.reservation_id,d.applied_folio_id,d.payment_id,d.id,
  jsonb_build_object('amount',d.amount,'currency',d.currency,'applied_line_id',d.applied_folio_line_id)
 FROM deposits d LEFT JOIN folios f ON f.id=d.applied_folio_id
 LEFT JOIN lines l ON l.id=d.applied_folio_line_id
 WHERE d.status='applied' AND (f.id IS NULL OR f.organization_id IS DISTINCT FROM d.organization_id
  OR f.branch_id IS DISTINCT FROM d.branch_id OR f.currency IS DISTINCT FROM d.currency
  OR (f.reservation_id IS NOT NULL AND f.reservation_id IS DISTINCT FROM d.reservation_id)
  OR l.id IS NULL OR l.organization_id IS DISTINCT FROM d.organization_id OR l.folio_id IS DISTINCT FROM f.id
  OR l.line_type IS NULL OR l.line_type NOT IN ('payment','deposit') OR coalesce(l.status,'posted') IN ('void','voided','reversed')
  OR l.net_amount IS DISTINCT FROM d.amount)
 UNION ALL
 SELECT 'deposit_linked_payment_mismatch',d.reservation_id,d.applied_folio_id,d.payment_id,d.id,
  jsonb_build_object('deposit_amount',d.amount,'payment_amount',p.amount,'payment_status',p.status,'payment_folio_id',p.folio_id)
 FROM deposits d LEFT JOIN payments p ON p.id=d.payment_id WHERE d.status IN ('held','applied') AND d.payment_id IS NOT NULL
  AND (p.id IS NULL OR p.organization_id IS DISTINCT FROM d.organization_id OR p.branch_id IS DISTINCT FROM d.branch_id
   OR p.currency IS DISTINCT FROM d.currency OR p.amount IS DISTINCT FROM d.amount
   OR p.status IS NULL OR p.status NOT IN ('confirmed','posted','completed','paid','settled','succeeded','captured')
   OR (p.reservation_id IS NOT NULL AND p.reservation_id IS DISTINCT FROM d.reservation_id)
   OR (d.status='applied' AND p.folio_id IS NOT NULL AND p.folio_id IS DISTINCT FROM d.applied_folio_id))
 UNION ALL
 SELECT 'same_receipt_linked_to_multiple_active_deposits',d.reservation_id,d.applied_folio_id,d.payment_id,d.id,
  jsonb_build_object('linked_deposit_ids',(SELECT jsonb_agg(other.id ORDER BY other.id) FROM deposits other
    WHERE other.payment_id=d.payment_id AND other.status IN ('held','applied')))
 FROM deposits d WHERE d.status IN ('held','applied') AND d.payment_id IS NOT NULL
  AND (SELECT count(*) FROM deposits other WHERE other.payment_id=d.payment_id AND other.status IN ('held','applied'))>1
 UNION ALL
 SELECT 'payment_scope_or_currency_mismatch',coalesce(p.reservation_id,f.reservation_id),p.folio_id,p.id,NULL::uuid,
  jsonb_build_object('payment_org',p.organization_id,'payment_branch',p.branch_id,'payment_currency',p.currency,
    'folio_org',f.organization_id,'folio_branch',f.branch_id,'folio_currency',f.currency)
 FROM payments p JOIN folios f ON f.id=p.folio_id WHERE p.organization_id IS DISTINCT FROM f.organization_id
  OR p.branch_id IS DISTINCT FROM f.branch_id OR p.currency IS DISTINCT FROM f.currency
  OR (p.reservation_id IS NOT NULL AND f.reservation_id IS NOT NULL AND p.reservation_id IS DISTINCT FROM f.reservation_id)
 UNION ALL
 SELECT 'cross_folio_or_invalid_allocation',coalesce(p.reservation_id,f.reservation_id),a.folio_id,a.payment_id,NULL::uuid,
  jsonb_build_object('payment_folio_id',p.folio_id,'allocation_amount',a.amount,'payment_amount',p.amount)
 FROM allocations a LEFT JOIN payments p ON p.id=a.payment_id LEFT JOIN folios f ON f.id=a.folio_id
 WHERE p.id IS NULL OR f.id IS NULL OR a.organization_id IS DISTINCT FROM p.organization_id
  OR a.organization_id IS DISTINCT FROM f.organization_id OR p.currency IS DISTINCT FROM f.currency
  OR p.folio_id IS DISTINCT FROM a.folio_id OR a.amount IS NULL OR a.amount<=0
 UNION ALL
 SELECT 'invalid_deposit_amount',d.reservation_id,d.applied_folio_id,d.payment_id,d.id,
  jsonb_build_object('amount',d.amount,'status',d.status)
 FROM deposits d WHERE d.amount IS NULL OR d.amount<=0 OR d.amount::text IN ('NaN','Infinity','-Infinity')
 UNION ALL
 SELECT 'invalid_payment_amount',p.reservation_id,p.folio_id,p.id,NULL::uuid,
  jsonb_build_object('amount',p.amount,'status',p.status)
 FROM payments p WHERE p.amount IS NULL OR p.amount<=0 OR p.amount::text IN ('NaN','Infinity','-Infinity')
 UNION ALL
 SELECT 'active_stay_reservation_lifecycle_mismatch',s.reservation_id,NULL::uuid,NULL::uuid,NULL::uuid,
  jsonb_build_object('stay_id',s.id,'stay_status',s.status,'reservation_status',r.status,'room_id',s.room_id)
 FROM stay_rows s LEFT JOIN bookings r ON r.id=s.reservation_id
 WHERE s.status IN ('checked-in','checked_in','in-house','in_house')
  AND (r.id IS NULL OR r.status IS NULL OR r.status NOT IN ('checked-in','checked_in','in-house','in_house')
    OR r.branch_id IS DISTINCT FROM s.branch_id)
), sample_cases AS (
 SELECT r.id,r.confirmation_number,r.status,to_jsonb(r)->>'currency' AS currency,
   to_jsonb(r)->'total_amount' AS total_amount,to_jsonb(r)->'balance' AS balance
 FROM bookings r ORDER BY EXISTS(SELECT 1 FROM findings issue WHERE issue.reservation_id=r.id) DESC,
   (to_jsonb(r)->>'created_at') DESC NULLS LAST,r.id LIMIT 20
)
SELECT jsonb_build_object(
 'read_only',true,'seed_found',EXISTS(SELECT 1 FROM seed),
 'seed_order',(SELECT jsonb_build_object('id',id,'organization_id',organization_id,'folio_id',folio_id,
  'order_number',record->>'order_number','status',record->>'status','grand_total',record->'grand_total','paid_total',record->'paid_total') FROM seed),
 'coverage',jsonb_build_object('reservations',(SELECT count(*) FROM bookings),'folios',(SELECT count(*) FROM folios),
  'payments',(SELECT count(*) FROM payments),'deposits',(SELECT count(*) FROM deposits)),
 'finding_counts',coalesce((SELECT jsonb_object_agg(issue,n) FROM (SELECT issue,count(*) n FROM findings GROUP BY issue) counted),'{}'::jsonb),
 'findings',coalesce((SELECT jsonb_agg(to_jsonb(sample)) FROM (SELECT * FROM findings ORDER BY issue,reservation_id,folio_id,payment_id,deposit_id LIMIT 100) sample),'[]'::jsonb),
 'finding_rows_truncated',(SELECT count(*)>100 FROM findings),
 'existing_reservation_cases',coalesce((SELECT jsonb_agg(to_jsonb(sample_cases)) FROM sample_cases),'[]'::jsonb),
 'limits','Zero findings does not certify correctness. Compare installed routines, pending requests, refund/transfer evidence, original journals, nightly charges, quote policy and deployed user actions. Never overwrite balances from this report.'
) AS reservation_money_inspection;
