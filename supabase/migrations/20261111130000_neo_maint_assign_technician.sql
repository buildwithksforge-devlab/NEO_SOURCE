CREATE OR REPLACE FUNCTION public.neo_maint_assign_technician(
    _work_order uuid,
    _technician uuid
)
RETURNS public.maintenance_work_orders
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
    v_order public.maintenance_work_orders;
BEGIN
    IF auth.uid() IS NULL THEN
        RAISE EXCEPTION 'Authentication required';
    END IF;

    IF _work_order IS NULL OR _technician IS NULL THEN
        RAISE EXCEPTION 'Work order and technician are required';
    END IF;

    IF NOT (
        public.has_permission('maintenance', 'edit')
        OR public.has_permission('maintenance', 'work-orders.assign')
        OR public.is_org_admin()
    ) THEN
        RAISE EXCEPTION 'Maintenance assignment permission required';
    END IF;

    SELECT *
    INTO v_order
    FROM public.maintenance_work_orders
    WHERE id = _work_order
      AND organization_id = public.current_org_id()
    FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Work order not found in current organization';
    END IF;

    IF NOT public.in_my_branch_scope(
        v_order.organization_id,
        v_order.branch_id
    ) THEN
        RAISE EXCEPTION 'Work order is outside your property';
    END IF;

    IF v_order.status NOT IN ('new', 'assigned') THEN
        RAISE EXCEPTION
            'Cannot assign technician while work order is %',
            v_order.status;
    END IF;

    IF NOT public.neo_maintenance_technician_eligible(
        _technician,
        v_order.organization_id,
        v_order.branch_id
    ) THEN
        RAISE EXCEPTION
            'Selected technician is not eligible at this property';
    END IF;

    IF v_order.status = 'assigned'
       AND v_order.assigned_to IS NOT DISTINCT FROM _technician
    THEN
        RETURN v_order;
    END IF;

    UPDATE public.maintenance_work_orders
    SET assigned_to = _technician,
        status = 'assigned'
    WHERE id = v_order.id
      AND organization_id = v_order.organization_id
    RETURNING * INTO v_order;

    RETURN v_order;
END;
$function$;

REVOKE ALL
ON FUNCTION public.neo_maint_assign_technician(uuid, uuid)
FROM PUBLIC, anon;

GRANT EXECUTE
ON FUNCTION public.neo_maint_assign_technician(uuid, uuid)
TO authenticated;