CREATE OR REPLACE FUNCTION public.inventory_consume_order_item_core(_order_item uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_item record; v_recipe record; v_ing record;
  v_location uuid; v_stock record; v_qty numeric;
  v_cost numeric := 0; v_lines integer := 0; v_unresolved integer := 0;
  v_org uuid;
BEGIN
  SELECT oi.*, o.branch_id, o.organization_id AS org
    INTO v_item
    FROM pos_order_items oi JOIN pos_orders o ON o.id = oi.order_id
   WHERE oi.id = _order_item;
  IF v_item IS NULL THEN RETURN jsonb_build_object('status','no-item'); END IF;
  v_org := v_item.org;

  IF EXISTS (SELECT 1 FROM inventory_posting_events WHERE order_item_id = _order_item AND status = 'posted') THEN
    RETURN jsonb_build_object('status','already-posted');
  END IF;

  SELECT * INTO v_recipe FROM recipes
   WHERE organization_id = v_org AND menu_item_id = v_item.menu_item_id AND status = 'active'
   ORDER BY version DESC LIMIT 1;
  IF v_recipe IS NULL THEN RETURN jsonb_build_object('status','no-recipe'); END IF;

  SELECT id INTO v_location FROM stock_locations
   WHERE organization_id = v_org AND active
   ORDER BY (location_type = 'kitchen') DESC, is_main DESC, created_at LIMIT 1;
  IF v_location IS NULL THEN RETURN jsonb_build_object('status','no-location'); END IF;

  FOR v_ing IN SELECT * FROM recipe_ingredients WHERE recipe_id = v_recipe.id LOOP
    SELECT si.id, si.average_cost, si.base_unit INTO v_stock FROM stock_items si
     WHERE si.organization_id = v_org
       AND (si.id::text = v_ing.inventory_item_ref OR lower(si.name) = lower(v_ing.ingredient_name))
     LIMIT 1;
    IF v_stock.id IS NULL THEN
      v_unresolved := v_unresolved + 1;
      CONTINUE;
    END IF;
    v_qty := v_ing.quantity * COALESCE(v_item.quantity, 1) * (1 + COALESCE(v_ing.waste_allowance, 0) / 100.0);
    PERFORM inventory_apply_movement(v_stock.id, v_location, -v_qty, v_ing.unit, 'consumption',
      COALESCE(v_stock.average_cost, 0),
      'pos_order_item', _order_item, 'Recipe consumption',
      'consume:' || _order_item::text || ':' || v_ing.id::text, NULL, NULL);
    v_cost := v_cost + (public.inventory_convert(v_qty, COALESCE(v_ing.unit, v_stock.base_unit), v_stock.base_unit)
                        * COALESCE(v_stock.average_cost, 0));
    v_lines := v_lines + 1;
  END LOOP;

  INSERT INTO inventory_posting_events (organization_id, branch_id, order_id, order_item_id, recipe_id,
    recipe_version, posting_type, idempotency_key, status, cost_snapshot, payload)
  VALUES (v_org, v_item.branch_id, v_item.order_id, _order_item, v_recipe.id, v_recipe.version,
    'consumption', 'consume:' || _order_item::text, 'posted', v_cost,
    jsonb_build_object('lines', v_lines, 'unresolved_ingredients', v_unresolved, 'costing', 'weighted-average'))
  ON CONFLICT DO NOTHING;

  RETURN jsonb_build_object('status','posted','lines',v_lines,'cost',v_cost,'unresolved',v_unresolved);
END;
$function$;

REVOKE ALL ON FUNCTION public.inventory_consume_order_item_core(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.inventory_consume_order_item_core(uuid) TO service_role;