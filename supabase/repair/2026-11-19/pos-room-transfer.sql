-- Reviewed template. Install only through the generated guarded migration.
CREATE OR REPLACE FUNCTION public.pos_post_room_charge(_order_id uuid,_folio_id uuid,_idempotency_key text)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp
AS $function$
DECLARE
 org uuid:=public.current_org_id(); source public.pos_orders; final_source public.pos_orders; target public.folios;
 stay public.stays; saved public.folio_lines; line_id uuid; previous_posting text;
 base numeric; delivery numeric; tip numeric; original_reservation uuid;
BEGIN
 IF auth.uid() IS NULL OR org IS NULL OR public.has_permission('pos','room_charge.post') IS NOT TRUE THEN
  RAISE EXCEPTION 'Not permitted to post room charges' USING ERRCODE='42501';
 END IF;
 IF nullif(btrim(_idempotency_key),'') IS NULL OR length(_idempotency_key)>200 THEN RAISE EXCEPTION 'A stable room-transfer identity is required'; END IF;
 SELECT * INTO source FROM public.pos_orders WHERE id=_order_id AND organization_id=org FOR UPDATE;
 IF source.id IS NULL OR NOT coalesce(public.neo_branch_in_scope(source.branch_id),false) THEN
  RAISE EXCEPTION 'Room-transfer order is outside your property scope' USING ERRCODE='42501';
 END IF;
 IF source.folio_post_status IS DISTINCT FROM 'posted' AND source.status IS DISTINCT FROM 'charged-to-room'
  AND source.folio_id IS NOT NULL AND source.folio_id IS DISTINCT FROM _folio_id THEN
  RAISE EXCEPTION 'This order is already assigned to a different guest account';
 END IF;
 -- Serialize conflicting use of a key across different orders, not just one bill.
 PERFORM pg_advisory_xact_lock(hashtextextended(org::text||':pos-room-transfer:'||_idempotency_key,0));
 SELECT * INTO target FROM public.folios WHERE id=_folio_id AND organization_id=org;
 IF target.id IS NULL OR target.branch_id IS DISTINCT FROM source.branch_id OR target.currency IS DISTINCT FROM source.currency
  OR nullif(btrim(target.currency),'') IS NULL THEN RAISE EXCEPTION 'Order and folio property/currency require reconciliation'; END IF;
 original_reservation:=target.reservation_id;

 SELECT * INTO saved FROM public.folio_lines WHERE organization_id=org AND idempotency_key=_idempotency_key;
 IF source.folio_post_status='posted' OR source.status='charged-to-room' OR saved.id IS NOT NULL THEN
  IF saved.id IS NULL OR source.folio_id IS DISTINCT FROM _folio_id OR source.folio_post_status IS DISTINCT FROM 'posted'
   OR coalesce(source.status,'') NOT IN ('charged-to-room','closed') OR saved.folio_id IS DISTINCT FROM _folio_id
   OR source.paid_total IS DISTINCT FROM 0 OR saved.net_amount IS NULL OR saved.net_amount::text IN ('NaN','Infinity','-Infinity')
   OR EXISTS(SELECT 1 FROM public.pos_payments p WHERE p.order_id=_order_id AND p.status IN ('confirmed','posted','completed','paid','settled','captured','succeeded'))
   OR saved.branch_id IS DISTINCT FROM source.branch_id OR saved.source_module IS DISTINCT FROM 'pos'
   OR saved.source_record_uuid IS DISTINCT FROM _order_id OR saved.line_type IS DISTINCT FROM 'charge'
   OR coalesce(saved.status,'posted') IN ('void','voided','cancelled','reversed')
   OR saved.net_amount IS DISTINCT FROM source.grand_total OR saved.tax_amount IS DISTINCT FROM source.tax_total
   OR saved.service_charge_amount IS DISTINCT FROM source.service_charge_total OR saved.discount_amount IS DISTINCT FROM source.discount_total THEN
   RAISE EXCEPTION 'Saved room transfer does not match this order and folio; reconcile before retrying';
  END IF;
  RETURN saved.id;
 END IF;
 IF coalesce(source.status,'') NOT IN ('sent','accepted','in-preparation','partially-ready','ready','partially-served','served','awaiting-payment') THEN
  RAISE EXCEPTION 'Bill % cannot be charged to a room from status %; send it to production first',source.order_number,source.status;
 END IF;
 IF source.paid_total IS DISTINCT FROM 0 OR coalesce(source.payment_status,'') IS DISTINCT FROM 'unpaid'
  OR EXISTS(SELECT 1 FROM public.pos_payments p WHERE p.order_id=_order_id
   AND (p.organization_id IS DISTINCT FROM org OR coalesce(p.status,'') NOT IN ('failed','cancelled','voided','void','expired')))
  OR EXISTS(SELECT 1 FROM public.cash_payment_requests r WHERE r.source_module='pos' AND r.source_record_id=_order_id
   AND (r.organization_id IS DISTINCT FROM org OR coalesce(r.status,'') NOT IN ('cancelled','rejected','failed','expired')))
  OR EXISTS(SELECT 1 FROM public.mpesa_transactions t WHERE (t.source_module IN ('pos','pos_order') AND t.source_record_id=_order_id
    OR t.payment_table='pos_payments' AND t.payment_id IN (SELECT id FROM public.pos_payments WHERE order_id=_order_id))
   AND (t.organization_id IS DISTINCT FROM org OR coalesce(t.status,'') NOT IN ('failed','cancelled','expired') OR t.result_code=0))
  OR EXISTS(SELECT 1 FROM public.approval_requests a JOIN public.pos_payments p ON p.id=a.source_record_id
   WHERE p.order_id=_order_id AND a.approval_type='mpesa-receipt-review'
    AND a.status IN ('pending_approval','approved_pending_execution','executing','execution_failed')) THEN
  RAISE EXCEPTION 'This bill has recorded or unresolved money. Reconcile the original payment before transferring it to a room';
 END IF;
 IF EXISTS(SELECT 1 FROM public.folio_lines l WHERE l.organization_id=org AND l.source_module='pos'
   AND l.source_record_uuid=_order_id AND l.line_type='charge' AND coalesce(l.status,'posted') NOT IN ('void','voided','reversed','cancelled')) THEN
  RAISE EXCEPTION 'This order already has a folio charge under another identity';
 END IF;
 -- Use the reservation collection lock before stay/folio locks, like checkout.
 PERFORM pg_advisory_xact_lock(hashtextextended(org::text||':reservation-collection:'||coalesce(target.reservation_id,target.id)::text,0));
 SELECT * INTO stay FROM public.stays WHERE id=target.stay_id AND organization_id=org FOR UPDATE;
 SELECT * INTO target FROM public.folios WHERE id=_folio_id AND organization_id=org FOR UPDATE;
 IF target.status IS DISTINCT FROM 'open' OR stay.id IS NULL OR target.stay_id IS DISTINCT FROM stay.id
  OR stay.branch_id IS DISTINCT FROM source.branch_id OR target.branch_id IS DISTINCT FROM source.branch_id
  OR target.currency IS DISTINCT FROM source.currency OR stay.room_id IS NULL
  OR target.reservation_id IS DISTINCT FROM original_reservation
  OR coalesce(stay.status,'') NOT IN ('checked-in','checked_in','in-house','in_house')
  OR (target.reservation_id IS NOT NULL AND target.reservation_id IS DISTINCT FROM stay.reservation_id)
  OR NOT EXISTS(SELECT 1 FROM public.rooms r WHERE r.id=stay.room_id AND r.organization_id=org AND r.branch_id=source.branch_id) THEN
  RAISE EXCEPTION 'Room transfer requires the matching current in-house stay and open folio';
 END IF;
 delivery:=coalesce((to_jsonb(source)->>'delivery_fee')::numeric,0);
 tip:=coalesce((to_jsonb(source)->>'tip_amount')::numeric,0);
 IF EXISTS(SELECT 1 FROM unnest(ARRAY[source.subtotal,source.grand_total,source.tax_total,source.service_charge_total,source.discount_total,delivery,tip]) amount
   WHERE amount IS NULL OR amount<0 OR amount::text IN ('NaN','Infinity','-Infinity') OR amount<>round(amount,2))
  OR source.grand_total<=0 OR source.discount_total>source.subtotal THEN RAISE EXCEPTION 'Room-transfer amounts are incomplete or invalid'; END IF;
 IF delivery<>0 OR tip<>0 THEN RAISE EXCEPTION 'A bill with delivery fees or tips needs component allocation before room transfer'; END IF;
 IF source.grand_total IS DISTINCT FROM round(source.subtotal-source.discount_total+source.service_charge_total,2) THEN
  RAISE EXCEPTION 'Saved bill components do not reconcile; included tax must not be added twice';
 END IF;
 base:=source.grand_total-source.tax_total-source.service_charge_total+source.discount_total;
 IF base<0 THEN RAISE EXCEPTION 'Saved room-transfer tax/components do not reconcile'; END IF;
 previous_posting:=coalesce(current_setting('neo.system_posting',true),'off');
 BEGIN
  PERFORM set_config('neo.system_posting','on',true);
  line_id:=public.folio_post_charge(_folio_id,'food-beverage','POS '||source.order_number||' ('||source.order_type||')',
   1,base,source.tax_total,source.service_charge_total,source.discount_total,'pos',_order_id,'fnb',_idempotency_key,NULL);
  SELECT * INTO saved FROM public.folio_lines WHERE id=line_id AND organization_id=org;
  IF saved.id IS NULL OR saved.folio_id IS DISTINCT FROM _folio_id OR saved.branch_id IS DISTINCT FROM source.branch_id
   OR saved.source_module IS DISTINCT FROM 'pos' OR saved.source_record_uuid IS DISTINCT FROM _order_id
   OR saved.idempotency_key IS DISTINCT FROM _idempotency_key OR saved.line_type IS DISTINCT FROM 'charge'
   OR coalesce(saved.status,'posted') IN ('void','voided','cancelled','reversed')
   OR saved.net_amount IS DISTINCT FROM source.grand_total OR saved.tax_amount IS DISTINCT FROM source.tax_total
   OR saved.service_charge_amount IS DISTINCT FROM source.service_charge_total OR saved.discount_amount IS DISTINCT FROM source.discount_total THEN
   RAISE EXCEPTION 'Room charge did not confirm its original order, folio and component amounts';
  END IF;
  -- Preserve the live rulebook's legal transition rather than jumping from service to settlement.
  IF source.status<>'awaiting-payment' THEN
   UPDATE public.pos_orders SET status='awaiting-payment' WHERE id=_order_id AND organization_id=org;
  END IF;
  UPDATE public.pos_orders SET folio_post_status='posted',folio_id=_folio_id,payment_status='paid',status='charged-to-room',closed_at=now()
    WHERE id=_order_id AND organization_id=org;
  SELECT * INTO final_source FROM public.pos_orders WHERE id=_order_id AND organization_id=org;
  IF final_source.status IS DISTINCT FROM 'charged-to-room' OR final_source.folio_id IS DISTINCT FROM _folio_id
   OR final_source.folio_post_status IS DISTINCT FROM 'posted' OR final_source.paid_total IS DISTINCT FROM 0
   OR final_source.branch_id IS DISTINCT FROM source.branch_id OR final_source.currency IS DISTINCT FROM source.currency
   OR final_source.subtotal IS DISTINCT FROM source.subtotal OR final_source.grand_total IS DISTINCT FROM source.grand_total
   OR final_source.tax_total IS DISTINCT FROM source.tax_total OR final_source.service_charge_total IS DISTINCT FROM source.service_charge_total
   OR final_source.discount_total IS DISTINCT FROM source.discount_total THEN
   RAISE EXCEPTION 'Bill totals or transfer state changed during posting; all transfer effects rolled back';
  END IF;
  PERFORM set_config('neo.system_posting',previous_posting,true);
 EXCEPTION WHEN OTHERS THEN
  PERFORM set_config('neo.system_posting',previous_posting,true); RAISE;
 END;
 PERFORM public.emit_domain_event(org,source.branch_id,'pos.room_charge.posted','pos',_order_id,
  jsonb_build_object('orderId',_order_id,'folioId',_folio_id,'amount',source.grand_total,'tax',source.tax_total,
    'serviceCharge',source.service_charge_total),_idempotency_key,source.customer_id);
 INSERT INTO public.audit_logs(organization_id,branch_id,user_id,action,module,record_id,new_value)
  VALUES(org,source.branch_id,auth.uid(),'pos.room_charge.post','pos',_order_id,
   jsonb_build_object('folioId',_folio_id,'gross',source.grand_total,'tax',source.tax_total,'serviceCharge',source.service_charge_total,'folioLineId',line_id));
 RETURN line_id;
END;
$function$;

CREATE OR REPLACE FUNCTION public.neo_pos_guard_room_transferred_receipt()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp
AS $function$
DECLARE source public.pos_orders;
BEGIN
 -- Provider/reference metadata may still be recorded without changing money.
 IF TG_OP='UPDATE' AND NEW.status IS NOT DISTINCT FROM OLD.status AND NEW.amount IS NOT DISTINCT FROM OLD.amount
  AND NEW.order_id IS NOT DISTINCT FROM OLD.order_id AND NEW.organization_id IS NOT DISTINCT FROM OLD.organization_id THEN RETURN NEW; END IF;
 IF coalesce(NEW.status,'') NOT IN ('failed','cancelled','voided','void','expired','refunded','reversed') THEN
  SELECT * INTO source FROM public.pos_orders WHERE id=NEW.order_id AND organization_id=NEW.organization_id FOR UPDATE;
  IF source.id IS NULL THEN RAISE EXCEPTION 'Receipt order could not be verified'; END IF;
  IF source.folio_post_status='posted' OR source.status='charged-to-room' THEN
   RAISE EXCEPTION 'This bill is already transferred to a folio; reconcile the original receipt on the guest account';
  END IF;
 END IF;
 RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.neo_cash_guard_room_transferred_order()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp
AS $function$
DECLARE source public.pos_orders;
BEGIN
 IF NEW.source_module='pos' AND coalesce(NEW.status,'') NOT IN ('cancelled','rejected','failed','expired') THEN
  SELECT * INTO source FROM public.pos_orders WHERE id=NEW.source_record_id AND organization_id=NEW.organization_id FOR UPDATE;
  IF source.id IS NULL THEN RAISE EXCEPTION 'Cash request order could not be verified'; END IF;
  IF source.folio_post_status='posted' OR source.status='charged-to-room' THEN
   RAISE EXCEPTION 'This bill is already transferred to a folio; collect against the guest account';
  END IF;
 END IF;
 RETURN NEW;
END;
$function$;
