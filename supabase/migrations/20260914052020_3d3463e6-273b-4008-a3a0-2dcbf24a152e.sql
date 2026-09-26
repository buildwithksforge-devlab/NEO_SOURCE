CREATE OR REPLACE FUNCTION public.neo_pos_item_void_effect()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_event record; v_mv record; v_prepared boolean; v_branch uuid; v_waste_no text; v_cost numeric := 0;
  v_direct boolean;
BEGIN
  IF NEW.status NOT IN ('voided','cancelled') OR OLD.status = NEW.status THEN
    RETURN NEW;
  END IF;

  SELECT branch_id INTO v_branch FROM pos_orders WHERE id = NEW.order_id;

  SELECT EXISTS (
    SELECT 1 FROM recipes r
     WHERE r.organization_id = NEW.organization_id
       AND r.menu_item_id = NEW.menu_item_id
       AND r.recipe_type = 'direct_sale'
       AND r.status = 'active'
  ) INTO v_direct;

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
      'Prepared item voided — waste recorded for review');
    RETURN NEW;
  END IF;

  -- The reversal is the mirror image of a posted sale, so it posts on the same
  -- system footing the sale did; the void itself was already authorised.
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
    jsonb_build_object('reversed_value', v_cost, 'item', NEW.item_name, 'packaged', COALESCE(v_direct,false)),
    'Item voided — stock returned');
  RETURN NEW;
END;
$function$;