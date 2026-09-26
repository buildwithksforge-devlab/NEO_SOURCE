CREATE OR REPLACE FUNCTION public.inventory_consume_order_item_core(_order_item uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  v_item record; v_recipe record; v_ing record;
  v_location uuid; v_stock record; v_qty numeric;
  v_cost numeric := 0; v_lines integer := 0; v_unresolved integer := 0;
  v_org uuid; v_branch uuid;
BEGIN
  SELECT oi.*, o.branch_id, o.organization_id AS org
    INTO v_item
    FROM pos_order_items oi JOIN pos_orders o ON o.id = oi.order_id
   WHERE oi.id = _order_item;
  IF v_item IS NULL THEN RETURN jsonb_build_object('status','no-item'); END IF;
  v_org := v_item.org;
  v_branch := v_item.branch_id;

  IF EXISTS (SELECT 1 FROM inventory_posting_events WHERE order_item_id = _order_item AND status = 'posted') THEN
    RETURN jsonb_build_object('status','already-posted');
  END IF;

  SELECT * INTO v_recipe FROM recipes
   WHERE organization_id = v_org AND menu_item_id = v_item.menu_item_id AND status = 'active'
   ORDER BY version DESC LIMIT 1;
  IF v_recipe IS NULL THEN RETURN jsonb_build_object('status','no-recipe'); END IF;

  -- Branch-scoped location resolution: never reach into another property's stores.
  SELECT id INTO v_location FROM stock_locations sl
   WHERE sl.organization_id = v_org
     AND sl.active
     AND (
       (v_branch IS NOT NULL AND (sl.branch_id = v_branch OR sl.branch_id IS NULL))
       OR (v_branch IS NULL AND sl.branch_id IS NULL)
     )
   ORDER BY (sl.branch_id IS NOT DISTINCT FROM v_branch) DESC,
            (sl.location_type = 'kitchen') DESC,
            sl.is_main DESC,
            sl.created_at
   LIMIT 1;
  IF v_location IS NULL THEN
    RETURN jsonb_build_object('status','no-location','branch_id',v_branch);
  END IF;

  FOR v_ing IN SELECT * FROM recipe_ingredients WHERE recipe_id = v_recipe.id LOOP
    -- Stock item must belong to the order's branch, or be an org-wide (unassigned) item.
    SELECT si.id, si.average_cost, si.base_unit INTO v_stock FROM stock_items si
     WHERE si.organization_id = v_org
       AND (si.branch_id IS NULL OR v_branch IS NULL OR si.branch_id = v_branch)
       AND (si.id::text = v_ing.inventory_item_ref OR lower(si.name) = lower(v_ing.ingredient_name))
     ORDER BY (si.branch_id IS NOT DISTINCT FROM v_branch) DESC, si.created_at
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
  VALUES (v_org, v_branch, v_item.order_id, _order_item, v_recipe.id, v_recipe.version,
    'consumption', 'consume:' || _order_item::text, 'posted', v_cost,
    jsonb_build_object('lines', v_lines, 'unresolved_ingredients', v_unresolved, 'costing', 'weighted-average',
                       'location_id', v_location, 'branch_id', v_branch))
  ON CONFLICT DO NOTHING;

  RETURN jsonb_build_object('status','posted','lines',v_lines,'cost',v_cost,'unresolved',v_unresolved,'location_id',v_location);
END;
$function$;

REVOKE ALL ON FUNCTION public.inventory_consume_order_item_core(uuid) FROM PUBLIC, anon;