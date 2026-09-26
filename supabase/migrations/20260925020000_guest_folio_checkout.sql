-- Guest folio M-Pesa checkout: customer-owned, idempotent, provider-confirmed only.
CREATE OR REPLACE FUNCTION public.neo_guest_folio_mpesa_start(_org uuid, _folio uuid, _msisdn text, _amount numeric DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE _cust uuid:=public.my_customer_id(); f public.folios; _digits text; _due numeric; _take numeric; _env text; _code text; _pay uuid; _txn uuid; _idem text;
BEGIN
 IF _cust IS NULL THEN RAISE EXCEPTION 'This account is not linked to a guest profile'; END IF;
 SELECT * INTO f FROM public.folios WHERE id=_folio AND organization_id=_org AND customer_id=_cust FOR UPDATE;
 IF f.id IS NULL THEN RAISE EXCEPTION 'Folio not found'; END IF;
 _due:=GREATEST(COALESCE(f.balance,0),0); IF _due<=0 THEN RAISE EXCEPTION 'This folio has no outstanding balance'; END IF;
 _take:=LEAST(COALESCE(NULLIF(_amount,0),_due),_due); IF _take<=0 THEN RAISE EXCEPTION 'Payment amount must be greater than zero'; END IF;
 _digits:=regexp_replace(COALESCE(_msisdn,''),'[^0-9]','','g'); IF length(_digits)<9 THEN RAISE EXCEPTION 'A valid mobile number is required'; END IF;
 SELECT environment,short_code INTO _env,_code FROM public.mpesa_settings WHERE organization_id=_org AND COALESCE(enabled,true) LIMIT 1;
 IF _code IS NULL THEN RAISE EXCEPTION 'Mobile payment is not configured for this property'; END IF;
 _idem:='guest-folio-mpesa:'||f.id::text||':'||round(_take,2)::text||':'||_digits;
 SELECT id INTO _pay FROM public.payments WHERE organization_id=_org AND idempotency_key=_idem AND status IN ('pending','confirmed') ORDER BY created_at DESC LIMIT 1;
 IF _pay IS NULL THEN
   INSERT INTO public.payments(organization_id,branch_id,receipt_number,folio_id,customer_id,amount,currency,method,status,paid_at,received_by,notes,idempotency_key,source_module,source_record_id)
   VALUES(_org,f.branch_id,'PENDING-'||upper(substr(replace(gen_random_uuid()::text,'-',''),1,12)),f.id,_cust,round(_take,2),COALESCE(f.currency,'KES'),'mpesa','pending',now(),NULL,'Guest app folio checkout',_idem,'guest_folio',f.id::text)
   RETURNING id INTO _pay;
 END IF;
 SELECT id INTO _txn FROM public.mpesa_transactions WHERE organization_id=_org AND payment_table='payments' AND payment_id=_pay AND status IN ('initiated','pending') ORDER BY created_at DESC LIMIT 1;
 IF _txn IS NULL THEN
   INSERT INTO public.mpesa_transactions(organization_id,branch_id,source_module,source_record_id,payment_table,payment_id,msisdn,amount,account_reference,description,environment,short_code,status,created_by)
   VALUES(_org,f.branch_id,'guest_folio',f.id,'payments',_pay,_digits,round(_take,2),COALESCE(f.folio_number,f.id::text),'Guest folio payment',COALESCE(_env,'sandbox'),_code,'initiated',NULL)
   RETURNING id INTO _txn;
 END IF;
 RETURN jsonb_build_object('ok',true,'payment_id',_pay,'transaction_id',_txn,'amount',round(_take,2),'folio_id',f.id,'environment',COALESCE(_env,'sandbox'));
END $$;
REVOKE ALL ON FUNCTION public.neo_guest_folio_mpesa_start(uuid,uuid,text,numeric) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.neo_guest_folio_mpesa_start(uuid,uuid,text,numeric) TO authenticated,service_role;
