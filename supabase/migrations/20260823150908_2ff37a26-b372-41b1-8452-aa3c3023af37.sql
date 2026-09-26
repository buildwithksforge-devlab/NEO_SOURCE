-- Cash payments now bank into the caller's own open till automatically.
-- The control still refuses cash when no till is open, and still refuses a
-- till that is closed or belongs to someone else.
CREATE OR REPLACE FUNCTION public.tg_pos_payment_controls()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE _s public.pos_shifts;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.shift_id IS NULL AND NEW.method = 'cash' THEN
      NEW.shift_id := public.pos_resolve_open_shift(NEW.branch_id);
    END IF;
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
END;
$function$;