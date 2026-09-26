CREATE OR REPLACE FUNCTION public.pms_check_out(_reservation uuid, _force boolean DEFAULT false, _notes text DEFAULT ''::text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  _org uuid := public.current_org_id(); _stay public.stays; _f public.folios;
  _charges numeric := 0; _paid numeric := 0; _line_paid numeric := 0; _outstanding numeric := 0;
BEGIN
  IF NOT public.has_permission('pms','checkout.perform') THEN RAISE EXCEPTION 'Not permitted to check out guests'; END IF;
  SELECT * INTO _stay FROM public.stays WHERE reservation_id=_reservation AND organization_id=_org FOR UPDATE;
  IF _stay.id IS NULL THEN RAISE EXCEPTION 'No stay found for this reservation'; END IF;
  IF _stay.status='checked-out' THEN RETURN jsonb_build_object('stay_id',_stay.id,'idempotent',true); END IF;
  SELECT * INTO _f FROM public.folios WHERE stay_id=_stay.id AND folio_type='guest' FOR UPDATE;

  SELECT COALESCE(sum(l.net_amount),0) INTO _charges FROM public.folio_lines l
   JOIN public.folios f ON f.id=l.folio_id WHERE f.stay_id=_stay.id
   AND COALESCE(l.status,'posted') NOT IN ('void','voided','reversed')
   AND COALESCE(l.line_type,'charge') NOT IN ('payment','deposit','refund');
  SELECT COALESCE(sum(a.amount),0) INTO _paid FROM public.payment_allocations a
   JOIN public.folios f ON f.id=a.folio_id JOIN public.payments p ON p.id=a.payment_id
   WHERE f.stay_id=_stay.id AND p.status='confirmed';
  SELECT COALESCE(sum(l.net_amount),0) INTO _line_paid FROM public.folio_lines l
   JOIN public.folios f ON f.id=l.folio_id WHERE f.stay_id=_stay.id
   AND COALESCE(l.status,'posted') NOT IN ('void','voided','reversed')
   AND COALESCE(l.line_type,'charge') IN ('payment','deposit');
  _outstanding := round(_charges-_paid-_line_paid,2);

  IF _outstanding > 0 THEN
    IF NOT _force THEN RAISE EXCEPTION 'Folio is not settled — outstanding balance of %. Settle the bill before check-out.',_outstanding; END IF;
    IF NOT (public.has_permission('pms','folio.override') OR public.is_org_admin()) THEN RAISE EXCEPTION 'Checking out with an unsettled balance requires folio override authority.'; END IF;
    IF btrim(COALESCE(_notes,''))='' THEN RAISE EXCEPTION 'A written reason is required to check out with an unsettled balance.'; END IF;
  END IF;

  UPDATE public.stays SET status='checked-out',checked_out_at=now(),checked_out_by=auth.uid(),updated_at=now() WHERE id=_stay.id;
  UPDATE public.reservations
     SET status='checked-out',
         payment_status=CASE WHEN _outstanding<=0 THEN 'paid' ELSE 'part-paid' END,
         updated_at=now()
   WHERE id=_reservation AND organization_id=_org;
  UPDATE public.room_assignments SET status='released',updated_at=now() WHERE reservation_id=_reservation AND status='active';
  IF _f.id IS NOT NULL THEN
    UPDATE public.folios SET total_charges=_charges,total_payments=_paid+_line_paid,balance=_outstanding,
      status=CASE WHEN _outstanding<=0 THEN 'settled' ELSE 'under-review' END,
      closed_at=CASE WHEN _outstanding<=0 THEN now() ELSE NULL END,updated_at=now() WHERE id=_f.id;
  END IF;
  IF _stay.room_id IS NOT NULL THEN
    PERFORM set_config('neo.system_posting','on',true);
    PERFORM public.ops_set_room_status(_stay.room_id,'dirty','operational','Guest checked out','pms',_reservation,'vacant');
  END IF;
  INSERT INTO public.pms_workflow_events
    (organization_id,branch_id,event_type,reservation_id,stay_id,folio_id,idempotency_key,created_by)
  VALUES (_org,_stay.branch_id,'guest.checked-out',_reservation,_stay.id,_f.id,'checkout:'||_reservation::text,auth.uid())
  ON CONFLICT (organization_id,idempotency_key) DO NOTHING;
  INSERT INTO public.audit_logs (organization_id,branch_id,user_id,user_name,action,module,record_id,new_value,reason)
  VALUES (_org,_stay.branch_id,auth.uid(),'', 'pms.checkout','front-office',_reservation::text,
    jsonb_build_object('stay_id',_stay.id,'folio_id',_f.id,'outstanding',_outstanding,'forced',_force AND _outstanding>0),_notes);
  RETURN jsonb_build_object('ok',true,'stay_id',_stay.id,'folio_id',_f.id,'outstanding',_outstanding,'idempotent',false,'room_state','vacant-dirty');
END;
$function$;

REVOKE ALL ON FUNCTION public.pms_check_out(uuid,boolean,text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.pms_check_out(uuid,boolean,text) TO authenticated;