
ALTER TABLE public.pos_payments
  ADD COLUMN IF NOT EXISTS idempotency_key text,
  ADD COLUMN IF NOT EXISTS correlation_id uuid NOT NULL DEFAULT gen_random_uuid();

DELETE FROM public.pos_payments a USING public.pos_payments b
 WHERE a.ctid > b.ctid AND a.organization_id=b.organization_id
   AND a.idempotency_key IS NOT NULL AND a.idempotency_key=b.idempotency_key;
CREATE UNIQUE INDEX IF NOT EXISTS pos_payments_idempotency_unique
  ON public.pos_payments (organization_id, idempotency_key) WHERE idempotency_key IS NOT NULL;

CREATE OR REPLACE FUNCTION public.tg_pos_payment_controls()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE _s public.pos_shifts;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.shift_id IS NOT NULL THEN
      SELECT * INTO _s FROM public.pos_shifts WHERE id = NEW.shift_id;
      IF _s.id IS NULL THEN RAISE EXCEPTION 'Cashier shift not found'; END IF;
      IF _s.status <> 'open' THEN RAISE EXCEPTION 'Cashier shift is % and cannot accept payments', _s.status; END IF;
    ELSIF NEW.method = 'cash' THEN
      RAISE EXCEPTION 'Cash payments must reference an open cashier shift';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.status = 'confirmed' AND current_setting('neo.payment_maintenance', true) IS DISTINCT FROM 'on'
     AND (NEW.amount IS DISTINCT FROM OLD.amount OR NEW.method IS DISTINCT FROM OLD.method
          OR NEW.status IS DISTINCT FROM OLD.status) THEN
    RAISE EXCEPTION 'Confirmed payments cannot be edited. Post a refund or reversal instead.';
  END IF;
  RETURN NEW;
END; $$;
REVOKE ALL ON FUNCTION public.tg_pos_payment_controls() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS trg_pos_payment_controls ON public.pos_payments;
CREATE TRIGGER trg_pos_payment_controls BEFORE INSERT OR UPDATE ON public.pos_payments
  FOR EACH ROW EXECUTE FUNCTION public.tg_pos_payment_controls();

CREATE OR REPLACE FUNCTION public.cash_shift_expected(_shift uuid)
RETURNS numeric LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
  SELECT COALESCE(s.opening_float,0)
       + COALESCE((SELECT sum(p.amount) FROM public.pos_payments p
                    WHERE p.shift_id = s.id AND p.method='cash' AND p.status='confirmed'),0)
       + COALESCE((SELECT sum(p.amount) FROM public.payments p
                    WHERE p.shift_id = s.id AND p.method='cash' AND p.status='confirmed'),0)
       - COALESCE(s.total_drops,0) - COALESCE(s.total_paid_outs,0)
  FROM public.pos_shifts s WHERE s.id = _shift AND s.organization_id = public.current_org_id();
$$;
REVOKE ALL ON FUNCTION public.cash_shift_expected(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.cash_shift_expected(uuid) TO authenticated, service_role;
