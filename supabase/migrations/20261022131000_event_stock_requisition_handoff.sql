-- NEØ E04: Events stock need -> Stores requisition
-- New function; existing shared requisition functions remain unchanged.
-- Creates no records until explicitly invoked by an authorised user.

CREATE OR REPLACE FUNCTION public.neo_event_stock_need_to_requisition(
    _need uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
    v_org uuid := public.current_org_id();
    v_need public.department_stock_needs;
    v_req uuid;
    v_number text;
BEGIN

    IF auth.uid() IS NULL
       OR v_org IS NULL
       OR public.is_active_staff() IS NOT TRUE THEN
        RAISE EXCEPTION 'An active staff session is required';
    END IF;

    -- Only authorised Events managers may raise this requisition.
    IF public.has_permission('events', 'stock_needs', 'approve')
       IS NOT TRUE THEN
        RAISE EXCEPTION
          'Only an authorised Events Manager can requisition stock';
    END IF;

    -- Lock the originating need to prevent concurrent duplication.
    SELECT *
      INTO v_need
      FROM public.department_stock_needs
     WHERE id = _need
       AND organization_id = v_org
       AND module = 'events'
     FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Event stock need not found';
    END IF;

    IF v_need.branch_id IS NULL
       OR NOT (v_need.branch_id = ANY(public.current_branch_ids())) THEN
        RAISE EXCEPTION 'The stock need is outside your property access';
    END IF;

    -- E04: Every new Events requisition must belong to a real,
    -- active booking in the same organization and property.
    IF v_need.event_booking_id IS NULL THEN
        RAISE EXCEPTION
          'Select an event booking before requisitioning supplies';
    END IF;

    IF NOT EXISTS (
        SELECT 1
        FROM public.event_bookings b
        WHERE b.id = v_need.event_booking_id
          AND b.organization_id = v_org
          AND b.branch_id = v_need.branch_id
          AND lower(coalesce(b.status, '')) NOT IN (
              'cancelled',
              'closed',
              'completed',
              'no-show'
          )
    ) THEN
        RAISE EXCEPTION
          'The originating event is invalid, closed, or belongs to another property';
    END IF;

    -- Return a previously linked requisition without creating another.
    IF v_need.requisition_id IS NOT NULL THEN

        SELECT id, request_number
          INTO v_req, v_number
          FROM public.internal_requisitions
         WHERE id = v_need.requisition_id
           AND organization_id = v_org
           AND branch_id = v_need.branch_id
           AND department_id IS NOT DISTINCT FROM v_need.department_id
           AND event_booking_id = v_need.event_booking_id;

        IF v_req IS NULL THEN
            RAISE EXCEPTION
              'The stock need references an invalid requisition';
        END IF;

        RETURN jsonb_build_object(
            'ok', true,
            'already_exists', true,
            'requisition_id', v_req,
            'request_number', v_number,
            'status', 'requisitioned'
        );
    END IF;

    IF v_need.status NOT IN ('pending', 'acknowledged') THEN
        RAISE EXCEPTION
          'Only pending or acknowledged stock needs can be requisitioned';
    END IF;

    IF coalesce(v_need.quantity, 0) <= 0 THEN
        RAISE EXCEPTION 'Requested quantity must be greater than zero';
    END IF;

    v_number :=
        'REQ-' ||
        to_char(now(), 'YYMMDD') ||
        '-' ||
        upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 5));

    -- New requisitions require supervisor approval.
    -- The creator is never recorded as their own approver.
    INSERT INTO public.internal_requisitions (
        organization_id,
        branch_id,
        request_number,
        department_id,
        event_booking_id,
        fulfilment_model,
        requested_by,
        request_date,
        priority,
        reason,
        status
    )
    VALUES (
        v_org,
        v_need.branch_id,
        v_number,
        v_need.department_id,
        v_need.event_booking_id,
        'stores-issue',
        auth.uid(),
        current_date,
        coalesce(v_need.priority, 'normal'),
        'Events stock need: ' || v_need.item ||
          ' (Need ' || v_need.id::text || ')',
        'pending-supervisor'
    )
    RETURNING id INTO v_req;

    INSERT INTO public.internal_requisition_lines (
        organization_id,
        requisition_id,
        description,
        unit,
        quantity_requested,
        notes
    )
    VALUES (
        v_org,
        v_req,
        v_need.item,
        coalesce(v_need.unit, 'unit'),
        v_need.quantity,
        v_need.notes
    );

    UPDATE public.department_stock_needs
       SET status = 'requisitioned',
           requisition_id = v_req,
           reviewed_by = auth.uid(),
           reviewed_at = now(),
           updated_at = now()
     WHERE id = v_need.id
       AND organization_id = v_org;

    PERFORM public.neo_notify(
        v_org,
        NULL,
        v_need.branch_id,
        'operational-alert',
        'Events requisition awaiting approval - ' || v_number,
        'An Events stock need has been submitted to Stores.',
        '/inventory/requisitions',
        coalesce(v_need.priority, 'normal'),
        true,
        'stores',
        v_req,
        'stores.requisition_raised',
        'req:' || v_req::text || ':raised'
    );

    RETURN jsonb_build_object(
        'ok', true,
        'already_exists', false,
        'need_id', v_need.id,
        'requisition_id', v_req,
        'request_number', v_number,
        'status', 'pending-supervisor',
        'lines', 1
    );

END;
$function$;

REVOKE ALL ON FUNCTION
public.neo_event_stock_need_to_requisition(uuid)
FROM PUBLIC;

GRANT EXECUTE ON FUNCTION
public.neo_event_stock_need_to_requisition(uuid)
TO authenticated;