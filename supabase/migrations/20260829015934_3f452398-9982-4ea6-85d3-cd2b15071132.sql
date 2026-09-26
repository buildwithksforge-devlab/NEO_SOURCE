-- ============ 1. Additive recipe model ============
ALTER TABLE public.recipes
  ADD COLUMN IF NOT EXISTS recipe_code text,
  ADD COLUMN IF NOT EXISTS recipe_type text NOT NULL DEFAULT 'menu_item',
  ADD COLUMN IF NOT EXISTS output_stock_item_id uuid REFERENCES public.stock_items(id);

ALTER TABLE public.recipes ALTER COLUMN menu_item_id DROP NOT NULL;

DO $$ BEGIN
  ALTER TABLE public.recipes
    ADD CONSTRAINT recipes_recipe_type_chk CHECK (recipe_type IN ('menu_item','sub_recipe'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE public.recipes
    ADD CONSTRAINT recipes_menu_item_required_chk
    CHECK (recipe_type <> 'menu_item' OR menu_item_id IS NOT NULL);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE UNIQUE INDEX IF NOT EXISTS recipes_org_code_uidx
  ON public.recipes (organization_id, lower(recipe_code))
  WHERE recipe_code IS NOT NULL;

ALTER TABLE public.recipe_ingredients
  ADD COLUMN IF NOT EXISTS component_type text NOT NULL DEFAULT 'stock_item',
  ADD COLUMN IF NOT EXISTS stock_item_id uuid REFERENCES public.stock_items(id),
  ADD COLUMN IF NOT EXISTS sub_recipe_id uuid REFERENCES public.recipes(id);

DO $$ BEGIN
  ALTER TABLE public.recipe_ingredients
    ADD CONSTRAINT recipe_ingredients_component_type_chk
    CHECK (component_type IN ('stock_item','sub_recipe'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE public.recipe_ingredients
    ADD CONSTRAINT recipe_ingredients_sub_recipe_chk
    CHECK (component_type <> 'sub_recipe' OR sub_recipe_id IS NOT NULL);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE INDEX IF NOT EXISTS recipe_ingredients_sub_recipe_idx
  ON public.recipe_ingredients (sub_recipe_id) WHERE sub_recipe_id IS NOT NULL;

-- ============ 2. Strict unit conversion ============
CREATE OR REPLACE FUNCTION public.inventory_convert_strict(_qty numeric, _from text, _to text)
RETURNS numeric
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE f record; t record;
BEGIN
  IF _from IS NULL OR _to IS NULL OR lower(trim(_from)) = lower(trim(_to)) THEN
    RETURN _qty;
  END IF;
  SELECT * INTO f FROM uom_units
   WHERE lower(code) = lower(trim(_from))
     AND (organization_id IS NULL OR organization_id = current_org_id())
   ORDER BY organization_id NULLS LAST LIMIT 1;
  SELECT * INTO t FROM uom_units
   WHERE lower(code) = lower(trim(_to))
     AND (organization_id IS NULL OR organization_id = current_org_id())
   ORDER BY organization_id NULLS LAST LIMIT 1;
  IF f IS NULL OR t IS NULL OR f.base_code <> t.base_code OR COALESCE(t.factor_to_base,0) = 0 THEN
    RAISE EXCEPTION 'No unit conversion from % to %', _from, _to
      USING ERRCODE = 'data_exception';
  END IF;
  RETURN _qty * f.factor_to_base / t.factor_to_base;
END;
$$;

REVOKE ALL ON FUNCTION public.inventory_convert_strict(numeric,text,text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.inventory_convert_strict(numeric,text,text) TO authenticated, service_role;

-- ============ 3. Recursive expansion to raw stock ============
-- _batches = how many full recipe yields are being produced/sold.
CREATE OR REPLACE FUNCTION public.recipe_expand_to_stock(
  _recipe uuid,
  _batches numeric,
  _branch uuid DEFAULT NULL,
  _path uuid[] DEFAULT '{}'::uuid[]
)
RETURNS TABLE(stock_item_id uuid, quantity numeric, unit text)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_recipe record;
  v_ing record;
  v_qty numeric;
  v_sub_qty numeric;
  v_stock record;
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

  FOR v_ing IN SELECT * FROM recipe_ingredients WHERE recipe_id = _recipe LOOP
    v_qty := COALESCE(v_ing.quantity, 0) * _batches
             * (1 + COALESCE(v_ing.waste_allowance, 0) / 100.0);
    IF v_qty = 0 THEN CONTINUE; END IF;

    IF v_ing.component_type = 'sub_recipe' THEN
      SELECT * INTO v_stock FROM recipes WHERE id = v_ing.sub_recipe_id;
      IF v_stock IS NULL THEN
        RAISE EXCEPTION 'Sub-recipe % not found', v_ing.sub_recipe_id USING ERRCODE = 'data_exception';
      END IF;
      IF COALESCE(v_stock.yield_quantity, 0) <= 0 THEN
        RAISE EXCEPTION 'Sub-recipe % has no usable yield quantity', v_ing.sub_recipe_id
          USING ERRCODE = 'data_exception';
      END IF;
      -- Quantity required, expressed in the sub-recipe's own yield unit.
      v_sub_qty := public.inventory_convert_strict(v_qty, COALESCE(v_ing.unit, v_stock.yield_unit), v_stock.yield_unit);
      RETURN QUERY
        SELECT * FROM public.recipe_expand_to_stock(
          v_ing.sub_recipe_id,
          v_sub_qty / v_stock.yield_quantity,
          _branch,
          _path || _recipe
        );
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
      -- Fail loudly when the ingredient unit cannot be converted to the stock base unit.
      RETURN QUERY SELECT
        v_stock.id,
        public.inventory_convert_strict(v_qty, COALESCE(v_ing.unit, v_stock.base_unit), v_stock.base_unit),
        v_stock.base_unit;
    END IF;
  END LOOP;
END;
$$;

REVOKE ALL ON FUNCTION public.recipe_expand_to_stock(uuid,numeric,uuid,uuid[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.recipe_expand_to_stock(uuid,numeric,uuid,uuid[]) TO authenticated, service_role;

-- ============ 4. Consumption uses yield math + recursive expansion ============
CREATE OR REPLACE FUNCTION public.inventory_consume_order_item_core(_order_item uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  v_item record; v_recipe record; v_comp record;
  v_location uuid; v_stock record; v_batches numeric;
  v_cost numeric := 0; v_lines integer := 0;
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
   WHERE organization_id = v_org
     AND menu_item_id = v_item.menu_item_id
     AND recipe_type = 'menu_item'
     AND status = 'active'
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

  -- Deterministic: batches = quantity sold / recipe yield quantity.
  IF COALESCE(v_recipe.yield_quantity, 0) <= 0 THEN
    RAISE EXCEPTION 'Recipe % has no usable yield quantity', v_recipe.id USING ERRCODE = 'data_exception';
  END IF;
  v_batches := COALESCE(v_item.quantity, 1) / v_recipe.yield_quantity;

  -- Sub-recipes are resolved recursively to raw stock; each stock item is
  -- deducted exactly once per order item (aggregated), never twice.
  FOR v_comp IN
    SELECT e.stock_item_id AS item_id, sum(e.quantity) AS qty, min(e.unit) AS unit
      FROM public.recipe_expand_to_stock(v_recipe.id, v_batches, v_branch) e
     GROUP BY e.stock_item_id
  LOOP
    SELECT si.average_cost INTO v_stock FROM stock_items si WHERE si.id = v_comp.item_id;
    PERFORM inventory_apply_movement(v_comp.item_id, v_location, -v_comp.qty, v_comp.unit, 'consumption',
      COALESCE(v_stock.average_cost, 0),
      'pos_order_item', _order_item, 'Recipe consumption',
      'consume:' || _order_item::text || ':' || v_comp.item_id::text, NULL, NULL);
    v_cost := v_cost + (v_comp.qty * COALESCE(v_stock.average_cost, 0));
    v_lines := v_lines + 1;
  END LOOP;

  INSERT INTO inventory_posting_events (organization_id, branch_id, order_id, order_item_id, recipe_id,
    recipe_version, posting_type, idempotency_key, status, cost_snapshot, payload)
  VALUES (v_org, v_branch, v_item.order_id, _order_item, v_recipe.id, v_recipe.version,
    'consumption', 'consume:' || _order_item::text, 'posted', v_cost,
    jsonb_build_object('lines', v_lines, 'unresolved_ingredients', 0, 'costing', 'weighted-average',
                       'location_id', v_location, 'branch_id', v_branch,
                       'batches', v_batches, 'recipe_yield', v_recipe.yield_quantity))
  ON CONFLICT DO NOTHING;

  RETURN jsonb_build_object('status','posted','lines',v_lines,'cost',v_cost,'unresolved',0,
                            'location_id',v_location,'batches',v_batches);
END;
$function$;

REVOKE ALL ON FUNCTION public.inventory_consume_order_item_core(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.inventory_consume_order_item_core(uuid) TO authenticated, service_role;