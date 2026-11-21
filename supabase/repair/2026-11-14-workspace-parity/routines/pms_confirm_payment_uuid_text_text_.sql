CREATE OR REPLACE FUNCTION public.pms_confirm_payment(_payment uuid, _reference text DEFAULT NULL::text, _note text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE org uuid:=public.current_org_id(); p public.payments; f public.folios; allocated numeric; allocation_count integer;
BEGIN
 IF org IS NULL THEN RETURN jsonb_build_object('ok',false,'reason','no_organisation'); END IF;
 IF NOT (public.has_permission('pms','payments.confirm') OR public.has_permission('finance','approve') OR public.is_org_admin() OR public.neo_system_posting()) THEN RAISE EXCEPTION 'Not permitted to confirm payments' USING ERRCODE='42501'; END IF;
 PERFORM public.neo_pms_collection_lock((SELECT folio_id FROM public.payments WHERE id=_payment AND organization_id=org));
 SELECT * INTO p FROM public.payments WHERE id=_payment AND organization_id=org FOR UPDATE;
 IF p.id IS NULL THEN RETURN jsonb_build_object('ok',false,'reason','not_found'); END IF;
 IF NOT coalesce(public.neo_branch_in_scope(p.branch_id),false) THEN RAISE EXCEPTION 'Payment is outside your property scope' USING ERRCODE='42501'; END IF;
 IF p.status='confirmed' THEN RETURN jsonb_build_object('ok',true,'reason','already_confirmed','payment_id',p.id); END IF;
 IF p.status NOT IN ('pending','processing','submitted') THEN RETURN jsonb_build_object('ok',false,'reason','invalid_status','status',p.status); END IF;
 IF p.method NOT IN ('cash','corporate-credit','card','bank-transfer','bank','bank_transfer','eft','voucher','ota-prepaid','debit-card','credit-card') THEN RETURN jsonb_build_object('ok',false,'reason','provider_confirmation_required','detail','This provider-backed payment requires its verified provider confirmation.'); END IF;
 IF p.amount IS NULL OR p.amount<=0 OR p.amount::text IN ('NaN','Infinity','-Infinity') OR p.amount<>round(p.amount,2) THEN RAISE EXCEPTION 'Payment amount is invalid'; END IF;
 IF p.method NOT IN ('cash','corporate-credit') AND nullif(btrim(coalesce(_reference,p.external_reference,'')),'') IS NULL THEN RETURN jsonb_build_object('ok',false,'reason','reference_required','detail','External payments require a confirmation reference.'); END IF;
 SELECT * INTO f FROM public.folios WHERE id=p.folio_id AND organization_id=org FOR UPDATE;
 IF f.id IS NULL THEN RETURN jsonb_build_object('ok',false,'reason','folio_not_found'); END IF;
 IF f.status NOT IN ('open','under-review') THEN RETURN jsonb_build_object('ok',false,'reason','folio_not_open','status',f.status); END IF;
 IF p.branch_id IS DISTINCT FROM f.branch_id OR p.currency IS DISTINCT FROM f.currency THEN RAISE EXCEPTION 'Payment property or currency differs from the folio'; END IF;
 IF p.amount>public.neo_pms_collection_headroom(f.id,p.id,NULL)+0.005 THEN RAISE EXCEPTION 'Payment exceeds the current unpaid amount after other pending collections'; END IF;
 SELECT count(*),coalesce(sum(a.amount),0) INTO allocation_count,allocated FROM public.payment_allocations a WHERE a.payment_id=p.id AND a.organization_id=org;
 IF allocation_count>0 AND (allocation_count<>1 OR allocated IS DISTINCT FROM p.amount OR NOT EXISTS(SELECT 1 FROM public.payment_allocations a WHERE a.payment_id=p.id AND a.folio_id=f.id AND a.organization_id=org AND a.amount=p.amount)) THEN RAISE EXCEPTION 'Existing payment allocations need review before confirmation'; END IF;
 IF allocation_count=0 THEN
  INSERT INTO public.payment_allocations(organization_id,payment_id,folio_id,amount,created_by) VALUES(org,p.id,f.id,p.amount,auth.uid());
  UPDATE public.folios SET total_payments=total_payments+p.amount,balance=balance-p.amount,updated_at=now() WHERE id=f.id AND organization_id=org;
 END IF;
 UPDATE public.payments SET status='confirmed',external_reference=coalesce(nullif(btrim(_reference),''),external_reference),notes=concat_ws(' · ',nullif(notes,''),nullif(_note,'')),paid_at=now(),updated_at=now() WHERE id=p.id AND organization_id=org;
 INSERT INTO public.audit_logs(organization_id,user_id,user_name,action,module,record_id,new_value,reason) VALUES(org,auth.uid(),'','pms.payment.confirm','finance',p.id::text,jsonb_build_object('folio_id',f.id,'amount',p.amount,'method',p.method,'reference',coalesce(nullif(btrim(_reference),''),p.external_reference)),_note);
 RETURN jsonb_build_object('ok',true,'payment_id',p.id,'folio_id',f.id,'amount',p.amount,'balance',(SELECT balance FROM public.folios WHERE id=f.id AND organization_id=org));
END $function$
