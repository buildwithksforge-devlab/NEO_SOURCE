-- 1. Expansion that keeps the used quantity and the wastage allowance apart.
CREATE OR REPLACE FUNCTION public.recipe_expand_to_stock_kinds(
  _recipe uuid, _batches numeric, _branch uuid DEFAULT NULL::uuid, _path uuid[] DEFAULT '{}'::uuid[])
RETURNS TABLE(stock_item_id uuid, quantity numeric, unit text, kind text)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_recipe record; v_ing record; v_use numeric; v_waste numeric; v_sub_qty numeric;
  v_stock record; v_batch_item record; v_conv numeric;
BEGIN
  IF _recipe = ANY(_path) THEN
    RAISE EXCEPTION 'Recipe cycle detected at %', _recipe USING ERRCODE = 'data_exception';
  END IF;
  IF array_length(_path, 1) IS NOT NULL AND array_length(_path, 1) > 10 THEN
    RAISE EXCEPTION 'Recipe nesting too deep' USING ERRCODE = 'data_exception';
  END IF;

  SELECT * INTO v_recipe FROM recipes WHERE id = _recipe;
  IF v_recipe IS NULL THEN
    RAISE EXCEPTION 'Recipe % not found', _recipe USING ERRCODE = 'data_exception';
  END IF;
  IF v_recipe.status <> 'active' THEN
    RAISE EXCEPTION 'Recipe % is not active', _recipe USING ERRCODE = 'data_exception';
  END IF;
  IF COALESCE(v_recipe.yield_quantity, 0) <= 0 THEN
    RAISE EXCEPTION 'Recipe % has no usable yield quantity', _recipe USING ERRCODE = 'data_exception';
  END IF;

  -- Direct-sale: the sale takes the finished product off the shelf.
  IF v_recipe.recipe_type = 'direct_sale' AND v_recipe.output_stock_item_id IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM recipe_ingredients WHERE recipe_id = _recipe) THEN
    SELECT si.id, si.base_unit INTO v_stock FROM stock_items si WHERE si.id = v_recipe.output_stock_item_id;
    IF v_stock.id IS NULL THEN
      RAISE EXCEPTION 'Direct-sale recipe % has no stock item', _recipe USING ERRCODE = 'data_exception';
    END IF;
    RETURN QUERY SELECT
      v_stock.id,
      public.inventory_round_for_item(
        public.inventory_convert_for_item(v_recipe.yield_quantity * _batches,
          COALESCE(v_recipe.yield_unit, v_stock.base_unit), v_stock.base_unit, v_stock.id),
        v_stock.base_unit, v_stock.id),
      v_stock.base_unit,
      'use'::text;
    RETURN;
  END IF;

  FOR v_ing IN SELECT * FROM recipe_ingredients WHERE recipe_id = _recipe LOOP
    v_use := COALESCE(v_ing.quantity, 0) * _batches;
    v_waste := v_use * (COALESCE(v_ing.waste_allowance, 0) / 100.0);
    IF v_use = 0 AND v_waste = 0 THEN CONTINUE; END IF;

    IF v_ing.component_type = 'sub_recipe' THEN
      SELECT * INTO v_stock FROM recipes WHERE id = v_ing.sub_recipe_id;
      IF v_stock IS NULL THEN
        RAISE EXCEPTION 'Sub-recipe % not found', v_ing.sub_recipe_id USING ERRCODE = 'data_exception';
      END IF;
      IF COALESCE(v_stock.yield_quantity, 0) <= 0 THEN
        RAISE EXCEPTION 'Sub-recipe % has no usable yield quantity', v_ing.sub_recipe_id
          USING ERRCODE = 'data_exception';
      END IF;
      v_sub_qty := public.inventory_convert_strict(v_use + v_waste,
        COALESCE(v_ing.unit, v_stock.yield_unit), v_stock.yield_unit);

      IF v_stock.output_stock_item_id IS NOT NULL THEN
        SELECT si.id, si.base_unit INTO v_batch_item FROM stock_items si WHERE si.id = v_stock.output_stock_item_id;
        IF v_batch_item.id IS NOT NULL THEN
          RETURN QUERY SELECT
            v_batch_item.id,
            public.inventory_round_for_item(
              public.inventory_convert_for_item(v_sub_qty,
                COALESCE(v_stock.yield_unit, v_batch_item.base_unit), v_batch_item.base_unit, v_batch_item.id),
              v_batch_item.base_unit, v_batch_item.id),
            v_batch_item.base_unit,
            'use'::text;
          CONTINUE;
        END IF;
      END IF;

      RETURN QUERY
        SELECT * FROM public.recipe_expand_to_stock_kinds(
          v_ing.sub_recipe_id, v_sub_qty / v_stock.yield_quantity, _branch, _path || _recipe);
    ELSE
      SELECT si.id, si.base_unit INTO v_stock FROM stock_items si
       WHERE si.organization_id = v_recipe.organization_id
         AND (si.branch_id IS NULL OR _branch IS NULL OR si.branch_id = _branch)
         AND (
           si.id = v_ing.stock_item_id
           OR si.id::text = v_ing.inventory_item_ref
           OR lower(si.name) = lower(v_ing.ingredient_name)
         )
       ORDER BY (si.id = v_ing.stock_item_id) DESC,
                (si.branch_id IS NOT DISTINCT FROM _branch) DESC,
                si.created_at
       LIMIT 1;
      IF v_stock.id IS NULL THEN
        RAISE EXCEPTION 'Recipe ingredient "%" does not resolve to a stock item', v_ing.ingredient_name
          USING ERRCODE = 'data_exception';
      END IF;

      -- Used quantity, rounded the way the item is counted (whole things stay whole).
      IF v_use > 0 THEN
        v_conv := public.inventory_convert_for_item(v_use,
          COALESCE(v_ing.unit, v_stock.base_unit), v_stock.base_unit, v_stock.id);
        RETURN QUERY SELECT v_stock.id,
          public.inventory_round_for_item(v_conv, v_stock.base_unit, v_stock.id),
          v_stock.base_unit, 'use'::text;
      END IF;

      -- Wastage allowance is its own entry, never a fraction added to the used quantity.
      IF v_waste > 0 THEN
        v_conv := public.inventory_convert_for_item(v_waste,
          COALESCE(v_ing.unit, v_stock.base_unit), v_stock.base_unit, v_stock.id);
        v_conv := public.inventory_round_for_item(v_conv, v_stock.base_unit, v_stock.id);
        IF v_conv > 0 THEN
          RETURN QUERY SELECT v_stock.id, v_conv, v_stock.base_unit, 'waste'::text;
        END IF;
      END IF;
    END IF;
  END LOOP;
END;
$$;

REVOKE ALL ON FUNCTION public.recipe_expand_to_stock_kinds(uuid,numeric,uuid,uuid[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.recipe_expand_to_stock_kinds(uuid,numeric,uuid,uuid[]) TO authenticated, service_role;

-- 2. The existing expansion keeps its shape, now built on the kinded one.
CREATE OR REPLACE FUNCTION public.recipe_expand_to_stock(
  _recipe uuid, _batches numeric, _branch uuid DEFAULT NULL::uuid, _path uuid[] DEFAULT '{}'::uuid[])
RETURNS TABLE(stock_item_id uuid, quantity numeric, unit text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
  SELECT e.stock_item_id, sum(e.quantity), min(e.unit)
    FROM public.recipe_expand_to_stock_kinds(_recipe, _batches, _branch, _path) e
   GROUP BY e.stock_item_id;
$$;

-- 3. Recipes may not store a fractional quantity for a whole-unit ingredient.
CREATE OR REPLACE FUNCTION public.recipe_ingredient_whole_unit_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $$
BEGIN
  IF NEW.quantity IS NOT NULL
     AND public.inventory_round_for_unit(0.5, COALESCE(NEW.unit, '')) = 1
     AND NEW.quantity <> trunc(NEW.quantity) THEN
    RAISE EXCEPTION '% is counted in whole % — enter a whole number, not %',
      COALESCE(NEW.ingredient_name, 'This ingredient'), NEW.unit, NEW.quantity
      USING ERRCODE = 'data_exception';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS recipe_ingredient_whole_unit_guard ON public.recipe_ingredients;
CREATE TRIGGER recipe_ingredient_whole_unit_guard
BEFORE INSERT OR UPDATE ON public.recipe_ingredients
FOR EACH ROW EXECUTE FUNCTION public.recipe_ingredient_whole_unit_guard();

-- 4. Consumption posts the used quantity and the wastage as separate movements.
CREATE OR REPLACE FUNCTION public.inventory_consume_order_item_core(_order_item uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_item record; v_menu record; v_recipe record; v_comp record; v_stock record;
  v_location uuid; v_station_location uuid; v_line_location uuid;
  v_batches numeric; v_cost numeric := 0; v_lines integer := 0; v_group_lines integer := 0;
  v_volume_lines integer := 0; v_waste_lines integer := 0; v_ml numeric;
  v_org uuid; v_branch uuid; v_station uuid; v_mode text;
  v_order_number text; v_menu_name text; v_station_name text;
  v_ticket_number text; v_actor text; v_store_name text; v_note text;
  v_channel text; v_components jsonb := '[]'::jsonb;
  v_direct_item uuid; v_direct_unit text; v_direct_qty numeric;
  v_kind text; v_movement_type text; v_key text;
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

  SELECT o.order_number, replace(lower(COALESCE(o.order_type,'')), '_', '-')
    INTO v_order_number, v_channel
    FROM pos_orders o WHERE o.id = v_item.order_id;

  SELECT * INTO v_menu FROM menu_items WHERE id = v_item.menu_item_id;
  v_menu_name := v_menu.name;

  SELECT * INTO v_recipe FROM recipes
   WHERE organization_id = v_org
     AND menu_item_id = v_item.menu_item_id
     AND recipe_type IN ('menu_item','direct_sale')
     AND status = 'active'
   ORDER BY (recipe_type = 'menu_item') DESC, version DESC LIMIT 1;

  v_mode := COALESCE(v_menu.consumption_mode, 'none');
  IF v_mode = 'none' AND v_recipe IS NOT NULL THEN
    v_mode := CASE WHEN v_recipe.recipe_type = 'direct_sale' THEN 'direct_stock' ELSE 'recipe' END;
  END IF;

  IF v_mode = 'none' THEN
    INSERT INTO inventory_posting_events (organization_id, branch_id, order_id, order_item_id,
      posting_type, idempotency_key, status, payload)
    VALUES (v_org, v_branch, v_item.order_id, _order_item, 'consumption',
      'nostock:' || _order_item::text, 'skipped',
      jsonb_build_object('reason','no-stock-consumption','menu_item',v_menu_name,'order_channel',v_channel))
    ON CONFLICT DO NOTHING;
    RETURN jsonb_build_object('status','no-consumption','menu_item',v_menu_name);
  END IF;

  IF v_menu.consumption_channels IS NOT NULL
     AND array_length(v_menu.consumption_channels, 1) > 0
     AND NOT (v_channel = ANY (v_menu.consumption_channels)) THEN
    INSERT INTO inventory_posting_events (organization_id, branch_id, order_id, order_item_id,
      posting_type, idempotency_key, status, payload)
    VALUES (v_org, v_branch, v_item.order_id, _order_item, 'consumption',
      'channel:' || _order_item::text, 'skipped',
      jsonb_build_object('reason','channel-excluded','order_channel',v_channel,
                         'channels',to_jsonb(v_menu.consumption_channels)))
    ON CONFLICT DO NOTHING;
    RETURN jsonb_build_object('status','channel-excluded','order_channel',v_channel);
  END IF;

  v_station := COALESCE(v_item.station_id, v_menu.station_id, v_recipe.station_id);

  SELECT sl.id INTO v_station_location
    FROM stock_locations sl
   WHERE sl.organization_id = v_org AND sl.active AND v_station IS NOT NULL
     AND sl.station_id = v_station
   LIMIT 1;

  v_location := COALESCE(
    v_menu.issuing_location_id,
    public.neo_station_consumption_location(v_org, v_station, v_branch));
  IF v_location IS NULL THEN
    RETURN jsonb_build_object('status','no-location','branch_id',v_branch,'station_id', v_station);
  END IF;

  IF v_station IS NOT NULL THEN
    SELECT s.name INTO v_station_name FROM operational_stations s WHERE s.id = v_station;
  END IF;
  SELECT t.ticket_number INTO v_ticket_number
    FROM station_ticket_items ti JOIN station_tickets t ON t.id = ti.ticket_id
   WHERE ti.order_item_id = _order_item
   ORDER BY t.created_at DESC LIMIT 1;
  SELECT COALESCE(p.full_name, p.email) INTO v_actor
    FROM profiles p WHERE p.id = auth.uid();

  IF v_mode IN ('direct_stock','batch') THEN
    v_direct_item := COALESCE(v_menu.stock_item_id, v_recipe.output_stock_item_id);
    IF v_direct_item IS NULL THEN
      RETURN jsonb_build_object('status','no-stock-item','menu_item',v_menu_name);
    END IF;
    SELECT si.* INTO v_stock FROM stock_items si WHERE si.id = v_direct_item;
    v_direct_qty := COALESCE(NULLIF(v_menu.stock_quantity_per_sale,0),
                             NULLIF(v_recipe.yield_quantity,0), 1) * COALESCE(v_item.quantity, 1);
    v_direct_unit := COALESCE(NULLIF(v_menu.stock_unit,''), NULLIF(v_recipe.yield_unit,''),
                              v_stock.base_unit, 'unit');
    v_direct_qty := public.inventory_round_for_item(v_direct_qty, v_direct_unit, v_direct_item);
    v_batches := COALESCE(v_item.quantity, 1);
    v_components := jsonb_build_array(jsonb_build_object(
      'item_id', v_direct_item, 'qty', v_direct_qty, 'unit', v_direct_unit, 'kind', 'use'));
  ELSE
    IF v_recipe IS NULL THEN RETURN jsonb_build_object('status','no-recipe'); END IF;
    IF COALESCE(v_recipe.yield_quantity, 0) <= 0 THEN
      RAISE EXCEPTION 'Recipe % has no usable yield quantity', v_recipe.id USING ERRCODE = 'data_exception';
    END IF;
    v_batches := COALESCE(v_item.quantity, 1) / v_recipe.yield_quantity;
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
             'item_id', x.stock_item_id, 'qty', x.qty, 'unit', x.unit, 'kind', x.kind)), '[]'::jsonb)
      INTO v_components
      FROM (SELECT e.stock_item_id, e.kind, sum(e.quantity) AS qty, min(e.unit) AS unit
              FROM public.recipe_expand_to_stock_kinds(v_recipe.id, v_batches, v_branch) e
             GROUP BY e.stock_item_id, e.kind) x;
  END IF;

  FOR v_comp IN
    SELECT (e->>'item_id')::uuid AS item_id, (e->>'qty')::numeric AS qty, e->>'unit' AS unit,
           COALESCE(e->>'kind','use') AS kind
      FROM jsonb_array_elements(v_components) e
  LOOP
    v_kind := v_comp.kind;
    v_line_location := COALESCE(
      v_menu.issuing_location_id,
      v_station_location,
      public.neo_item_group_store(v_org, v_comp.item_id, v_branch),
      v_location);
    IF v_menu.issuing_location_id IS NULL AND v_station_location IS NULL
       AND public.neo_item_group_store(v_org, v_comp.item_id, v_branch) IS NOT NULL THEN
      v_group_lines := v_group_lines + 1;
    END IF;

    SELECT sl.name INTO v_store_name FROM stock_locations sl WHERE sl.id = v_line_location;

    v_note := CASE WHEN v_kind = 'waste' THEN 'Wastage allowance · order ' ELSE 'Sale consumption · order ' END
              || COALESCE(v_order_number, v_item.order_id::text)
              || ' · line ' || _order_item::text
              || CASE WHEN v_channel IS NOT NULL AND v_channel <> '' THEN ' · channel ' || v_channel ELSE '' END
              || ' · ' || COALESCE(v_menu_name, 'menu item')
              || ' (' || v_mode || ')'
              || ' ×' || trim(to_char(COALESCE(v_item.quantity, 1), 'FM999999990.###'))
              || CASE WHEN v_ticket_number IS NOT NULL THEN ' · ticket ' || v_ticket_number ELSE '' END
              || CASE WHEN v_station_name IS NOT NULL THEN ' · station ' || v_station_name ELSE '' END
              || CASE WHEN v_store_name IS NOT NULL THEN ' · from ' || v_store_name ELSE '' END
              || CASE WHEN v_actor IS NOT NULL THEN ' · recorded by ' || v_actor ELSE '' END;

    SELECT si.* INTO v_stock FROM stock_items si WHERE si.id = v_comp.item_id;

    IF lower(COALESCE(v_comp.unit,'')) IN ('ml','millilitre','millilitres','cl','l','litre','litres')
       AND COALESCE(v_stock.tracking_method,'whole') IN ('volume','both')
       AND COALESCE(v_stock.container_volume_ml,0) > 0 THEN
      v_ml := v_comp.qty * CASE lower(v_comp.unit)
                             WHEN 'cl' THEN 10
                             WHEN 'l' THEN 1000 WHEN 'litre' THEN 1000 WHEN 'litres' THEN 1000
                             ELSE 1 END;
      PERFORM public.inventory_consume_volume(
        v_comp.item_id, v_line_location, v_ml, v_note,
        CASE WHEN v_kind = 'waste' THEN 'wastage' ELSE 'pour' END,
        'pos_order_item', _order_item,
        CASE WHEN v_kind = 'waste' THEN 'pour-waste:' ELSE 'pour:' END
          || _order_item::text || ':' || v_comp.item_id::text);
      v_cost := v_cost + (v_ml / v_stock.container_volume_ml) * COALESCE(v_stock.average_cost, 0);
      v_volume_lines := v_volume_lines + 1;
      IF v_kind = 'waste' THEN v_waste_lines := v_waste_lines + 1; END IF;
      v_lines := v_lines + 1;
      PERFORM public.neo_evaluate_low_stock(v_org, v_branch, v_comp.item_id, 'consumption', _order_item);
      CONTINUE;
    END IF;

    v_movement_type := CASE WHEN v_kind = 'waste' THEN 'wastage' ELSE 'consumption' END;
    v_key := CASE WHEN v_kind = 'waste' THEN 'waste:' ELSE 'consume:' END
             || _order_item::text || ':' || v_comp.item_id::text;

    PERFORM inventory_apply_movement(v_comp.item_id, v_line_location, -v_comp.qty, v_comp.unit, v_movement_type,
      COALESCE(v_stock.average_cost, 0),
      'pos_order_item', _order_item, v_note, v_key, NULL, NULL);
    v_cost := v_cost + (v_comp.qty * COALESCE(v_stock.average_cost, 0));
    v_lines := v_lines + 1;
    IF v_kind = 'waste' THEN v_waste_lines := v_waste_lines + 1; END IF;
    PERFORM public.neo_evaluate_low_stock(v_org, v_branch, v_comp.item_id, 'consumption', _order_item);
  END LOOP;

  INSERT INTO inventory_posting_events (organization_id, branch_id, order_id, order_item_id, recipe_id,
    recipe_version, posting_type, idempotency_key, status, cost_snapshot, payload)
  VALUES (v_org, v_branch, v_item.order_id, _order_item,
    CASE WHEN v_mode = 'recipe' THEN v_recipe.id ELSE NULL END,
    CASE WHEN v_mode = 'recipe' THEN v_recipe.version ELSE NULL END,
    'consumption', 'consume:' || _order_item::text, 'posted', v_cost,
    jsonb_build_object('lines', v_lines, 'unresolved_ingredients', 0, 'costing', 'weighted-average',
                       'location_id', v_location, 'branch_id', v_branch,
                       'station_location_id', v_station_location,
                       'group_routed_lines', v_group_lines,
                       'volume_lines', v_volume_lines,
                       'waste_lines', v_waste_lines,
                       'batches', v_batches,
                       'consumption_mode', v_mode,
                       'components', v_components,
                       'order_id', v_item.order_id,
                       'order_item_id', _order_item,
                       'order_number', v_order_number,
                       'order_channel', v_channel,
                       'menu_item_id', v_item.menu_item_id,
                       'menu_item', v_menu_name,
                       'employee', COALESCE(v_actor, 'system'),
                       'employee_id', auth.uid(),
                       'recorded_at', now(),
                       'ticket_number', v_ticket_number,
                       'station_name', v_station_name))
  ON CONFLICT DO NOTHING;

  RETURN jsonb_build_object('status','posted','lines',v_lines,'cost',v_cost,'unresolved',0,
                            'location_id',v_location,'group_routed_lines',v_group_lines,
                            'volume_lines',v_volume_lines,
                            'waste_lines',v_waste_lines,
                            'consumption_mode',v_mode,
                            'order_channel',v_channel,
                            'batches',v_batches);
END;
$$;

-- 5. A void returns both the used quantity and its wastage entry.
CREATE OR REPLACE FUNCTION public.neo_pos_item_void_effect()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_event record; v_mv record; v_prepared boolean; v_branch uuid; v_waste_no text; v_cost numeric := 0;
  v_direct boolean; v_mode text;
BEGIN
  IF NEW.status NOT IN ('voided','cancelled') OR OLD.status = NEW.status THEN
    RETURN NEW;
  END IF;

  SELECT branch_id INTO v_branch FROM pos_orders WHERE id = NEW.order_id;

  SELECT consumption_mode INTO v_mode FROM menu_items WHERE id = NEW.menu_item_id;
  IF v_mode IS NULL OR v_mode = 'none' THEN
    SELECT CASE WHEN r.recipe_type = 'direct_sale' THEN 'direct_stock' ELSE 'recipe' END
      INTO v_mode
      FROM recipes r
     WHERE r.organization_id = NEW.organization_id
       AND r.menu_item_id = NEW.menu_item_id
       AND r.status = 'active'
     ORDER BY (r.recipe_type = 'menu_item') DESC, r.version DESC LIMIT 1;
  END IF;
  v_direct := COALESCE(v_mode,'') IN ('direct_stock','batch');

  v_prepared := NOT COALESCE(v_direct, false)
                AND (NEW.sent_at IS NOT NULL OR NEW.ready_at IS NOT NULL OR NEW.served_at IS NOT NULL);

  SELECT * INTO v_event FROM inventory_posting_events
   WHERE order_item_id = NEW.id AND status = 'posted' LIMIT 1;

  IF v_event IS NULL THEN
    INSERT INTO audit_logs (organization_id, branch_id, station_id, user_name, action, module, record_id, new_value, reason)
    VALUES (NEW.organization_id, v_branch, NEW.station_id, COALESCE(auth.uid()::text,'system'),
      'pos.item.voided', 'pos', NEW.id::text,
      jsonb_build_object('prepared', v_prepared, 'stock_impact', 'none', 'item', NEW.item_name),
      'Voided before stock was consumed');
    RETURN NEW;
  END IF;

  IF v_prepared THEN
    v_waste_no := 'WST-' || to_char(now(), 'YYYYMMDD') || '-' || substr(NEW.id::text, 1, 6);
    INSERT INTO waste_records (organization_id, branch_id, station_id, waste_number, occurred_at,
      menu_item_id, order_item_id, quantity, unit, estimated_cost, category, reason, status,
      inventory_adjustment_status, recorded_by)
    VALUES (NEW.organization_id, v_branch, NEW.station_id, v_waste_no, now(),
      NEW.menu_item_id, NEW.id, GREATEST(COALESCE(NEW.quantity,1), 0.001), 'portion',
      COALESCE(v_event.cost_snapshot, 0), 'prepared-void',
      'Prepared item voided after production', 'pending-review', 'not-applicable', auth.uid())
    ON CONFLICT DO NOTHING;

    INSERT INTO audit_logs (organization_id, branch_id, station_id, user_name, action, module, record_id, new_value, reason)
    VALUES (NEW.organization_id, v_branch, NEW.station_id, COALESCE(auth.uid()::text,'system'),
      'pos.item.voided.waste', 'kitchen', NEW.id::text,
      jsonb_build_object('waste_number', v_waste_no, 'cost', COALESCE(v_event.cost_snapshot,0), 'item', NEW.item_name),
      'Prepared item voided after production — waste recorded for review');
    RETURN NEW;
  END IF;

  PERFORM set_config('neo.system_posting', '1', true);

  FOR v_mv IN
    SELECT * FROM stock_movements
     WHERE organization_id = NEW.organization_id
       AND reference_type = 'pos_order_item'
       AND reference_id = NEW.id
       AND movement_type IN ('consumption','wastage')
  LOOP
    PERFORM inventory_apply_movement(v_mv.stock_item_id, v_mv.location_id, abs(v_mv.quantity), v_mv.unit,
      'reversal', v_mv.unit_cost, 'pos_order_item', NEW.id,
      CASE WHEN v_mv.movement_type = 'wastage' THEN 'Void reversal · wastage allowance returned to '
           ELSE 'Void reversal · order line returned to ' END
      || COALESCE((SELECT sl.name FROM stock_locations sl WHERE sl.id = v_mv.location_id), 'store'),
      CASE WHEN v_mv.movement_type = 'wastage' THEN 'reverse-waste:' ELSE 'reverse:' END
        || NEW.id::text || ':' || v_mv.stock_item_id::text, NULL, NULL);
    v_cost := v_cost + abs(v_mv.quantity) * COALESCE(v_mv.unit_cost, 0);
  END LOOP;

  PERFORM set_config('neo.system_posting', '', true);

  UPDATE inventory_posting_events SET status = 'reversed', updated_at = now()
   WHERE id = v_event.id;

  INSERT INTO audit_logs (organization_id, branch_id, station_id, user_name, action, module, record_id, new_value, reason)
  VALUES (NEW.organization_id, v_branch, NEW.station_id, COALESCE(auth.uid()::text,'system'),
    'pos.item.voided.reversed', 'inventory', NEW.id::text,
    jsonb_build_object('reversed_value', v_cost, 'item', NEW.item_name, 'consumption_mode', v_mode),
    'Item voided — stock returned');
  RETURN NEW;
END;
$$;