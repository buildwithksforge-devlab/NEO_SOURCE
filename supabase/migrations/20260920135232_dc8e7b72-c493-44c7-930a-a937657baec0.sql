-- 1. Recognise both spellings of the transaction-local system-posting flag.
--    Controlled routines (maintenance part issue, recipe consumption, posting
--    engines) set 'on' or '1'; the stock guard only accepted '1', so an
--    authorised maintenance issue was rejected as a manual stock move.
CREATE OR REPLACE FUNCTION public.neo_system_posting()
 RETURNS boolean
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $function$
  SELECT COALESCE(current_setting('neo.system_posting', true), 'off') IN ('on','1','true')
$function$;

CREATE OR REPLACE FUNCTION public.inventory_apply_movement(_item uuid, _location uuid, _quantity numeric, _unit text, _movement_type text, _unit_cost numeric DEFAULT NULL::numeric, _reference_type text DEFAULT NULL::text, _reference_id uuid DEFAULT NULL::uuid, _reason text DEFAULT NULL::text, _idempotency_key text DEFAULT NULL::text, _batch_number text DEFAULT NULL::text, _expiry date DEFAULT NULL::date)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_org uuid := current_org_id();
  v_item record;
  v_qty_base numeric;
  v_cost numeric;
  v_level record;
  v_batch uuid;
  v_movement uuid;
  v_existing uuid;
BEGIN
  IF v_org IS NULL THEN RAISE EXCEPTION 'No active organization'; END IF;
  IF NOT public.neo_system_posting()
     AND NOT (has_permission('inventory','stock.manage') OR has_permission('procurement','receiving.manage')) THEN
    RAISE EXCEPTION 'Not permitted to move stock';
  END IF;

  IF _idempotency_key IS NOT NULL THEN
    SELECT id INTO v_existing FROM stock_movements WHERE organization_id = v_org AND idempotency_key = _idempotency_key;
    IF v_existing IS NOT NULL THEN RETURN v_existing; END IF;
  END IF;

  SELECT * INTO v_item FROM stock_items WHERE id = _item AND organization_id = v_org;
  IF v_item IS NULL THEN RAISE EXCEPTION 'Unknown stock item'; END IF;

  v_qty_base := inventory_convert(_quantity, COALESCE(_unit, v_item.base_unit), v_item.base_unit);
  v_cost := COALESCE(_unit_cost, v_item.average_cost);

  INSERT INTO stock_levels (organization_id, stock_item_id, location_id, quantity_on_hand, last_movement_at)
  VALUES (v_org, _item, _location, 0, now())
  ON CONFLICT (stock_item_id, location_id) DO NOTHING;

  SELECT * INTO v_level FROM stock_levels WHERE stock_item_id = _item AND location_id = _location FOR UPDATE;

  IF v_qty_base > 0 AND (v_item.track_batches OR _batch_number IS NOT NULL OR _expiry IS NOT NULL) THEN
    INSERT INTO stock_batches (organization_id, stock_item_id, location_id, batch_number, expiry_date, quantity, unit_cost)
    VALUES (v_org, _item, _location, _batch_number, _expiry, v_qty_base, v_cost)
    RETURNING id INTO v_batch;
  ELSIF v_qty_base < 0 THEN
    SELECT id INTO v_batch FROM stock_batches
      WHERE stock_item_id = _item AND location_id = _location AND quantity > 0 AND status = 'active'
      ORDER BY expiry_date NULLS LAST, received_at LIMIT 1;
    IF v_batch IS NOT NULL THEN
      UPDATE stock_batches SET quantity = GREATEST(0, quantity + v_qty_base) WHERE id = v_batch;
    END IF;
  END IF;

  UPDATE stock_levels
     SET quantity_on_hand = quantity_on_hand + v_qty_base,
         quantity_damaged = quantity_damaged + CASE WHEN _movement_type = 'damage' THEN abs(v_qty_base) ELSE 0 END,
         quantity_expired = quantity_expired + CASE WHEN _movement_type = 'expiry' THEN abs(v_qty_base) ELSE 0 END,
         last_movement_at = now()
   WHERE id = v_level.id;

  IF v_qty_base > 0 AND _unit_cost IS NOT NULL THEN
    UPDATE stock_items
       SET last_cost = v_cost,
           average_cost = CASE
             WHEN COALESCE(v_level.quantity_on_hand, 0) + v_qty_base <= 0 THEN v_cost
             ELSE ((GREATEST(v_level.quantity_on_hand, 0) * average_cost) + (v_qty_base * v_cost))
                  / (GREATEST(v_level.quantity_on_hand, 0) + v_qty_base)
           END
     WHERE id = _item;
  END IF;

  INSERT INTO stock_movements (
    organization_id, branch_id, stock_item_id, location_id, batch_id, movement_type,
    quantity, unit, unit_cost, value, balance_after, reference_type, reference_id,
    reason, idempotency_key, performed_by
  ) VALUES (
    v_org, v_item.branch_id, _item, _location, v_batch, _movement_type,
    v_qty_base, v_item.base_unit, v_cost, v_qty_base * v_cost,
    (SELECT quantity_on_hand FROM stock_levels WHERE id = v_level.id),
    _reference_type, _reference_id, _reason, _idempotency_key, auth.uid()
  ) RETURNING id INTO v_movement;

  RETURN v_movement;
END;
$function$;

-- 2. What a work order may legitimately draw on: real stock, in an active
--    store of that work order's property, in this workspace. No semantic
--    exclusions the hotel has not configured.
CREATE OR REPLACE FUNCTION public.neo_maint_issuable_stock(_work_order uuid)
 RETURNS TABLE(stock_item_id uuid, item_name text, base_unit text, location_id uuid, location_name text, quantity_on_hand numeric)
 LANGUAGE plpgsql
 STABLE
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE v_wo public.maintenance_work_orders;
BEGIN
  SELECT * INTO v_wo FROM public.maintenance_work_orders
   WHERE id = _work_order AND organization_id = current_org_id();
  IF v_wo.id IS NULL THEN RETURN; END IF;
  IF v_wo.assigned_to IS DISTINCT FROM auth.uid()
     AND NOT (has_permission('maintenance','overview','edit') OR has_permission('maintenance','edit')) THEN
    RETURN;
  END IF;

  RETURN QUERY
  SELECT si.id, si.name, si.base_unit, sl.id, sl.name, lv.quantity_on_hand
    FROM public.stock_levels lv
    JOIN public.stock_items si ON si.id = lv.stock_item_id
    JOIN public.stock_locations sl ON sl.id = lv.location_id
   WHERE lv.organization_id = v_wo.organization_id
     AND si.organization_id = v_wo.organization_id
     AND sl.organization_id = v_wo.organization_id
     AND sl.active
     AND coalesce(si.active, true)
     AND (sl.branch_id IS NULL OR v_wo.branch_id IS NULL OR sl.branch_id = v_wo.branch_id)
     AND lv.quantity_on_hand > 0
   ORDER BY si.name, sl.name;
END; $function$;

REVOKE ALL ON FUNCTION public.neo_maint_issuable_stock(uuid) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.neo_maint_issuable_stock(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.neo_maint_issuable_stock(uuid) TO service_role;

-- 3. A part cannot be taken from a store that does not hold it.
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
        v_available numeric; v_qty_base numeric;
BEGIN
  SELECT * INTO v_wo FROM public.maintenance_work_orders
   WHERE id = _work_order AND organization_id = current_org_id();
  IF v_wo.id IS NULL THEN RAISE EXCEPTION 'Work order not found'; END IF;
  IF v_wo.assigned_to IS DISTINCT FROM auth.uid()
     AND NOT (has_permission('maintenance','overview','edit') OR has_permission('maintenance','edit')) THEN
    RAISE EXCEPTION 'Only the assigned technician or a supervisor can record materials';
  END IF;
  IF v_wo.status IN ('closed','cancelled') THEN
    RAISE EXCEPTION 'This work order is already closed';
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

  v_qty_base := public.inventory_convert(_quantity,
                  coalesce(nullif(btrim(coalesce(_unit,'')),''), v_item.base_unit), v_item.base_unit);
  SELECT coalesce(quantity_on_hand, 0) INTO v_available
    FROM public.stock_levels WHERE stock_item_id = _stock_item AND location_id = _location;
  IF coalesce(v_available, 0) < v_qty_base THEN
    RAISE EXCEPTION 'Only % % of % are on hand in %', coalesce(v_available,0), v_item.base_unit, v_item.name, v_loc.name;
  END IF;

  v_cost := public.neo_stock_average_cost(_stock_item, _location);

  PERFORM set_config('neo.system_posting', 'on', true);
  v_movement := public.inventory_apply_movement(
    _stock_item, _location, -1 * _quantity, coalesce(nullif(btrim(coalesce(_unit,'')),''), v_item.base_unit),
    'issue', v_cost, 'maintenance_work_order', _work_order,
    'Maintenance work order ' || coalesce(v_wo.work_order_number,''), v_key, NULL, NULL);
  PERFORM set_config('neo.system_posting', 'off', true);

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