-- STAGED ONLY: reconcile each stay folio separately and retain per-folio settlement evidence.
-- Installation changes no guest, payment, charge, room or journal row.
BEGIN;
DO $guard$ BEGIN
 IF to_regprocedure('public.neo_folio_financial_components(uuid,uuid)') IS NULL THEN RAISE EXCEPTION 'Canonical Finance calculation is missing'; END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_proc p JOIN pg_roles r ON r.oid=p.proowner
 WHERE p.oid=to_regprocedure('public.pms_check_out(uuid,boolean,text)') AND r.rolname NOT IN ('anon','authenticated')
 AND md5(regexp_replace(regexp_replace(p.prosrc,'--[^'||chr(10)||']*','','g'),'[[:space:]]','','g')) IN ('050eb10752ff4ae40265dcc7cb4c2e97','e9bd1cfa8cb67b4a76c7326459b338b1','07cc04cb81587b9938de7969fbc2ddf8')) THEN
 RAISE EXCEPTION 'Checkout differs from reviewed source; nothing replaced'; END IF;
END $guard$;
CREATE TEMP TABLE neo_multifolio_checkout_acl ON COMMIT DROP AS SELECT proowner,coalesce(proacl::text,'') acl
 FROM pg_proc WHERE oid='public.pms_check_out(uuid,boolean,text)'::regprocedure;
CREATE OR REPLACE FUNCTION public.pms_check_out(_reservation uuid, _force boolean DEFAULT false, _notes text DEFAULT ''::text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE
  org uuid := public.current_org_id();
  stay_record public.stays;
  folio_record public.folios;
  parts jsonb;
  summaries jsonb := '[]'::jsonb;
  summary jsonb;
  result jsonb;
  primary_folio uuid;
  currency_code text;
  charges numeric;
  collected numeric;
  balance numeric;
  total_charges numeric := 0;
  total_collected numeric := 0;
  total_outstanding numeric := 0;
  forced boolean := false;
  previous_posting text;
BEGIN
  IF auth.uid() IS NULL OR org IS NULL OR NOT coalesce(
    public.has_permission('pms','checkout.perform') OR public.is_org_admin(),false
  ) THEN RAISE EXCEPTION 'Not permitted to check out guests' USING ERRCODE='42501'; END IF;

  -- Same reservation collection lock used by recorded/confirmed payments.
  PERFORM pg_advisory_xact_lock(hashtextextended(org::text||':reservation-collection:'||_reservation::text,0));
  SELECT * INTO stay_record FROM public.stays
    WHERE reservation_id=_reservation AND organization_id=org FOR UPDATE;
  IF stay_record.id IS NULL THEN RAISE EXCEPTION 'No stay found for this reservation'; END IF;
  IF NOT coalesce(public.neo_branch_in_scope(stay_record.branch_id),false) THEN
    RAISE EXCEPTION 'Stay outside authorized property scope' USING ERRCODE='42501';
  END IF;
  IF stay_record.status='checked-out' THEN
    SELECT a.new_value INTO result FROM public.audit_logs a
      WHERE a.organization_id=org AND a.branch_id=stay_record.branch_id
        AND a.action='pms.checkout' AND a.record_id=_reservation::text
        AND a.new_value->>'stay_id'=stay_record.id::text AND a.new_value ? 'folios'
      LIMIT 1;
    RETURN coalesce(result,jsonb_build_object('stay_id',stay_record.id,'legacy_result',true))
      || jsonb_build_object('idempotent',true);
  END IF;
  IF coalesce(stay_record.status,'') NOT IN ('checked-in','checked_in','in-house','in_house') THEN
    RAISE EXCEPTION 'Stay cannot check out from status %',stay_record.status;
  END IF;
  IF NOT EXISTS(SELECT 1 FROM public.reservations r WHERE r.id=_reservation
    AND r.organization_id=org AND r.branch_id=stay_record.branch_id) THEN
    RAISE EXCEPTION 'Reservation and stay property require reconciliation';
  END IF;
  IF stay_record.room_id IS NULL OR NOT EXISTS(SELECT 1 FROM public.rooms r
    WHERE r.id=stay_record.room_id AND r.organization_id=org AND r.branch_id=stay_record.branch_id) THEN
    RAISE EXCEPTION 'Assigned room and stay property require reconciliation';
  END IF;
  IF EXISTS(SELECT 1 FROM public.folios f WHERE f.stay_id=stay_record.id
    AND (f.organization_id IS DISTINCT FROM org OR f.branch_id IS DISTINCT FROM stay_record.branch_id
      OR (f.reservation_id IS NOT NULL AND f.reservation_id IS DISTINCT FROM _reservation))) THEN
    RAISE EXCEPTION 'Stay folios contain conflicting property or reservation ownership';
  END IF;

  -- Folios without reservation_id use their own collection lock in existing payment paths.
  FOR folio_record IN SELECT * FROM public.folios WHERE stay_id=stay_record.id AND organization_id=org ORDER BY id LOOP
    PERFORM pg_advisory_xact_lock(hashtextextended(org::text||':reservation-collection:'||coalesce(folio_record.reservation_id,folio_record.id)::text,0));
  END LOOP;

  -- Existing canonical Finance counts a payment on its saved folio exactly once.
  -- Refuse ambiguous legacy cross-folio allocations instead of netting or guessing.
  IF EXISTS(SELECT 1 FROM public.payments p JOIN public.folios f ON f.id=p.folio_id
    WHERE f.stay_id=stay_record.id AND p.status IN ('confirmed','posted','completed')
      AND (p.organization_id IS DISTINCT FROM org OR p.currency IS DISTINCT FROM f.currency
        OR p.amount IS NULL OR p.amount::text IN ('NaN','Infinity','-Infinity') OR p.amount<>round(p.amount,2))) THEN
    RAISE EXCEPTION 'Confirmed folio collections require reconciliation';
  END IF;
  IF EXISTS(
    SELECT 1 FROM public.payment_allocations a
      JOIN public.payments p ON p.id=a.payment_id
      LEFT JOIN public.folios allocated ON allocated.id=a.folio_id
    WHERE (allocated.stay_id=stay_record.id OR p.folio_id IN (SELECT id FROM public.folios WHERE stay_id=stay_record.id))
      AND p.status IN ('confirmed','posted','completed')
      AND (a.organization_id IS DISTINCT FROM org OR p.organization_id IS DISTINCT FROM org
        OR allocated.organization_id IS DISTINCT FROM org OR allocated.branch_id IS DISTINCT FROM stay_record.branch_id
        OR p.folio_id IS DISTINCT FROM a.folio_id OR p.currency IS DISTINCT FROM allocated.currency
        OR a.amount IS NULL OR a.amount::text IN ('NaN','Infinity','-Infinity'))
  ) OR EXISTS(
    SELECT 1 FROM public.payments p WHERE p.folio_id IN (SELECT id FROM public.folios WHERE stay_id=stay_record.id)
      AND p.organization_id=org AND p.status IN ('confirmed','posted','completed')
      AND EXISTS(SELECT 1 FROM public.payment_allocations a WHERE a.payment_id=p.id)
      AND (SELECT sum(a.amount) FROM public.payment_allocations a WHERE a.payment_id=p.id) IS DISTINCT FROM p.amount
  ) THEN RAISE EXCEPTION 'Payment allocation requires per-folio reconciliation before checkout'; END IF;

  FOR folio_record IN SELECT * FROM public.folios WHERE stay_id=stay_record.id AND organization_id=org ORDER BY id FOR UPDATE LOOP
    IF nullif(btrim(folio_record.currency),'') IS NULL THEN RAISE EXCEPTION 'Folio currency is missing'; END IF;
    IF currency_code IS NULL THEN currency_code:=folio_record.currency;
    ELSIF currency_code IS DISTINCT FROM folio_record.currency THEN
      RAISE EXCEPTION 'Checkout requires reconciliation of mixed-currency folios';
    END IF;
    IF folio_record.status NOT IN ('open','under-review','reopened','settled','closed') OR folio_record.status IS NULL THEN
      RAISE EXCEPTION 'Folio % cannot be settled from status %',folio_record.id,folio_record.status;
    END IF;
    parts:=public.neo_folio_financial_components(folio_record.id,org);
    IF coalesce(parts->>'found','false')<>'true' OR parts->>'gross_obligation' IS NULL
      OR parts->>'collected' IS NULL OR parts->>'outstanding' IS NULL THEN
      RAISE EXCEPTION 'Checkout financial projection is incomplete';
    END IF;
    charges:=(parts->>'gross_obligation')::numeric;
    collected:=(parts->>'collected')::numeric;
    balance:=charges-collected;
    IF charges::text IN ('NaN','Infinity','-Infinity') OR collected::text IN ('NaN','Infinity','-Infinity')
      OR balance::text IN ('NaN','Infinity','-Infinity') OR (parts->>'outstanding')::numeric IS DISTINCT FROM balance THEN
      RAISE EXCEPTION 'Checkout financial amounts do not reconcile';
    END IF;
    charges:=round(charges,2); collected:=round(collected,2); balance:=round(charges-collected,2);
    IF balance<0 THEN RAISE EXCEPTION 'Folio % has a credit of %; resolve its refund or transfer before checkout',folio_record.id,-balance; END IF;
    IF balance>0 THEN
      IF NOT coalesce(_force,false) THEN RAISE EXCEPTION 'Folio % is not settled; outstanding balance %',folio_record.id,balance; END IF;
      IF NOT coalesce(public.has_permission('pms','folio.override') OR public.is_org_admin(),false) THEN
        RAISE EXCEPTION 'Checking out with an unsettled balance requires folio override authority';
      END IF;
      IF nullif(btrim(_notes),'') IS NULL THEN RAISE EXCEPTION 'A written reason is required to check out with an unsettled balance'; END IF;
      forced:=true;
    END IF;
    IF primary_folio IS NULL OR folio_record.folio_type='guest' THEN primary_folio:=folio_record.id; END IF;
    summaries:=summaries||jsonb_build_array(jsonb_build_object('folio_id',folio_record.id,
      'folio_number',folio_record.folio_number,'folio_type',folio_record.folio_type,'currency',folio_record.currency,
      'charges',charges,'collected',collected,'outstanding',balance,'status',CASE WHEN balance=0 THEN 'settled' ELSE 'under-review' END));
    total_charges:=total_charges+charges; total_collected:=total_collected+collected; total_outstanding:=total_outstanding+balance;
  END LOOP;
  IF jsonb_array_length(summaries)=0 THEN RAISE EXCEPTION 'No financial folio exists for this stay'; END IF;

  -- Apply only after every included folio passes. Operational failure rolls all summaries back.
  FOR summary IN SELECT value FROM jsonb_array_elements(summaries) LOOP
    UPDATE public.folios SET total_charges=(summary->>'charges')::numeric,
      total_payments=(summary->>'collected')::numeric,balance=(summary->>'outstanding')::numeric,
      status=summary->>'status',closed_at=CASE WHEN (summary->>'outstanding')::numeric=0 THEN coalesce(closed_at,now()) ELSE NULL END,
      updated_at=now() WHERE id=(summary->>'folio_id')::uuid AND organization_id=org;
  END LOOP;
  UPDATE public.stays SET status='checked-out',checked_out_at=now(),checked_out_by=auth.uid(),updated_at=now() WHERE id=stay_record.id AND organization_id=org;
  UPDATE public.reservations SET status='checked-out',payment_status=CASE WHEN total_outstanding=0 THEN 'paid' ELSE 'part-paid' END,
    updated_at=now() WHERE id=_reservation AND organization_id=org;
  UPDATE public.room_assignments SET status='released',updated_at=now()
    WHERE reservation_id=_reservation AND organization_id=org AND status='active';
  IF stay_record.room_id IS NOT NULL THEN
    previous_posting:=coalesce(current_setting('neo.system_posting',true),'off');
    BEGIN
      PERFORM set_config('neo.system_posting','on',true);
      -- Departure never releases an independently controlled maintenance hold.
      PERFORM public.ops_set_room_status(stay_record.room_id,'dirty',NULL,'Guest checked out','pms',_reservation,'vacant');
      PERFORM set_config('neo.system_posting',previous_posting,true);
    EXCEPTION WHEN OTHERS THEN
      PERFORM set_config('neo.system_posting',previous_posting,true);
      RAISE;
    END;
    IF NOT EXISTS(SELECT 1 FROM public.rooms r WHERE r.id=stay_record.room_id AND r.organization_id=org
      AND r.branch_id=stay_record.branch_id AND r.occupancy_status='vacant' AND r.housekeeping_status='dirty') THEN
      RAISE EXCEPTION 'Checkout room release was not saved; reconcile before retrying';
    END IF;
  END IF;
  INSERT INTO public.pms_workflow_events(organization_id,branch_id,event_type,reservation_id,stay_id,folio_id,idempotency_key,created_by)
    VALUES(org,stay_record.branch_id,'guest.checked-out',_reservation,stay_record.id,primary_folio,'checkout:'||_reservation::text,auth.uid())
    ON CONFLICT(organization_id,idempotency_key) DO NOTHING;
  result:=jsonb_build_object('ok',true,'reservation_id',_reservation,'stay_id',stay_record.id,'folio_id',primary_folio,
    'folio_count',jsonb_array_length(summaries),'folios',summaries,'charges',total_charges,'collected',total_collected,
    'outstanding',total_outstanding,'forced',forced,'idempotent',false,'room_state','vacant-dirty');
  INSERT INTO public.audit_logs(organization_id,branch_id,user_id,user_name,action,module,record_id,new_value,reason)
    VALUES(org,stay_record.branch_id,auth.uid(),'','pms.checkout','front-office',_reservation::text,result,_notes);
  RETURN result;
END;
$function$;
DO $verify$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_proc p CROSS JOIN neo_multifolio_checkout_acl old
 WHERE p.oid='public.pms_check_out(uuid,boolean,text)'::regprocedure AND p.proowner=old.proowner AND coalesce(p.proacl::text,'')=old.acl) THEN
 RAISE EXCEPTION 'Checkout owner or grants changed'; END IF;
END $verify$;
COMMIT;
