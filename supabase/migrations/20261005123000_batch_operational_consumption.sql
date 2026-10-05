-- NEØ batch-production inventory correction
--
-- Contract:
-- 1. Production prepares/populates a batch container.
-- 2. Production does NOT deduct the canonical recipe ingredients.
-- 3. Production does NOT create a canonical finished-stock receipt.
-- 4. A sale consumes the available prepared batch quantity operationally.
-- 5. That same sale performs the canonical recipe inventory consumption once.
--
-- Markers used by the regression contract:
-- batch_component_log_only
-- batch_operational_consumption
-- batch_canonical_recipe_consumption

ALTER TABLE public.production_batches
  ADD COLUMN IF NOT EXISTS consumed_quantity numeric NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS remaining_quantity numeric;

DO $$
BEGIN
  ALTER TABLE public.production_batches
    ADD CONSTRAINT production_batches_consumed_quantity_chk
    CHECK (consumed_quantity >= 0);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  ALTER TABLE public.production_batches
    ADD CONSTRAINT production_batches_remaining_quantity_chk
    CHECK (remaining_quantity IS NULL OR remaining_quantity >= 0);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;


-- ============================================================
-- Production posting
-- batch_component_log_only
-- ============================================================

CREATE OR REPLACE FUNCTION public.neo_production_batch_post(
  _batch uuid,
  _location uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_b public.production_batches;
  v_recipe public.recipes;
  v_available numeric;
  v_unit text;
  v_loc uuid;
BEGIN
  SELECT *
    INTO v_b
    FROM public.production_batches
   WHERE id = _batch
   FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_found');
  END IF;

  IF v_b.organization_id IS DISTINCT FROM public.current_org_id() THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'forbidden');
  END IF;

  IF NOT (
    public.has_permission('kitchen', 'production', 'edit')
    OR public.has_permission('stores', 'issues', 'create')
  ) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_permitted');
  END IF;

  IF v_b.posted_at IS NOT NULL THEN
    RETURN jsonb_build_object(
      'ok', true,
      'reason', 'already_posted',
      'posted_at', v_b.posted_at,
      'remaining_quantity', v_b.remaining_quantity
    );
  END IF;

  IF COALESCE(v_b.actual_quantity, 0) <= 0 THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'no_actual_quantity');
  END IF;

  IF COALESCE(v_b.waste_quantity, 0) < 0 THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'negative_waste');
  END IF;

  IF COALESCE(v_b.waste_quantity, 0) > v_b.actual_quantity THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'waste_exceeds_production');
  END IF;

  SELECT *
    INTO v_recipe
    FROM public.recipes
   WHERE id = v_b.recipe_id;

  IF v_recipe IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'no_recipe');
  END IF;

  IF COALESCE(v_recipe.yield_quantity, 0) <= 0 THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'bad_yield');
  END IF;

  v_available :=
    v_b.actual_quantity - COALESCE(v_b.waste_quantity, 0);

  v_unit := COALESCE(
    NULLIF(v_b.unit, ''),
    NULLIF(v_recipe.yield_unit, ''),
    'portion'
  );

  -- Location remains useful operational metadata, but posting the batch
  -- does not create inventory movements.
  v_loc := COALESCE(
    _location,
    v_b.output_location_id,
    public.neo_station_consumption_location(
      v_b.organization_id,
      v_b.station_id,
      v_b.branch_id
    )
  );

  UPDATE public.production_batches
     SET consumed_quantity = 0,
         remaining_quantity = v_available,
         posted_at = now(),
         posted_by = auth.uid(),
         output_location_id = v_loc,
         posted_cost = NULL,
         status = CASE
                    WHEN v_available > 0 THEN 'completed'
                    ELSE 'fully-used'
                  END,
         updated_at = now()
   WHERE id = _batch;

  -- batch_component_log_only
  -- Ingredient usage is deliberately not posted here.
  -- The canonical recipe is consumed by the order that uses this batch.

  INSERT INTO public.audit_logs (
    organization_id,
    branch_id,
    user_id,
    action,
    module,
    record_id,
    new_value
  )
  VALUES (
    v_b.organization_id,
    v_b.branch_id,
    auth.uid(),
    'kitchen.production.posted',
    'kitchen',
    _batch::text,
    jsonb_build_object(
      'batch_number', v_b.batch_number,
      'gross_produced', v_b.actual_quantity,
      'production_waste', COALESCE(v_b.waste_quantity, 0),
      'available_quantity', v_available,
      'unit', v_unit,
      'inventory_effect', 'none',
      'inventory_policy', 'order_is_canonical_consumption',
      'location_id', v_loc
    )
  );

  RETURN jsonb_build_object(
    'ok', true,
    'produced', v_b.actual_quantity,
    'waste', COALESCE(v_b.waste_quantity, 0),
    'available', v_available,
    'remaining_quantity', v_available,
    'unit', v_unit,
    'location_id', v_loc,
    'inventory_effect', 'none'
  );
END;
$$;

REVOKE ALL
  ON FUNCTION public.neo_production_batch_post(uuid, uuid)
  FROM PUBLIC, anon;

GRANT EXECUTE
  ON FUNCTION public.neo_production_batch_post(uuid, uuid)
  TO authenticated;


-- ============================================================
-- Operational batch allocation
-- batch_operational_consumption
-- ============================================================

CREATE OR REPLACE FUNCTION public.neo_consume_prepared_batch(
  _recipe uuid,
  _branch uuid,
  _quantity numeric,
  _unit text,
  _order_item uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  -- v_needed is always expressed in _unit.
  v_needed numeric := _quantity;
  v_take numeric;
  v_take_batch numeric;
  v_available_requested numeric;
  v_batch_unit text;
  v_batch public.production_batches;
  v_used jsonb := '[]'::jsonb;
BEGIN
  IF COALESCE(_quantity, 0) <= 0 THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'bad_quantity');
  END IF;

  IF NULLIF(trim(COALESCE(_unit, '')), '') IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'missing_unit');
  END IF;

  -- Idempotency: if this order line already allocated batch quantity,
  -- do not consume it again.
  IF EXISTS (
    SELECT 1
      FROM public.audit_logs a
     WHERE a.organization_id = public.current_org_id()
       AND a.action = 'batch.operational.consumed'
       AND a.record_id = _order_item::text
  ) THEN
    RETURN jsonb_build_object(
      'ok', true,
      'reason', 'already_consumed'
    );
  END IF;

  FOR v_batch IN
    SELECT pb.*
      FROM public.production_batches pb
     WHERE pb.organization_id = public.current_org_id()
       AND pb.recipe_id = _recipe
       AND (
         (_branch IS NULL AND pb.branch_id IS NULL)
         OR pb.branch_id = _branch
       )
       AND pb.posted_at IS NOT NULL
       AND COALESCE(pb.remaining_quantity, 0) > 0
       AND pb.status IN ('completed', 'partially-used')
       AND (
         pb.use_by IS NULL
         OR pb.use_by >= now()
       )
     ORDER BY
       pb.use_by NULLS LAST,
       pb.prepared_at NULLS LAST,
       pb.created_at
     FOR UPDATE
  LOOP
    EXIT WHEN v_needed <= 0;

    v_batch_unit := COALESCE(
      NULLIF(trim(v_batch.unit), ''),
      _unit
    );

    -- Compare everything in the requested unit first.
    v_available_requested :=
      public.inventory_convert_strict(
        v_batch.remaining_quantity,
        v_batch_unit,
        _unit
      );

    v_take := LEAST(v_needed, v_available_requested);

    -- The production batch itself must be updated in its own native unit.
    v_take_batch :=
      public.inventory_convert_strict(
        v_take,
        _unit,
        v_batch_unit
      );

    UPDATE public.production_batches
       SET consumed_quantity = consumed_quantity + v_take_batch,
           remaining_quantity = remaining_quantity - v_take_batch,
           status = CASE
                      WHEN remaining_quantity - v_take_batch <= 0
                        THEN 'fully-used'
                      ELSE 'partially-used'
                    END,
           updated_at = now()
     WHERE id = v_batch.id;

    v_used := v_used || jsonb_build_array(
      jsonb_build_object(
        'batch_id', v_batch.id,
        'batch_number', v_batch.batch_number,

        -- Quantity allocated in the sale/request unit.
        'quantity', v_take,
        'unit', _unit,

        -- Exact amount removed from this physical batch container.
        'batch_quantity', v_take_batch,
        'batch_unit', v_batch_unit
      )
    );

    v_needed := v_needed - v_take;
  END LOOP;

  IF v_needed > 0 THEN
    RAISE EXCEPTION
      'Insufficient prepared batch quantity for recipe %. Missing %',
      _recipe,
      v_needed
      USING ERRCODE = 'check_violation';
  END IF;

  INSERT INTO public.audit_logs (
    organization_id,
    branch_id,
    user_id,
    action,
    module,
    record_id,
    new_value
  )
  VALUES (
    public.current_org_id(),
    _branch,
    auth.uid(),
    'batch.operational.consumed',
    'kitchen',
    _order_item::text,
    jsonb_build_object(
      'recipe_id', _recipe,
      'quantity', _quantity,
      'unit', _unit,
      'batches', v_used,
      'policy', 'batch_operational_consumption'
    )
  );

  RETURN jsonb_build_object(
    'ok', true,
    'consumed', _quantity,
    'batches', v_used
  );
END;
$$;


-- ============================================================
-- Sale consumption
-- batch_canonical_recipe_consumption
-- ============================================================

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

  SELECT sl.id
    INTO v_station_location
    FROM public.stock_locations sl
   WHERE sl.organization_id = v_org
     AND sl.active
     AND v_station IS NOT NULL
     AND sl.station_id = v_station
   LIMIT 1;

  v_location := COALESCE(
    v_menu.issuing_location_id,
    public.neo_station_consumption_location(
      v_org,
      v_station,
      v_branch
    )
  );

  IF v_location IS NULL THEN
    RETURN jsonb_build_object(
      'status','no-location',
      'branch_id',v_branch,
      'station_id',v_station
    );
  END IF;

  IF v_recipe IS NULL THEN
    RETURN jsonb_build_object('status','no-recipe');
  END IF;

  IF COALESCE(v_recipe.yield_quantity, 0) <= 0 THEN
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

    v_line_location := COALESCE(
      v_menu.issuing_location_id,
      v_station_location,
      public.neo_item_group_store(
        v_org,
        v_comp.item_id,
        v_branch
      ),
      v_location
    );

    IF v_menu.issuing_location_id IS NULL
       AND v_station_location IS NULL
       AND public.neo_item_group_store(
             v_org,
             v_comp.item_id,
             v_branch
           ) IS NOT NULL THEN
      v_group_lines := v_group_lines + 1;
    END IF;

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
          THEN 'Wastage allowance · order '
        ELSE 'Sale consumption · order '
      END
      || COALESCE(v_order_number, v_item.order_id::text)
      || ' · ' || COALESCE(v_menu_name, 'menu item')
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

REVOKE ALL
  ON FUNCTION public.inventory_consume_order_item_core(uuid)
  FROM PUBLIC, anon;

GRANT EXECUTE
  ON FUNCTION public.inventory_consume_order_item_core(uuid)
  TO authenticated, service_role;

-- ============================================================
-- Batch-aware void semantics
--
-- direct_stock:
--   may return to physical stock when voided
--
-- recipe:
--   before preparation -> reverse canonical recipe consumption
--   after preparation  -> retain consumption and record waste
--
-- batch:
--   before preparation -> reverse canonical recipe consumption
--                         AND restore exact operational batch quantity
--   after preparation  -> retain recipe consumption
--                         AND retain batch usage as waste
-- ============================================================

CREATE OR REPLACE FUNCTION public.neo_pos_item_void_effect()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_event record;
  v_mv record;
  v_batch_audit record;
  v_alloc record;

  v_prepared boolean;
  v_branch uuid;
  v_waste_no text;
  v_cost numeric := 0;
  v_mode text;
BEGIN
  IF NEW.status NOT IN ('voided','cancelled')
     OR OLD.status = NEW.status THEN
    RETURN NEW;
  END IF;

  SELECT branch_id
    INTO v_branch
    FROM public.pos_orders
   WHERE id = NEW.order_id;

  SELECT consumption_mode
    INTO v_mode
    FROM public.menu_items
   WHERE id = NEW.menu_item_id;

  IF v_mode IS NULL OR v_mode = 'none' THEN
    SELECT CASE
             WHEN r.recipe_type = 'direct_sale'
               THEN 'direct_stock'
             ELSE 'recipe'
           END
      INTO v_mode
      FROM public.recipes r
     WHERE r.organization_id = NEW.organization_id
       AND r.menu_item_id = NEW.menu_item_id
       AND r.status = 'active'
     ORDER BY
       (r.recipe_type = 'menu_item') DESC,
       r.version DESC
     LIMIT 1;
  END IF;

  /*
   * Direct packaged stock is never treated as kitchen-prepared.
   *
   * Recipe and batch items become prepared once they entered
   * the operational preparation/service lifecycle.
   */
  v_prepared :=
    COALESCE(v_mode, '') <> 'direct_stock'
    AND (
      NEW.sent_at IS NOT NULL
      OR NEW.ready_at IS NOT NULL
      OR NEW.served_at IS NOT NULL
    );

  SELECT *
    INTO v_event
    FROM public.inventory_posting_events
   WHERE order_item_id = NEW.id
     AND status = 'posted'
   LIMIT 1;

  IF v_event IS NULL THEN
    INSERT INTO public.audit_logs (
      organization_id,
      branch_id,
      station_id,
      user_name,
      action,
      module,
      record_id,
      new_value,
      reason
    )
    VALUES (
      NEW.organization_id,
      v_branch,
      NEW.station_id,
      COALESCE(auth.uid()::text,'system'),
      'pos.item.voided',
      'pos',
      NEW.id::text,
      jsonb_build_object(
        'prepared', v_prepared,
        'stock_impact', 'none',
        'item', NEW.item_name,
        'consumption_mode', v_mode
      ),
      'Voided before stock consumption was posted'
    );

    RETURN NEW;
  END IF;


  -- ==========================================================
  -- PREPARED / SERVED
  -- Consumption remains consumed.
  --
  -- For batch mode the prepared container quantity also remains
  -- consumed: it has physically left the reusable container.
  -- ==========================================================
  IF v_prepared THEN
    v_waste_no :=
      'WST-'
      || to_char(now(), 'YYYYMMDD')
      || '-'
      || substr(NEW.id::text, 1, 6);

    INSERT INTO public.waste_records (
      organization_id,
      branch_id,
      station_id,
      waste_number,
      occurred_at,
      menu_item_id,
      order_item_id,
      quantity,
      unit,
      estimated_cost,
      category,
      reason,
      status,
      inventory_adjustment_status,
      recorded_by
    )
    VALUES (
      NEW.organization_id,
      v_branch,
      NEW.station_id,
      v_waste_no,
      now(),
      NEW.menu_item_id,
      NEW.id,
      GREATEST(COALESCE(NEW.quantity,1), 0.001),
      'portion',
      COALESCE(v_event.cost_snapshot, 0),
      'prepared-void',
      CASE
        WHEN v_mode = 'batch'
          THEN 'Prepared batch quantity voided after allocation'
        ELSE 'Prepared item voided after production'
      END,
      'pending-review',
      'not-applicable',
      auth.uid()
    )
    ON CONFLICT DO NOTHING;

    INSERT INTO public.audit_logs (
      organization_id,
      branch_id,
      station_id,
      user_name,
      action,
      module,
      record_id,
      new_value,
      reason
    )
    VALUES (
      NEW.organization_id,
      v_branch,
      NEW.station_id,
      COALESCE(auth.uid()::text,'system'),
      'pos.item.voided.waste',
      'kitchen',
      NEW.id::text,
      jsonb_build_object(
        'waste_number', v_waste_no,
        'cost', COALESCE(v_event.cost_snapshot,0),
        'item', NEW.item_name,
        'consumption_mode', v_mode,
        'batch_restored', false
      ),
      'Prepared item voided - consumption retained and waste recorded'
    );

    RETURN NEW;
  END IF;


  -- ==========================================================
  -- NOT PREPARED
  -- Reverse canonical inventory movements.
  -- ==========================================================

  PERFORM set_config('neo.system_posting', '1', true);

  FOR v_mv IN
    SELECT *
      FROM public.stock_movements
     WHERE organization_id = NEW.organization_id
       AND reference_type = 'pos_order_item'
       AND reference_id = NEW.id
       AND movement_type IN ('consumption','wastage')
  LOOP
    PERFORM public.inventory_apply_movement(
      v_mv.stock_item_id,
      v_mv.location_id,
      abs(v_mv.quantity),
      v_mv.unit,
      'reversal',
      v_mv.unit_cost,
      'pos_order_item',
      NEW.id,
      CASE
        WHEN v_mv.movement_type = 'wastage'
          THEN 'Void reversal - wastage allowance returned to '
        ELSE 'Void reversal - order line returned to '
      END
      || COALESCE(
           (
             SELECT sl.name
               FROM public.stock_locations sl
              WHERE sl.id = v_mv.location_id
           ),
           'store'
         ),
      CASE
        WHEN v_mv.movement_type = 'wastage'
          THEN 'reverse-waste:'
        ELSE 'reverse:'
      END
      || NEW.id::text
      || ':'
      || v_mv.stock_item_id::text,
      NULL,
      NULL
    );

    v_cost :=
      v_cost
      + abs(v_mv.quantity)
        * COALESCE(v_mv.unit_cost, 0);
  END LOOP;

  PERFORM set_config('neo.system_posting', '', true);


  -- ==========================================================
  -- BATCH OPERATIONAL RESTORE
  --
  -- Only when it was voided before preparation.
  -- Restore exactly the batch allocations previously consumed.
  -- ==========================================================
  IF v_mode = 'batch' THEN

    IF NOT EXISTS (
      SELECT 1
        FROM public.audit_logs a
       WHERE a.organization_id = NEW.organization_id
         AND a.action = 'batch.operational.restored'
         AND a.record_id = NEW.id::text
    ) THEN

      SELECT *
        INTO v_batch_audit
        FROM public.audit_logs a
       WHERE a.organization_id = NEW.organization_id
         AND a.action = 'batch.operational.consumed'
         AND a.record_id = NEW.id::text
       ORDER BY a.created_at DESC
       LIMIT 1;

      IF FOUND
         AND v_batch_audit.new_value ? 'batches' THEN

        FOR v_alloc IN
          SELECT
            (x->>'batch_id')::uuid AS batch_id,
            COALESCE(
              NULLIF(x->>'batch_quantity', '')::numeric,
              (x->>'quantity')::numeric
            ) AS quantity
          FROM jsonb_array_elements(
            v_batch_audit.new_value->'batches'
          ) x
        LOOP

          UPDATE public.production_batches pb
             SET consumed_quantity =
                   GREATEST(
                     COALESCE(pb.consumed_quantity,0)
                     - v_alloc.quantity,
                     0
                   ),

                 remaining_quantity =
                   LEAST(
                     pb.actual_quantity
                       - COALESCE(pb.waste_quantity,0),

                     COALESCE(pb.remaining_quantity,0)
                       + v_alloc.quantity
                   ),

                 status =
                   CASE
                     WHEN GREATEST(
                            COALESCE(pb.consumed_quantity,0)
                            - v_alloc.quantity,
                            0
                          ) <= 0
                       THEN 'completed'
                     ELSE 'partially-used'
                   END,

                 updated_at = now()

           WHERE pb.id = v_alloc.batch_id
             AND pb.organization_id = NEW.organization_id;
        END LOOP;

        INSERT INTO public.audit_logs (
          organization_id,
          branch_id,
          station_id,
          user_name,
          action,
          module,
          record_id,
          new_value,
          reason
        )
        VALUES (
          NEW.organization_id,
          v_branch,
          NEW.station_id,
          COALESCE(auth.uid()::text,'system'),
          'batch.operational.restored',
          'kitchen',
          NEW.id::text,
          jsonb_build_object(
            'source_allocation',
              v_batch_audit.new_value->'batches',
            'policy',
              'batch_operational_void_restore'
          ),
          'Unprepared batch order voided - prepared quantity returned to its original batch container'
        );

      END IF;
    END IF;
  END IF;


  UPDATE public.inventory_posting_events
     SET status = 'reversed',
         updated_at = now()
   WHERE id = v_event.id;

  INSERT INTO public.audit_logs (
    organization_id,
    branch_id,
    station_id,
    user_name,
    action,
    module,
    record_id,
    new_value,
    reason
  )
  VALUES (
    NEW.organization_id,
    v_branch,
    NEW.station_id,
    COALESCE(auth.uid()::text,'system'),
    'pos.item.voided.reversed',
    'inventory',
    NEW.id::text,
    jsonb_build_object(
      'reversed_value', v_cost,
      'item', NEW.item_name,
      'consumption_mode', v_mode,
      'batch_restored', v_mode = 'batch'
    ),
    CASE
      WHEN v_mode = 'batch'
        THEN 'Unprepared batch item voided - canonical recipe reversed and batch quantity restored'
      ELSE 'Unprepared item voided - stock returned'
    END
  );

  RETURN NEW;
END;
$$;

