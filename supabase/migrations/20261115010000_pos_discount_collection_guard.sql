-- One explicit existing command replacement; no business routine is invoked by installation.
BEGIN;
DO $guard$
DECLARE actual text;
BEGIN
 IF to_regprocedure('public.neo_pos_apply_discount(uuid,uuid,text)') IS NULL THEN
  RAISE EXCEPTION 'Expected discount command is absent; stop and inspect the installed schema.';
 END IF;
 SELECT md5(pg_get_functiondef('public.neo_pos_apply_discount(uuid,uuid,text)'::regprocedure)) INTO actual;
 IF actual NOT IN ('401fc1815b3805db6d0e2cbc9c0be741','0c1ff88bb7e414484470dfd750f7454a') THEN
  RAISE EXCEPTION 'Installed discount code differs from the reviewed definition; nothing replaced.';
 END IF;
END $guard$;
CREATE TEMP TABLE neo_discount_acl_before ON COMMIT DROP AS
 SELECT md5(coalesce(proacl::text,'')) acl_hash FROM pg_proc
 WHERE oid='public.neo_pos_apply_discount(uuid,uuid,text)'::regprocedure;
CREATE OR REPLACE FUNCTION public.neo_pos_apply_discount(_order uuid, _discount uuid, _reason text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE o public.pos_orders; d public.pos_discounts;
 _amount numeric(14,2); _cap numeric(14,2); _clock timestamp;
BEGIN
 SELECT * INTO o FROM public.pos_orders WHERE id=_order FOR UPDATE;
 IF o.id IS NULL THEN RAISE EXCEPTION 'That order could not be found.'; END IF;
 IF o.organization_id IS DISTINCT FROM public.current_org_id() THEN
  RAISE EXCEPTION 'That order belongs to another workspace.' USING ERRCODE='42501'; END IF;
 IF NOT coalesce(o.branch_id=ANY(public.current_branch_ids()),false) THEN
  RAISE EXCEPTION 'You are not assigned to the property that owns this order.' USING ERRCODE='42501'; END IF;
 IF public.has_permission('pos','discount.execute') IS NOT TRUE THEN
  RAISE EXCEPTION 'You do not have permission to apply a discount to a bill.' USING ERRCODE='42501'; END IF;
 IF coalesce(o.status,'draft') IN ('paid','closed','cancelled','voided','charged-to-room','credit') THEN
  RAISE EXCEPTION 'This bill is % and can no longer be discounted.',o.status; END IF;
 IF coalesce(o.paid_total,0)>0 OR coalesce(o.payment_status,'unpaid') IN ('paid','partial','partially_paid','settled')
  OR EXISTS(SELECT 1 FROM public.pos_payments p WHERE p.organization_id=o.organization_id AND p.order_id=o.id
    AND p.amount>0 AND p.status IN ('initiated','pending','confirmed'))
  OR EXISTS(SELECT 1 FROM public.cash_payment_requests c WHERE c.organization_id=o.organization_id
    AND c.source_module='pos' AND c.source_record_id=o.id AND c.amount>0
    AND coalesce(c.status,'pending') NOT IN ('cancelled','rejected','failed','expired'))
  OR EXISTS(SELECT 1 FROM public.mpesa_transactions t JOIN public.pos_payments p
    ON p.id=t.payment_id AND p.organization_id=t.organization_id
    WHERE p.order_id=o.id AND t.organization_id=o.organization_id AND t.payment_table='pos_payments'
    AND t.amount>0 AND t.status IN ('initiated','pending','unknown','success')) THEN
  RAISE EXCEPTION 'This bill has a pending or recorded collection. Reconcile that collection before changing its discount.' USING ERRCODE='23514'; END IF;
 IF o.subtotal IS NULL OR o.subtotal<0 OR o.subtotal::text IN ('NaN','Infinity','-Infinity') THEN
  RAISE EXCEPTION 'The bill amount is incomplete or non-finite.' USING ERRCODE='22023'; END IF;
 IF _discount IS NULL THEN
  UPDATE public.pos_orders SET discount_total=0 WHERE id=o.id;
  PERFORM public.emit_domain_event(o.organization_id,o.branch_id,'pos.discount.cleared','pos',o.id,
    jsonb_build_object('reason',_reason),NULL,NULL);
  RETURN jsonb_build_object('ok',true,'discount_total',0);
 END IF;
 SELECT * INTO d FROM public.pos_discounts WHERE id=_discount FOR SHARE;
 IF d.id IS NULL OR d.organization_id IS DISTINCT FROM o.organization_id THEN
  RAISE EXCEPTION 'That discount policy could not be found for this workspace.'; END IF;
 IF d.branch_id IS NOT NULL AND d.branch_id IS DISTINCT FROM o.branch_id THEN
  RAISE EXCEPTION 'That discount policy belongs to another property.'; END IF;
 IF d.active IS NOT TRUE THEN RAISE EXCEPTION 'That discount policy is not active.'; END IF;
 _clock:=now() AT TIME ZONE public.neo_fact_timezone(o.organization_id,o.branch_id);
 IF d.valid_from IS NOT NULL AND _clock::date<d.valid_from THEN RAISE EXCEPTION 'That discount policy is not valid yet.'; END IF;
 IF d.valid_to IS NOT NULL AND _clock::date>d.valid_to THEN RAISE EXCEPTION 'That discount policy has expired.'; END IF;
 IF (d.valid_time_from IS NOT NULL AND d.valid_time_to IS NULL AND _clock::time<d.valid_time_from)
  OR (d.valid_time_to IS NOT NULL AND d.valid_time_from IS NULL AND _clock::time>d.valid_time_to)
  OR (d.valid_time_from IS NOT NULL AND d.valid_time_to IS NOT NULL AND
   CASE WHEN d.valid_time_from<=d.valid_time_to THEN _clock::time NOT BETWEEN d.valid_time_from AND d.valid_time_to
    ELSE NOT (_clock::time>=d.valid_time_from OR _clock::time<=d.valid_time_to) END) THEN
  RAISE EXCEPTION 'That discount policy is outside its configured property hours.'; END IF;
 IF d.order_types IS NOT NULL AND cardinality(d.order_types)>0 AND NOT coalesce(o.order_type=ANY(d.order_types),false) THEN
  RAISE EXCEPTION 'That discount policy does not apply to % orders.',o.order_type; END IF;
 IF coalesce(d.requires_approval,false) AND public.has_permission('pos','discount.approve') IS NOT TRUE THEN
  RAISE EXCEPTION 'This discount needs approval. Ask an authorised manager to apply it.'; END IF;
 IF d.value IS NULL OR d.value<0 OR d.value::text IN ('NaN','Infinity','-Infinity')
  OR (d.discount_type='percentage' AND d.value>100)
  OR (d.max_value IS NOT NULL AND (d.max_value<0 OR d.max_value::text IN ('NaN','Infinity','-Infinity'))) THEN
  RAISE EXCEPTION 'That discount policy has an invalid amount or cap.' USING ERRCODE='22023'; END IF;
 -- Preserve the installed policy-mode arithmetic; retain its database approval guards.
 _amount:=round(CASE WHEN d.discount_type='percentage' THEN o.subtotal*d.value/100.0 ELSE d.value END,2);
 _cap:=coalesce(d.max_value,_amount);
 _amount:=least(_amount,_cap,o.subtotal);
 UPDATE public.pos_orders SET discount_total=_amount WHERE id=o.id;
 PERFORM public.emit_domain_event(o.organization_id,o.branch_id,'pos.discount.applied','pos',o.id,
  jsonb_build_object('discount_id',d.id,'discount_name',d.name,'amount',_amount,'capped_at',d.max_value,'reason',_reason),NULL,NULL);
 RETURN jsonb_build_object('ok',true,'discount_total',_amount,
  'capped',_cap<round(CASE WHEN d.discount_type='percentage' THEN o.subtotal*d.value/100.0 ELSE d.value END,2));
END;
$function$;

DO $verify$
BEGIN
 IF md5(pg_get_functiondef('public.neo_pos_apply_discount(uuid,uuid,text)'::regprocedure))<>'0c1ff88bb7e414484470dfd750f7454a'
  OR NOT EXISTS(SELECT 1 FROM pg_proc p CROSS JOIN neo_discount_acl_before b
   WHERE p.oid='public.neo_pos_apply_discount(uuid,uuid,text)'::regprocedure
   AND md5(coalesce(p.proacl::text,''))=b.acl_hash) THEN
  RAISE EXCEPTION 'Discount definition or unchanged permission verification failed; installation rolled back.';
 END IF;
END $verify$;
SELECT jsonb_build_object('diagnostic_version','pos-discount-collection-guard-v1',
 'definition_matches',md5(pg_get_functiondef('public.neo_pos_apply_discount(uuid,uuid,text)'::regprocedure))='0c1ff88bb7e414484470dfd750f7454a',
 'permissions_unchanged',EXISTS(SELECT 1 FROM pg_proc p CROSS JOIN neo_discount_acl_before b
  WHERE p.oid='public.neo_pos_apply_discount(uuid,uuid,text)'::regprocedure AND md5(coalesce(p.proacl::text,''))=b.acl_hash),
 'scope','Protects future discount commands against pending or recorded collections, validates configured policy amounts/hours and retains approval checks. Installation changes no bill, payment, policy, stock, history or permission.');
COMMIT;
