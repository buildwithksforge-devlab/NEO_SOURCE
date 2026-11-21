-- STAGED ONLY: future batch depletion, receipt conversion, retry and shared cost integrity.
-- No historical batch quantity, cost, movement, GRN or journal is recalculated by installation.
BEGIN;
DO $guard$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_proc p JOIN pg_roles r ON r.oid=p.proowner
 WHERE p.oid=to_regprocedure('public.inventory_apply_movement(uuid,uuid,numeric,text,text,numeric,text,uuid,text,text,text,date)') AND r.rolname NOT IN ('anon','authenticated')
 AND md5(regexp_replace(regexp_replace(p.prosrc,'--[^'||chr(10)||']*','','g'),'[[:space:]]','','g')) IN ('3a5d802eefecde073c67dc69298e4fb4','c693c3e210026d09ba21424837ad6604','50261c71841d646d7677bf9f1e5c07c2')) THEN
 RAISE EXCEPTION 'inventory_apply_movement differs from reviewed source; nothing replaced'; END IF;
END $guard$;
DO $guard$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_proc p JOIN pg_roles r ON r.oid=p.proowner
 WHERE p.oid=to_regprocedure('public.inventory_post_receipt(uuid)') AND r.rolname NOT IN ('anon','authenticated')
 AND md5(regexp_replace(regexp_replace(p.prosrc,'--[^'||chr(10)||']*','','g'),'[[:space:]]','','g')) IN ('20c0e36117337cda3c8697a7260d28e3','1bbc1f221d51047c001c4fc1748c25d4')) THEN
 RAISE EXCEPTION 'inventory_post_receipt differs from reviewed source; nothing replaced'; END IF;
END $guard$;
ALTER TABLE public.stock_movements ADD COLUMN IF NOT EXISTS batch_allocations jsonb NOT NULL DEFAULT '[]'::jsonb;
DO $column$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid='public.stock_movements'::regclass AND attname='batch_allocations' AND atttypid='jsonb'::regtype AND NOT attisdropped) THEN
 RAISE EXCEPTION 'Stock batch allocation column has an unexpected type'; END IF;
END $column$;
CREATE TEMP TABLE neo_batch_cost_acl ON COMMIT DROP AS SELECT oid,proowner,coalesce(proacl::text,'') acl FROM pg_proc
 WHERE oid IN ('public.inventory_apply_movement(uuid,uuid,numeric,text,text,numeric,text,uuid,text,text,text,date)'::regprocedure,'public.inventory_post_receipt(uuid)'::regprocedure);
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
  v_location record;
  v_prior record;
  v_batch_row record;
  v_remaining numeric;
  v_take numeric;
  v_global_onhand numeric;
  v_allocations jsonb := '[]'::jsonb;
BEGIN
  IF auth.uid() IS NULL OR v_org IS NULL THEN RAISE EXCEPTION 'No active organization'; END IF;
  IF NOT coalesce(public.neo_system_posting() OR has_permission('inventory','stock.manage') OR has_permission('procurement','receiving.manage'),false) THEN
    RAISE EXCEPTION 'Not permitted to move stock';
  END IF;

  IF _quantity IS NULL OR _quantity=0 OR _quantity::text IN ('NaN','Infinity','-Infinity')
     OR _unit_cost<0 OR _unit_cost::text IN ('NaN','Infinity','-Infinity') THEN
    RAISE EXCEPTION 'Stock movement requires finite nonzero quantity and nonnegative cost';
  END IF;
  SELECT * INTO v_location FROM public.stock_locations WHERE id=_location AND organization_id=v_org;
  IF v_location.id IS NULL OR v_location.active IS NOT TRUE OR v_location.branch_id IS NULL
     OR NOT coalesce(public.neo_branch_in_scope(v_location.branch_id),false) THEN
    RAISE EXCEPTION 'Stock location is not active in your authorized property' USING ERRCODE='42501';
  END IF;
  -- Serialize an item's movements across stores before calculating its shared average cost.
  SELECT * INTO v_item FROM public.stock_items WHERE id=_item AND organization_id=v_org FOR UPDATE;
  IF v_item.id IS NULL OR (v_item.branch_id IS NOT NULL AND v_item.branch_id<>v_location.branch_id) THEN
    RAISE EXCEPTION 'Stock item does not belong to this property' USING ERRCODE='42501';
  END IF;
  v_qty_base := public.inventory_convert_strict(_quantity,coalesce(nullif(btrim(_unit),''),v_item.base_unit),v_item.base_unit);
  IF v_qty_base IS NULL OR v_qty_base=0 OR v_qty_base::text IN ('NaN','Infinity','-Infinity') OR (v_qty_base>0)<>(_quantity>0) THEN
    RAISE EXCEPTION 'Stock unit conversion must produce a finite nonzero quantity';
  END IF;
  IF nullif(btrim(_movement_type),'') IS NULL THEN RAISE EXCEPTION 'Stock movement type is required'; END IF;
  IF _idempotency_key IS NOT NULL THEN
    PERFORM pg_advisory_xact_lock(hashtextextended(v_org::text||':movement:'||_idempotency_key,0));
    SELECT * INTO v_prior FROM public.stock_movements WHERE organization_id=v_org AND idempotency_key=_idempotency_key;
    IF v_prior.id IS NOT NULL THEN
      IF v_prior.stock_item_id IS DISTINCT FROM _item OR v_prior.location_id IS DISTINCT FROM _location
        OR v_prior.quantity IS DISTINCT FROM v_qty_base OR v_prior.movement_type IS DISTINCT FROM _movement_type
        OR (_unit_cost IS NOT NULL AND v_prior.unit_cost IS DISTINCT FROM _unit_cost)
        OR v_prior.reference_type IS DISTINCT FROM _reference_type OR v_prior.reference_id IS DISTINCT FROM _reference_id
        OR v_prior.reason IS DISTINCT FROM _reason
        OR (v_qty_base>0 AND v_prior.batch_id IS NULL AND (_batch_number IS NOT NULL OR _expiry IS NOT NULL))
        OR (v_qty_base>0 AND EXISTS(SELECT 1 FROM public.stock_batches saved WHERE saved.id=v_prior.batch_id
          AND (saved.batch_number IS DISTINCT FROM _batch_number OR saved.expiry_date IS DISTINCT FROM _expiry))) THEN
        RAISE EXCEPTION 'Stock movement identity belongs to different work';
      END IF;
      RETURN v_prior.id;
    END IF;
  END IF;
  v_cost := coalesce(_unit_cost,v_item.average_cost);
  IF v_cost<0 OR v_cost::text IN ('NaN','Infinity','-Infinity') THEN RAISE EXCEPTION 'Stock cost needs reconciliation'; END IF;
  SELECT coalesce(sum(greatest(quantity_on_hand,0)),0) INTO v_global_onhand FROM public.stock_levels
    WHERE stock_item_id=_item AND organization_id=v_org;
  IF v_global_onhand::text IN ('NaN','Infinity','-Infinity') THEN RAISE EXCEPTION 'Stock balances need reconciliation'; END IF;
  IF v_qty_base>0 AND _unit_cost IS NOT NULL AND v_global_onhand>0 AND v_item.average_cost IS NULL THEN
    RAISE EXCEPTION 'Existing stock cost needs reconciliation before receiving more stock';
  END IF;

  INSERT INTO stock_levels (organization_id, stock_item_id, location_id, quantity_on_hand, last_movement_at)
  VALUES (v_org, _item, _location, 0, now())
  ON CONFLICT (stock_item_id, location_id) DO NOTHING;

  SELECT * INTO v_level FROM stock_levels WHERE stock_item_id = _item AND location_id = _location FOR UPDATE;
  IF v_level.organization_id IS DISTINCT FROM v_org OR v_level.quantity_on_hand IS NULL
    OR v_level.quantity_on_hand::text IN ('NaN','Infinity','-Infinity') THEN
    RAISE EXCEPTION 'Store stock balance ownership or quantity needs reconciliation';
  END IF;

  -- Taking out more than is there creates impossible inventory. A count,
  -- adjustment or opening balance must still be able to state reality.
  IF v_qty_base < 0
     AND COALESCE(v_level.quantity_on_hand, 0) + v_qty_base < 0
     AND lower(COALESCE(_movement_type,'')) NOT IN
         ('count','stock_take','stock-take','adjustment','opening','opening_balance','variance','recount','correction')
     AND NOT public.neo_inventory_allows_negative(v_org, v_location.branch_id) THEN
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
    INSERT INTO stock_batches(organization_id,stock_item_id,location_id,batch_number,expiry_date,quantity,unit_cost)
    VALUES(v_org,_item,_location,_batch_number,_expiry,v_qty_base,v_cost) RETURNING id INTO v_batch;
    v_allocations:=jsonb_build_array(jsonb_build_object('batch_id',v_batch,'quantity',v_qty_base,'batch_number',_batch_number,'expiry_date',_expiry));
  ELSIF v_qty_base < 0 THEN
    IF EXISTS(SELECT 1 FROM public.stock_batches WHERE organization_id=v_org AND stock_item_id=_item AND location_id=_location
      AND status='active' AND (quantity IS NULL OR quantity<0 OR quantity::text IN ('NaN','Infinity','-Infinity'))) THEN
      RAISE EXCEPTION 'Batch quantities need reconciliation';
    END IF;
    v_remaining:=abs(v_qty_base);
    FOR v_batch_row IN SELECT * FROM public.stock_batches
      WHERE organization_id=v_org AND stock_item_id=_item AND location_id=_location AND quantity>0 AND status='active'
      ORDER BY expiry_date NULLS LAST,received_at,id FOR UPDATE LOOP
      v_take:=least(v_remaining,v_batch_row.quantity);
      UPDATE public.stock_batches SET quantity=quantity-v_take WHERE id=v_batch_row.id;
      v_allocations:=v_allocations||jsonb_build_array(jsonb_build_object('batch_id',v_batch_row.id,'quantity',-v_take,'batch_number',v_batch_row.batch_number,'expiry_date',v_batch_row.expiry_date));
      v_remaining:=v_remaining-v_take;
      EXIT WHEN v_remaining=0;
    END LOOP;
    IF v_remaining>0 AND v_item.track_batches THEN
      RAISE EXCEPTION 'Batch balances do not cover this stock movement; reconcile batches before issuing';
    END IF;
    IF v_remaining>0 THEN
      v_allocations:=v_allocations||jsonb_build_array(jsonb_build_object('batch_id',null,'quantity',-v_remaining));
    END IF;
    IF jsonb_array_length(v_allocations)=1 THEN v_batch:=nullif(v_allocations->0->>'batch_id','')::uuid; END IF;
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
             WHEN v_global_onhand + v_qty_base <= 0 THEN v_cost
             ELSE ((v_global_onhand * coalesce(average_cost,0)) + (v_qty_base * v_cost)) / (v_global_onhand + v_qty_base)
           END
     WHERE id = _item;
  END IF;

  INSERT INTO stock_movements (
    organization_id, branch_id, stock_item_id, location_id, batch_id, movement_type,
    quantity, unit, unit_cost, value, balance_after, reference_type, reference_id,
    reason, idempotency_key, performed_by, batch_allocations
  ) VALUES (
    v_org, v_location.branch_id, _item, _location, v_batch, _movement_type,
    v_qty_base, v_item.base_unit, v_cost, v_qty_base * v_cost,
    (SELECT quantity_on_hand FROM stock_levels WHERE id = v_level.id),
    _reference_type, _reference_id, _reason, _idempotency_key, auth.uid(), v_allocations
  ) RETURNING id INTO v_movement;

  RETURN v_movement;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.inventory_post_receipt(_receipt uuid)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE v_org uuid:=current_org_id(); r record; l record; v_total numeric:=0; v_lines integer:=0; v_accepted numeric; v_err text;
BEGIN
 IF auth.uid() IS NULL OR NOT coalesce(has_permission('procurement','receiving.manage'),false) THEN RAISE EXCEPTION 'Not permitted to receive stock'; END IF;
 SELECT * INTO r FROM goods_receipts WHERE id=_receipt AND organization_id=v_org FOR UPDATE;
 IF r IS NULL THEN RAISE EXCEPTION 'Receipt not found'; END IF;
 IF NOT coalesce(public.neo_branch_in_scope(r.branch_id),false) THEN RAISE EXCEPTION 'Receipt outside authorized property'; END IF;
 IF r.status IS NULL OR r.status NOT IN ('received','approved','posted') THEN RAISE EXCEPTION 'Receipt is not approved for stock posting'; END IF;
 IF r.status='posted' AND r.accrual_journal_id IS NOT NULL THEN RETURN jsonb_build_object('status','already-posted','journal_id',r.accrual_journal_id); END IF;
 IF r.status<>'posted' THEN
  FOR l IN SELECT * FROM goods_receipt_lines WHERE receipt_id=_receipt LOOP
   v_accepted:=COALESCE(l.quantity_accepted,GREATEST(COALESCE(l.quantity_received,0)-COALESCE(l.quantity_rejected,0)-COALESCE(l.quantity_damaged,0)-COALESCE(l.quantity_returned,0),0));
   IF EXISTS(SELECT 1 FROM unnest(ARRAY[l.quantity_received,l.quantity_rejected,l.quantity_damaged,l.quantity_returned]) q
       WHERE q<0 OR q::text IN ('NaN','Infinity','-Infinity'))
     OR l.organization_id IS DISTINCT FROM v_org
     OR v_accepted IS NULL OR v_accepted<0 OR v_accepted::text IN ('NaN','Infinity','-Infinity')
     OR l.unit_price IS NULL OR l.unit_price<0 OR l.unit_price::text IN ('NaN','Infinity','-Infinity')
     OR v_accepted>coalesce(l.quantity_received,0)-coalesce(l.quantity_rejected,0)-coalesce(l.quantity_damaged,0)-coalesce(l.quantity_returned,0) THEN
     RAISE EXCEPTION 'Receipt accepted quantities and cost need reconciliation';
   END IF;
   IF l.order_line_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.purchase_order_lines pl
     WHERE pl.id=l.order_line_id AND pl.order_id=r.order_id AND pl.stock_item_id=l.stock_item_id
       AND lower(btrim(pl.unit))=lower(btrim(l.unit))) THEN
     RAISE EXCEPTION 'Receipt line item or unit differs from its original purchase line';
   END IF;
   IF v_accepted>0 THEN
    PERFORM inventory_apply_movement(l.stock_item_id,COALESCE(l.location_id,r.location_id),v_accepted,l.unit,'receipt',
      l.unit_price/NULLIF(public.inventory_convert_strict(1,l.unit,(SELECT base_unit FROM stock_items WHERE id=l.stock_item_id)),0),
      'goods_receipt',_receipt,'Goods accepted','grn:'||_receipt::text||':'||l.id::text,l.batch_number,l.expiry_date);
    v_total:=v_total+(v_accepted*COALESCE(l.unit_price,0)); v_lines:=v_lines+1;
   END IF;
   IF l.order_line_id IS NOT NULL THEN UPDATE purchase_order_lines SET received_quantity=COALESCE(received_quantity,0)+COALESCE(l.quantity_received,0),accepted_quantity=COALESCE(accepted_quantity,0)+v_accepted,rejected_quantity=COALESCE(rejected_quantity,0)+COALESCE(l.quantity_rejected,0),returned_quantity=COALESCE(returned_quantity,0)+COALESCE(l.quantity_returned,0) WHERE id=l.order_line_id; END IF;
  END LOOP;
  UPDATE goods_receipts SET status='posted',posted_at=now(),total_value=v_total WHERE id=_receipt;
 ELSE v_total:=COALESCE(r.total_value,0); END IF;
 BEGIN
  PERFORM public.neo_grn_post_accrual(_receipt);
  UPDATE goods_receipts SET accrual_error=NULL WHERE id=_receipt;
 EXCEPTION WHEN OTHERS THEN
  v_err:=SQLERRM; UPDATE goods_receipts SET accrual_error=v_err WHERE id=_receipt;
  PERFORM public.neo_record_posting_receipt(v_org,r.branch_id,'inventory',_receipt,COALESCE(r.grn_number,_receipt::text),'failed',v_total,'KES',NULL,'Goods receipt accrual',v_err,CURRENT_DATE);
 END;
 RETURN jsonb_build_object('status',CASE WHEN v_err IS NULL THEN 'posted' ELSE 'pending-finance' END,'lines',v_lines,'value',v_total,'finance_error',v_err);
END;
$function$;
DO $verify$ BEGIN
 IF EXISTS(SELECT 1 FROM neo_batch_cost_acl old LEFT JOIN pg_proc p ON p.oid=old.oid WHERE p.oid IS NULL OR p.proowner<>old.proowner OR coalesce(p.proacl::text,'')<>old.acl) THEN
 RAISE EXCEPTION 'Inventory movement/receipt owner or grants changed'; END IF;
END $verify$;
COMMIT;
