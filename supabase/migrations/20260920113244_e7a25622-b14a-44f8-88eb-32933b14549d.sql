CREATE OR REPLACE FUNCTION public.neo_maint_consume_part(
  _work_order uuid, _stock_item uuid, _location uuid, _quantity numeric,
  _unit text DEFAULT NULL::text, _description text DEFAULT NULL::text,
  _idempotency_key text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE v_wo public.maintenance_work_orders; v_item public.stock_items; v_loc public.stock_locations;
        v_cost numeric; v_movement uuid; v_part public.work_order_parts; v_key text; v_existing uuid;
BEGIN
  SELECT * INTO v_wo FROM public.maintenance_work_orders
   WHERE id = _work_order AND organization_id = current_org_id();
  IF v_wo.id IS NULL THEN RAISE EXCEPTION 'Work order not found'; END IF;
  IF v_wo.assigned_to IS DISTINCT FROM auth.uid()
     AND NOT (has_permission('maintenance','overview','edit') OR has_permission('maintenance','edit')) THEN
    RAISE EXCEPTION 'Only the assigned technician or a supervisor can record materials';
  END IF;
  IF coalesce(_quantity,0) <= 0 THEN RAISE EXCEPTION 'Quantity must be greater than zero'; END IF;

  SELECT * INTO v_item FROM public.stock_items WHERE id = _stock_item AND organization_id = v_wo.organization_id;
  IF v_item.id IS NULL THEN RAISE EXCEPTION 'That stock item does not belong to this workspace'; END IF;
  SELECT * INTO v_loc FROM public.stock_locations
   WHERE id = _location AND organization_id = v_wo.organization_id AND active;
  IF v_loc.id IS NULL THEN RAISE EXCEPTION 'Choose the store the part came from'; END IF;
  IF v_loc.branch_id IS NOT NULL AND v_wo.branch_id IS NOT NULL AND v_loc.branch_id <> v_wo.branch_id THEN
    RAISE EXCEPTION 'That store belongs to another property';
  END IF;

  -- A retry must not issue the same part twice. The screen supplies a one-time
  -- reference for each recording; without one we fall back to the details of
  -- the entry itself so an immediate duplicate submission is still caught.
  v_key := 'maint:part:' || _work_order::text || ':' || _stock_item::text || ':' ||
           coalesce(nullif(btrim(coalesce(_idempotency_key,'')),''),
                    md5(_location::text || _quantity::text || coalesce(_description,'')));

  SELECT id INTO v_existing FROM public.stock_movements
   WHERE idempotency_key = v_key AND organization_id = v_wo.organization_id LIMIT 1;
  IF v_existing IS NOT NULL THEN
    SELECT * INTO v_part FROM public.work_order_parts
     WHERE work_order_id = _work_order AND stock_item_id = _stock_item
     ORDER BY created_at DESC LIMIT 1;
    RETURN jsonb_build_object('ok', true, 'duplicate', true, 'part_id', v_part.id,
      'movement_id', v_existing, 'unit_cost', v_part.unit_cost,
      'valued', v_part.unit_cost IS NOT NULL AND v_part.unit_cost > 0);
  END IF;

  v_cost := public.neo_stock_average_cost(_stock_item, _location);

  PERFORM set_config('neo.system_posting', 'on', true);
  v_movement := public.inventory_apply_movement(
    _stock_item, _location, -1 * _quantity, coalesce(nullif(btrim(coalesce(_unit,'')),''), v_item.base_unit),
    'issue', v_cost, 'maintenance_work_order', _work_order,
    'Maintenance work order ' || coalesce(v_wo.work_order_number,''), v_key, NULL, NULL);

  INSERT INTO public.work_order_parts (
    organization_id, work_order_id, stock_item_id, description, quantity, unit, unit_cost, status, created_by)
  VALUES (v_wo.organization_id, _work_order, _stock_item,
    coalesce(nullif(btrim(coalesce(_description,'')),''), v_item.name), _quantity,
    coalesce(nullif(btrim(coalesce(_unit,'')),''), v_item.base_unit), v_cost, 'issued', auth.uid())
  RETURNING * INTO v_part;

  UPDATE public.maintenance_work_orders
     SET actual_cost = coalesce(actual_cost, 0) + coalesce(round(_quantity * coalesce(v_cost,0), 2), 0)
   WHERE id = _work_order;

  INSERT INTO public.audit_logs (organization_id, branch_id, user_id, user_name, action, module, record_id, new_value)
  VALUES (v_wo.organization_id, v_wo.branch_id, auth.uid(), '', 'maintenance.part.consumed', 'maintenance',
    _work_order::text, jsonb_build_object('stock_item_id', _stock_item, 'location_id', _location,
      'quantity', _quantity, 'unit_cost', v_cost, 'movement_id', v_movement, 'part_id', v_part.id));

  RETURN jsonb_build_object('ok', true, 'part_id', v_part.id, 'movement_id', v_movement,
    'unit_cost', v_cost, 'valued', v_cost IS NOT NULL AND v_cost > 0);
END; $function$;

REVOKE ALL ON FUNCTION public.neo_maint_consume_part(uuid, uuid, uuid, numeric, text, text, text) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.neo_maint_consume_part(uuid, uuid, uuid, numeric, text, text, text) TO authenticated;
DROP FUNCTION IF EXISTS public.neo_maint_consume_part(uuid, uuid, uuid, numeric, text, text);
REVOKE ALL ON FUNCTION public.neo_maint_escalation_scan(uuid) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.neo_maint_escalation_scan(uuid) TO authenticated;