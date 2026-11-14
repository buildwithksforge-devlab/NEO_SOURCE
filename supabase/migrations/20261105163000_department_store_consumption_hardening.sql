-- NEÃ˜: authoritative departmental-store consumption.
--
-- Main Store supplies departments through controlled requisitions.
-- POS consumption must never silently fall back to Main Store, an item-group
-- store or a menu-item issuing override.

CREATE OR REPLACE FUNCTION public.neo_station_consumption_location(
  _org uuid,
  _station uuid,
  _branch uuid
)
RETURNS uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
  SELECT sl.id
  FROM public.station_consumption_stores m
  JOIN public.operational_stations s
    ON s.id = m.station_id
   AND s.organization_id = _org
  JOIN public.stock_locations sl
    ON sl.id = m.location_id
   AND sl.organization_id = _org
   AND sl.active
  WHERE m.organization_id = _org
    AND m.station_id = _station
    AND _station IS NOT NULL
    AND s.branch_id IS NOT DISTINCT FROM _branch
    AND sl.branch_id IS NOT DISTINCT FROM _branch
  LIMIT 1;
$function$;

DO $repair$
DECLARE
  v_org uuid;
  v_branch constant uuid :=
    '2addbd01-c643-406a-bd7d-fac1aa76b23c'::uuid;

  v_grill constant uuid :=
    'ac11408c-fc97-52e2-a2e3-23f4669d1f82'::uuid;

  v_beverage constant uuid :=
    '86b07744-d9f5-5a25-ac26-47155a1c7346'::uuid;

  v_kitchen_store constant uuid :=
    '4089c5bd-d136-569a-88ad-ff07df20794a'::uuid;

  v_beverage_store constant uuid :=
    '732adf15-c3a4-5f61-8686-15c9ab5cece3'::uuid;

  v_count integer;
BEGIN
  SELECT b.organization_id
    INTO v_org
  FROM public.branches b
  WHERE b.id = v_branch
    AND b.name = 'Savanna Crown Nairobi';

  IF v_org IS NULL THEN
    RAISE EXCEPTION
      'Exact Savanna Crown Nairobi branch was not found; nothing changed';
  END IF;

  /*
   * Validate the departmental stores before making any correction.
   * Main Store is expressly disallowed.
   */
  SELECT count(*)
    INTO v_count
  FROM public.stock_locations sl
  WHERE sl.id = v_kitchen_store
    AND sl.organization_id = v_org
    AND sl.branch_id = v_branch
    AND sl.name = 'SCN Kitchen Store'
    AND sl.active
    AND NOT sl.is_main;

  IF v_count <> 1 THEN
    RAISE EXCEPTION
      'SCN Kitchen Store failed the active departmental-store contract';
  END IF;

  SELECT count(*)
    INTO v_count
  FROM public.stock_locations sl
  WHERE sl.id = v_beverage_store
    AND sl.organization_id = v_org
    AND sl.branch_id = v_branch
    AND sl.name = 'SCN Beverage Store'
    AND sl.active
    AND NOT sl.is_main;

  IF v_count <> 1 THEN
    RAISE EXCEPTION
      'SCN Beverage Store failed the active departmental-store contract';
  END IF;

  /*
   * Grill is already mapped correctly. Refuse to proceed if that changes.
   */
  SELECT count(*)
    INTO v_count
  FROM public.station_consumption_stores m
  WHERE m.organization_id = v_org
    AND m.station_id = v_grill
    AND m.location_id = v_kitchen_store;

  IF v_count <> 1 THEN
    RAISE EXCEPTION
      'Expected Grill to map exactly once to SCN Kitchen Store; found %',
      v_count;
  END IF;

  /*
   * Beverage has no explicit mapping yet. It shares the departmental
   * beverage inventory location currently dedicated to Coffee Station.
   *
   * Refuse to replace a different pre-existing mapping silently.
   */
  SELECT count(*)
    INTO v_count
  FROM public.station_consumption_stores m
  WHERE m.organization_id = v_org
    AND m.station_id = v_beverage
    AND m.location_id IS DISTINCT FROM v_beverage_store;

  IF v_count <> 0 THEN
    RAISE EXCEPTION
      'Beverage already has a conflicting consumption-store mapping';
  END IF;

  INSERT INTO public.station_consumption_stores (
    organization_id,
    station_id,
    location_id
  )
  SELECT
    v_org,
    v_beverage,
    v_beverage_store
  WHERE NOT EXISTS (
    SELECT 1
    FROM public.station_consumption_stores m
    WHERE m.organization_id = v_org
      AND m.station_id = v_beverage
  );

  SELECT count(*)
    INTO v_count
  FROM public.station_consumption_stores m
  WHERE m.organization_id = v_org
    AND m.station_id = v_beverage
    AND m.location_id = v_beverage_store;

  IF v_count <> 1 THEN
    RAISE EXCEPTION
      'Expected Beverage to map exactly once to SCN Beverage Store; found %',
      v_count;
  END IF;

  /*
   * Correct only the three exact, independently inspected Nairobi ingredient
   * rows. The unresolved SCM and SCT ingredients remain untouched.
   */

  -- Full Breakfast: one whole avocado, not 100 grams.
  UPDATE public.recipe_ingredients ri
     SET quantity = 1,
         unit = 'piece'
  WHERE ri.id =
          '71ccafb0-81c9-4c57-bf92-f0d566d55c2c'::uuid
    AND ri.stock_item_id =
          '6a0dd216-23e8-4daf-b2c8-ecea97dfd0ac'::uuid
    AND ri.quantity = 100
    AND lower(trim(ri.unit)) = 'g'
    AND EXISTS (
      SELECT 1
      FROM public.recipes r
      JOIN public.menu_items mi
        ON mi.id = r.menu_item_id
      JOIN public.stock_items si
        ON si.id = ri.stock_item_id
      WHERE r.id = ri.recipe_id
        AND r.organization_id = v_org
        AND r.branch_id = v_branch
        AND r.status = 'active'
        AND r.recipe_type = 'menu_item'
        AND mi.organization_id = v_org
        AND mi.branch_id = v_branch
        AND mi.name = 'Full Breakfast'
        AND si.organization_id = v_org
        AND si.sku = 'FI-FRUIT-002'
        AND lower(trim(si.base_unit)) = 'piece'
    );

  GET DIAGNOSTICS v_count = ROW_COUNT;

  IF v_count <> 1 THEN
    RAISE EXCEPTION
      'Expected one exact Nairobi Full Breakfast Avocado correction; found %',
      v_count;
  END IF;

  -- Full Breakfast: Beef Mince is 100 g, not 100 kg.
  UPDATE public.recipe_ingredients ri
     SET quantity = 100,
         unit = 'g'
  WHERE ri.id =
          '692a01d7-a7f0-4c0d-bcba-b87158522b55'::uuid
    AND ri.stock_item_id =
          'f8b65162-ad39-5b65-923a-993d29797524'::uuid
    AND ri.quantity = 100
    AND lower(trim(ri.unit)) = 'kg'
    AND EXISTS (
      SELECT 1
      FROM public.recipes r
      JOIN public.menu_items mi
        ON mi.id = r.menu_item_id
      JOIN public.stock_items si
        ON si.id = ri.stock_item_id
      WHERE r.id = ri.recipe_id
        AND r.organization_id = v_org
        AND r.branch_id = v_branch
        AND r.status = 'active'
        AND r.recipe_type = 'menu_item'
        AND mi.organization_id = v_org
        AND mi.branch_id = v_branch
        AND mi.name = 'Full Breakfast'
        AND si.organization_id = v_org
        AND si.sku = 'SCN-BEEFM'
        AND lower(trim(si.base_unit)) = 'g'
    );

  GET DIAGNOSTICS v_count = ROW_COUNT;

  IF v_count <> 1 THEN
    RAISE EXCEPTION
      'Expected one exact Nairobi Full Breakfast Beef Mince correction; found %',
      v_count;
  END IF;

  -- Sirloin Steak: Cooking Oil is 30 ml, not 30 L.
  UPDATE public.recipe_ingredients ri
     SET quantity = 30,
         unit = 'ml'
  WHERE ri.id =
          'cb562c84-b7fa-4348-b2c0-cac1c375d7ba'::uuid
    AND ri.stock_item_id =
          '59e4d967-6ad7-50bc-923f-320108e04327'::uuid
    AND ri.quantity = 30
    AND lower(trim(ri.unit)) = 'l'
    AND EXISTS (
      SELECT 1
      FROM public.recipes r
      JOIN public.menu_items mi
        ON mi.id = r.menu_item_id
      JOIN public.stock_items si
        ON si.id = ri.stock_item_id
      WHERE r.id = ri.recipe_id
        AND r.organization_id = v_org
        AND r.branch_id = v_branch
        AND r.status = 'active'
        AND r.recipe_type = 'menu_item'
        AND mi.organization_id = v_org
        AND mi.branch_id = v_branch
        AND mi.name = 'Sirloin Steak 375g'
        AND si.organization_id = v_org
        AND si.sku = 'SCN-COOKIN'
        AND lower(trim(si.base_unit)) = 'ml'
    );

  GET DIAGNOSTICS v_count = ROW_COUNT;

  IF v_count <> 1 THEN
    RAISE EXCEPTION
      'Expected one exact Nairobi Sirloin Cooking Oil correction; found %',
      v_count;
  END IF;

  /*
   * Align exactly five Nairobi recipes with their menu/KDS station.
   *
   * The expected old station is included as an optimistic lock. If any row
   * has changed since inspection, the transaction refuses to continue.
   */
  UPDATE public.recipes r
     SET station_id = target.target_station_id,
         updated_at = now()
  FROM (
    VALUES
      (
        'd7ba1a7b-1096-55e2-b773-0708798b27df'::uuid,
        '2289c806-1ac2-45be-a5a8-3c50bc4cd2de'::uuid,
        v_grill
      ),
      (
        '68181b00-2bba-5e8c-af62-d89cc6c94318'::uuid,
        '2289c806-1ac2-45be-a5a8-3c50bc4cd2de'::uuid,
        v_grill
      ),
      (
        'bae1b65b-dd5f-57c5-814e-a9d079729e4a'::uuid,
        '7ca9a72b-b74a-5c2e-a3a4-3c7f146ba474'::uuid,
        v_grill
      ),
      (
        '9e95e403-9583-5cfd-8289-dda01a271a70'::uuid,
        'ffdeb780-3d0d-4d3c-a5e9-c6c8e48ae2c7'::uuid,
        v_beverage
      ),
      (
        'c7bd8599-803e-5050-9ecb-1d38093cbe51'::uuid,
        'ffdeb780-3d0d-4d3c-a5e9-c6c8e48ae2c7'::uuid,
        v_beverage
      )
  ) AS target(
    recipe_id,
    expected_station_id,
    target_station_id
  ),
  public.menu_items mi
  WHERE r.id = target.recipe_id
    AND r.station_id = target.expected_station_id
    AND r.organization_id = v_org
    AND r.branch_id = v_branch
    AND r.status = 'active'
    AND r.recipe_type = 'menu_item'
    AND mi.id = r.menu_item_id
    AND mi.organization_id = v_org
    AND mi.branch_id = v_branch
    AND mi.station_id = target.target_station_id;

  GET DIAGNOSTICS v_count = ROW_COUNT;

  IF v_count <> 5 THEN
    RAISE EXCEPTION
      'Expected five exact Nairobi recipe station alignments; found %',
      v_count;
  END IF;

  /*
   * Final routing proof: each production station resolves to its explicit
   * departmental store and never to SCN Main Store.
   */
  IF public.neo_station_consumption_location(
       v_org,
       v_grill,
       v_branch
     ) IS DISTINCT FROM v_kitchen_store THEN
    RAISE EXCEPTION
      'Grill does not resolve to SCN Kitchen Store';
  END IF;

  IF public.neo_station_consumption_location(
       v_org,
       v_beverage,
       v_branch
     ) IS DISTINCT FROM v_beverage_store THEN
    RAISE EXCEPTION
      'Beverage does not resolve to SCN Beverage Store';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.stock_locations sl
    WHERE sl.id IN (
      public.neo_station_consumption_location(
        v_org,
        v_grill,
        v_branch
      ),
      public.neo_station_consumption_location(
        v_org,
        v_beverage,
        v_branch
      )
    )
      AND sl.is_main
  ) THEN
    RAISE EXCEPTION
      'Operational POS consumption resolved to Main Store';
  END IF;
END;
$repair$;

CREATE OR REPLACE FUNCTION public.inventory_consume_order_item_core(
  _order_item uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_item record;
  v_menu record;
  v_recipe record;
  v_comp record;
  v_stock record;

  v_location uuid;
  v_station_location uuid;
  v_line_location uuid;

  v_batches numeric;
  v_cost numeric := 0;
  v_lines integer := 0;
  v_group_lines integer := 0;
  v_volume_lines integer := 0;
  v_waste_lines integer := 0;
  v_ml numeric;

  v_org uuid;
  v_branch uuid;
  v_station uuid;
  v_mode text;

  v_order_number text;
  v_menu_name text;
  v_station_name text;
  v_ticket_number text;
  v_actor text;
  v_store_name text;
  v_note text;
  v_channel text;

  v_components jsonb := '[]'::jsonb;
  v_kind text;
  v_movement_type text;
  v_key text;

  v_batch_use numeric;
  v_batch_use_recipe numeric;
  v_batch_unit text;
BEGIN
  SELECT oi.*, o.branch_id, o.organization_id AS org, o.status AS order_status
    INTO v_item
    FROM public.pos_order_items oi
    JOIN public.pos_orders o ON o.id = oi.order_id
   WHERE oi.id = _order_item;

  IF v_item IS NULL THEN
    RETURN jsonb_build_object('status', 'no-item');
  END IF;

  v_org := v_item.org;
  v_branch := v_item.branch_id;

  IF v_item.order_status IN ('cancelled','voided','void-pending')
     OR v_item.status IN ('draft','cancelled','voided','cancel-pending') THEN

    INSERT INTO public.inventory_posting_events (
      organization_id, branch_id, order_id, order_item_id,
      posting_type, idempotency_key, status, payload
    )
    VALUES (
      v_org, v_branch, v_item.order_id, _order_item,
      'consumption',
      'skip:' || _order_item::text,
      'skipped',
      jsonb_build_object(
        'reason','lifecycle',
        'order_status',v_item.order_status,
        'item_status',v_item.status
      )
    )
    ON CONFLICT DO NOTHING;

    RETURN jsonb_build_object(
      'status','skipped-lifecycle',
      'order_status',v_item.order_status
    );
  END IF;

  IF EXISTS (
    SELECT 1
      FROM public.inventory_posting_events
     WHERE order_item_id = _order_item
       AND status = 'posted'
  ) THEN
    RETURN jsonb_build_object('status','already-posted');
  END IF;

  SELECT o.order_number,
         replace(lower(COALESCE(o.order_type,'')), '_', '-')
    INTO v_order_number, v_channel
    FROM public.pos_orders o
   WHERE o.id = v_item.order_id;

  SELECT *
    INTO v_menu
    FROM public.menu_items
   WHERE id = v_item.menu_item_id;

  v_menu_name := v_menu.name;

  SELECT *
    INTO v_recipe
    FROM public.recipes
   WHERE organization_id = v_org
     AND menu_item_id = v_item.menu_item_id
     AND recipe_type IN ('menu_item','direct_sale')
     AND status = 'active'
   ORDER BY (recipe_type = 'menu_item') DESC, version DESC
   LIMIT 1;

  v_mode := COALESCE(v_menu.consumption_mode, 'none');

  IF v_mode = 'none' AND v_recipe IS NOT NULL THEN
    v_mode :=
      CASE
        WHEN v_recipe.recipe_type = 'direct_sale'
          THEN 'direct_stock'
        ELSE 'recipe'
      END;
  END IF;

  IF v_mode = 'none' THEN
    RETURN jsonb_build_object(
      'status','no-consumption',
      'menu_item',v_menu_name
    );
  END IF;

  IF v_menu.consumption_channels IS NOT NULL
     AND array_length(v_menu.consumption_channels, 1) > 0
     AND NOT (v_channel = ANY (v_menu.consumption_channels)) THEN
    RETURN jsonb_build_object(
      'status','channel-excluded',
      'order_channel',v_channel
    );
  END IF;

  v_station := COALESCE(
    v_item.station_id,
    v_menu.station_id,
    v_recipe.station_id
  );

  /*
   * POS consumption is owned by the production station's explicitly mapped
   * departmental store. Menu overrides, item defaults and Main Store fallbacks
   * must never redirect an operational sale.
   */
  v_location :=
    public.neo_station_consumption_location(
      v_org,
      v_station,
      v_branch
    );

  IF v_location IS NULL THEN
    RETURN jsonb_build_object(
      'status','no-location',
      'branch_id',v_branch,
      'station_id',v_station
    );
  END IF;

  -- Direct-stock products consume their linked inventory item.
  -- Only recipe and batch modes require an active recipe.
  IF v_mode <> 'direct_stock' AND v_recipe IS NULL THEN
    RETURN jsonb_build_object('status','no-recipe');
  END IF;

  IF v_mode <> 'direct_stock'
     AND COALESCE(v_recipe.yield_quantity, 0) <= 0 THEN
    RAISE EXCEPTION
      'Recipe % has no usable yield quantity',
      v_recipe.id
      USING ERRCODE = 'data_exception';
  END IF;

  /*
   * batch_operational_consumption
   *
   * Batch mode now means:
   * - reserve/use prepared container quantity operationally
   * - then continue through the canonical recipe expansion below.
   *
   * stock_quantity_per_sale is the amount removed from the prepared
   * container for one sold menu quantity.
   */
  IF v_mode = 'batch' THEN
    v_batch_use :=
      COALESCE(NULLIF(v_menu.stock_quantity_per_sale, 0), 1)
      * COALESCE(v_item.quantity, 1);

    v_batch_unit := COALESCE(
      NULLIF(trim(v_menu.stock_unit), ''),
      NULLIF(trim(v_recipe.yield_unit), '')
    );

    IF v_batch_unit IS NULL THEN
      RAISE EXCEPTION
        'Batch menu item % has no usable consumption unit',
        v_menu.id
        USING ERRCODE = 'data_exception';
    END IF;

    /*
     * Convert the amount used by the sale into the recipe's yield unit.
     *
     * Example:
     *   sale uses 250 ml
     *   recipe yields 10 L
     *   250 ml -> 0.25 L
     *   canonical recipe fraction = 0.25 / 10 = 0.025
     */
    v_batch_use_recipe :=
      public.inventory_convert_strict(
        v_batch_use,
        v_batch_unit,
        v_recipe.yield_unit
      );

    PERFORM public.neo_consume_prepared_batch(
      v_recipe.id,
      v_branch,
      v_batch_use_recipe,
      v_recipe.yield_unit,
      _order_item
    );
  END IF;

  /*
   * Direct-stock products remain direct-stock.
   * Recipe and batch products both consume their canonical recipe here.
   */
  IF v_mode = 'direct_stock' THEN
    IF v_menu.stock_item_id IS NULL THEN
      RETURN jsonb_build_object(
        'status','no-stock-item',
        'menu_item',v_menu_name
      );
    END IF;

    v_components := jsonb_build_array(
      jsonb_build_object(
        'item_id', v_menu.stock_item_id,
        'qty',
          public.inventory_round_for_item(
            COALESCE(NULLIF(v_menu.stock_quantity_per_sale,0),1)
              * COALESCE(v_item.quantity,1),
            COALESCE(NULLIF(v_menu.stock_unit,''),'unit'),
            v_menu.stock_item_id
          ),
        'unit', COALESCE(NULLIF(v_menu.stock_unit,''),'unit'),
        'kind','use'
      )
    );

    v_batches := COALESCE(v_item.quantity, 1);

  ELSE
    -- batch_canonical_recipe_consumption
    --
    -- A normal recipe menu item is driven by menu quantity.
    -- A prepared batch item is driven by the actual amount removed
    -- from the prepared container, converted to recipe-yield units.
    v_batches :=
      CASE
        WHEN v_mode = 'batch'
          THEN v_batch_use_recipe / v_recipe.yield_quantity
        ELSE COALESCE(v_item.quantity, 1) / v_recipe.yield_quantity
      END;

    SELECT COALESCE(
             jsonb_agg(
               jsonb_build_object(
                 'item_id', x.stock_item_id,
                 'qty', x.qty,
                 'unit', x.unit,
                 'kind', x.kind
               )
             ),
             '[]'::jsonb
           )
      INTO v_components
      FROM (
        SELECT
          e.stock_item_id,
          e.kind,
          sum(e.quantity) AS qty,
          min(e.unit) AS unit
        FROM public.recipe_expand_to_stock_kinds(
          v_recipe.id,
          v_batches,
          v_branch
        ) e
        GROUP BY e.stock_item_id, e.kind
      ) x;
  END IF;

  IF v_station IS NOT NULL THEN
    SELECT s.name
      INTO v_station_name
      FROM public.operational_stations s
     WHERE s.id = v_station;
  END IF;

  SELECT t.ticket_number
    INTO v_ticket_number
    FROM public.station_ticket_items ti
    JOIN public.station_tickets t ON t.id = ti.ticket_id
   WHERE ti.order_item_id = _order_item
   ORDER BY t.created_at DESC
   LIMIT 1;

  SELECT COALESCE(p.full_name, p.email)
    INTO v_actor
    FROM public.profiles p
   WHERE p.id = auth.uid();

  FOR v_comp IN
    SELECT
      (e->>'item_id')::uuid AS item_id,
      (e->>'qty')::numeric AS qty,
      e->>'unit' AS unit,
      COALESCE(e->>'kind','use') AS kind
    FROM jsonb_array_elements(v_components) e
  LOOP
    v_kind := v_comp.kind;

    /*
     * Every component of this sold item leaves the same departmental store
     * selected for its production station.
     */
    v_line_location := v_location;

    SELECT sl.name
      INTO v_store_name
      FROM public.stock_locations sl
     WHERE sl.id = v_line_location;

    SELECT si.*
      INTO v_stock
      FROM public.stock_items si
     WHERE si.id = v_comp.item_id;

    v_note :=
      CASE
        WHEN v_kind = 'waste'
          THEN 'Wastage allowance Ã‚Â· order '
        ELSE 'Sale consumption Ã‚Â· order '
      END
      || COALESCE(v_order_number, v_item.order_id::text)
      || ' Ã‚Â· ' || COALESCE(v_menu_name, 'menu item')
      || ' (' || v_mode || ')';

    IF lower(COALESCE(v_comp.unit,'')) IN (
         'ml','millilitre','millilitres','cl','l','litre','litres'
       )
       AND COALESCE(v_stock.tracking_method,'whole') IN ('volume','both')
       AND COALESCE(v_stock.container_volume_ml,0) > 0 THEN

      v_ml :=
        v_comp.qty *
        CASE lower(v_comp.unit)
          WHEN 'cl' THEN 10
          WHEN 'l' THEN 1000
          WHEN 'litre' THEN 1000
          WHEN 'litres' THEN 1000
          ELSE 1
        END;

      PERFORM public.inventory_consume_volume(
        v_comp.item_id,
        v_line_location,
        v_ml,
        v_note,
        CASE WHEN v_kind = 'waste' THEN 'wastage' ELSE 'pour' END,
        'pos_order_item',
        _order_item,
        CASE WHEN v_kind = 'waste' THEN 'pour-waste:' ELSE 'pour:' END
          || _order_item::text || ':' || v_comp.item_id::text
      );

      v_cost :=
        v_cost
        + (v_ml / v_stock.container_volume_ml)
          * COALESCE(v_stock.average_cost, 0);

      v_volume_lines := v_volume_lines + 1;

      IF v_kind = 'waste' THEN
        v_waste_lines := v_waste_lines + 1;
      END IF;

      v_lines := v_lines + 1;

      PERFORM public.neo_evaluate_low_stock(
        v_org,
        v_branch,
        v_comp.item_id,
        'consumption',
        _order_item
      );

      CONTINUE;
    END IF;

    v_movement_type :=
      CASE
        WHEN v_kind = 'waste' THEN 'wastage'
        ELSE 'consumption'
      END;

    v_key :=
      CASE
        WHEN v_kind = 'waste' THEN 'waste:'
        ELSE 'consume:'
      END
      || _order_item::text
      || ':'
      || v_comp.item_id::text;

    PERFORM public.inventory_apply_movement(
      v_comp.item_id,
      v_line_location,
      -v_comp.qty,
      v_comp.unit,
      v_movement_type,
      COALESCE(v_stock.average_cost, 0),
      'pos_order_item',
      _order_item,
      v_note,
      v_key,
      NULL,
      NULL
    );

    v_cost :=
      v_cost
      + v_comp.qty * COALESCE(v_stock.average_cost, 0);

    v_lines := v_lines + 1;

    IF v_kind = 'waste' THEN
      v_waste_lines := v_waste_lines + 1;
    END IF;

    PERFORM public.neo_evaluate_low_stock(
      v_org,
      v_branch,
      v_comp.item_id,
      'consumption',
      _order_item
    );
  END LOOP;

  INSERT INTO public.inventory_posting_events (
    organization_id,
    branch_id,
    order_id,
    order_item_id,
    recipe_id,
    recipe_version,
    posting_type,
    idempotency_key,
    status,
    cost_snapshot,
    payload
  )
  VALUES (
    v_org,
    v_branch,
    v_item.order_id,
    _order_item,
    CASE
      WHEN v_mode IN ('recipe','batch') THEN v_recipe.id
      ELSE NULL
    END,
    CASE
      WHEN v_mode IN ('recipe','batch') THEN v_recipe.version
      ELSE NULL
    END,
    'consumption',
    'consume:' || _order_item::text,
    'posted',
    v_cost,
    jsonb_build_object(
      'lines', v_lines,
      'costing', 'weighted-average',
      'consumption_mode', v_mode,
      'components', v_components,
      'batch_operational_quantity',
        CASE WHEN v_mode = 'batch' THEN v_batch_use ELSE NULL END,
      'batch_operational_unit',
        CASE WHEN v_mode = 'batch' THEN v_batch_unit ELSE NULL END,
      'batch_recipe_quantity',
        CASE WHEN v_mode = 'batch' THEN v_batch_use_recipe ELSE NULL END,
      'batch_recipe_unit',
        CASE WHEN v_mode = 'batch' THEN v_recipe.yield_unit ELSE NULL END,
      'inventory_policy',
        CASE
          WHEN v_mode = 'batch'
            THEN 'batch_canonical_recipe_consumption'
          ELSE v_mode
        END,
      'order_number', v_order_number,
      'menu_item', v_menu_name,
      'ticket_number', v_ticket_number,
      'station_name', v_station_name
    )
  )
  ON CONFLICT DO NOTHING;

  RETURN jsonb_build_object(
    'status','posted',
    'lines',v_lines,
    'cost',v_cost,
    'consumption_mode',v_mode,
    'batch_operational_quantity',
      CASE WHEN v_mode = 'batch' THEN v_batch_use ELSE NULL END,
    'batch_operational_unit',
      CASE WHEN v_mode = 'batch' THEN v_batch_unit ELSE NULL END,
    'batch_recipe_quantity',
      CASE WHEN v_mode = 'batch' THEN v_batch_use_recipe ELSE NULL END,
    'batch_recipe_unit',
      CASE WHEN v_mode = 'batch' THEN v_recipe.yield_unit ELSE NULL END
  );
END;
$$;
