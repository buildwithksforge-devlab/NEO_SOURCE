REVOKE ALL ON FUNCTION public.inventory_open_container(uuid,uuid,text,text,uuid,text) FROM anon, public;
REVOKE ALL ON FUNCTION public.inventory_consume_volume(uuid,uuid,numeric,text,text,text,uuid,text) FROM anon, public;
REVOKE ALL ON FUNCTION public.inventory_record_usage(uuid,uuid,numeric,text,text,text,text,uuid,text) FROM anon, public;
GRANT EXECUTE ON FUNCTION public.inventory_open_container(uuid,uuid,text,text,uuid,text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.inventory_consume_volume(uuid,uuid,numeric,text,text,text,uuid,text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.inventory_record_usage(uuid,uuid,numeric,text,text,text,text,uuid,text) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.inventory_consume_order_item_core(_order_item uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_item record; v_recipe record; v_comp record;
  v_location uuid; v_station_location uuid; v_line_location uuid;
  v_stock record; v_batches numeric;
  v_cost numeric := 0; v_lines integer := 0; v_group_lines integer := 0;
  v_volume_lines integer := 0; v_ml numeric;
  v_org uuid; v_branch uuid; v_station uuid;
  v_order_number text; v_menu_name text; v_station_name text;
  v_ticket_number text; v_actor text; v_store_name text; v_note text;
BEGIN
  SELECT oi.*, o.branch_id, o.organization_id AS org, o.status AS order_status
    INTO v_item
    FROM pos_order_items oi JOIN pos_orders o ON o.id = oi.order_id
   WHERE oi.id = _order_item;
  IF v_item IS NULL THEN RETURN jsonb_build_object('status','no-item'); END IF;
  v_org := v_item.org;
  v_branch := v_item.branch_id;

  IF v_item.order_status IN ('cancelled','voided','void-pending')
     OR v_item.status IN ('draft','cancelled','voided','cancel-pending') THEN
    INSERT INTO inventory_posting_events (organization_id, branch_id, order_id, order_item_id,
      posting_type, idempotency_key, status, payload)
    VALUES (v_org, v_branch, v_item.order_id, _order_item, 'consumption',
      'skip:' || _order_item::text, 'skipped',
      jsonb_build_object('reason','lifecycle','order_status',v_item.order_status,'item_status',v_item.status))
    ON CONFLICT DO NOTHING;

    INSERT INTO audit_logs (organization_id, branch_id, user_name, action, module, record_id, new_value, reason)
    VALUES (v_org, v_branch, COALESCE(auth.uid()::text, 'system'), 'stock.consumption.skipped', 'inventory',
      _order_item::text,
      jsonb_build_object('order_status', v_item.order_status, 'item_status', v_item.status),
      'Cancelled or draft order item — no stock deducted');

    RETURN jsonb_build_object('status','skipped-lifecycle','order_status',v_item.order_status);
  END IF;

  IF EXISTS (SELECT 1 FROM inventory_posting_events WHERE order_item_id = _order_item AND status = 'posted') THEN
    RETURN jsonb_build_object('status','already-posted');
  END IF;

  SELECT * INTO v_recipe FROM recipes
   WHERE organization_id = v_org
     AND menu_item_id = v_item.menu_item_id
     AND recipe_type IN ('menu_item','direct_sale')
     AND status = 'active'
   ORDER BY (recipe_type = 'menu_item') DESC, version DESC LIMIT 1;
  IF v_recipe IS NULL THEN RETURN jsonb_build_object('status','no-recipe'); END IF;

  v_station := COALESCE(v_item.station_id, v_recipe.station_id);

  SELECT sl.id INTO v_station_location
    FROM stock_locations sl
   WHERE sl.organization_id = v_org AND sl.active AND v_station IS NOT NULL
     AND sl.station_id = v_station
   LIMIT 1;

  v_location := public.neo_station_consumption_location(v_org, v_station, v_branch);
  IF v_location IS NULL THEN
    RETURN jsonb_build_object('status','no-location','branch_id',v_branch,'station_id', v_station);
  END IF;

  IF COALESCE(v_recipe.yield_quantity, 0) <= 0 THEN
    RAISE EXCEPTION 'Recipe % has no usable yield quantity', v_recipe.id USING ERRCODE = 'data_exception';
  END IF;
  v_batches := CASE WHEN v_recipe.recipe_type = 'direct_sale'
                    THEN COALESCE(v_item.quantity, 1)
                    ELSE COALESCE(v_item.quantity, 1) / v_recipe.yield_quantity END;

  SELECT o.order_number INTO v_order_number FROM pos_orders o WHERE o.id = v_item.order_id;
  SELECT m.name INTO v_menu_name FROM menu_items m WHERE m.id = v_item.menu_item_id;
  IF v_station IS NOT NULL THEN
    SELECT s.name INTO v_station_name FROM operational_stations s WHERE s.id = v_station;
  END IF;
  SELECT t.ticket_number INTO v_ticket_number
    FROM station_ticket_items ti JOIN station_tickets t ON t.id = ti.ticket_id
   WHERE ti.order_item_id = _order_item
   ORDER BY t.created_at DESC LIMIT 1;
  SELECT COALESCE(p.full_name, p.email) INTO v_actor
    FROM profiles p WHERE p.id = auth.uid();

  FOR v_comp IN
    SELECT e.stock_item_id AS item_id, sum(e.quantity) AS qty, min(e.unit) AS unit
      FROM public.recipe_expand_to_stock(v_recipe.id, v_batches, v_branch) e
     GROUP BY e.stock_item_id
  LOOP
    v_line_location := COALESCE(
      v_station_location,
      public.neo_item_group_store(v_org, v_comp.item_id, v_branch),
      v_location);
    IF v_station_location IS NULL
       AND public.neo_item_group_store(v_org, v_comp.item_id, v_branch) IS NOT NULL THEN
      v_group_lines := v_group_lines + 1;
    END IF;

    SELECT sl.name INTO v_store_name FROM stock_locations sl WHERE sl.id = v_line_location;

    v_note := 'Sale consumption · order ' || COALESCE(v_order_number, v_item.order_id::text)
              || ' · ' || COALESCE(v_menu_name, 'menu item')
              || ' ×' || trim(to_char(COALESCE(v_item.quantity, 1), 'FM999999990.###'))
              || CASE WHEN v_ticket_number IS NOT NULL THEN ' · ticket ' || v_ticket_number ELSE '' END
              || CASE WHEN v_station_name IS NOT NULL THEN ' · station ' || v_station_name ELSE '' END
              || CASE WHEN v_store_name IS NOT NULL THEN ' · from ' || v_store_name ELSE '' END
              || CASE WHEN v_actor IS NOT NULL THEN ' · recorded by ' || v_actor ELSE '' END;

    SELECT si.* INTO v_stock FROM stock_items si WHERE si.id = v_comp.item_id;

    -- Measured pours (tots, cocktails) draw from the open container; another
    -- container is opened automatically when the open one runs short.
    IF lower(COALESCE(v_comp.unit,'')) IN ('ml','millilitre','millilitres','cl','l','litre','litres')
       AND COALESCE(v_stock.tracking_method,'whole') IN ('volume','both')
       AND COALESCE(v_stock.container_volume_ml,0) > 0 THEN
      v_ml := v_comp.qty * CASE lower(v_comp.unit)
                             WHEN 'cl' THEN 10
                             WHEN 'l' THEN 1000 WHEN 'litre' THEN 1000 WHEN 'litres' THEN 1000
                             ELSE 1 END;
      PERFORM public.inventory_consume_volume(
        v_comp.item_id, v_line_location, v_ml, v_note, 'pour',
        'pos_order_item', _order_item,
        'pour:' || _order_item::text || ':' || v_comp.item_id::text);
      v_cost := v_cost + (v_ml / v_stock.container_volume_ml) * COALESCE(v_stock.average_cost, 0);
      v_volume_lines := v_volume_lines + 1;
      v_lines := v_lines + 1;
      PERFORM public.neo_evaluate_low_stock(v_org, v_branch, v_comp.item_id, 'consumption', _order_item);
      CONTINUE;
    END IF;

    PERFORM inventory_apply_movement(v_comp.item_id, v_line_location, -v_comp.qty, v_comp.unit, 'consumption',
      COALESCE(v_stock.average_cost, 0),
      'pos_order_item', _order_item, v_note,
      'consume:' || _order_item::text || ':' || v_comp.item_id::text, NULL, NULL);
    v_cost := v_cost + (v_comp.qty * COALESCE(v_stock.average_cost, 0));
    v_lines := v_lines + 1;
    PERFORM public.neo_evaluate_low_stock(v_org, v_branch, v_comp.item_id, 'consumption', _order_item);
  END LOOP;

  INSERT INTO inventory_posting_events (organization_id, branch_id, order_id, order_item_id, recipe_id,
    recipe_version, posting_type, idempotency_key, status, cost_snapshot, payload)
  VALUES (v_org, v_branch, v_item.order_id, _order_item, v_recipe.id, v_recipe.version,
    'consumption', 'consume:' || _order_item::text, 'posted', v_cost,
    jsonb_build_object('lines', v_lines, 'unresolved_ingredients', 0, 'costing', 'weighted-average',
                       'location_id', v_location, 'branch_id', v_branch,
                       'station_location_id', v_station_location,
                       'group_routed_lines', v_group_lines,
                       'volume_lines', v_volume_lines,
                       'batches', v_batches, 'recipe_yield', v_recipe.yield_quantity,
                       'recipe_type', v_recipe.recipe_type,
                       'order_number', v_order_number,
                       'menu_item', v_menu_name,
                       'ticket_number', v_ticket_number,
                       'station_name', v_station_name))
  ON CONFLICT DO NOTHING;

  RETURN jsonb_build_object('status','posted','lines',v_lines,'cost',v_cost,'unresolved',0,
                            'location_id',v_location,'group_routed_lines',v_group_lines,
                            'volume_lines',v_volume_lines,
                            'batches',v_batches);
END;
$function$;
