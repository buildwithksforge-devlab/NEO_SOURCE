BEGIN;

CREATE INDEX IF NOT EXISTS cash_requests_pos_pending_order_idx
ON public.cash_payment_requests (organization_id, source_record_id)
WHERE source_module='pos' AND status='pending';

CREATE FUNCTION public.neo_pos_guard_new_collection()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  order_id_to_check uuid;
  order_row public.pos_orders;
  converting_request_id uuid;
  reserved numeric;
BEGIN
  IF TG_TABLE_NAME = 'cash_payment_requests' THEN
    IF NEW.source_module IS DISTINCT FROM 'pos' OR NEW.status IS DISTINCT FROM 'pending' THEN
      RETURN NEW;
    END IF;
    order_id_to_check := NEW.source_record_id;
  ELSE
    IF NEW.status NOT IN ('confirmed', 'initiated', 'pending') THEN
      RETURN NEW;
    END IF;
    order_id_to_check := NEW.order_id;
  END IF;

  -- Every collection writer shares the order lock, including direct inserts.
  SELECT * INTO order_row FROM public.pos_orders o
  WHERE o.id=order_id_to_check AND o.organization_id=NEW.organization_id
  FOR UPDATE;
  IF NOT FOUND OR order_row.branch_id IS DISTINCT FROM NEW.branch_id
      OR order_row.currency IS DISTINCT FROM NEW.currency THEN
    RAISE EXCEPTION 'Collection property or currency does not match the bill.' USING ERRCODE='23514';
  END IF;
  IF NEW.amount IS NULL OR NEW.amount::text IN ('NaN','Infinity','-Infinity')
      OR NEW.amount<=0 OR NEW.amount<>round(NEW.amount,2)
      OR order_row.grand_total IS NULL OR order_row.grand_total::text IN ('NaN','Infinity','-Infinity') THEN
    RAISE EXCEPTION 'Collection requires a finite amount and a valid bill total.' USING ERRCODE='23514';
  END IF;

  IF TG_TABLE_NAME = 'pos_payments' AND NEW.status='confirmed' AND NEW.method='cash' THEN
    -- Cashier confirmation converts its own reservation into a payment row.
    SELECT r.id INTO converting_request_id FROM public.cash_payment_requests r
    WHERE r.organization_id=NEW.organization_id AND r.source_module='pos'
      AND r.source_record_id=order_id_to_check AND r.status='pending'
      AND r.branch_id IS NOT DISTINCT FROM NEW.branch_id AND r.currency=NEW.currency
      AND r.amount=NEW.amount AND r.method=NEW.method AND r.assigned_shift_id=NEW.shift_id
      AND (r.assigned_cashier_id IS NULL OR r.assigned_cashier_id=NEW.cashier_id)
      AND NEW.idempotency_key='cash-request:'||r.id::text;
  END IF;

  SELECT coalesce((
      SELECT sum(p.amount) FROM public.pos_payments p
      WHERE p.organization_id=NEW.organization_id AND p.order_id=order_id_to_check
        AND p.status IN ('confirmed','initiated','pending')
    ),0) + CASE WHEN converting_request_id IS NOT NULL THEN 0 ELSE coalesce((
      SELECT sum(r.amount) FROM public.cash_payment_requests r
      WHERE r.organization_id=NEW.organization_id AND r.source_module='pos'
        AND r.source_record_id=order_id_to_check AND r.status='pending'
    ),0) END INTO reserved;

  -- Conversion does not create a new reservation. Legacy orders may have
  -- duplicate pending cash requests; settling one may proceed up to the
  -- remaining confirmed/provider balance while the others are reconciled.

  IF reserved::text IN ('NaN','Infinity','-Infinity') OR reserved<0 THEN
    RAISE EXCEPTION 'Saved collection amounts need reconciliation before taking another payment.' USING ERRCODE='23514';
  END IF;
  IF NEW.amount > round(order_row.grand_total-reserved,2) THEN
    RAISE EXCEPTION 'Only % remains available after confirmed payments and requests awaiting confirmation.',
      greatest(round(order_row.grand_total-reserved,2),0) USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION public.neo_pos_guard_new_collection() FROM PUBLIC, anon, authenticated;
CREATE TRIGGER neo_pos_reserve_cash_request BEFORE INSERT ON public.cash_payment_requests
FOR EACH ROW EXECUTE FUNCTION public.neo_pos_guard_new_collection();
CREATE TRIGGER neo_pos_reserve_payment BEFORE INSERT ON public.pos_payments
FOR EACH ROW EXECUTE FUNCTION public.neo_pos_guard_new_collection();

COMMIT;
