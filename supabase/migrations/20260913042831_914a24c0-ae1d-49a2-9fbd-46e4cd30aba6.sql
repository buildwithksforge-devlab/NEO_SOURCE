
ALTER TABLE public.recipes DROP CONSTRAINT IF EXISTS recipes_recipe_type_chk;
ALTER TABLE public.recipes ADD CONSTRAINT recipes_recipe_type_chk
  CHECK (recipe_type = ANY (ARRAY['menu_item'::text, 'sub_recipe'::text, 'direct_sale'::text]));

ALTER TABLE public.recipes DROP CONSTRAINT IF EXISTS recipes_direct_sale_output_chk;
ALTER TABLE public.recipes ADD CONSTRAINT recipes_direct_sale_output_chk
  CHECK (recipe_type <> 'direct_sale' OR output_stock_item_id IS NOT NULL);

CREATE OR REPLACE FUNCTION public.inventory_round_for_unit(_qty numeric, _unit text)
RETURNS numeric
LANGUAGE sql
IMMUTABLE
SET search_path TO 'public'
AS $$
  SELECT CASE
    WHEN _qty IS NULL THEN _qty
    WHEN lower(btrim(coalesce(_unit,''))) IN (
      'pc','pcs','piece','pieces','each','unit','units',
      'bottle','bottles','can','cans','carton','cartons','crate','crates',
      'ream','reams','roll','rolls','bag','bags','tin','tins','jar','jars',
      'set','sets','pack','packs','box','boxes','sachet','sachets','tray','trays'
    ) THEN ceil(_qty)
    ELSE _qty
  END
$$;

CREATE OR REPLACE FUNCTION public.recipe_expand_to_stock(_recipe uuid, _batches numeric, _branch uuid DEFAULT NULL::uuid, _path uuid[] DEFAULT '{}'::uuid[])
 RETURNS TABLE(stock_item_id uuid, quantity numeric, unit text)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_recipe record;
  v_ing record;
  v_qty numeric;
  v_sub_qty numeric;
  v_stock record;
  v_batch_item record;
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

  IF v_recipe.recipe_type = 'direct_sale' AND v_recipe.output_stock_item_id IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM recipe_ingredients WHERE recipe_id = _recipe) THEN
    SELECT si.id, si.base_unit INTO v_stock FROM stock_items si WHERE si.id = v_recipe.output_stock_item_id;
    IF v_stock.id IS NULL THEN
      RAISE EXCEPTION 'Direct-sale recipe % has no stock item', _recipe USING ERRCODE = 'data_exception';
    END IF;
    RETURN QUERY SELECT
      v_stock.id,
      public.inventory_round_for_unit(
        public.inventory_convert_strict(v_recipe.yield_quantity * _batches,
          COALESCE(v_recipe.yield_unit, v_stock.base_unit), v_stock.base_unit),
        v_stock.base_unit),
      v_stock.base_unit;
    RETURN;
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
      v_sub_qty := public.inventory_convert_strict(v_qty, COALESCE(v_ing.unit, v_stock.yield_unit), v_stock.yield_unit);

      IF v_stock.output_stock_item_id IS NOT NULL THEN
        SELECT si.id, si.base_unit INTO v_batch_item FROM stock_items si WHERE si.id = v_stock.output_stock_item_id;
        IF v_batch_item.id IS NOT NULL THEN
          RETURN QUERY SELECT
            v_batch_item.id,
            public.inventory_round_for_unit(
              public.inventory_convert_strict(v_sub_qty, COALESCE(v_stock.yield_unit, v_batch_item.base_unit), v_batch_item.base_unit),
              v_batch_item.base_unit),
            v_batch_item.base_unit;
          CONTINUE;
        END IF;
      END IF;

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
      RETURN QUERY SELECT
        v_stock.id,
        public.inventory_round_for_unit(
          public.inventory_convert_strict(v_qty, COALESCE(v_ing.unit, v_stock.base_unit), v_stock.base_unit),
          v_stock.base_unit),
        v_stock.base_unit;
    END IF;
  END LOOP;
END;
$function$;
