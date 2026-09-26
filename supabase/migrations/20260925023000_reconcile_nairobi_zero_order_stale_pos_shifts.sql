-- Reconcile historical Nairobi POS shifts that were left open but never received an order.
-- Do not close them and do not invent a cash count: pending-closure keeps the real-world
-- counted-cash control intact while removing the false "active shift" signal.
UPDATE public.pos_shifts ps
SET status = 'pending-closure',
    notes = concat_ws(E'\n', nullif(ps.notes, ''), 'System reconciliation: historical zero-order shift moved to pending closure; counted cash still required.'),
    updated_at = now()
WHERE ps.id IN (
  '322c3411-d032-40cb-8654-94a48a0a630f'::uuid,
  '90bd9d7f-d09d-4775-be8a-c82ee02b25f6'::uuid,
  'ea58a9fc-09b1-42a7-92d3-5fb63da6dc88'::uuid
)
AND ps.branch_id = '2addbd01-c643-406a-bd7d-fac1aa76b23c'::uuid
AND ps.status = 'open'
AND ps.counted_cash IS NULL
AND NOT EXISTS (SELECT 1 FROM public.pos_orders po WHERE po.shift_id = ps.id);
