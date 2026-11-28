-- E1D: Protect event quotation lifecycle fields.
-- Source migration only. No database execution during development.
--
-- Direct authenticated table writes may create or edit draft quotations.
-- Lifecycle transitions must use controlled SECURITY DEFINER functions.
--
-- The guard function deliberately uses SECURITY INVOKER.
-- It distinguishes direct authenticated table writes from trusted
-- server-side SECURITY DEFINER execution using current_user.
--
-- This is an application-role boundary, not a restriction on database
-- owners or other privileged SECURITY DEFINER functions.

CREATE OR REPLACE FUNCTION public.neo_event_quotation_write_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path TO 'public'
AS $function$
BEGIN
    -- Trusted database functions remain responsible for their own
    -- permission, organization, property and lifecycle checks.
    IF current_user <> 'authenticated' THEN
        RETURN NEW;
    END IF;

    IF TG_OP = 'INSERT' THEN

        IF NEW.status IS DISTINCT FROM 'draft'
           OR NEW.approved_by IS NOT NULL
           OR NEW.approved_at IS NOT NULL
           OR NEW.sent_at IS NOT NULL
           OR NEW.responded_at IS NOT NULL
           OR NEW.viewed_at IS NOT NULL
           OR NULLIF(BTRIM(COALESCE(NEW.accepted_by_name, '')), '') IS NOT NULL
           OR NULLIF(BTRIM(COALESCE(NEW.acceptance_note, '')), '') IS NOT NULL THEN

            RAISE EXCEPTION
                'New quotations must start as unapproved drafts.'
                USING ERRCODE = '42501';

        END IF;

        RETURN NEW;
    END IF;

    IF TG_OP = 'UPDATE' THEN

        -- Once submitted, editing requires the appropriate controlled RPC.
        IF OLD.status IS DISTINCT FROM 'draft' THEN

            RAISE EXCEPTION
                'Submitted quotations cannot be edited directly. Use the controlled workflow.'
                USING ERRCODE = '42501';

        END IF;

        -- Direct draft edits cannot manipulate lifecycle history,
        -- ownership or approval identities.
        IF NEW.status IS DISTINCT FROM OLD.status
           OR NEW.organization_id IS DISTINCT FROM OLD.organization_id
           OR NEW.branch_id IS DISTINCT FROM OLD.branch_id
           OR NEW.created_by IS DISTINCT FROM OLD.created_by
           OR NEW.approved_by IS DISTINCT FROM OLD.approved_by
           OR NEW.approved_at IS DISTINCT FROM OLD.approved_at
           OR NEW.sent_at IS DISTINCT FROM OLD.sent_at
           OR NEW.viewed_at IS DISTINCT FROM OLD.viewed_at
           OR NEW.responded_at IS DISTINCT FROM OLD.responded_at
           OR NEW.accepted_by_name IS DISTINCT FROM OLD.accepted_by_name
           OR NEW.acceptance_note IS DISTINCT FROM OLD.acceptance_note THEN

            RAISE EXCEPTION
                'Quotation lifecycle and ownership fields cannot be changed directly.'
                USING ERRCODE = '42501';

        END IF;

        RETURN NEW;
    END IF;

    RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trg_neo_event_quotation_write_guard
    ON public.event_quotations;

CREATE TRIGGER trg_neo_event_quotation_write_guard
BEFORE INSERT OR UPDATE
ON public.event_quotations
FOR EACH ROW
EXECUTE FUNCTION public.neo_event_quotation_write_guard();


-- Quotation lines also become immutable after submission.
-- The pricing engine remains responsible for authorized draft repricing.

CREATE OR REPLACE FUNCTION public.neo_event_quotation_items_write_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path TO 'public'
AS $function$
DECLARE
    v_old_status text;
    v_new_status text;
BEGIN
    IF current_user <> 'authenticated' THEN
        IF TG_OP = 'DELETE' THEN
        RETURN OLD;
    END IF;

    RETURN NEW;
    END IF;

    IF TG_OP IN ('UPDATE', 'DELETE') THEN
        SELECT status INTO v_old_status
        FROM public.event_quotations
        WHERE id = OLD.quotation_id
        FOR UPDATE;

        IF v_old_status IS DISTINCT FROM 'draft' THEN
            RAISE EXCEPTION
                'Quotation items cannot be changed after submission.'
                USING ERRCODE = '42501';
        END IF;
    END IF;

    IF TG_OP IN ('INSERT', 'UPDATE') THEN
        SELECT status INTO v_new_status
        FROM public.event_quotations
        WHERE id = NEW.quotation_id
        FOR UPDATE;

        IF v_new_status IS DISTINCT FROM 'draft' THEN
            RAISE EXCEPTION
                'Quotation items may only be added to draft quotations.'
                USING ERRCODE = '42501';
        END IF;

        IF TG_OP = 'UPDATE'
           AND NEW.organization_id IS DISTINCT FROM OLD.organization_id THEN
            RAISE EXCEPTION
                'Quotation item organization cannot be changed.'
                USING ERRCODE = '42501';
        END IF;

        IF EXISTS (
            SELECT 1
            FROM public.event_quotations q
            WHERE q.id = NEW.quotation_id
              AND q.organization_id IS DISTINCT FROM NEW.organization_id
        ) THEN
            RAISE EXCEPTION
                'Quotation item organization must match its quotation.'
                USING ERRCODE = '42501';
        END IF;
    END IF;

    IF TG_OP = 'DELETE' THEN
        RETURN OLD;
    END IF;

    RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trg_neo_event_quotation_items_write_guard
    ON public.event_quotation_items;

CREATE TRIGGER trg_neo_event_quotation_items_write_guard
BEFORE INSERT OR UPDATE OR DELETE
ON public.event_quotation_items
FOR EACH ROW
EXECUTE FUNCTION public.neo_event_quotation_items_write_guard();
