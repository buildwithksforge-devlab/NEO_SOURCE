-- NEØ F02 — Protect check-in against early arrival.
-- Preserves existing deposit, room and folio controls.
-- Does not modify existing reservation or stay records.

CREATE OR REPLACE FUNCTION public.neo_f02_checkin_arrival_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
    _arrival date;
    _property_today date;
BEGIN
    SELECT r.arrival_date
      INTO _arrival
    FROM public.reservations r
    WHERE r.id = NEW.reservation_id
      AND r.organization_id = NEW.organization_id
      AND r.branch_id = NEW.branch_id;

    IF _arrival IS NULL THEN
        RAISE EXCEPTION
            'Check-in blocked: reservation arrival date could not be verified';
    END IF;

    -- Use the property's configured timezone; fall back to East Africa Time.
    -- Reject invalid timezone names rather than silently using the wrong date.
    SELECT (now() AT TIME ZONE COALESCE(
        NULLIF(btrim(b.timezone), ''),
        'Africa/Nairobi'
    ))::date
    INTO _property_today
    FROM public.branches b
    WHERE b.id = NEW.branch_id
      AND b.organization_id = NEW.organization_id;

    IF _property_today IS NULL THEN
        RAISE EXCEPTION
            'Check-in blocked: property timezone could not be verified';
    END IF;

    IF _arrival > _property_today THEN
        RAISE EXCEPTION
            'Early check-in blocked: reservation arrival date is %, current property date is %',
            _arrival, _property_today;
    END IF;

    RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trg_neo_f02_checkin_arrival_guard
ON public.stays;

CREATE TRIGGER trg_neo_f02_checkin_arrival_guard
BEFORE INSERT ON public.stays
FOR EACH ROW
EXECUTE FUNCTION public.neo_f02_checkin_arrival_guard();