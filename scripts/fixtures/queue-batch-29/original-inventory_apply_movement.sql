CREATE OR REPLACE FUNCTION public.inventory_apply_movement(_item uuid, _location uuid, _quantity numeric, _unit text, _movement_type text, _unit_cost numeric DEFAULT NULL::numeric, _reference_type text DEFAULT NULL::text, _reference_id uuid DEFAULT NULL::uuid, _reason text DEFAULT NULL::text, _idempotency_key text DEFAULT NULL::text, _batch_number text DEFAULT NULL::text, _expiry date DEFAULT NULL::date)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_org uuid := current_org_id();
  v_item record;
  v_qty_base numeric;
  v_cost numeric;
  v_level record;
  v_batch uuid;
  v_movement uuid;
  v_existing uuid;
  v_available numeric;
  v_store text;
BEGIN
  IF v_org IS NULL THEN RAISE EXCEPTION 'No active organization'; END IF;
  IF NOT public.neo_system_posting()
     AND NOT (has_permission('inventory','stock.manage') OR has_permission('procurement','receiving.manage')) THEN
    RAISE EXCEPTION 'Not permitted to move stock';
  END IF;

  IF _idempotency_key IS NOT NULL THEN
    SELECT id INTO v_existing FROM stock_movements WHERE organization_id = v_org AND idempotency_key = _idempotency_key;
    IF v_existing IS NOT NULL THEN RETURN v_existing; END IF;
  END IF;

  SELECT * INTO v_item FROM stock_items WHERE id = _item AND organization_id = v_org;
  IF v_item IS NULL THEN RAISE EXCEPTION 'Unknown stock item'; END IF;

  v_qty_base := inventory_convert(_quantity, COALESCE(_unit, v_item.base_unit), v_item.base_unit);
  v_cost := COALESCE(_unit_cost, v_item.average_cost);

  INSERT INTO stock_levels (organization_id, stock_item_id, location_id, quantity_on_hand, last_movement_at)
  VALUES (v_org, _item, _location, 0, now())
  ON CONFLICT (stock_item_id, location_id) DO NOTHING;

  SELECT * INTO v_level FROM stock_levels WHERE stock_item_id = _item AND location_id = _location FOR UPDATE;

  -- Taking out more than is there creates impossible inventory. A count,
  -- adjustment or opening balance must still be able to state reality.
  IF v_qty_base < 0
     AND COALESCE(v_level.quantity_on_hand, 0) + v_qty_base < 0
     AND lower(COALESCE(_movement_type,'')) NOT IN
         ('count','stock_take','stock-take','adjustment','opening','opening_balance','variance','recount','correction')
     AND NOT public.neo_inventory_allows_negative(v_org, v_item.branch_id) THEN
    SELECT sl.name INTO v_store FROM stock_locations sl WHERE sl.id = _location;
    v_available := round(COALESCE(v_level.quantity_on_hand, 0), 4);
    RAISE EXCEPTION 'Not enough %: % % available in %, % % requested',
      v_item.name,
      trim(to_char(GREATEST(v_available,0), 'FM999999990.###')), v_item.base_unit,
      COALESCE(v_store, 'this store'),
      trim(to_char(abs(v_qty_base), 'FM999999990.###')), v_item.base_unit
      USING ERRCODE = 'check_violation';
  END IF;

  IF v_qty_base > 0 AND (v_item.track_batches OR _batch_number IS NOT NULL OR _expiry IS NOT NULL) THEN
    INSERT INTO stock_batches (organization_id, stock_item_id, location_id, batch_number, expiry_date, quantity, unit_cost)
    VALUES (v_org, _item, _location, _batch_number, _expiry, v_qty_base, v_cost)
    RETURNING id INTO v_batch;
  ELSIF v_qty_base < 0 THEN
    SELECT id INTO v_batch FROM stock_batches
      WHERE stock_item_id = _item AND location_id = _location AND quantity > 0 AND status = 'active'
      ORDER BY expiry_date NULLS LAST, received_at LIMIT 1;
    IF v_batch IS NOT NULL THEN
      UPDATE stock_batches SET quantity = GREATEST(0, quantity + v_qty_base) WHERE id = v_batch;
    END IF;
  END IF;

  UPDATE stock_levels
     SET quantity_on_hand = quantity_on_hand + v_qty_base,
         -- Reconciliation treats opening movements as the opening baseline.
         -- Keep that baseline in sync with the ledger in the same transaction.
         opening_balance = opening_balance + CASE
           WHEN lower(COALESCE(_movement_type, '')) = 'opening' THEN v_qty_base
           ELSE 0 END,
         quantity_damaged = quantity_damaged + CASE WHEN _movement_type = 'damage' THEN abs(v_qty_base) ELSE 0 END,
         quantity_expired = quantity_expired + CASE WHEN _movement_type = 'expiry' THEN abs(v_qty_base) ELSE 0 END,
         last_movement_at = now()
   WHERE id = v_level.id;

  IF v_qty_base > 0 AND _unit_cost IS NOT NULL THEN
    UPDATE stock_items
       SET last_cost = v_cost,
           average_cost = CASE
             WHEN COALESCE(v_level.quantity_on_hand, 0) + v_qty_base <= 0 THEN v_cost
             ELSE ((GREATEST(v_level.quantity_on_hand, 0) * average_cost) + (v_qty_base * v_cost))
                  / (GREATEST(v_level.quantity_on_hand, 0) + v_qty_base)
           END
     WHERE id = _item;
  END IF;

  INSERT INTO stock_movements (
    organization_id, branch_id, stock_item_id, location_id, batch_id, movement_type,
    quantity, unit, unit_cost, value, balance_after, reference_type, reference_id,
    reason, idempotency_key, performed_by
  ) VALUES (
    v_org, v_item.branch_id, _item, _location, v_batch, _movement_type,
    v_qty_base, v_item.base_unit, v_cost, v_qty_base * v_cost,
    (SELECT quantity_on_hand FROM stock_levels WHERE id = v_level.id),
    _reference_type, _reference_id, _reason, _idempotency_key, auth.uid()
  ) RETURNING id INTO v_movement;

  RETURN v_movement;
END;
$function$
;
