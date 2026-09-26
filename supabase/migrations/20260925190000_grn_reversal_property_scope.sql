-- R9.2 certification hardening: a receiver/admin may reverse only a GRN in
-- their current branch scope. Organisation membership alone is insufficient.
CREATE OR REPLACE FUNCTION public.neo_grn_reverse(_receipt uuid, _reason text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE
  v_org uuid := current_org_id(); r record; l record; pol public.procurement_matching_policies;
  v_accepted numeric; v_value numeric := 0; v_res jsonb;
BEGIN
  IF NOT (has_permission('procurement','receiving.manage') OR is_org_admin()) THEN RAISE EXCEPTION 'Not permitted to reverse a goods receipt'; END IF;
  IF COALESCE(btrim(_reason),'') = '' THEN RAISE EXCEPTION 'A reason is required to reverse a receipt'; END IF;
  SELECT * INTO r FROM goods_receipts WHERE id=_receipt AND organization_id=v_org;
  IF r IS NULL THEN RAISE EXCEPTION 'Receipt not found'; END IF;
  IF NOT public.in_my_branch_scope(r.branch_id) THEN RAISE EXCEPTION 'Receipt is outside your property scope'; END IF;
  IF r.status <> 'posted' THEN RAISE EXCEPTION 'Only a posted receipt can be reversed'; END IF;
  IF EXISTS (SELECT 1 FROM supplier_invoices si WHERE si.receipt_id=_receipt AND si.journal_id IS NOT NULL) THEN RAISE EXCEPTION 'This receipt is already invoiced. Raise a supplier credit note instead.'; END IF;
  pol := public.neo_matching_policy(v_org,r.branch_id);
  FOR l IN SELECT * FROM goods_receipt_lines WHERE receipt_id=_receipt LOOP
    v_accepted:=COALESCE(l.quantity_accepted,GREATEST(COALESCE(l.quantity_received,0)-COALESCE(l.quantity_rejected,0)-COALESCE(l.quantity_damaged,0)-COALESCE(l.quantity_returned,0),0));
    IF v_accepted>0 THEN
      PERFORM inventory_apply_movement(l.stock_item_id,COALESCE(l.location_id,r.location_id),-v_accepted,l.unit,'reversal',NULLIF(l.unit_price,0),'goods_receipt_reversal',_receipt,_reason,'grn-reverse:'||_receipt::text||':'||l.id::text,l.batch_number,l.expiry_date);
      v_value:=v_value+(v_accepted*COALESCE(l.unit_price,0));
    END IF;
    IF l.order_line_id IS NOT NULL THEN UPDATE purchase_order_lines SET received_quantity=GREATEST(COALESCE(received_quantity,0)-COALESCE(l.quantity_received,0),0),accepted_quantity=GREATEST(COALESCE(accepted_quantity,0)-v_accepted,0) WHERE id=l.order_line_id; END IF;
  END LOOP;
  IF round(v_value,2)>0 THEN
    v_res:=public.neo_gl_post(v_org,r.branch_id,'procurement','goods_receipt',_receipt,'accrual:reversal',CURRENT_DATE,'KES','Reversal of goods receipt '||COALESCE(r.grn_number,_receipt::text)||' — '||_reason,jsonb_build_array(jsonb_build_object('code',pol.grni_account_code,'debit',round(v_value,2),'description','Reverse goods received not invoiced'),jsonb_build_object('code',pol.inventory_account_code,'credit',round(v_value,2),'description','Reverse stock received')),NULL,r.accrual_journal_id);
  END IF;
  UPDATE goods_receipts SET status='reversed',reversed_at=now(),reversed_by=auth.uid(),reversal_reason=_reason,reversal_journal_id=(v_res->>'journal_id')::uuid WHERE id=_receipt;
  IF r.order_id IS NOT NULL THEN UPDATE purchase_orders po SET status=CASE WHEN EXISTS(SELECT 1 FROM purchase_order_lines pl WHERE pl.order_id=po.id AND COALESCE(pl.accepted_quantity,0)>0) THEN 'partially-received' ELSE 'sent' END WHERE po.id=r.order_id AND po.status NOT IN('closed','cancelled','voided'); END IF;
  RETURN jsonb_build_object('ok',true,'reversed_value',round(v_value,2),'journal_id',v_res->>'journal_id');
END $$;
