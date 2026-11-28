-- Upgrade environments that already recorded the original clerk-owned GRN version.
BEGIN;
DO $guard$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p
    WHERE p.oid = to_regprocedure('public.neo_receiving_post_receipt_internal(uuid)')
      AND p.prosecdef
      AND md5(replace(p.prosrc, chr(13)||chr(10), chr(10))) = ANY(ARRAY['88942e02590968c978ca9e28ce98c2ab','59ffb83f0d54333aa0bbbdfc62b486cc','daaf3e2e497dbc1b06ec5c69c64f7f70','b194cc9d490c90c4b042c7090fe0bf03','8e517246600878edf6b2e93114153283'])
  ) THEN
    RAISE EXCEPTION 'Unreviewed receiving function: public.neo_receiving_post_receipt_internal(uuid)';
  END IF;
END;
$guard$;

CREATE OR REPLACE FUNCTION public.neo_receiving_post_receipt_internal(_receipt uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE v_org uuid:=current_org_id(); r record; l record; v_total numeric:=0; v_lines integer:=0; v_accepted numeric; v_err text; v_currency text; v_journal uuid; v_prior_posting text;
BEGIN
 IF auth.uid() IS NULL OR public.current_access_scope() IS NULL OR public.current_access_scope()='technical' THEN RAISE EXCEPTION 'Authorised staff context required' USING ERRCODE='42501'; END IF;
 SELECT * INTO r FROM goods_receipts WHERE id=_receipt AND organization_id=v_org FOR UPDATE;
 IF r IS NULL THEN RAISE EXCEPTION 'Receipt not found'; END IF;
 IF NOT coalesce(public.has_permission('procurement','receiving.manage'),false)
    AND NOT (r.received_by IS NOT DISTINCT FROM auth.uid()
      AND public.has_permission('procurement','receiving','create') IS TRUE
      AND EXISTS (SELECT 1 FROM public.neo_blind_receiving_counts c
        WHERE c.organization_id=v_org AND c.branch_id=r.branch_id AND c.purchase_order_id=r.order_id
          AND c.supplier_delivery_note=r.delivery_note_number AND c.status='approved'
          AND c.submitted_by=auth.uid() AND c.reviewed_by IS DISTINCT FROM auth.uid()
          AND c.reviewed_by IS NOT NULL AND c.reviewed_at IS NOT NULL
          AND c.posted_grn_id IS NULL)
    ) THEN RAISE EXCEPTION 'Not permitted to receive stock' USING ERRCODE='42501';
 END IF;
 IF r.branch_id IS NULL OR NOT coalesce(public.neo_branch_in_scope(r.branch_id),false) THEN RAISE EXCEPTION 'Receipt outside authorised property' USING ERRCODE='42501'; END IF;
 IF NOT EXISTS(SELECT 1 FROM public.stock_locations sl WHERE sl.id=r.location_id AND sl.organization_id=v_org AND sl.branch_id IS NOT DISTINCT FROM r.branch_id AND sl.active) THEN RAISE EXCEPTION 'Receipt store is outside the receipt property'; END IF;
 v_currency:=coalesce((SELECT currency FROM public.purchase_orders WHERE id=r.order_id AND organization_id=v_org),public.neo_fact_currency(v_org,r.branch_id));
 IF r.status='posted' AND r.accrual_journal_id IS NOT NULL AND public.neo_connection_journal_matches(r.accrual_journal_id,v_org,r.branch_id,v_currency,r.total_value,'goods_receipt:accrual',_receipt) THEN RETURN jsonb_build_object('status','already-posted','journal_id',r.accrual_journal_id); END IF;
 IF r.status IS NULL OR r.status NOT IN ('received','approved','posted') THEN RAISE EXCEPTION 'Receipt cannot post from its current state'; END IF;
 IF r.order_id IS NOT NULL THEN PERFORM 1 FROM public.purchase_orders po WHERE po.id=r.order_id AND po.organization_id=v_org AND po.branch_id IS NOT DISTINCT FROM r.branch_id AND (r.status='posted' OR po.status IN ('approved','pending-delivery','sent','partially-received','partially_received')) FOR UPDATE; IF NOT FOUND THEN RAISE EXCEPTION 'Receipt purchase order property needs review'; END IF; END IF;
 IF r.status<>'posted' THEN
  IF NOT EXISTS(SELECT 1 FROM public.goods_receipt_lines WHERE receipt_id=_receipt AND organization_id=v_org) THEN RAISE EXCEPTION 'Receipt has no lines'; END IF;
  FOR l IN SELECT * FROM goods_receipt_lines WHERE receipt_id=_receipt FOR UPDATE LOOP
   IF l.organization_id IS DISTINCT FROM v_org THEN RAISE EXCEPTION 'Receipt line belongs to another organisation'; END IF;
   IF NOT EXISTS(SELECT 1 FROM public.stock_locations sl WHERE sl.id=coalesce(l.location_id,r.location_id) AND sl.organization_id=v_org AND sl.branch_id IS NOT DISTINCT FROM r.branch_id AND sl.active) THEN RAISE EXCEPTION 'Receipt line store is outside the receipt property'; END IF;
   v_accepted:=COALESCE(l.quantity_accepted,GREATEST(COALESCE(l.quantity_received,0)-COALESCE(l.quantity_rejected,0)-COALESCE(l.quantity_damaged,0)-COALESCE(l.quantity_returned,0),0));
   IF l.quantity_received IS NULL OR l.quantity_received<=0 OR l.quantity_received::text IN ('NaN','Infinity','-Infinity') OR v_accepted<0 OR v_accepted::text IN ('NaN','Infinity','-Infinity') OR coalesce(l.quantity_rejected,0)<0 OR coalesce(l.quantity_damaged,0)<0 OR coalesce(l.quantity_returned,0)<0 OR coalesce(l.quantity_rejected,0)::text IN ('NaN','Infinity','-Infinity') OR coalesce(l.quantity_damaged,0)::text IN ('NaN','Infinity','-Infinity') OR coalesce(l.quantity_returned,0)::text IN ('NaN','Infinity','-Infinity') OR v_accepted+coalesce(l.quantity_rejected,0)+coalesce(l.quantity_damaged,0)+coalesce(l.quantity_returned,0)>l.quantity_received OR l.unit_price IS NULL OR l.unit_price<0 OR l.unit_price::text IN ('NaN','Infinity','-Infinity') THEN RAISE EXCEPTION 'Receipt quantities or price are not finite and consistent'; END IF;
   IF l.order_line_id IS NOT NULL THEN
    PERFORM 1 FROM public.purchase_order_lines pl WHERE pl.id=l.order_line_id AND pl.order_id=r.order_id AND pl.organization_id=v_org AND pl.stock_item_id IS NOT DISTINCT FROM l.stock_item_id AND lower(btrim(pl.unit))=lower(btrim(l.unit)) AND pl.quantity>=coalesce(pl.accepted_quantity,0)+coalesce(pl.cancelled_quantity,0)+v_accepted FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Receipt line exceeds or differs from its purchase order'; END IF;
   END IF;
   IF v_accepted>0 THEN
    v_prior_posting := coalesce(current_setting('neo.system_posting',true),'off');
    PERFORM set_config('neo.system_posting','on',true);
    PERFORM public.neo_receiving_movement_internal(l.stock_item_id,COALESCE(l.location_id,r.location_id),v_accepted,l.unit,'receipt',
      l.unit_price/NULLIF(public.inventory_convert_strict(1,l.unit,(SELECT base_unit FROM stock_items WHERE id=l.stock_item_id)),0),
      'goods_receipt',_receipt,'Goods accepted','grn:'||_receipt::text||':'||l.id::text,l.batch_number,l.expiry_date);
    PERFORM set_config('neo.system_posting',v_prior_posting,true);
    v_total:=v_total+(v_accepted*COALESCE(l.unit_price,0)); v_lines:=v_lines+1;
   END IF;
   IF l.order_line_id IS NOT NULL THEN UPDATE purchase_order_lines SET received_quantity=COALESCE(received_quantity,0)+COALESCE(l.quantity_received,0),accepted_quantity=COALESCE(accepted_quantity,0)+v_accepted,rejected_quantity=COALESCE(rejected_quantity,0)+COALESCE(l.quantity_rejected,0),returned_quantity=COALESCE(returned_quantity,0)+COALESCE(l.quantity_returned,0) WHERE id=l.order_line_id; END IF;
  END LOOP;
  UPDATE goods_receipts SET status='posted',posted_at=now(),total_value=v_total WHERE id=_receipt;
 ELSE v_total:=COALESCE(r.total_value,0); END IF;
 BEGIN
  PERFORM public.neo_grn_post_accrual(_receipt);
  SELECT accrual_journal_id INTO v_journal FROM public.goods_receipts WHERE id=_receipt AND organization_id=v_org;
  IF v_total>0 AND public.neo_connection_journal_matches(v_journal,v_org,r.branch_id,v_currency,round(v_total,2),'goods_receipt:accrual',_receipt) IS NOT TRUE THEN RAISE EXCEPTION 'Goods receipt accrual did not produce a matching posted journal'; END IF;
  UPDATE goods_receipts SET accrual_error=NULL WHERE id=_receipt;
 EXCEPTION WHEN OTHERS THEN
  v_err:=SQLERRM; UPDATE goods_receipts SET accrual_error=v_err WHERE id=_receipt;
  PERFORM public.neo_record_posting_receipt(v_org,r.branch_id,'inventory',_receipt,COALESCE(r.grn_number,_receipt::text),'failed',v_total,v_currency,NULL,'Goods receipt accrual',v_err,CURRENT_DATE);
 END;
 RETURN jsonb_build_object('status',CASE WHEN v_err IS NULL THEN 'posted' ELSE 'pending-finance' END,'lines',v_lines,'value',v_total,'finance_error',v_err);
END;
$function$;

REVOKE ALL ON FUNCTION public.neo_receiving_post_receipt_internal(uuid)
FROM PUBLIC, anon, authenticated, service_role;
NOTIFY pgrst, 'reload schema';
COMMIT;
