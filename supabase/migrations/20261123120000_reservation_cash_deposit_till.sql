BEGIN;

ALTER TABLE public.reservation_deposits
  ADD COLUMN cashier_shift_id uuid REFERENCES public.pos_shifts(id);
CREATE INDEX reservation_deposits_cashier_shift_idx
  ON public.reservation_deposits (cashier_shift_id)
  WHERE cashier_shift_id IS NOT NULL;

-- Attach new cash receipts to the collecting cashier's open property till.
-- Lock the session so till close cannot race the receipt.
CREATE FUNCTION public.neo_reservation_cash_deposit_shift()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $function$
BEGIN
  SELECT s.id INTO NEW.cashier_shift_id
  FROM public.pos_shifts s
  WHERE s.organization_id = NEW.organization_id
    AND s.branch_id = NEW.branch_id
    AND s.cashier_id = auth.uid()
    AND s.status = 'open'
  ORDER BY s.opened_at DESC, s.id
  LIMIT 1 FOR UPDATE;

  IF NEW.cashier_shift_id IS NULL THEN
    RAISE EXCEPTION 'Open your cashier till for this property before recording a cash deposit';
  END IF;
  RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION public.neo_reservation_cash_deposit_shift() FROM PUBLIC, anon, authenticated;

CREATE TRIGGER reservation_cash_deposit_shift
  BEFORE INSERT ON public.reservation_deposits
  FOR EACH ROW WHEN (NEW.method = 'cash')
  EXECUTE FUNCTION public.neo_reservation_cash_deposit_shift();

CREATE OR REPLACE FUNCTION public.cash_shift_expected(_shift uuid)
RETURNS numeric LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $function$
  SELECT coalesce(s.opening_float, 0)
       + coalesce((SELECT sum(p.amount) FROM public.pos_payments p
                   WHERE p.shift_id = s.id AND p.method = 'cash' AND p.status = 'confirmed'), 0)
       + coalesce((SELECT sum(p.amount) FROM public.payments p
                   WHERE p.shift_id = s.id AND p.method = 'cash' AND p.status = 'confirmed'), 0)
       + coalesce((SELECT sum(m.amount) FROM public.cash_movements m
                   WHERE m.shift_id = s.id AND m.movement_type = 'rider-cash'), 0)
       + coalesce((SELECT sum(d.amount) FROM public.reservation_deposits d
                   WHERE d.cashier_shift_id = s.id AND d.organization_id = s.organization_id
                     AND d.branch_id = s.branch_id AND d.method = 'cash'
                     AND NOT EXISTS (
                       SELECT 1 FROM public.payments p
                       WHERE p.id = d.payment_id AND p.shift_id = s.id
                         AND p.method = 'cash' AND p.status = 'confirmed'
                     )), 0)
       - coalesce(s.total_drops, 0) - coalesce(s.total_paid_outs, 0)
  FROM public.pos_shifts s WHERE s.id = _shift AND s.organization_id = public.current_org_id();
$function$;

DO $migration$
DECLARE
  definition text := pg_get_functiondef('public.neo_cash_shift_reconciliation(uuid)'::regprocedure);
  anchor text := '''folio_receipts'',_receipts';
BEGIN
  IF strpos(definition, anchor) = 0 THEN
    RAISE EXCEPTION 'Unrecognized cashier shift reconciliation definition';
  END IF;
  EXECUTE replace(definition, anchor, $projection$
    'deposit_receipts', (
      SELECT coalesce(jsonb_agg(jsonb_build_object(
        'id', d.id, 'reference', d.reference, 'amount', d.amount, 'received_at', d.received_at,
        'journal_number', j.journal_number, 'posting_status', fs.financial_status
      ) ORDER BY d.received_at, d.id), '[]'::jsonb)
      FROM public.reservation_deposits d
      LEFT JOIN public.financial_states fs ON fs.organization_id = d.organization_id
        AND fs.branch_id = d.branch_id AND fs.source_module = 'deposit' AND fs.source_id = d.id
      LEFT JOIN public.journal_entries j ON j.id = fs.journal_id AND j.organization_id = d.organization_id
      WHERE d.cashier_shift_id = _s.id AND d.organization_id = _s.organization_id
        AND d.branch_id = _s.branch_id AND d.method = 'cash'
        AND NOT EXISTS (
          SELECT 1 FROM public.payments p WHERE p.id = d.payment_id AND p.shift_id = _s.id
            AND p.method = 'cash' AND p.status = 'confirmed'
        )
    ), 'folio_receipts',_receipts$projection$);
END;
$migration$;

COMMIT;
