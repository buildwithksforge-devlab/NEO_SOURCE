CREATE OR REPLACE FUNCTION public.neo_beo_revise(
    _beo uuid,
    _change_summary text
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    old_beo public.banquet_event_orders%ROWTYPE;
    new_beo_id uuid;
    next_revision integer;
BEGIN
    IF auth.uid() IS NULL THEN
        RAISE EXCEPTION 'Authentication required.';
    END IF;

    SELECT *
    INTO old_beo
    FROM public.banquet_event_orders
    WHERE id = _beo
    FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Banquet event order not found.';
    END IF;

    IF old_beo.organization_id IS DISTINCT FROM public.current_org_id() THEN
        RAISE EXCEPTION 'This BEO belongs to another workspace.';
    END IF;

    IF NOT (
        public.has_permission('events', 'beo.manage')
        OR public.is_org_admin()
    ) THEN
        RAISE EXCEPTION 'You are not permitted to revise this BEO.';
    END IF;

    IF old_beo.status IN ('superseded', 'cancelled') THEN
        RAISE EXCEPTION 'A superseded or cancelled BEO cannot be revised.';
    END IF;

    IF length(trim(coalesce(_change_summary, ''))) = 0 THEN
        RAISE EXCEPTION 'Provide a summary of the changes.';
    END IF;

    SELECT coalesce(max(revision), 0) + 1
    INTO next_revision
    FROM public.banquet_event_orders
    WHERE organization_id = old_beo.organization_id
      AND beo_number = old_beo.beo_number;

    INSERT INTO public.banquet_event_orders (
        organization_id,
        branch_id,
        booking_id,
        beo_number,
        revision,
        change_summary,
        setup_at,
        guest_arrival_at,
        start_at,
        serving_times,
        end_at,
        breakdown_at,
        guaranteed_guests,
        final_guests,
        seating_layout,
        menu_summary,
        beverage_service,
        dietary_requirements,
        allergies,
        equipment,
        decor,
        entertainment,
        signage,
        accommodation,
        transport,
        security,
        billing_instructions,
        department_instructions,
        emergency_contacts,
        status,
        published_at,
        approved_by,
        approved_at,
        locked,
        created_by,
        updated_by
    )
    VALUES (
        old_beo.organization_id,
        old_beo.branch_id,
        old_beo.booking_id,
        old_beo.beo_number,
        next_revision,
        trim(_change_summary),
        old_beo.setup_at,
        old_beo.guest_arrival_at,
        old_beo.start_at,
        old_beo.serving_times,
        old_beo.end_at,
        old_beo.breakdown_at,
        old_beo.guaranteed_guests,
        old_beo.final_guests,
        old_beo.seating_layout,
        old_beo.menu_summary,
        old_beo.beverage_service,
        old_beo.dietary_requirements,
        old_beo.allergies,
        old_beo.equipment,
        old_beo.decor,
        old_beo.entertainment,
        old_beo.signage,
        old_beo.accommodation,
        old_beo.transport,
        old_beo.security,
        old_beo.billing_instructions,
        old_beo.department_instructions,
        old_beo.emergency_contacts,
        'draft',
        NULL,
        NULL,
        NULL,
        FALSE,
        auth.uid(),
        auth.uid()
    )
    RETURNING id INTO new_beo_id;

    UPDATE public.banquet_event_orders
    SET status = 'superseded',
        updated_by = auth.uid(),
        updated_at = now()
    WHERE id = old_beo.id;

    RETURN new_beo_id;
END;
$$;

REVOKE ALL ON FUNCTION public.neo_beo_revise(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.neo_beo_revise(uuid, text) TO authenticated;