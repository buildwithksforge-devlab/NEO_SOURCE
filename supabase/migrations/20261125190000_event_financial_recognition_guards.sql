BEGIN;

CREATE OR REPLACE FUNCTION
public.neo_guard_event_financial_recognition()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog','public'
AS $function$
DECLARE
    v_event uuid;
    v_invoice uuid;
BEGIN

    IF NEW.source_document_type NOT IN (
        'event_earned:earned',
        'event_invoice:invoice',
        'event_cancellation:cancellation'
    ) THEN
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

    IF NEW.source_document_type = 'event_invoice:invoice' THEN

        SELECT i.event_booking_id,i.id
          INTO v_event,v_invoice
        FROM public.invoices i
        WHERE i.id = NEW.source_document_id
          AND i.organization_id = NEW.organization_id;

        IF v_event IS NULL THEN
            RETURN NEW;
        END IF;

    ELSE

        v_event := NEW.source_document_id;

    END IF;

    PERFORM pg_advisory_xact_lock(
        hashtextextended(
            'event-recognition:' ||
            NEW.organization_id::text ||
            ':' || v_event::text,
            0
        )
    );

    IF NOT EXISTS (
        SELECT 1
        FROM public.event_bookings e
        WHERE e.id = v_event
          AND e.organization_id = NEW.organization_id
          AND e.branch_id IS NOT DISTINCT FROM NEW.branch_id
    ) THEN
        RAISE EXCEPTION
            'Event financial source or property requires verification';
    END IF;

    IF NEW.source_document_type = 'event_earned:earned'
       AND EXISTS (
           SELECT 1
           FROM public.invoices i
           JOIN public.journal_entries j
             ON j.source_document_id = i.id
            AND j.organization_id = i.organization_id
           WHERE i.event_booking_id = v_event
             AND i.organization_id = NEW.organization_id
             AND j.id <> NEW.id
             AND j.status = 'posted'
             AND j.reversed_by_journal_id IS NULL
             AND j.source_document_type = 'event_invoice:invoice'
       )
    THEN

        RAISE EXCEPTION
            'Event invoice revenue already exists; reconcile the invoice and earned revenue before posting';

    END IF;

    IF NEW.source_document_type = 'event_invoice:invoice'
       AND EXISTS (
           SELECT 1
           FROM public.journal_entries j
           WHERE j.organization_id = NEW.organization_id
             AND j.source_document_id = v_event
             AND j.source_document_type = 'event_earned:earned'
             AND j.status = 'posted'
             AND j.reversed_by_journal_id IS NULL
             AND j.id <> NEW.id
       )
    THEN

        RAISE EXCEPTION
            'Event earned revenue already exists; invoice revenue requires reconciliation';

    END IF;

    IF NEW.source_document_type =
       'event_cancellation:cancellation'
       AND EXISTS (
           SELECT 1
           FROM public.journal_entry_lines l
           JOIN public.chart_of_accounts a
             ON a.id = l.account_id
            AND a.organization_id = NEW.organization_id
           WHERE l.journal_id = NEW.id
             AND l.organization_id = NEW.organization_id
             AND l.credit > 0
             AND a.category = 'asset'
       )
    THEN

        RAISE EXCEPTION
            'Event cancellation cannot automatically credit an asset account without verified refund settlement';

    END IF;

    RETURN NEW;

END;
$function$;

CREATE TRIGGER neo_event_financial_recognition_guard
BEFORE INSERT OR UPDATE OF status
ON public.journal_entries
FOR EACH ROW
EXECUTE FUNCTION
public.neo_guard_event_financial_recognition();

REVOKE ALL ON FUNCTION
public.neo_guard_event_financial_recognition()
FROM PUBLIC,anon,authenticated;

COMMIT;