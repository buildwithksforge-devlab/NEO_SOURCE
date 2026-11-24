-- NEÃƒÆ’Ã†â€™Ãƒâ€¹Ã…â€œ E2C: Payment-backed event booking confirmation.
-- Source only. Requires compatibility testing before migration application.

CREATE OR REPLACE FUNCTION public.neo_event_verified_collection_total(
    _booking uuid
)
RETURNS numeric
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
    v_total numeric := 0;
    v_org uuid := public.current_org_id();
BEGIN
    IF v_org IS NULL THEN
        RAISE EXCEPTION 'No active organization.'
            USING ERRCODE = '42501';
    END IF;

    IF NOT EXISTS (
        SELECT 1
        FROM public.event_bookings b
        WHERE b.id = _booking
          AND b.organization_id = v_org
          AND public.neo_branch_in_scope(b.branch_id)
    ) THEN
        RAISE EXCEPTION 'Event booking is outside your access scope.'
            USING ERRCODE = '42501';
    END IF;

    SELECT COALESCE(SUM(ep.amount), 0)
      INTO v_total
    FROM public.event_payments ep
    JOIN public.payments p
      ON p.id = ep.payment_id
     AND p.organization_id = ep.organization_id
     AND p.branch_id = ep.branch_id
    JOIN public.journal_entries j
      ON j.id = p.posted_journal_id
     AND j.organization_id = p.organization_id
     AND j.branch_id = p.branch_id
    WHERE ep.booking_id = _booking
      AND ep.organization_id = v_org
      AND ep.entry_type IN ('deposit', 'payment')
      AND p.status = 'confirmed'
      AND j.status = 'posted'
      AND j.reversed_by_journal_id IS NULL
      AND p.source_module = 'events'
      AND p.source_record_id = _booking
      AND ep.amount > 0;

    RETURN GREATEST(v_total, 0);
END;
$function$;


CREATE OR REPLACE FUNCTION public.neo_event_confirmation_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
    v_paid numeric := 0;
    v_required numeric := 0;
BEGIN
    -- Allow ordinary updates that do not enter a protected state.
    IF NEW.status NOT IN (
        'confirmed',
        'in-planning',
        'ready',
        'in-progress',
        'completed',
        'closed'
    ) THEN
        RETURN NEW;
    END IF;

    -- Existing confirmed bookings may progress through normal
    -- planning and execution without another confirmation.
    IF TG_OP = 'UPDATE'
       AND OLD.status IN (
           'confirmed',
           'in-planning',
           'ready',
           'in-progress',
           'completed'
       )
       AND NEW.status IN (
           'confirmed',
           'in-planning',
           'ready',
           'in-progress',
           'completed',
           'closed'
       ) THEN
        RETURN NEW;
    END IF;

    -- Unconfirmed bookings must enter through the confirmation step.
    IF NEW.status IS DISTINCT FROM 'confirmed' THEN
        RAISE EXCEPTION
            'Confirm this event before progressing to planning or completion.'
            USING ERRCODE = '42501';
    END IF;

    -- Confirmation must be authorized and deposit-backed.

    IF auth.uid() IS NULL THEN
        RAISE EXCEPTION 'Authenticated user required.'
            USING ERRCODE = '42501';
    END IF;

    IF NEW.organization_id IS DISTINCT FROM public.current_org_id()
       OR NOT public.neo_branch_in_scope(NEW.branch_id) THEN

        RAISE EXCEPTION 'Event booking is outside your access scope.'
            USING ERRCODE = '42501';
    END IF;

    IF NOT (
        public.has_permission('events', 'confirm')
        OR public.is_org_admin()
    ) THEN
        RAISE EXCEPTION 'Booking confirmation permission required.'
            USING ERRCODE = '42501';
    END IF;

    v_required := GREATEST(COALESCE(NEW.deposit_required, 0), 0);

    -- During INSERT, the booking has no recorded payments.
    IF TG_OP = 'INSERT' THEN
        v_paid := 0;
    ELSE
        v_paid := public.neo_event_verified_collection_total(NEW.id);
    END IF;

    IF v_paid < v_required THEN
        RAISE EXCEPTION
            'Insufficient event deposit. Required %, verified received %, shortfall %.',
            v_required, v_paid, v_required - v_paid
            USING ERRCODE = '23514';
    END IF;

    NEW.confirmed_at := NOW();
    NEW.confirmed_by := auth.uid();

    RETURN NEW;
END;
$function$;


DROP TRIGGER IF EXISTS trg_neo_event_confirmation_guard
ON public.event_bookings;

CREATE TRIGGER trg_neo_event_confirmation_guard
BEFORE INSERT OR UPDATE OF status
ON public.event_bookings
FOR EACH ROW
EXECUTE FUNCTION public.neo_event_confirmation_guard();

