-- E03: Link event stock needs to their originating booking.
-- New Events-specific RPC; other department RPC signatures are unchanged.

ALTER TABLE public.department_stock_needs
ADD COLUMN IF NOT EXISTS event_booking_id uuid
REFERENCES public.event_bookings(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_event_stock_needs_booking
ON public.department_stock_needs(organization_id, event_booking_id)
WHERE event_booking_id IS NOT NULL;

CREATE OR REPLACE FUNCTION public.neo_event_stock_need_create(
    _booking uuid,
    _item text,
    _quantity numeric,
    _unit text DEFAULT 'unit',
    _priority text DEFAULT 'normal',
    _notes text DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
    v_org uuid := public.current_org_id();
    v_booking public.event_bookings;
    v_id uuid;
    v_department uuid;
BEGIN
    IF auth.uid() IS NULL
       OR v_org IS NULL
       OR public.is_active_staff() IS NOT TRUE THEN
        RAISE EXCEPTION 'Only active staff can report event stock needs';
    END IF;

    IF public.has_permission('events', 'stock_needs', 'create')
       IS NOT TRUE THEN
        RAISE EXCEPTION
          'You are not permitted to report Events stock needs';
    END IF;

    SELECT *
      INTO v_booking
      FROM public.event_bookings
     WHERE id = _booking
       AND organization_id = v_org;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Event booking not found';
    END IF;

    IF v_booking.branch_id IS NULL
       OR NOT (v_booking.branch_id = ANY(public.current_branch_ids())) THEN
        RAISE EXCEPTION 'The event is outside your property access';
    END IF;

    IF v_booking.status IN ('cancelled', 'closed') THEN
        RAISE EXCEPTION 'Stock cannot be requested for a closed or cancelled event';
    END IF;

    IF coalesce(btrim(_item), '') = '' THEN
        RAISE EXCEPTION 'Describe the item needed';
    END IF;

    IF _quantity IS NULL OR _quantity <= 0 THEN
        RAISE EXCEPTION 'Quantity must be greater than zero';
    END IF;

    SELECT p.department_id
      INTO v_department
      FROM public.profiles p
     WHERE p.id = auth.uid();

    INSERT INTO public.department_stock_needs (
        organization_id,
        branch_id,
        department_id,
        module,
        event_booking_id,
        item,
        quantity,
        unit,
        priority,
        notes,
        requested_by
    )
    VALUES (
        v_org,
        v_booking.branch_id,
        v_department,
        'events',
        v_booking.id,
        btrim(_item),
        _quantity,
        coalesce(nullif(btrim(_unit), ''), 'unit'),
        coalesce(nullif(btrim(_priority), ''), 'normal'),
        nullif(btrim(_notes), ''),
        auth.uid()
    )
    RETURNING id INTO v_id;

    RETURN v_id;
END;
$function$;

REVOKE ALL ON FUNCTION
public.neo_event_stock_need_create(uuid,text,numeric,text,text,text)
FROM PUBLIC;

GRANT EXECUTE ON FUNCTION
public.neo_event_stock_need_create(uuid,text,numeric,text,text,text)
TO authenticated;