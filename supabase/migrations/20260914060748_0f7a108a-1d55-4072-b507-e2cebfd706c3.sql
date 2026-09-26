-- 1. Universal consumption mode on the menu item itself.
ALTER TABLE public.menu_items
  ADD COLUMN IF NOT EXISTS consumption_mode text NOT NULL DEFAULT 'none',
  ADD COLUMN IF NOT EXISTS stock_item_id uuid REFERENCES public.stock_items(id),
  ADD COLUMN IF NOT EXISTS stock_quantity_per_sale numeric NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS stock_unit text,
  ADD COLUMN IF NOT EXISTS issuing_location_id uuid REFERENCES public.stock_locations(id),
  ADD COLUMN IF NOT EXISTS consumption_channels text[];

DO $$ BEGIN
  ALTER TABLE public.menu_items
    ADD CONSTRAINT menu_items_consumption_mode_chk
    CHECK (consumption_mode IN ('none','direct_stock','recipe','batch'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE public.menu_items
    ADD CONSTRAINT menu_items_stock_qty_chk CHECK (stock_quantity_per_sale > 0);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE INDEX IF NOT EXISTS menu_items_stock_item_idx ON public.menu_items(stock_item_id);

-- 2. Backfill from how each item is configured today. Nothing is invented:
--    an item only becomes direct-stock when it already points at a stock item.
UPDATE public.menu_items mi
   SET consumption_mode = 'direct_stock',
       stock_item_id = COALESCE(mi.stock_item_id, r.output_stock_item_id),
       stock_quantity_per_sale = COALESCE(NULLIF(r.yield_quantity,0), 1),
       stock_unit = COALESCE(NULLIF(mi.stock_unit,''), NULLIF(r.yield_unit,''))
  FROM public.recipes r
 WHERE r.menu_item_id = mi.id
   AND r.organization_id = mi.organization_id
   AND r.recipe_type = 'direct_sale'
   AND r.status = 'active'
   AND r.output_stock_item_id IS NOT NULL
   AND mi.consumption_mode = 'none';

UPDATE public.menu_items mi
   SET consumption_mode = 'recipe'
 WHERE mi.consumption_mode = 'none'
   AND EXISTS (
     SELECT 1 FROM public.recipes r
      WHERE r.menu_item_id = mi.id
        AND r.organization_id = mi.organization_id
        AND r.recipe_type = 'menu_item'
        AND r.status = 'active');

-- 3. A configured mode must be complete, or the sale would post nothing quietly.
CREATE OR REPLACE FUNCTION public.neo_menu_item_consumption_guard()
RETURNS trigger LANGUAGE plpgsql SET search_path TO 'public' AS $$
BEGIN
  IF NEW.consumption_mode IN ('direct_stock','batch') AND NEW.stock_item_id IS NULL THEN
    RAISE EXCEPTION 'Choose the stock item this menu item deducts'
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.consumption_mode NOT IN ('direct_stock','batch') THEN
    NEW.stock_item_id := NULL;
    NEW.issuing_location_id := NULL;
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS menu_items_consumption_guard ON public.menu_items;
CREATE TRIGGER menu_items_consumption_guard
  BEFORE INSERT OR UPDATE ON public.menu_items
  FOR EACH ROW EXECUTE FUNCTION public.neo_menu_item_consumption_guard();

-- 4. Attaching a recipe to an item that consumes nothing keeps the two in step.
CREATE OR REPLACE FUNCTION public.neo_recipe_sync_menu_mode()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
BEGIN
  IF NEW.menu_item_id IS NULL OR NEW.status <> 'active' THEN RETURN NEW; END IF;
  IF NEW.recipe_type = 'direct_sale' AND NEW.output_stock_item_id IS NOT NULL THEN
    UPDATE public.menu_items
       SET consumption_mode = 'direct_stock',
           stock_item_id = NEW.output_stock_item_id,
           stock_quantity_per_sale = COALESCE(NULLIF(NEW.yield_quantity,0), 1),
           stock_unit = COALESCE(NULLIF(stock_unit,''), NULLIF(NEW.yield_unit,''))
     WHERE id = NEW.menu_item_id AND consumption_mode = 'none';
  ELSIF NEW.recipe_type = 'menu_item' THEN
    UPDATE public.menu_items SET consumption_mode = 'recipe'
     WHERE id = NEW.menu_item_id AND consumption_mode = 'none';
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS recipes_sync_menu_mode ON public.recipes;
CREATE TRIGGER recipes_sync_menu_mode
  AFTER INSERT OR UPDATE ON public.recipes
  FOR EACH ROW EXECUTE FUNCTION public.neo_recipe_sync_menu_mode();

-- 5. One fulfilment engine for every channel, driven by the menu item.
CREATE OR REPLACE FUNCTION public.inventory_consume_order_item_core(_order_item uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_item record; v_menu record; v_recipe record; v_comp record; v_stock record;
  v_location uuid; v_station_location uuid; v_line_location uuid;
  v_batches numeric; v_cost numeric := 0; v_lines integer := 0; v_group_lines integer := 0;
  v_volume_lines integer := 0; v_ml numeric;
  v_org uuid; v_branch uuid; v_station uuid; v_mode text;
  v_order_number text; v_menu_name text; v_station_name text;
  v_ticket_number text; v_actor text; v_store_name text; v_note text;
  v_channel text; v_components jsonb := '[]'::jsonb;
  v_direct_item uuid; v_direct_unit text; v_direct_qty numeric;
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
  -- Legacy rows configured only through the recipe still behave as before.
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
    v_batches := COALESCE(v_item.quantity, 1);
    v_components := jsonb_build_array(jsonb_build_object(
      'item_id', v_direct_item, 'qty', v_direct_qty, 'unit', v_direct_unit));
  ELSE
    IF v_recipe IS NULL THEN RETURN jsonb_build_object('status','no-recipe'); END IF;
    IF COALESCE(v_recipe.yield_quantity, 0) <= 0 THEN
      RAISE EXCEPTION 'Recipe % has no usable yield quantity', v_recipe.id USING ERRCODE = 'data_exception';
    END IF;
    v_batches := COALESCE(v_item.quantity, 1) / v_recipe.yield_quantity;
    SELECT COALESCE(jsonb_agg(jsonb_build_object('item_id', x.stock_item_id, 'qty', x.qty, 'unit', x.unit)),
                    '[]'::jsonb)
      INTO v_components
      FROM (SELECT e.stock_item_id, sum(e.quantity) AS qty, min(e.unit) AS unit
              FROM public.recipe_expand_to_stock(v_recipe.id, v_batches, v_branch) e
             GROUP BY e.stock_item_id) x;
  END IF;

  FOR v_comp IN
    SELECT (e->>'item_id')::uuid AS item_id, (e->>'qty')::numeric AS qty, e->>'unit' AS unit
      FROM jsonb_array_elements(v_components) e
  LOOP
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

    v_note := 'Sale consumption · order ' || COALESCE(v_order_number, v_item.order_id::text)
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
  VALUES (v_org, v_branch, v_item.order_id, _order_item,
    CASE WHEN v_mode = 'recipe' THEN v_recipe.id ELSE NULL END,
    CASE WHEN v_mode = 'recipe' THEN v_recipe.version ELSE NULL END,
    'consumption', 'consume:' || _order_item::text, 'posted', v_cost,
    jsonb_build_object('lines', v_lines, 'unresolved_ingredients', 0, 'costing', 'weighted-average',
                       'location_id', v_location, 'branch_id', v_branch,
                       'station_location_id', v_station_location,
                       'group_routed_lines', v_group_lines,
                       'volume_lines', v_volume_lines,
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
                            'consumption_mode',v_mode,
                            'order_channel',v_channel,
                            'batches',v_batches);
END;
$function$;

-- 6. A void or refund returns a packaged product to the shelf; the mode now says
--    whether the line was ever prepared.
CREATE OR REPLACE FUNCTION public.neo_pos_item_void_effect()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
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

  -- A sealed packaged product is never "prepared": it goes back on the shelf.
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
       AND movement_type = 'consumption'
  LOOP
    PERFORM inventory_apply_movement(v_mv.stock_item_id, v_mv.location_id, abs(v_mv.quantity), v_mv.unit,
      'reversal', v_mv.unit_cost, 'pos_order_item', NEW.id,
      'Void reversal · order line returned to ' || COALESCE((SELECT sl.name FROM stock_locations sl WHERE sl.id = v_mv.location_id), 'store'),
      'reverse:' || NEW.id::text || ':' || v_mv.stock_item_id::text, NULL, NULL);
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
$function$;

-- 7. The catalogue reports the mode the item actually uses.
DROP FUNCTION IF EXISTS public.neo_menu_catalogue(uuid, boolean);
CREATE FUNCTION public.neo_menu_catalogue(_branch uuid DEFAULT NULL::uuid, _include_drafts boolean DEFAULT false)
 RETURNS TABLE(id uuid, name text, sku text, description text, currency text, image_url text, prep_minutes integer, recipe_status text, consumption_mode text, recipe_id uuid, direct_stock_item_id uuid, direct_stock_item_name text, direct_stock_unit text, direct_stock_quantity numeric, issuing_location_id uuid, issuing_location_name text, consumption_channels text[], category_id uuid, category_name text, menu_id uuid, menu_name text, menu_outlet text, base_price numeric, tax_rate numeric, availability text, publish_status text, branch_id uuid, branch_name text, department_id uuid, department_name text, station_id uuid, station_name text, station_source text, station_missing boolean, assigned_station_id uuid, imported boolean, import_batch_id uuid, import_file_name text, import_batch_status text, published_at timestamp with time zone, updated_at timestamp with time zone)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE _org uuid := public.current_org_id();
BEGIN
  IF _org IS NULL THEN RETURN; END IF;
  IF NOT public.has_permission('pos','menu','view') THEN
    RAISE EXCEPTION 'Not permitted to view the menu catalogue';
  END IF;

  RETURN QUERY
  WITH src AS (
    SELECT mi.*, mc.name AS cat_name, m.id AS menu_ident, m.name AS menu_nm, m.outlet AS menu_out,
           b.file_name AS batch_file, b.status AS batch_status,
           br.name AS branch_nm,
           rc.id AS rec_id,
           rc.ingredient_count,
           rc.recipe_type AS rec_type,
           rc.output_stock_item_id AS rec_output,
           rc.yield_quantity AS rec_yield,
           rc.yield_unit AS rec_yield_unit,
           public.neo_kitchen_resolve_station(_org, coalesce(mi.branch_id, _branch), mi.id, mi.category_id, NULL, NULL) AS res
      FROM public.menu_items mi
      LEFT JOIN public.menu_categories mc ON mc.id = mi.category_id
      LEFT JOIN public.menus m ON m.id = mc.menu_id
      LEFT JOIN public.menu_import_batches b ON b.id = mi.import_batch_id
      LEFT JOIN public.branches br ON br.id = mi.branch_id
      LEFT JOIN LATERAL (
        SELECT r.id, r.recipe_type, r.output_stock_item_id, r.yield_quantity, r.yield_unit,
               (SELECT count(*) FROM public.recipe_ingredients ri WHERE ri.recipe_id = r.id) AS ingredient_count
          FROM public.recipes r
         WHERE r.menu_item_id = mi.id AND r.organization_id = _org
         ORDER BY r.version DESC NULLS LAST, r.created_at DESC
         LIMIT 1
      ) rc ON true
     WHERE mi.organization_id = _org
       AND (_include_drafts OR mi.publish_status = 'published')
       AND (_branch IS NULL OR mi.branch_id IS NULL OR mi.branch_id = _branch)
       AND public.neo_branch_in_scope(mi.branch_id)
  ), shaped AS (
    SELECT r.*,
           CASE
             WHEN COALESCE(r.consumption_mode,'none') <> 'none' THEN r.consumption_mode
             WHEN r.rec_type = 'direct_sale' AND r.rec_output IS NOT NULL THEN 'direct_stock'
             WHEN r.rec_id IS NOT NULL THEN 'recipe'
             ELSE 'none'
           END AS eff_mode,
           COALESCE(r.stock_item_id, CASE WHEN r.rec_type = 'direct_sale' THEN r.rec_output END) AS eff_stock_item
      FROM src r
  )
  SELECT s.id, s.name, s.sku, s.description, s.currency, s.image_url, s.prep_minutes,
         CASE
           WHEN s.eff_mode = 'none' THEN 'no-stock'
           WHEN s.eff_mode IN ('direct_stock','batch') THEN
             CASE WHEN s.eff_stock_item IS NOT NULL THEN 'direct-stock' ELSE 'incomplete' END
           WHEN s.rec_id IS NULL THEN 'not-linked'
           WHEN coalesce(s.ingredient_count,0) = 0 THEN 'incomplete'
           ELSE 'linked'
         END,
         s.eff_mode,
         s.rec_id,
         s.eff_stock_item,
         si.name,
         CASE WHEN s.eff_stock_item IS NOT NULL
              THEN coalesce(nullif(s.stock_unit,''), nullif(s.rec_yield_unit,''), si.base_unit) END,
         CASE WHEN s.eff_stock_item IS NOT NULL
              THEN coalesce(nullif(s.stock_quantity_per_sale,0), s.rec_yield, 1) END,
         s.issuing_location_id, iss.name, s.consumption_channels,
         s.category_id, s.cat_name, s.menu_ident, s.menu_nm, coalesce(s.menu_out,'all'),
         s.base_price, s.tax_rate, s.availability, s.publish_status,
         s.branch_id, s.branch_nm,
         st.department_id, dp.name,
         nullif(s.res->>'station_id','')::uuid,
         st.name,
         s.res->>'source',
         (s.res->>'missing')::boolean,
         s.station_id,
         s.import_batch_id IS NOT NULL,
         s.import_batch_id, s.batch_file, s.batch_status,
         s.published_at, s.updated_at
    FROM shaped s
    LEFT JOIN public.stock_items si ON si.id = s.eff_stock_item
    LEFT JOIN public.stock_locations iss ON iss.id = s.issuing_location_id
    LEFT JOIN public.operational_stations st ON st.id = nullif(s.res->>'station_id','')::uuid
    LEFT JOIN public.departments dp ON dp.id = st.department_id
   ORDER BY s.branch_nm NULLS FIRST, s.cat_name NULLS LAST, s.name;
END $function$;

GRANT EXECUTE ON FUNCTION public.neo_menu_catalogue(uuid, boolean) TO authenticated;
REVOKE EXECUTE ON FUNCTION public.neo_menu_catalogue(uuid, boolean) FROM anon;
REVOKE EXECUTE ON FUNCTION public.neo_menu_item_consumption_guard() FROM anon, public;
REVOKE EXECUTE ON FUNCTION public.neo_recipe_sync_menu_mode() FROM anon, public;