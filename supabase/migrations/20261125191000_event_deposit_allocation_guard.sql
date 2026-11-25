BEGIN;

CREATE OR REPLACE FUNCTION
public.neo_guard_event_deposit_allocation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog','public'
AS $function$
DECLARE
    v_event public.event_bookings;
    v_received numeric;
    v_deposited numeric;
    v_accounts integer;
BEGIN

    IF NEW.source_document_type IS DISTINCT FROM
       'event_deposit:deposit'
    THEN
        RETURN NEW;
    END IF;

    IF NEW.status IS DISTINCT FROM 'posted' THEN
        RETURN NEW;
    END IF;

    IF TG_OP = 'UPDATE' THEN
        IF OLD.status = 'posted' THEN
            RETURN NEW;
        END IF;
    END IF;

    SELECT e.*
      INTO v_event
    FROM public.event_bookings e
    WHERE e.id = NEW.source_document_id
      AND e.organization_id = NEW.organization_id
      AND e.branch_id IS NOT DISTINCT FROM NEW.branch_id;

    IF v_event.id IS NULL THEN
        RAISE EXCEPTION
            'Event deposit source or property is invalid';
    END IF;

    v_deposited := v_event.deposit_paid;

    IF v_deposited IS NULL
       OR v_deposited <= 0
       OR v_deposited::text IN (
           'NaN','Infinity','-Infinity'
       )
    THEN
        RAISE EXCEPTION
            'Event deposit requires valid receipt evidence';
    END IF;

    IF EXISTS (
        SELECT 1
        FROM public.payments p
        WHERE p.organization_id = NEW.organization_id
          AND p.source_module = 'events'
          AND p.source_record_id = v_event.id
          AND p.status IN (
              'confirmed','completed','paid',
              'succeeded','captured'
          )
          AND (
              p.amount IS NULL
              OR p.amount <= 0
              OR p.amount::text IN (
                  'NaN','Infinity','-Infinity'
              )
              OR p.method IS NULL
          )
    ) THEN
        RAISE EXCEPTION
            'Invalid event payment evidence requires review';
    END IF;

    SELECT
        coalesce(sum(p.amount),0),
        count(DISTINCT
            public.neo_gl_account_code(
                p.organization_id,
                p.method,
                p.destination_account_id
            )
        )
    INTO v_received,v_accounts
    FROM public.payments p
    WHERE p.organization_id = NEW.organization_id
      AND p.source_module = 'events'
      AND p.source_record_id = v_event.id
      AND p.status IN (
          'confirmed','completed','paid',
          'succeeded','captured'
      );

    IF round(v_received,2) <>
       round(v_deposited,2)
    THEN
        RAISE EXCEPTION
            'Event deposit does not match confirmed payment evidence';
    END IF;

    IF v_accounts <> 1 THEN
        RAISE EXCEPTION
            'Mixed or unresolved event settlement accounts require allocation review';
    END IF;

    RETURN NEW;

END;
$function$;

CREATE TRIGGER neo_event_deposit_allocation_guard
BEFORE INSERT OR UPDATE OF status
ON public.journal_entries
FOR EACH ROW
EXECUTE FUNCTION
public.neo_guard_event_deposit_allocation();

REVOKE ALL ON FUNCTION
public.neo_guard_event_deposit_allocation()
FROM PUBLIC,anon,authenticated;

COMMIT;