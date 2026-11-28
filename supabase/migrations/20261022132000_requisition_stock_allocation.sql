-- NEØ E07-A: Secure stock-item allocation for departmental requisitions.
-- Forward-only migration.
-- No operational records are modified by installing this function.

CREATE OR REPLACE FUNCTION public.neo_requisition_assign_stock_item(
    _requisition uuid,
    _line uuid,
    _stock_item uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
    v_org uuid := public.current_org_id();
    v_req public.internal_requisitions;
    v_line public.internal_requisition_lines;
    v_item public.stock_items;
BEGIN
    -- Authentication and Stores authorization.
    IF auth.uid() IS NULL
       OR v_org IS NULL
       OR public.is_active_staff() IS NOT TRUE THEN
        RAISE EXCEPTION 'An active staff session is required';
    END IF;

    IF NOT (
        public.has_permission('stores', 'edit')
        OR public.has_permission('stores', 'approve')
        OR public.is_org_admin()
    ) THEN
        RAISE EXCEPTION 'Stores authorization is required';
    END IF;

    -- Lock the requisition to serialize allocation against approval.
    SELECT *
      INTO v_req
      FROM public.internal_requisitions
     WHERE id = _requisition
       AND organization_id = v_org
     FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Requisition not found';
    END IF;

    -- Property access.
    IF v_req.branch_id IS NULL
       OR NOT (
           v_req.branch_id = ANY(public.current_branch_ids())
       ) THEN
        RAISE EXCEPTION 'Requisition is outside your property access';
    END IF;

    -- Mapping must happen before Stores quantity approval.
    IF v_req.status NOT IN (
        'pending-supervisor',
        'awaiting-stores'
    ) THEN
        RAISE EXCEPTION
            'Stock items cannot be changed after Stores approval';
    END IF;

    -- Lock the selected requisition line.
    SELECT *
      INTO v_line
      FROM public.internal_requisition_lines
     WHERE id = _line
       AND requisition_id = _requisition
       AND organization_id = v_org
     FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Requisition line not found';
    END IF;

    -- Never change stock identity after issuing starts.
    IF COALESCE(v_line.quantity_issued, 0) > 0 THEN
        RAISE EXCEPTION
            'Cannot change an inventory item after stock has been issued';
    END IF;

    -- Validate the inventory item.
    SELECT *
      INTO v_item
      FROM public.stock_items
     WHERE id = _stock_item
       AND organization_id = v_org
       AND (
           branch_id = v_req.branch_id
           OR branch_id IS NULL
       );

    IF NOT FOUND THEN
        RAISE EXCEPTION
            'Inventory item does not belong to this organization or property';
    END IF;

    IF v_item.active IS NOT TRUE THEN
        RAISE EXCEPTION 'Cannot allocate an inactive inventory item';
    END IF;

    -- Safe repeat: no duplicate records or movements.
    IF v_line.stock_item_id = _stock_item THEN
        RETURN jsonb_build_object(
            'ok', true,
            'already_assigned', true,
            'requisition_id', _requisition,
            'line_id', _line,
            'stock_item_id', _stock_item
        );
    END IF;

    -- Allocation does NOT issue or deduct inventory.
    UPDATE public.internal_requisition_lines
       SET stock_item_id = _stock_item
     WHERE id = _line
       AND requisition_id = _requisition
       AND organization_id = v_org;

    RETURN jsonb_build_object(
        'ok', true,
        'already_assigned', false,
        'requisition_id', _requisition,
        'line_id', _line,
        'stock_item_id', _stock_item
    );
END;
$function$;

REVOKE ALL ON FUNCTION
public.neo_requisition_assign_stock_item(uuid, uuid, uuid)
FROM PUBLIC;

GRANT EXECUTE ON FUNCTION
public.neo_requisition_assign_stock_item(uuid, uuid, uuid)
TO authenticated;