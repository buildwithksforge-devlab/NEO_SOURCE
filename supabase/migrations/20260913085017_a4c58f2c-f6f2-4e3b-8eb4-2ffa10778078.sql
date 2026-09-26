ALTER TABLE public.stock_items
  ADD COLUMN IF NOT EXISTS container_volume_ml numeric,
  ADD COLUMN IF NOT EXISTS is_divisible boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.stock_items.container_volume_ml IS
  'Volume of one container in millilitres (e.g. a 0.75 l spirit bottle = 750). Required before a measure-based recipe (a 30 ml tot) can deduct a fraction of this item.';
COMMENT ON COLUMN public.stock_items.is_divisible IS
  'True when the item is served in parts of a container (spirits poured by the tot), so deductions are kept fractional instead of rounded to whole units.';

ALTER TABLE public.stock_items
  DROP CONSTRAINT IF EXISTS stock_items_container_volume_positive;
ALTER TABLE public.stock_items
  ADD CONSTRAINT stock_items_container_volume_positive
  CHECK (container_volume_ml IS NULL OR container_volume_ml > 0);

-- Rounding, but aware of the item: a poured bottle keeps its fraction.
CREATE OR REPLACE FUNCTION public.inventory_round_for_item(_qty numeric, _unit text, _item uuid)
 RETURNS numeric
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'public'
AS $function$
DECLARE v_divisible boolean;
BEGIN
  IF _qty IS NULL THEN RETURN _qty; END IF;
  SELECT coalesce(is_divisible, false) INTO v_divisible FROM public.stock_items WHERE id = _item;
  IF coalesce(v_divisible, false) THEN
    RETURN round(_qty, 4);
  END IF;
  RETURN public.inventory_round_for_unit(_qty, _unit);
END;
$function$;

-- Conversion, but aware of the item: millilitres/litres become a fraction of a
-- container when that container's volume is recorded.
CREATE OR REPLACE FUNCTION public.inventory_convert_for_item(_qty numeric, _from text, _to text, _item uuid)
 RETURNS numeric
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'public'
AS $function$
DECLARE
  v_from text := public.inventory_normalise_unit(_from);
  v_to   text := public.inventory_normalise_unit(_to);
  v_vol  numeric;
  v_name text;
  v_ml   numeric;
BEGIN
  IF _qty IS NULL THEN RETURN _qty; END IF;
  IF v_from = v_to OR v_from = '' OR v_to = '' THEN RETURN _qty; END IF;

  -- Only the container direction needs the extra knowledge; everything else is
  -- ordinary unit conversion and must still fail loudly when it cannot convert.
  IF v_from IN ('ml','millilitre','millilitres','l','litre','litres','cl','centilitre','centilitres')
     AND v_to IN ('bottle','bottles','can','cans','jar','jars','tin','tins','carton','cartons','pack','packs') THEN
    SELECT container_volume_ml, name INTO v_vol, v_name FROM public.stock_items WHERE id = _item;
    IF v_vol IS NULL OR v_vol <= 0 THEN
      RAISE EXCEPTION 'Bottle size is not recorded for "%", so a measure cannot be deducted from it. Set the container size in litres on the stock item first.',
        coalesce(v_name, _item::text) USING ERRCODE = 'data_exception';
    END IF;
    v_ml := public.inventory_convert_strict(_qty, v_from, 'ml');
    RETURN v_ml / v_vol;
  END IF;

  RETURN public.inventory_convert_strict(_qty, _from, _to);
END;
$function$;

CREATE OR REPLACE FUNCTION public.recipe_expand_to_stock(_recipe uuid, _batches numeric, _branch uuid DEFAULT NULL::uuid, _path uuid[] DEFAULT '{}'::uuid[])
 RETURNS TABLE(stock_item_id uuid, quantity numeric, unit text)
 LANGUAGE plpgsql
 STABLE
 SECURITY DEFINER
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
      public.inventory_round_for_item(
        public.inventory_convert_for_item(v_recipe.yield_quantity * _batches,
          COALESCE(v_recipe.yield_unit, v_stock.base_unit), v_stock.base_unit, v_stock.id),
        v_stock.base_unit, v_stock.id),
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
            public.inventory_round_for_item(
              public.inventory_convert_for_item(v_sub_qty, COALESCE(v_stock.yield_unit, v_batch_item.base_unit), v_batch_item.base_unit, v_batch_item.id),
              v_batch_item.base_unit, v_batch_item.id),
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
        public.inventory_round_for_item(
          public.inventory_convert_for_item(v_qty, COALESCE(v_ing.unit, v_stock.base_unit), v_stock.base_unit, v_stock.id),
          v_stock.base_unit, v_stock.id),
        v_stock.base_unit;
    END IF;
  END LOOP;
END;
$function$;