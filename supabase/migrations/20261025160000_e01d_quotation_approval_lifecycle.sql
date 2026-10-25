-- E1D: Controlled event quotation lifecycle.
-- Code migration only. Install and test separately.
--
-- Staff approval and customer acceptance are separate decisions.
-- This RPC does not create bookings, receive money or post accounting.

CREATE OR REPLACE FUNCTION public.neo_event_quotation_transition(
    _quotation uuid,
    _action text,
    _note text DEFAULT '',
    _customer_name text DEFAULT ''
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
    v_org uuid := public.current_org_id();
    v_actor uuid := auth.uid();
    v_q public.event_quotations%ROWTYPE;
    v_action text := lower(btrim(coalesce(_action, '')));
    v_note text := btrim(coalesce(_note, ''));
    v_customer text := btrim(coalesce(_customer_name, ''));
    v_status text;
    v_line_count integer;
    v_calculated numeric;
BEGIN
    IF v_actor IS NULL OR v_org IS NULL THEN
        RAISE EXCEPTION 'An authenticated workspace is required.'
            USING ERRCODE = '42501';
    END IF;

    SELECT *
      INTO v_q
      FROM public.event_quotations
     WHERE id = _quotation
       AND organization_id = v_org
     FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Quotation not found in this workspace.'
            USING ERRCODE = 'P0002';
    END IF;

    IF v_q.branch_id IS NULL
       OR public.neo_branch_in_scope(v_q.branch_id) IS NOT TRUE THEN
        RAISE EXCEPTION 'Quotation property is outside your access scope.'
            USING ERRCODE = '42501';
    END IF;

    IF v_action NOT IN (
        'submit', 'approve', 'send', 'accept', 'reject'
    ) THEN
        RAISE EXCEPTION 'Unsupported quotation action: %', v_action
            USING ERRCODE = '22023';
    END IF;

    IF v_action = 'submit' THEN

        IF NOT public.has_permission('events', 'quotations', 'edit') THEN
            RAISE EXCEPTION 'Permission to edit quotations is required.'
                USING ERRCODE = '42501';
        END IF;

        IF v_q.status <> 'draft' THEN
            RAISE EXCEPTION 'Only draft quotations can be submitted.'
                USING ERRCODE = '22023';
        END IF;

        SELECT count(*), coalesce(sum(line_total), 0)
          INTO v_line_count, v_calculated
          FROM public.event_quotation_items
         WHERE quotation_id = v_q.id
           AND organization_id = v_org;

        IF v_line_count = 0 THEN
            RAISE EXCEPTION 'Add and price quotation items before submission.'
                USING ERRCODE = '22023';
        END IF;

        IF v_q.grand_total <= 0 THEN
            RAISE EXCEPTION 'Quotation total must be greater than zero.'
                USING ERRCODE = '22023';
        END IF;

        IF abs(v_calculated - v_q.subtotal) > 0.01 THEN
            RAISE EXCEPTION 'Quotation lines and subtotal do not reconcile. Reprice before submission.'
                USING ERRCODE = '22023';
        END IF;

        v_status := 'pending-approval';

        UPDATE public.event_quotations
           SET status = v_status,
               approved_by = NULL,
               approved_at = NULL,
               updated_by = v_actor,
               updated_at = now()
         WHERE id = v_q.id;

    ELSIF v_action = 'approve' THEN

        IF NOT public.has_permission('events', 'quotations', 'approve') THEN
            RAISE EXCEPTION 'Quotation approval permission is required.'
                USING ERRCODE = '42501';
        END IF;

        IF v_q.status <> 'pending-approval' THEN
            RAISE EXCEPTION 'Only quotations pending approval can be approved.'
                USING ERRCODE = '22023';
        END IF;

        IF v_q.created_by IS NULL THEN
            RAISE EXCEPTION 'Quotation has no accountable creator. Assign its maker before approval.'
                USING ERRCODE = '23514';
        END IF;

        IF v_q.created_by = v_actor THEN
            RAISE EXCEPTION 'The quotation creator cannot approve their own quotation.'
                USING ERRCODE = '42501';
        END IF;

        v_status := 'approved';

        UPDATE public.event_quotations
           SET status = v_status,
               approved_by = v_actor,
               approved_at = now(),
               updated_by = v_actor,
               updated_at = now()
         WHERE id = v_q.id;

    ELSIF v_action = 'send' THEN

        IF NOT public.has_permission('events', 'quotations', 'edit') THEN
            RAISE EXCEPTION 'Permission to issue quotations is required.'
                USING ERRCODE = '42501';
        END IF;

        IF v_q.status <> 'approved'
           OR v_q.approved_by IS NULL
           OR v_q.approved_at IS NULL THEN
            RAISE EXCEPTION 'The quotation must receive managerial approval before issuing.'
                USING ERRCODE = '22023';
        END IF;

        v_status := 'sent';

        UPDATE public.event_quotations
           SET status = v_status,
               sent_at = now(),
               updated_by = v_actor,
               updated_at = now()
         WHERE id = v_q.id;

    ELSIF v_action = 'accept' THEN

        IF NOT public.has_permission('events', 'quotations', 'edit') THEN
            RAISE EXCEPTION 'Permission to record client decisions is required.'
                USING ERRCODE = '42501';
        END IF;

        IF v_q.status NOT IN ('sent', 'viewed') THEN
            RAISE EXCEPTION 'Only issued quotations can be accepted.'
                USING ERRCODE = '22023';
        END IF;

        IF v_q.approved_by IS NULL OR v_q.approved_at IS NULL THEN
            RAISE EXCEPTION 'Managerial approval is missing.'
                USING ERRCODE = '22023';
        END IF;

        IF v_customer = '' THEN
            RAISE EXCEPTION 'Record the name of the customer accepting the quotation.'
                USING ERRCODE = '22023';
        END IF;

        v_status := 'accepted';

        UPDATE public.event_quotations
           SET status = v_status,
               responded_at = now(),
               accepted_by_name = v_customer,
               acceptance_note = v_note,
               updated_by = v_actor,
               updated_at = now()
         WHERE id = v_q.id;

    ELSIF v_action = 'reject' THEN

        IF NOT public.has_permission('events', 'quotations', 'edit') THEN
            RAISE EXCEPTION 'Permission to record client decisions is required.'
                USING ERRCODE = '42501';
        END IF;

        IF v_q.status NOT IN ('sent', 'viewed') THEN
            RAISE EXCEPTION 'Only issued quotations can be rejected.'
                USING ERRCODE = '22023';
        END IF;

        IF v_note = '' THEN
            RAISE EXCEPTION 'Record the reason for rejection.'
                USING ERRCODE = '22023';
        END IF;

        v_status := 'rejected';

        UPDATE public.event_quotations
           SET status = v_status,
               responded_at = now(),
               acceptance_note = v_note,
               accepted_by_name = v_customer,
               updated_by = v_actor,
               updated_at = now()
         WHERE id = v_q.id;

    END IF;

    RETURN jsonb_build_object(
        'quotation_id', v_q.id,
        'quotation_number', v_q.quotation_number,
        'previous_status', v_q.status,
        'status', v_status,
        'action', v_action,
        'actor_id', v_actor,
        'customer_name', nullif(v_customer, ''),
        'note', nullif(v_note, '')
    );
END;
$function$;

REVOKE ALL ON FUNCTION public.neo_event_quotation_transition(
    uuid, text, text, text
) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION public.neo_event_quotation_transition(
    uuid, text, text, text
) TO authenticated;
