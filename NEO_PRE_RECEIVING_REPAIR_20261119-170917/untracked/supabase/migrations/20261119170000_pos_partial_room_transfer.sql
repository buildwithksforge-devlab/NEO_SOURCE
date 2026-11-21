-- Apply after the reviewed POS room transfer and receipt-guard migration.
BEGIN;
DO $guard$
BEGIN
 IF NOT EXISTS (
  SELECT 1 FROM pg_proc p WHERE p.oid=to_regprocedure('public.pos_post_room_charge(uuid,uuid,text)')
   AND md5(regexp_replace(regexp_replace(p.prosrc,'--[^'||chr(10)||']*','','g'),'[[:space:]]','','g'))='f90f178cdb5c81aba01d885b937078af'
 ) THEN RAISE EXCEPTION 'POS room-transfer definition differs from the reviewed predecessor'; END IF;
 IF (SELECT count(*) FROM pg_trigger t WHERE t.tgrelid='public.payments'::regclass
  AND t.tgtype=21 AND t.tgenabled='O' AND t.tgqual IS NULL AND (
    (t.tgname='payment_attempt_sync' AND t.tgfoid=to_regprocedure('public.trg_payment_attempt_payments()'))
    OR (t.tgname='payments_domain_events' AND t.tgfoid=to_regprocedure('public.tg_payment_events()'))
  ))<>2 THEN RAISE EXCEPTION 'Payment events or register mirror differ from the reviewed configuration'; END IF;
END $guard$;
ALTER TABLE public.pos_orders ADD COLUMN room_transfer_paid_total numeric;
CREATE UNIQUE INDEX payments_one_pos_room_transfer_tender
 ON public.payments(organization_id,source_record_id) WHERE source_module='pos_room_transfer';
-- A folio allocation of tender already collected at POS is not a new collection event or attempt.
CREATE OR REPLACE TRIGGER payment_attempt_sync AFTER INSERT OR UPDATE ON public.payments
 FOR EACH ROW WHEN (NEW.source_module IS DISTINCT FROM 'pos_room_transfer')
 EXECUTE FUNCTION public.trg_payment_attempt_payments();
CREATE OR REPLACE TRIGGER payments_domain_events AFTER INSERT OR UPDATE ON public.payments
 FOR EACH ROW WHEN (NEW.source_module IS DISTINCT FROM 'pos_room_transfer')
 EXECUTE FUNCTION public.tg_payment_events();
CREATE OR REPLACE FUNCTION public.pos_post_room_charge(_order_id uuid,_folio_id uuid,_idempotency_key text)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp
AS $function$
DECLARE
 org uuid:=public.current_org_id(); source public.pos_orders; final_source public.pos_orders; target public.folios;
 stay public.stays; saved public.folio_lines; line_id uuid; previous_posting text;
 base numeric; delivery numeric; tip numeric; original_reservation uuid;
 collected numeric; tender public.pos_payments; folio_payment uuid; posting jsonb;
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

 -- The order lock serializes receipt writers and the identity lock serializes cross-order retries.
 SELECT coalesce(sum(p.amount),0) INTO collected FROM public.pos_payments p
  WHERE p.order_id=_order_id AND p.organization_id=org AND p.status='confirmed';

 SELECT * INTO saved FROM public.folio_lines WHERE organization_id=org AND idempotency_key=_idempotency_key;
 IF source.folio_post_status='posted' OR source.status='charged-to-room' OR saved.id IS NOT NULL THEN
  IF saved.id IS NULL OR source.folio_id IS DISTINCT FROM _folio_id OR source.folio_post_status IS DISTINCT FROM 'posted'
   OR coalesce(source.status,'') NOT IN ('charged-to-room','closed') OR saved.folio_id IS DISTINCT FROM _folio_id
   OR source.paid_total IS DISTINCT FROM collected OR saved.net_amount IS NULL OR saved.net_amount::text IN ('NaN','Infinity','-Infinity')
   OR (collected>0 AND source.room_transfer_paid_total IS DISTINCT FROM collected)
   OR EXISTS (
    SELECT 1 FROM public.pos_payments p WHERE p.order_id=_order_id AND p.status='confirmed'
     AND NOT EXISTS (
      SELECT 1 FROM public.payments fp JOIN public.payment_allocations a ON a.payment_id=fp.id
      WHERE fp.organization_id=org AND fp.branch_id=source.branch_id AND fp.currency=source.currency
       AND fp.source_module='pos_room_transfer' AND fp.source_record_id=p.id
       AND fp.folio_id=_folio_id AND fp.status='confirmed' AND fp.amount=p.amount
       AND a.organization_id=org AND a.folio_id=_folio_id AND a.amount=p.amount
     )
   )
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
 IF collected::text IN ('NaN','Infinity','-Infinity') OR collected<0
  OR source.paid_total IS DISTINCT FROM collected
  OR source.payment_status IS DISTINCT FROM (CASE WHEN collected=0 THEN 'unpaid' ELSE 'partial' END)
  OR (collected>0 AND collected>=source.grand_total)
  OR EXISTS(SELECT 1 FROM public.pos_payments p WHERE p.order_id=_order_id
   AND (p.organization_id IS DISTINCT FROM org OR coalesce(p.status,'') NOT IN ('confirmed','failed','cancelled','voided','void','expired')
    OR (p.status='confirmed' AND (
      p.branch_id IS DISTINCT FROM source.branch_id OR p.currency IS DISTINCT FROM source.currency
      OR p.amount IS NULL OR p.amount<=0 OR p.amount<>round(p.amount,2) OR p.amount::text IN ('NaN','Infinity','-Infinity')
      OR p.paid_at IS NULL OR (nullif(btrim(p.receipt_number),'') IS NULL
       AND (p.method IS DISTINCT FROM 'mpesa' OR nullif(btrim(p.external_reference),'') IS NULL))
      OR nullif(btrim(p.method),'') IS NULL OR p.method IN ('room-charge','room_charge','corporate-credit')
    ))))
  OR EXISTS(SELECT 1 FROM public.cash_payment_requests r WHERE r.source_module='pos' AND r.source_record_id=_order_id
   AND (r.organization_id IS DISTINCT FROM org OR (coalesce(r.status,'') NOT IN ('cancelled','rejected','failed','expired')
    AND NOT (r.status='confirmed' AND EXISTS (
     SELECT 1 FROM public.pos_payments p WHERE p.id=r.payment_id AND p.order_id=_order_id AND p.organization_id=org
      AND p.status='confirmed' AND p.amount=r.amount AND p.branch_id=r.branch_id AND p.currency=r.currency
    )))))
  OR EXISTS(SELECT 1 FROM public.mpesa_transactions t WHERE (t.source_module IN ('pos','pos_order') AND t.source_record_id=_order_id
    OR t.payment_table='pos_payments' AND t.payment_id IN (SELECT id FROM public.pos_payments WHERE order_id=_order_id))
   AND (t.organization_id IS DISTINCT FROM org OR ((coalesce(t.status,'') NOT IN ('failed','cancelled','expired') OR t.result_code=0)
    AND NOT (t.status='success' AND t.result_code IS NOT DISTINCT FROM 0 AND t.applied_at IS NOT NULL
     AND t.payment_table='pos_payments' AND EXISTS (
      SELECT 1 FROM public.pos_payments p WHERE p.id=t.payment_id AND p.order_id=_order_id
       AND p.organization_id=org AND p.method='mpesa' AND p.status='confirmed' AND p.currency='KES'
       AND p.branch_id=t.branch_id AND p.amount=t.amount
       AND upper(nullif(btrim(p.external_reference),''))=upper(nullif(btrim(t.mpesa_receipt_number),''))
     )))))
  OR EXISTS(SELECT 1 FROM public.approval_requests a JOIN public.pos_payments p ON p.id=a.source_record_id
   WHERE p.order_id=_order_id AND a.approval_type='mpesa-receipt-review'
    AND a.status IN ('pending_approval','approved_pending_execution','executing','execution_failed')) THEN
  RAISE EXCEPTION 'This bill has recorded or unresolved money. Reconcile the original payment before transferring it to a room';
 END IF;
 IF collected>0 AND (
  EXISTS(SELECT 1 FROM public.pos_refund_requests r WHERE r.order_id=_order_id AND r.status IS DISTINCT FROM 'rejected')
  OR EXISTS(SELECT 1 FROM public.cash_refund_requests r JOIN public.pos_payments p ON p.id=r.pos_payment_id
    WHERE p.order_id=_order_id AND r.status NOT IN ('rejected','cancelled'))
  OR EXISTS(SELECT 1 FROM public.journal_entries j WHERE j.organization_id=org AND j.status='posted'
    AND j.reversed_by_journal_id IS NULL AND j.journal_type<>'reversal'
    AND ((j.source_document_id=_order_id AND j.source_document_type LIKE 'pos_order:%')
      OR j.source_document_id IN (SELECT p.id FROM public.pos_payments p WHERE p.order_id=_order_id)))
 ) THEN RAISE EXCEPTION 'Original POS receipts already have refunds or journal entries requiring reconciliation'; END IF;
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
  -- Apply the existing tender to the folio. The original POS receipt owns the till entry.
  FOR tender IN SELECT * FROM public.pos_payments p WHERE p.order_id=_order_id AND p.organization_id=org
   AND p.status='confirmed' ORDER BY p.id LOOP
   IF tender.destination_account_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.bank_accounts b JOIN public.chart_of_accounts a ON a.id=b.gl_account_id
    WHERE b.id=tender.destination_account_id AND b.organization_id=org AND a.organization_id=org
     AND (b.branch_id IS NULL OR b.branch_id=source.branch_id) AND b.active AND a.active AND a.postable AND NOT a.is_header
   ) THEN RAISE EXCEPTION 'The original tender receiving account needs reconciliation'; END IF;
   INSERT INTO public.payments(organization_id,branch_id,folio_id,reservation_id,customer_id,receipt_number,
    amount,currency,method,external_reference,status,paid_at,received_by,notes,source_module,source_record_id,
    idempotency_key,destination_account_id)
   VALUES(org,source.branch_id,_folio_id,target.reservation_id,target.customer_id,
    coalesce(nullif(btrim(tender.receipt_number),''),btrim(tender.external_reference)),
    tender.amount,tender.currency,tender.method,tender.external_reference,'confirmed',tender.paid_at,tender.cashier_id,
    'Applied original POS receipt '||coalesce(nullif(btrim(tender.receipt_number),''),btrim(tender.external_reference)),
    'pos_room_transfer',tender.id,
    'pos-room-tender:'||tender.id::text,tender.destination_account_id)
   RETURNING id INTO folio_payment;
   INSERT INTO public.payment_allocations(organization_id,payment_id,folio_id,amount,created_by)
   VALUES(org,folio_payment,_folio_id,tender.amount,auth.uid());
   posting:=public.neo_finance_post_txn('folio_payment',folio_payment,true);
   IF posting->>'ok' IS DISTINCT FROM 'true' OR nullif(posting->>'journal_id','') IS NULL THEN
    RAISE EXCEPTION 'Original POS tender could not be reconciled to the guest folio';
   END IF;
   UPDATE public.payments SET posted_journal_id=(posting->>'journal_id')::uuid
    WHERE id=folio_payment AND organization_id=org;
   UPDATE public.payment_attempts SET posted_journal_id=(posting->>'journal_id')::uuid,updated_at=now()
    WHERE payment_table='pos_payments' AND payment_id=tender.id AND organization_id=org;
  END LOOP;
  IF collected>0 THEN
   posting:=public.neo_finance_post_txn('folio_charge',line_id,true);
   IF posting->>'ok' IS DISTINCT FROM 'true' OR nullif(posting->>'journal_id','') IS NULL THEN
    RAISE EXCEPTION 'POS sale charge could not be reconciled to the guest folio';
   END IF;
   UPDATE public.folios SET total_payments=coalesce(total_payments,0)+collected,
    balance=balance-collected,updated_at=now() WHERE id=_folio_id;
  END IF;
  -- Use the legal service-to-settlement transition.
  IF source.status<>'awaiting-payment' THEN
   UPDATE public.pos_orders SET status='awaiting-payment' WHERE id=_order_id AND organization_id=org;
  END IF;
  UPDATE public.pos_orders SET folio_post_status='posted',folio_id=_folio_id,payment_status='paid',status='charged-to-room',closed_at=now(),room_transfer_paid_total=collected
    WHERE id=_order_id AND organization_id=org;
  SELECT * INTO final_source FROM public.pos_orders WHERE id=_order_id AND organization_id=org;
  IF final_source.status IS DISTINCT FROM 'charged-to-room' OR final_source.folio_id IS DISTINCT FROM _folio_id
   OR final_source.folio_post_status IS DISTINCT FROM 'posted' OR final_source.paid_total IS DISTINCT FROM collected OR final_source.room_transfer_paid_total IS DISTINCT FROM collected
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
    'serviceCharge',source.service_charge_total,'alreadyCollected',collected,'transferredBalance',source.grand_total-collected),_idempotency_key,source.customer_id);
 INSERT INTO public.audit_logs(organization_id,branch_id,user_id,action,module,record_id,new_value)
  VALUES(org,source.branch_id,auth.uid(),'pos.room_charge.post','pos',_order_id,
   jsonb_build_object('folioId',_folio_id,'gross',source.grand_total,'tax',source.tax_total,'serviceCharge',source.service_charge_total,'folioLineId',line_id,'alreadyCollected',collected,'transferredBalance',source.grand_total-collected));
 RETURN line_id;
END;
$function$;
CREATE FUNCTION public.neo_guard_allocated_pos_tender()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp
AS $function$
DECLARE original public.pos_payments; payment_key uuid;
BEGIN
 IF TG_TABLE_NAME='pos_payments' THEN
  original:=OLD;
  IF OLD.status IS DISTINCT FROM 'confirmed' THEN
   IF TG_OP='DELETE' THEN RETURN OLD; END IF;
   RETURN NEW;
  END IF;
  IF TG_OP='UPDATE' AND
   ROW(NEW.id,NEW.order_id,NEW.organization_id,NEW.branch_id,NEW.amount,NEW.currency,NEW.status,
       NEW.method,NEW.destination_account_id,NEW.shift_id,NEW.paid_at,NEW.receipt_number)
   IS NOT DISTINCT FROM
   ROW(OLD.id,OLD.order_id,OLD.organization_id,OLD.branch_id,OLD.amount,OLD.currency,OLD.status,
       OLD.method,OLD.destination_account_id,OLD.shift_id,OLD.paid_at,OLD.receipt_number) THEN
   RETURN NEW;
  END IF;
 ELSE
  IF NEW.status IN ('rejected','cancelled') THEN RETURN NEW; END IF;
  payment_key:=CASE WHEN TG_TABLE_NAME='cash_refund_requests' THEN (to_jsonb(NEW)->>'pos_payment_id')::uuid
    ELSE (to_jsonb(NEW)->>'payment_id')::uuid END;
  IF payment_key IS NULL THEN RETURN NEW; END IF;
  SELECT * INTO original FROM public.pos_payments WHERE id=payment_key;
 END IF;
 IF original.id IS NOT NULL THEN
  PERFORM 1 FROM public.pos_orders WHERE id=original.order_id AND organization_id=original.organization_id FOR UPDATE;
  IF EXISTS(SELECT 1 FROM public.payments p WHERE p.organization_id=original.organization_id
    AND p.source_module='pos_room_transfer' AND p.source_record_id=original.id) THEN
   RAISE EXCEPTION 'This POS tender was applied to a guest folio; use the linked folio receipt for adjustments or refunds';
  END IF;
 END IF;
 IF TG_OP='DELETE' THEN RETURN OLD; END IF;
 RETURN NEW;
END;
$function$;
REVOKE ALL ON FUNCTION public.neo_guard_allocated_pos_tender() FROM PUBLIC,anon,authenticated;
CREATE TRIGGER neo_protect_allocated_pos_tender BEFORE UPDATE OR DELETE ON public.pos_payments
 FOR EACH ROW EXECUTE FUNCTION public.neo_guard_allocated_pos_tender();
CREATE TRIGGER neo_pos_refund_allocated_tender BEFORE INSERT OR UPDATE ON public.pos_refund_requests
 FOR EACH ROW EXECUTE FUNCTION public.neo_guard_allocated_pos_tender();
CREATE TRIGGER neo_cash_refund_allocated_tender BEFORE INSERT OR UPDATE ON public.cash_refund_requests
 FOR EACH ROW EXECUTE FUNCTION public.neo_guard_allocated_pos_tender();
COMMIT;
