-- 1. Station consumption location -------------------------------------------
ALTER TABLE public.stock_locations
  ADD COLUMN IF NOT EXISTS station_id uuid REFERENCES public.operational_stations(id) ON DELETE SET NULL;

CREATE UNIQUE INDEX IF NOT EXISTS stock_locations_station_consumption_idx
  ON public.stock_locations (organization_id, station_id)
  WHERE station_id IS NOT NULL AND active;

CREATE OR REPLACE FUNCTION public.neo_station_consumption_location(_org uuid, _station uuid, _branch uuid)
RETURNS uuid
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $$
  SELECT sl.id
    FROM stock_locations sl
   WHERE sl.organization_id = _org
     AND sl.active
     AND (
       (_station IS NOT NULL AND sl.station_id = _station)
       OR (
         sl.station_id IS NULL
         AND (
           (_branch IS NOT NULL AND (sl.branch_id = _branch OR sl.branch_id IS NULL))
           OR (_branch IS NULL AND sl.branch_id IS NULL)
         )
       )
     )
   ORDER BY (_station IS NOT NULL AND sl.station_id = _station) DESC,
            (sl.branch_id IS NOT DISTINCT FROM _branch) DESC,
            (sl.location_type = 'kitchen') DESC,
            sl.is_main DESC,
            sl.created_at
   LIMIT 1;
$$;

-- Validation read: which stations serving active recipes have no consumption store.
CREATE OR REPLACE FUNCTION public.neo_recipe_location_readiness(_branch uuid DEFAULT NULL)
RETURNS TABLE(station_id uuid, station_name text, branch_id uuid, recipes_active bigint, location_id uuid, location_name text, ready boolean)
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $$
  SELECT s.id, s.name, s.branch_id, count(r.id),
         l.id, l.name,
         l.id IS NOT NULL
    FROM operational_stations s
    LEFT JOIN recipes r
      ON r.station_id = s.id
     AND r.organization_id = s.organization_id
     AND r.status = 'active'
    LEFT JOIN stock_locations l
      ON l.organization_id = s.organization_id
     AND l.station_id = s.id
     AND l.active
   WHERE s.organization_id = current_org_id()
     AND s.active
     AND (_branch IS NULL OR s.branch_id = _branch OR s.branch_id IS NULL)
   GROUP BY s.id, s.name, s.branch_id, l.id, l.name
   ORDER BY (l.id IS NULL) DESC, s.name;
$$;

-- 2. Low-stock replenishment recommendations ---------------------------------
CREATE TABLE IF NOT EXISTS public.stock_replenishment_recommendations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  branch_id uuid REFERENCES public.branches(id) ON DELETE SET NULL,
  stock_item_id uuid NOT NULL REFERENCES public.stock_items(id) ON DELETE CASCADE,
  location_id uuid REFERENCES public.stock_locations(id) ON DELETE SET NULL,
  on_hand numeric NOT NULL DEFAULT 0,
  threshold numeric NOT NULL DEFAULT 0,
  recommended_quantity numeric NOT NULL DEFAULT 0,
  source text NOT NULL DEFAULT 'consumption',
  source_record_id uuid,
  status text NOT NULL DEFAULT 'recommended',
  purchase_request_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT stock_replenishment_status_chk
    CHECK (status = ANY (ARRAY['recommended','acknowledged','requisitioned','dismissed']))
);

CREATE UNIQUE INDEX IF NOT EXISTS stock_replenishment_open_idx
  ON public.stock_replenishment_recommendations (organization_id, stock_item_id, COALESCE(branch_id, '00000000-0000-0000-0000-000000000000'::uuid))
  WHERE status = 'recommended';

GRANT SELECT, INSERT, UPDATE ON public.stock_replenishment_recommendations TO authenticated;
GRANT ALL ON public.stock_replenishment_recommendations TO service_role;

ALTER TABLE public.stock_replenishment_recommendations ENABLE ROW LEVEL SECURITY;

CREATE POLICY "replenishment_select" ON public.stock_replenishment_recommendations
  FOR SELECT TO authenticated
  USING (organization_id = current_org_id());

CREATE POLICY "replenishment_insert" ON public.stock_replenishment_recommendations
  FOR INSERT TO authenticated
  WITH CHECK (organization_id = current_org_id());

CREATE POLICY "replenishment_update" ON public.stock_replenishment_recommendations
  FOR UPDATE TO authenticated
  USING (organization_id = current_org_id())
  WITH CHECK (organization_id = current_org_id());

CREATE TRIGGER stock_replenishment_touch
  BEFORE UPDATE ON public.stock_replenishment_recommendations
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

-- Evaluate a single stock item after consumption. Recommends only; never
-- creates, approves or places an order.
CREATE OR REPLACE FUNCTION public.neo_evaluate_low_stock(_org uuid, _branch uuid, _item uuid, _source text, _source_record uuid)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_item record; v_on_hand numeric; v_threshold numeric; v_target numeric; v_rec uuid;
BEGIN
  SELECT * INTO v_item FROM stock_items WHERE id = _item AND organization_id = _org;
  IF v_item IS NULL OR NOT v_item.active THEN RETURN NULL; END IF;

  v_threshold := COALESCE(NULLIF(v_item.reorder_point, 0), v_item.min_level, 0);
  IF v_threshold <= 0 THEN RETURN NULL; END IF;

  SELECT COALESCE(SUM(l.quantity_on_hand), 0) INTO v_on_hand
    FROM stock_levels l WHERE l.stock_item_id = _item;

  IF v_on_hand > v_threshold THEN RETURN NULL; END IF;

  v_target := COALESCE(NULLIF(v_item.par_level, 0), NULLIF(v_item.max_level, 0),
                       NULLIF(v_item.reorder_quantity, 0), v_threshold * 2);

  INSERT INTO stock_replenishment_recommendations
    (organization_id, branch_id, stock_item_id, on_hand, threshold, recommended_quantity, source, source_record_id)
  VALUES (_org, _branch, _item, v_on_hand, v_threshold, GREATEST(v_target - v_on_hand, 0), COALESCE(_source, 'consumption'), _source_record)
  ON CONFLICT DO NOTHING
  RETURNING id INTO v_rec;

  IF v_rec IS NULL THEN
    UPDATE stock_replenishment_recommendations
       SET on_hand = v_on_hand,
           recommended_quantity = GREATEST(v_target - v_on_hand, 0),
           updated_at = now()
     WHERE organization_id = _org AND stock_item_id = _item AND status = 'recommended'
       AND branch_id IS NOT DISTINCT FROM _branch
     RETURNING id INTO v_rec;
  END IF;

  RETURN v_rec;
END;
$$;

-- 3. Batch products expand once ----------------------------------------------
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

  -- Direct-sale product: the recipe is a wrapper over a single stock item.
  IF v_recipe.recipe_type = 'direct_sale' AND v_recipe.output_stock_item_id IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM recipe_ingredients WHERE recipe_id = _recipe) THEN
    SELECT si.id, si.base_unit INTO v_stock FROM stock_items si WHERE si.id = v_recipe.output_stock_item_id;
    IF v_stock.id IS NULL THEN
      RAISE EXCEPTION 'Direct-sale recipe % has no stock item', _recipe USING ERRCODE = 'data_exception';
    END IF;
    RETURN QUERY SELECT
      v_stock.id,
      public.inventory_convert_strict(v_recipe.yield_quantity * _batches,
        COALESCE(v_recipe.yield_unit, v_stock.base_unit), v_stock.base_unit),
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
      -- Quantity required, expressed in the sub-recipe's own yield unit.
      v_sub_qty := public.inventory_convert_strict(v_qty, COALESCE(v_ing.unit, v_stock.yield_unit), v_stock.yield_unit);

      -- A produced batch is itself a stock item: deduct the batch once instead
      -- of re-deducting its raw components (production already consumed them).
      IF v_stock.output_stock_item_id IS NOT NULL THEN
        SELECT si.id, si.base_unit INTO v_batch_item FROM stock_items si WHERE si.id = v_stock.output_stock_item_id;
        IF v_batch_item.id IS NOT NULL THEN
          RETURN QUERY SELECT
            v_batch_item.id,
            public.inventory_convert_strict(v_sub_qty, COALESCE(v_stock.yield_unit, v_batch_item.base_unit), v_batch_item.base_unit),
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
        public.inventory_convert_strict(v_qty, COALESCE(v_ing.unit, v_stock.base_unit), v_stock.base_unit),
        v_stock.base_unit;
    END IF;
  END LOOP;
END;
$function$;

-- 4. Consumption core: lifecycle guard, station location, low-stock signal ----
CREATE OR REPLACE FUNCTION public.inventory_consume_order_item_core(_order_item uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_item record; v_recipe record; v_comp record;
  v_location uuid; v_stock record; v_batches numeric;
  v_cost numeric := 0; v_lines integer := 0;
  v_org uuid; v_branch uuid;
BEGIN
  SELECT oi.*, o.branch_id, o.organization_id AS org, o.status AS order_status
    INTO v_item
    FROM pos_order_items oi JOIN pos_orders o ON o.id = oi.order_id
   WHERE oi.id = _order_item;
  IF v_item IS NULL THEN RETURN jsonb_build_object('status','no-item'); END IF;
  v_org := v_item.org;
  v_branch := v_item.branch_id;

  -- Cancelled, voided or still-draft work never deducts stock.
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

  -- Station-aware, branch-scoped location resolution.
  v_location := public.neo_station_consumption_location(
    v_org, COALESCE(v_item.station_id, v_recipe.station_id), v_branch);
  IF v_location IS NULL THEN
    RETURN jsonb_build_object('status','no-location','branch_id',v_branch,
                              'station_id', COALESCE(v_item.station_id, v_recipe.station_id));
  END IF;

  IF COALESCE(v_recipe.yield_quantity, 0) <= 0 THEN
    RAISE EXCEPTION 'Recipe % has no usable yield quantity', v_recipe.id USING ERRCODE = 'data_exception';
  END IF;
  v_batches := CASE WHEN v_recipe.recipe_type = 'direct_sale'
                    THEN COALESCE(v_item.quantity, 1)
                    ELSE COALESCE(v_item.quantity, 1) / v_recipe.yield_quantity END;

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
    -- Recommendation only: procurement still decides.
    PERFORM public.neo_evaluate_low_stock(v_org, v_branch, v_comp.item_id, 'consumption', _order_item);
  END LOOP;

  INSERT INTO inventory_posting_events (organization_id, branch_id, order_id, order_item_id, recipe_id,
    recipe_version, posting_type, idempotency_key, status, cost_snapshot, payload)
  VALUES (v_org, v_branch, v_item.order_id, _order_item, v_recipe.id, v_recipe.version,
    'consumption', 'consume:' || _order_item::text, 'posted', v_cost,
    jsonb_build_object('lines', v_lines, 'unresolved_ingredients', 0, 'costing', 'weighted-average',
                       'location_id', v_location, 'branch_id', v_branch,
                       'batches', v_batches, 'recipe_yield', v_recipe.yield_quantity,
                       'recipe_type', v_recipe.recipe_type))
  ON CONFLICT DO NOTHING;

  RETURN jsonb_build_object('status','posted','lines',v_lines,'cost',v_cost,'unresolved',0,
                            'location_id',v_location,'batches',v_batches);
END;
$function$;

-- 5. Void of a prepared item: waste or reversal, always audited --------------
CREATE OR REPLACE FUNCTION public.neo_pos_item_void_effect()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_event record; v_mv record; v_prepared boolean; v_branch uuid; v_waste_no text; v_cost numeric := 0;
BEGIN
  IF NEW.status NOT IN ('voided','cancelled') OR OLD.status = NEW.status THEN
    RETURN NEW;
  END IF;

  SELECT branch_id INTO v_branch FROM pos_orders WHERE id = NEW.order_id;
  v_prepared := NEW.sent_at IS NOT NULL OR NEW.ready_at IS NOT NULL OR NEW.served_at IS NOT NULL;

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
    -- Prepared food cannot return to stock: record waste for review.
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
      'Prepared item voided — waste recorded for review');
    RETURN NEW;
  END IF;

  -- Not yet prepared: reverse the consumption movements exactly once.
  FOR v_mv IN
    SELECT * FROM stock_movements
     WHERE organization_id = NEW.organization_id
       AND reference_type = 'pos_order_item'
       AND reference_id = NEW.id
       AND movement_type = 'consumption'
  LOOP
    PERFORM inventory_apply_movement(v_mv.stock_item_id, v_mv.location_id, abs(v_mv.quantity), v_mv.unit,
      'reversal', v_mv.unit_cost, 'pos_order_item', NEW.id, 'Void reversal',
      'reverse:' || NEW.id::text || ':' || v_mv.stock_item_id::text, NULL, NULL);
    v_cost := v_cost + abs(v_mv.quantity) * COALESCE(v_mv.unit_cost, 0);
  END LOOP;

  UPDATE inventory_posting_events SET status = 'reversed', updated_at = now()
   WHERE id = v_event.id;

  INSERT INTO audit_logs (organization_id, branch_id, station_id, user_name, action, module, record_id, new_value, reason)
  VALUES (NEW.organization_id, v_branch, NEW.station_id, COALESCE(auth.uid()::text,'system'),
    'pos.item.voided.reversed', 'inventory', NEW.id::text,
    jsonb_build_object('reversed_value', v_cost, 'item', NEW.item_name),
    'Item voided before production — stock returned');
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS neo_pos_item_void_effect_trg ON public.pos_order_items;
CREATE TRIGGER neo_pos_item_void_effect_trg
  AFTER UPDATE OF status ON public.pos_order_items
  FOR EACH ROW EXECUTE FUNCTION public.neo_pos_item_void_effect();

-- 6. Order-level cancellation / duplication audit ----------------------------
CREATE OR REPLACE FUNCTION public.neo_pos_order_lifecycle_audit()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
  IF NEW.status NOT IN ('cancelled','voided') OR OLD.status = NEW.status THEN
    RETURN NEW;
  END IF;
  INSERT INTO audit_logs (organization_id, branch_id, user_name, action, module, record_id, previous_value, new_value, reason)
  VALUES (NEW.organization_id, NEW.branch_id, COALESCE(auth.uid()::text,'system'),
    'pos.order.' || NEW.status, 'pos', NEW.id::text,
    jsonb_build_object('status', OLD.status),
    jsonb_build_object('status', NEW.status,
      'stock_posted', EXISTS (SELECT 1 FROM inventory_posting_events e
                                WHERE e.order_id = NEW.id AND e.status = 'posted')),
    'Order lifecycle change recorded');
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS neo_pos_order_lifecycle_audit_trg ON public.pos_orders;
CREATE TRIGGER neo_pos_order_lifecycle_audit_trg
  AFTER UPDATE OF status ON public.pos_orders
  FOR EACH ROW EXECUTE FUNCTION public.neo_pos_order_lifecycle_audit();