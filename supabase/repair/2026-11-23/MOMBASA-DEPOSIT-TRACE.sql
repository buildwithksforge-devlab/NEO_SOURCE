-- Read-only trace for RES-2611-F806A and its recorded deposit QW1KDLAX.
WITH deposit AS (
  SELECT d.*
  FROM public.reservation_deposits d
  WHERE d.reservation_id = '05d7ae57-f048-4c77-9623-30ce1c5c880e'::uuid
    AND d.reference = 'QW1KDLAX'
)
SELECT
  d.id AS deposit_id,
  d.branch_id,
  d.amount,
  d.currency,
  d.method,
  d.status AS deposit_status,
  d.received_at,
  d.applied_folio_id,
  f.total_charges AS folio_charges,
  f.total_payments AS folio_payments,
  f.balance AS folio_balance,
  d.payment_id AS linked_payment_id,
  p.status AS linked_payment_status,
  p.shift_id AS linked_cashier_shift_id,
  s.shift_number,
  fr.status AS deposit_posting_status,
  j.journal_number,
  CASE
    WHEN p.shift_id IS NULL THEN 'No till shift on the linked payment'
    WHEN s.id IS NULL THEN 'Linked shift missing from this property'
    WHEN p.method = 'cash' AND p.status = 'confirmed' THEN 'Qualifies for till receipt listing'
    ELSE 'Linked payment does not qualify as confirmed till cash'
  END AS till_trace
FROM deposit d
LEFT JOIN public.folios f
  ON f.id = d.applied_folio_id AND f.organization_id = d.organization_id
LEFT JOIN public.payments p
  ON p.id = d.payment_id AND p.organization_id = d.organization_id
LEFT JOIN public.pos_shifts s
  ON s.id = p.shift_id AND s.organization_id = d.organization_id AND s.branch_id = d.branch_id
LEFT JOIN public.finance_posting_receipts fr
  ON fr.organization_id = d.organization_id AND fr.source_module = 'deposit' AND fr.source_id = d.id
LEFT JOIN public.financial_states fs
  ON fs.organization_id = d.organization_id AND fs.branch_id = d.branch_id
  AND fs.source_module = 'deposit' AND fs.source_id = d.id
LEFT JOIN public.journal_entries j
  ON j.id = COALESCE(fr.journal_id, fs.journal_id) AND j.organization_id = d.organization_id
ORDER BY d.received_at, fr.journal_id;
