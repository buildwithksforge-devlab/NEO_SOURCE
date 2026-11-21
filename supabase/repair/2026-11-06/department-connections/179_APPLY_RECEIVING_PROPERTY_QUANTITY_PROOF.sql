BEGIN;
DO $guard$ DECLARE mismatch boolean; BEGIN WITH expected(signature,hash) AS(VALUES ('public.inventory_post_receipt(uuid)','22e93cebfc2501c493350657695a4c86'),('public.neo_stores_receive_goods(uuid,uuid,jsonb,uuid,text,text,text,text)','8da681dbdabc43053a2ea7f65206d909')) SELECT bool_or(md5(pg_get_functiondef(to_regprocedure(signature))) IS DISTINCT FROM hash) INTO mismatch FROM expected; IF mismatch OR to_regprocedure('public.neo_connection_journal_matches(uuid,uuid,uuid,text,numeric,text,uuid)') IS NULL THEN RAISE EXCEPTION 'Receiving prerequisites changed or repair exists; inspect or use postcheck'; END IF; END $guard$;
CREATE OR REPLACE FUNCTION public.neo_stores_receive_goods(_order uuid, _location uuid, _lines jsonb, _attempt uuid, _notes text DEFAULT NULL::text, _over_receipt_reason text DEFAULT NULL::text, _delivery_note text DEFAULT NULL::text, _supplier_invoice text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE _org uuid := public.current_org_id(); _p record; _line jsonb; _pl record;
        _grn uuid; _number text; _prior jsonb; _count integer := 0;
        _hash text; _qty numeric; _outstanding numeric; _lreason text; _post jsonb; _partial boolean := false;
BEGIN
  IF auth.uid() IS NULL OR public.current_access_scope() IS NULL OR public.current_access_scope()='technical' THEN RAISE EXCEPTION 'Authorised staff context required' USING ERRCODE='42501'; END IF;
  IF _org IS NULL THEN RAISE EXCEPTION 'no_organisation' USING ERRCODE='42501'; END IF;
  IF _attempt IS NULL THEN RAISE EXCEPTION 'attempt_key_required' USING ERRCODE='22023'; END IF;

  IF NOT (public.has_permission('procurement','receiving.manage')
          OR public.has_permission('procurement','receiving.create')
          OR public.is_org_admin()) THEN
    RAISE EXCEPTION 'insufficient_privilege' USING ERRCODE='42501';
  END IF;

  SELECT * INTO _p FROM public.purchase_orders WHERE id=_order AND organization_id=_org FOR UPDATE;
  IF _p IS NULL THEN RAISE EXCEPTION 'order_not_found' USING ERRCODE='22023'; END IF;
  IF NOT public.neo_branch_in_scope(_p.branch_id) THEN RAISE EXCEPTION 'branch_out_of_scope' USING ERRCODE='42501'; END IF;
  IF _lines IS NULL OR jsonb_typeof(_lines)<>'array' OR jsonb_array_length(_lines)=0 THEN RAISE EXCEPTION 'no_receipt_lines'; END IF;
  _hash:=md5(jsonb_build_object('order',_order,'location',_location,'lines',_lines,'notes',_notes,'over_receipt_reason',_over_receipt_reason,'delivery_note',_delivery_note,'supplier_invoice',_supplier_invoice)::text);
  PERFORM pg_advisory_xact_lock(hashtextextended('goods.receive:'||_org::text||':'||_attempt::text,7));
  SELECT result INTO _prior FROM public.procurement_attempts WHERE organization_id=_org AND action='goods.receive' AND attempt_key=_attempt;
  IF _prior IS NOT NULL THEN
   IF _prior->>'request_hash' IS DISTINCT FROM _hash THEN RAISE EXCEPTION 'Receipt attempt differs or is legacy; review the saved GRN before receiving again'; END IF;
   IF NOT EXISTS(SELECT 1 FROM public.goods_receipts r WHERE r.id=(_prior->>'receipt_id')::uuid AND r.organization_id=_org AND r.order_id=_order AND r.branch_id IS NOT DISTINCT FROM _p.branch_id AND r.location_id IS NOT DISTINCT FROM _location) THEN RAISE EXCEPTION 'Saved receipt evidence needs review'; END IF;
   RETURN _prior||jsonb_build_object('replayed',true);
  END IF;
  IF _p.status NOT IN ('approved','pending-delivery','sent','partially-received','partially_received') THEN
    RAISE EXCEPTION 'order_not_receivable' USING ERRCODE='22023';
  END IF;
  IF _location IS NULL OR NOT EXISTS (
      SELECT 1 FROM public.stock_locations sl WHERE sl.id=_location AND sl.organization_id=_org AND sl.active AND sl.branch_id IS NOT DISTINCT FROM _p.branch_id) THEN
    RAISE EXCEPTION 'store_location_required' USING ERRCODE='22023';
  END IF;
  IF _lines IS NULL OR jsonb_array_length(_lines) = 0 THEN
    RAISE EXCEPTION 'no_receipt_lines' USING ERRCODE='22023';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended('grn:'||_order::text, 7));

  IF (SELECT count(*) FROM jsonb_array_elements(_lines))<>(SELECT count(DISTINCT x->>'order_line_id') FROM jsonb_array_elements(_lines) x) THEN RAISE EXCEPTION 'Each purchase order line may appear only once in a receipt'; END IF;
  _number := public.next_document_number('goods_receipt','GRN', _p.branch_id);
  INSERT INTO public.goods_receipts (organization_id, branch_id, order_id, supplier_id, location_id,
    grn_number, status, received_at, received_by, notes, delivery_note_number, supplier_invoice_number)
  VALUES (_org, _p.branch_id, _order, _p.supplier_id, _location, _number, 'received', now(), auth.uid(),
          _notes, nullif(btrim(coalesce(_delivery_note,'')),''), nullif(btrim(coalesce(_supplier_invoice,'')),''))
  RETURNING id INTO _grn;

  FOR _line IN SELECT * FROM jsonb_array_elements(_lines) LOOP
    SELECT * INTO _pl FROM public.purchase_order_lines
     WHERE id = (_line->>'order_line_id')::uuid AND order_id = _order AND organization_id=_org FOR UPDATE;
    IF _pl IS NULL THEN RAISE EXCEPTION 'order_line_not_on_order' USING ERRCODE='22023'; END IF;

    _qty := COALESCE((_line->>'quantity_received')::numeric, 0);
    IF _qty::text IN ('NaN','Infinity','-Infinity') OR _qty<=0 OR coalesce((_line->>'quantity_rejected')::numeric,0)<0 OR coalesce((_line->>'quantity_damaged')::numeric,0)<0 OR coalesce((_line->>'quantity_rejected')::numeric,0)::text IN ('NaN','Infinity','-Infinity') OR coalesce((_line->>'quantity_damaged')::numeric,0)::text IN ('NaN','Infinity','-Infinity') OR coalesce((_line->>'quantity_rejected')::numeric,0)+coalesce((_line->>'quantity_damaged')::numeric,0)>_qty THEN RAISE EXCEPTION 'Receipt quantities must be finite, positive and internally consistent'; END IF;
    IF nullif(_line->>'unit','') IS NOT NULL AND (_line->>'unit') IS DISTINCT FROM _pl.unit THEN RAISE EXCEPTION 'Receive in the purchase order unit; convert through the stock unit mapping'; END IF;
    IF nullif(_line->>'location_id','') IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.stock_locations sl WHERE sl.id=(_line->>'location_id')::uuid AND sl.organization_id=_org AND sl.active AND sl.branch_id IS NOT DISTINCT FROM _p.branch_id) THEN RAISE EXCEPTION 'Receipt line store is outside the order property'; END IF;
    IF _pl.unit_price IS NULL OR _pl.unit_price<0 OR _pl.unit_price::text IN ('NaN','Infinity','-Infinity') OR _pl.quantity IS NULL OR _pl.quantity::text IN ('NaN','Infinity','-Infinity') THEN RAISE EXCEPTION 'Purchase order quantity or price needs review'; END IF;

    _lreason := nullif(btrim(coalesce(_line->>'over_receipt_reason', _over_receipt_reason, '')), '');

    _outstanding := COALESCE(_pl.quantity,0) - COALESCE(_pl.cancelled_quantity,0) - COALESCE(_pl.received_quantity,0);
    IF _qty > _outstanding + 0.0001 THEN
      RAISE EXCEPTION 'over_receipt_refused: % outstanding on this line, % offered', _outstanding, _qty
        USING ERRCODE='23514';
    END IF;

    INSERT INTO public.goods_receipt_lines (organization_id, receipt_id, order_line_id, stock_item_id,
      quantity_ordered, quantity_previously_received, quantity_received, quantity_rejected, quantity_damaged,
      quantity_accepted, unit, unit_price, batch_number, expiry_date, location_id, notes,
      rejection_reason, over_receipt_reason)
    VALUES (_org, _grn, _pl.id, _pl.stock_item_id, _pl.quantity, COALESCE(_pl.received_quantity,0), _qty,
      COALESCE((_line->>'quantity_rejected')::numeric,0), COALESCE((_line->>'quantity_damaged')::numeric,0),
      GREATEST(_qty - COALESCE((_line->>'quantity_rejected')::numeric,0)
                    - COALESCE((_line->>'quantity_damaged')::numeric,0), 0),
      COALESCE(_line->>'unit', _pl.unit), _pl.unit_price,
      nullif(_line->>'batch_number',''), (nullif(_line->>'expiry_date',''))::date,
      COALESCE((nullif(_line->>'location_id',''))::uuid, _location), nullif(_line->>'notes',''),
      nullif(btrim(coalesce(_line->>'rejection_reason','')),''),
      CASE WHEN _qty > _outstanding + 0.0001 THEN _lreason ELSE NULL END);
    _count := _count + 1;
  END LOOP;

  IF _count = 0 THEN RAISE EXCEPTION 'no_receipt_lines' USING ERRCODE='22023'; END IF;

  _post := public.inventory_post_receipt(_grn);

  SELECT EXISTS (
    SELECT 1 FROM public.purchase_order_lines pl
     WHERE pl.order_id=_order
       AND COALESCE(pl.accepted_quantity,0) + COALESCE(pl.cancelled_quantity,0) < pl.quantity
  ) INTO _partial;
  UPDATE public.goods_receipts SET is_partial=_partial WHERE id=_grn;

  _prior := jsonb_build_object('ok',true,'receipt_id',_grn,'grn_number',_number,
              'lines',_count,'posting',_post,'partial',_partial,'request_hash',_hash,'finance_pending',coalesce(_post->>'status','')='pending-finance',
              'order_status',(SELECT status FROM public.purchase_orders WHERE id=_order));
  INSERT INTO public.procurement_attempts (organization_id, action, attempt_key, record_id, result)
  VALUES (_org,'goods.receive',_attempt,_grn,_prior);
  RETURN _prior;
END $function$
;

CREATE OR REPLACE FUNCTION public.inventory_post_receipt(_receipt uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE v_org uuid:=current_org_id(); r record; l record; v_total numeric:=0; v_lines integer:=0; v_accepted numeric; v_err text; v_currency text; v_journal uuid;
BEGIN
 IF auth.uid() IS NULL OR public.current_access_scope() IS NULL OR public.current_access_scope()='technical' THEN RAISE EXCEPTION 'Authorised staff context required' USING ERRCODE='42501'; END IF;
 IF NOT (
            public.has_permission('procurement','receiving.manage')
            OR public.has_permission('procurement','receiving.create')
            OR public.is_org_admin()
        ) THEN RAISE EXCEPTION 'Not permitted to receive stock'; END IF;
 SELECT * INTO r FROM goods_receipts WHERE id=_receipt AND organization_id=v_org FOR UPDATE;
 IF r IS NULL THEN RAISE EXCEPTION 'Receipt not found'; END IF;
 IF r.branch_id IS NULL OR NOT coalesce(public.neo_branch_in_scope(r.branch_id),false) THEN RAISE EXCEPTION 'Receipt outside authorised property' USING ERRCODE='42501'; END IF;
 IF NOT EXISTS(SELECT 1 FROM public.stock_locations sl WHERE sl.id=r.location_id AND sl.organization_id=v_org AND sl.branch_id IS NOT DISTINCT FROM r.branch_id AND sl.active) THEN RAISE EXCEPTION 'Receipt store is outside the receipt property'; END IF;
 v_currency:=coalesce((SELECT currency FROM public.purchase_orders WHERE id=r.order_id AND organization_id=v_org),public.neo_fact_currency(v_org,r.branch_id));
 IF r.status='posted' AND r.accrual_journal_id IS NOT NULL AND public.neo_connection_journal_matches(r.accrual_journal_id,v_org,r.branch_id,v_currency,r.total_value,'goods_receipt:accrual',_receipt) THEN RETURN jsonb_build_object('status','already-posted','journal_id',r.accrual_journal_id); END IF;
 IF r.status NOT IN ('received','draft','posted') THEN RAISE EXCEPTION 'Receipt cannot post from its current state'; END IF;
 IF r.order_id IS NOT NULL THEN PERFORM 1 FROM public.purchase_orders po WHERE po.id=r.order_id AND po.organization_id=v_org AND po.branch_id IS NOT DISTINCT FROM r.branch_id AND (r.status='posted' OR po.status IN ('approved','pending-delivery','sent','partially-received','partially_received')) FOR UPDATE; IF NOT FOUND THEN RAISE EXCEPTION 'Receipt purchase order property needs review'; END IF; END IF;
 IF r.status<>'posted' THEN
  IF NOT EXISTS(SELECT 1 FROM public.goods_receipt_lines WHERE receipt_id=_receipt AND organization_id=v_org) THEN RAISE EXCEPTION 'Receipt has no lines'; END IF;
  FOR l IN SELECT * FROM goods_receipt_lines WHERE receipt_id=_receipt FOR UPDATE LOOP
   IF l.organization_id IS DISTINCT FROM v_org THEN RAISE EXCEPTION 'Receipt line belongs to another organisation'; END IF;
   IF NOT EXISTS(SELECT 1 FROM public.stock_locations sl WHERE sl.id=coalesce(l.location_id,r.location_id) AND sl.organization_id=v_org AND sl.branch_id IS NOT DISTINCT FROM r.branch_id AND sl.active) THEN RAISE EXCEPTION 'Receipt line store is outside the receipt property'; END IF;
   v_accepted:=COALESCE(l.quantity_accepted,GREATEST(COALESCE(l.quantity_received,0)-COALESCE(l.quantity_rejected,0)-COALESCE(l.quantity_damaged,0)-COALESCE(l.quantity_returned,0),0));
   IF l.quantity_received IS NULL OR l.quantity_received<=0 OR l.quantity_received::text IN ('NaN','Infinity','-Infinity') OR v_accepted<0 OR v_accepted::text IN ('NaN','Infinity','-Infinity') OR coalesce(l.quantity_rejected,0)<0 OR coalesce(l.quantity_damaged,0)<0 OR coalesce(l.quantity_returned,0)<0 OR coalesce(l.quantity_rejected,0)::text IN ('NaN','Infinity','-Infinity') OR coalesce(l.quantity_damaged,0)::text IN ('NaN','Infinity','-Infinity') OR coalesce(l.quantity_returned,0)::text IN ('NaN','Infinity','-Infinity') OR v_accepted+coalesce(l.quantity_rejected,0)+coalesce(l.quantity_damaged,0)+coalesce(l.quantity_returned,0)>l.quantity_received OR l.unit_price IS NULL OR l.unit_price<0 OR l.unit_price::text IN ('NaN','Infinity','-Infinity') THEN RAISE EXCEPTION 'Receipt quantities or price are not finite and consistent'; END IF;
   IF l.order_line_id IS NOT NULL THEN
    PERFORM 1 FROM public.purchase_order_lines pl WHERE pl.id=l.order_line_id AND pl.order_id=r.order_id AND pl.organization_id=v_org AND pl.stock_item_id IS NOT DISTINCT FROM l.stock_item_id AND pl.unit IS NOT DISTINCT FROM l.unit AND pl.quantity>=coalesce(pl.received_quantity,0)+coalesce(pl.cancelled_quantity,0)+l.quantity_received FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Receipt line exceeds or differs from its purchase order'; END IF;
   END IF;
   IF v_accepted>0 THEN
    PERFORM inventory_apply_movement(l.stock_item_id,COALESCE(l.location_id,r.location_id),v_accepted,l.unit,'receipt',
      CASE WHEN l.unit_price>0 THEN l.unit_price/NULLIF(inventory_convert(1,l.unit,(SELECT base_unit FROM stock_items WHERE id=l.stock_item_id)),0) ELSE NULL END,
      'goods_receipt',_receipt,'Goods accepted','grn:'||_receipt::text||':'||l.id::text,l.batch_number,l.expiry_date);
    v_total:=v_total+(v_accepted*COALESCE(l.unit_price,0)); v_lines:=v_lines+1;
   END IF;
   IF l.order_line_id IS NOT NULL THEN UPDATE purchase_order_lines SET received_quantity=COALESCE(received_quantity,0)+COALESCE(l.quantity_received,0),accepted_quantity=COALESCE(accepted_quantity,0)+v_accepted,rejected_quantity=COALESCE(rejected_quantity,0)+COALESCE(l.quantity_rejected,0),returned_quantity=COALESCE(returned_quantity,0)+COALESCE(l.quantity_returned,0) WHERE id=l.order_line_id; END IF;
  END LOOP;
  UPDATE goods_receipts SET status='posted',posted_at=now(),total_value=v_total WHERE id=_receipt;
 ELSE v_total:=COALESCE(r.total_value,0); END IF;
 BEGIN
  PERFORM public.neo_grn_post_accrual(_receipt);
  SELECT accrual_journal_id INTO v_journal FROM public.goods_receipts WHERE id=_receipt AND organization_id=v_org;
  IF v_total>0 AND NOT public.neo_connection_journal_matches(v_journal,v_org,r.branch_id,v_currency,round(v_total,2),'goods_receipt:accrual',_receipt) THEN RAISE EXCEPTION 'Goods receipt accrual did not produce a matching posted journal'; END IF;
  UPDATE goods_receipts SET accrual_error=NULL WHERE id=_receipt;
 EXCEPTION WHEN OTHERS THEN
  v_err:=SQLERRM; UPDATE goods_receipts SET accrual_error=v_err WHERE id=_receipt;
  PERFORM public.neo_record_posting_receipt(v_org,r.branch_id,'inventory',_receipt,COALESCE(r.grn_number,_receipt::text),'failed',v_total,v_currency,NULL,'Goods receipt accrual',v_err,CURRENT_DATE);
 END;
 RETURN jsonb_build_object('status',CASE WHEN v_err IS NULL THEN 'posted' ELSE 'pending-finance' END,'lines',v_lines,'value',v_total,'finance_error',v_err);
END;
$function$
;

REVOKE ALL ON FUNCTION public.inventory_post_receipt(uuid) FROM PUBLIC,anon; GRANT EXECUTE ON FUNCTION public.inventory_post_receipt(uuid) TO authenticated;
REVOKE ALL ON FUNCTION public.neo_stores_receive_goods(uuid,uuid,jsonb,uuid,text,text,text,text) FROM PUBLIC,anon; GRANT EXECUTE ON FUNCTION public.neo_stores_receive_goods(uuid,uuid,jsonb,uuid,text,text,text,text) TO authenticated;
NOTIFY pgrst,'reload schema';
WITH expected(signature,hash) AS(VALUES ('public.inventory_post_receipt(uuid)','86bbb5119fea9f5f4954bf9fe7035d29'),('public.neo_stores_receive_goods(uuid,uuid,jsonb,uuid,text,text,text,text)','373ae1b84909eff55404e9579f943a79')),checked AS(SELECT signature,coalesce(md5(pg_get_functiondef(to_regprocedure(signature)))=hash,false) matches FROM expected) SELECT jsonb_build_object('diagnostic_version','receiving-property-quantity-proof-v1','definitions_match',(SELECT bool_and(matches) FROM checked),'definition_checks',(SELECT jsonb_agg(to_jsonb(checked)) FROM checked),'scope','Tightens two receipt commands: property and unit boundaries, finite accepted/rejected/damaged quantities, immutable attempt replay and verified accrual evidence. No GRN created, stock moved, order updated or historical receipt rewritten by installation.') result;
COMMIT;
