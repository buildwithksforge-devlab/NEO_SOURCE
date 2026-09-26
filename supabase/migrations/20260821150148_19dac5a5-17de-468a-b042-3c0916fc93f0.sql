
-- 1. Ledger-derived consumption costing -------------------------------------
CREATE OR REPLACE FUNCTION public.inventory_consume_order_item(_order_item uuid)
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
    -- Cost of sale is the ledger weighted-average cost of the stock item, in
    -- base units. Recipe prices are planning figures and never value the ledger.
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

-- 2. Order-level safety net: a completed/paid sale posts any missing lines ---
CREATE OR REPLACE FUNCTION public.inventory_order_consumption_trigger()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE r record;
BEGIN
  IF lower(COALESCE(NEW.status,'')) NOT IN ('completed','paid','closed') THEN RETURN NEW; END IF;
  IF TG_OP = 'UPDATE' AND lower(COALESCE(OLD.status,'')) = lower(COALESCE(NEW.status,'')) THEN RETURN NEW; END IF;
  FOR r IN SELECT id FROM pos_order_items WHERE order_id = NEW.id AND COALESCE(status,'') <> 'voided' LOOP
    BEGIN
      PERFORM public.inventory_consume_order_item(r.id);
    EXCEPTION WHEN OTHERS THEN NULL;
    END;
  END LOOP;
  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS pos_orders_inventory_consumption ON public.pos_orders;
CREATE TRIGGER pos_orders_inventory_consumption
AFTER UPDATE OF status ON public.pos_orders
FOR EACH ROW EXECUTE FUNCTION public.inventory_order_consumption_trigger();

-- 3. Menu profitability from ledger cost, not recipe list prices ------------
CREATE OR REPLACE FUNCTION public.inventory_menu_profitability()
 RETURNS TABLE(menu_item_id uuid, menu_item text, recipe_cost numeric, sale_price numeric, gross_profit numeric, margin_pct numeric, units_sold numeric)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  WITH costs AS (
    SELECT r.menu_item_id, MAX(r.version) AS v
      FROM recipes r WHERE r.organization_id = current_org_id() AND r.status = 'active'
     GROUP BY r.menu_item_id
  ), rc AS (
    SELECT r.menu_item_id,
           COALESCE(SUM(
             public.inventory_convert(ri.quantity, COALESCE(ri.unit, si.base_unit), si.base_unit)
             * COALESCE(si.average_cost, 0)
           ), 0) / GREATEST(COALESCE(r.yield_quantity, 1), 1) AS cost
      FROM recipes r
      JOIN costs c ON c.menu_item_id = r.menu_item_id AND c.v = r.version
      LEFT JOIN recipe_ingredients ri ON ri.recipe_id = r.id
      LEFT JOIN stock_items si ON si.organization_id = r.organization_id
             AND (si.id::text = ri.inventory_item_ref OR lower(si.name) = lower(ri.ingredient_name))
     WHERE r.organization_id = current_org_id()
     GROUP BY r.menu_item_id, r.yield_quantity
  )
  SELECT m.id, m.name, COALESCE(rc.cost, 0),
         COALESCE(m.base_price, 0),
         COALESCE(m.base_price, 0) - COALESCE(rc.cost, 0),
         CASE WHEN COALESCE(m.base_price, 0) > 0
              THEN ((COALESCE(m.base_price, 0) - COALESCE(rc.cost, 0)) / m.base_price) * 100 ELSE 0 END,
         COALESCE((SELECT SUM(oi.quantity) FROM pos_order_items oi
                    WHERE oi.menu_item_id = m.id AND oi.created_at >= now() - interval '30 days'), 0)
    FROM menu_items m
    LEFT JOIN rc ON rc.menu_item_id = m.id
   WHERE m.organization_id = current_org_id()
   ORDER BY 7 DESC NULLS LAST;
$function$;

-- 4. Check-out requires a settled folio before the room is released ---------
CREATE OR REPLACE FUNCTION public.pms_check_out(_reservation uuid, _notes text DEFAULT ''::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  _org uuid := public.current_org_id();
  _res public.reservations; _stay public.stays; _folio record; _balance numeric := 0;
BEGIN
  IF NOT public.has_permission('pms','checkout.perform') THEN
    RAISE EXCEPTION 'Not permitted to check out guests';
  END IF;
  SELECT * INTO _res FROM public.reservations WHERE id=_reservation AND organization_id=_org FOR UPDATE;
  IF _res.id IS NULL THEN RAISE EXCEPTION 'Reservation not found'; END IF;

  SELECT * INTO _stay FROM public.stays WHERE reservation_id=_reservation ORDER BY created_at DESC LIMIT 1;
  IF _stay.id IS NULL THEN RAISE EXCEPTION 'This reservation has no active stay to check out'; END IF;
  IF _stay.checked_out_at IS NOT NULL THEN
    RETURN jsonb_build_object('stay_id',_stay.id,'idempotent',true);
  END IF;

  -- Folio settlement is mandatory. The balance is recomputed from posted folio
  -- lines so a stale cached total can never release an unpaid room.
  FOR _folio IN
    SELECT f.id, f.folio_number,
           COALESCE((SELECT SUM(l.net_amount) FROM public.folio_lines l
                      WHERE l.folio_id = f.id AND COALESCE(l.status,'posted') <> 'void'), 0) AS computed
      FROM public.folios f
     WHERE f.stay_id = _stay.id
  LOOP
    _balance := _balance + COALESCE(_folio.computed, 0);
  END LOOP;

  IF round(_balance, 2) <> 0 THEN
    RAISE EXCEPTION 'Folio is not settled — outstanding balance %. Settle the bill before check-out.', round(_balance, 2);
  END IF;

  UPDATE public.folios SET status='closed', closed_at=now(), balance=0, updated_at=now()
   WHERE stay_id=_stay.id AND COALESCE(status,'open') <> 'closed';

  UPDATE public.stays SET status='checked-out', checked_out_at=now(), checked_out_by=auth.uid(), updated_at=now()
   WHERE id=_stay.id;

  -- Releases the room and raises the departure clean via the existing trigger.
  UPDATE public.reservations SET status='checked-out', updated_at=now() WHERE id=_reservation;

  INSERT INTO public.pms_workflow_events (organization_id, branch_id, event_type, reservation_id, stay_id, idempotency_key, created_by)
  VALUES (_org, _res.branch_id, 'guest.checked-out', _reservation, _stay.id, 'checkout:' || _reservation::text, auth.uid())
  ON CONFLICT DO NOTHING;

  INSERT INTO public.audit_logs (organization_id, user_id, user_name, action, module, record_id, new_value, reason)
  VALUES (_org, auth.uid(), '', 'pms.checkout', 'front-office', _reservation::text,
    jsonb_build_object('stay_id',_stay.id,'settled',true), _notes);

  RETURN jsonb_build_object('stay_id',_stay.id,'settled',true,'idempotent',false);
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.pms_check_out(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.pms_check_out(uuid, text) TO authenticated;

-- 5. Availability guard: no overlapping room assignment --------------------
CREATE OR REPLACE FUNCTION public.pms_guard_room_availability()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE _clash text;
BEGIN
  IF NEW.room_id IS NULL THEN RETURN NEW; END IF;
  IF lower(COALESCE(NEW.status,'')) IN ('cancelled','no-show','checked-out') THEN RETURN NEW; END IF;
  IF TG_OP = 'UPDATE'
     AND COALESCE(OLD.room_id::text,'') = COALESCE(NEW.room_id::text,'')
     AND OLD.arrival_date = NEW.arrival_date
     AND OLD.departure_date = NEW.departure_date THEN
    RETURN NEW;
  END IF;

  SELECT r.confirmation_number INTO _clash
    FROM public.reservations r
   WHERE r.organization_id = NEW.organization_id
     AND r.room_id = NEW.room_id
     AND r.id <> NEW.id
     AND lower(COALESCE(r.status,'')) NOT IN ('cancelled','no-show','checked-out')
     AND r.arrival_date < NEW.departure_date
     AND r.departure_date > NEW.arrival_date
   LIMIT 1;

  IF _clash IS NOT NULL THEN
    RAISE EXCEPTION 'Room is already booked for these dates (reservation %).', _clash;
  END IF;
  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS pms_reservations_availability_guard ON public.reservations;
CREATE TRIGGER pms_reservations_availability_guard
BEFORE INSERT OR UPDATE OF room_id, arrival_date, departure_date, status ON public.reservations
FOR EACH ROW EXECUTE FUNCTION public.pms_guard_room_availability();
