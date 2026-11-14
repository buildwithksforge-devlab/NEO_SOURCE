CREATE OR REPLACE FUNCTION public.neo_reservation_deposit_record(_reservation uuid, _amount numeric, _method text DEFAULT 'cash'::text, _reference text DEFAULT NULL::text, _idempotency_key text DEFAULT NULL::text, _notes text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  _org uuid := public.current_org_id();
  _res public.reservations;
  _id uuid;
  _existing uuid;
  _post jsonb; _saved public.reservation_deposits; _facts jsonb;
BEGIN
  IF NOT (public.has_permission('pms','reservations.edit') OR public.has_permission('finance','collections.record_payment')) THEN
    RAISE EXCEPTION 'Not permitted to record a reservation deposit';
  END IF;
  IF COALESCE(_amount,0) <= 0 THEN RAISE EXCEPTION 'A deposit must be greater than zero'; END IF;
  IF NULLIF(btrim(COALESCE(_idempotency_key,'')), '') IS NULL THEN RAISE EXCEPTION 'A deposit idempotency key is required'; END IF;

   IF _amount::text IN ('NaN','Infinity','-Infinity') OR _amount<>round(_amount,2) THEN RAISE EXCEPTION 'Deposit amount must be finite and in currency cents'; END IF;
   IF coalesce(nullif(lower(_method),''),'cash') NOT IN ('cash','card','bank-transfer','bank','bank_transfer','eft','voucher') THEN RAISE EXCEPTION 'This deposit method needs a verified collection workflow; do not record an unconfirmed provider payment as a received deposit'; END IF;
   IF coalesce(nullif(lower(_method),''),'cash')<>'cash' AND nullif(btrim(_reference),'') IS NULL THEN RAISE EXCEPTION 'A received non-cash deposit requires its bank, terminal or voucher confirmation reference'; END IF;
   PERFORM pg_advisory_xact_lock(hashtextextended(_org::text||':deposit-intent:'||_idempotency_key,0));
   PERFORM pg_advisory_xact_lock(hashtextextended(_org::text||':reservation-collection:'||_reservation::text,0));
  SELECT * INTO _res FROM public.reservations
   WHERE id = _reservation AND organization_id = _org FOR UPDATE;
  IF _res.id IS NULL THEN RAISE EXCEPTION 'Reservation not found'; END IF;
  IF NOT coalesce(public.neo_branch_in_scope(_res.branch_id),false) THEN RAISE EXCEPTION 'Reservation is outside your property scope' USING ERRCODE='42501'; END IF;

  SELECT id INTO _existing FROM public.reservation_deposits
   WHERE organization_id = _org AND idempotency_key = _idempotency_key;
  IF _existing IS NOT NULL THEN
      SELECT * INTO _saved FROM public.reservation_deposits WHERE id=_existing AND organization_id=_org;
      IF _saved.reservation_id IS DISTINCT FROM _res.id OR _saved.branch_id IS DISTINCT FROM _res.branch_id OR _saved.amount IS DISTINCT FROM _amount OR _saved.method IS DISTINCT FROM coalesce(nullif(lower(_method),''),'cash') OR _saved.currency IS DISTINCT FROM public.neo_fact_currency(_org,_res.branch_id) OR _saved.status NOT IN ('held','applied') THEN RAISE EXCEPTION 'Deposit collection key already belongs to different details. Review the saved collection.' USING ERRCODE='23514'; END IF;
    _post := public.neo_deposit_post(_existing, true);
    RETURN jsonb_build_object('deposit_id', _existing, 'idempotent', true,
      'position', public.neo_reservation_deposit_position(_reservation), 'finance', _post);
  END IF;

    IF _res.status NOT IN ('enquiry','on-hold','waitlisted','tentative','pending-deposit','confirmed','guaranteed','provisional-hold','awaiting-deposit') THEN RAISE EXCEPTION 'Record further collections against the active folio after arrival; do not create another pre-arrival deposit'; END IF;
    _facts:=public.neo_reservation_collection_facts(_reservation);
    IF _amount>(_facts->>'headroom')::numeric+0.005 THEN RAISE EXCEPTION 'Deposit exceeds the unpaid booking amount after pending collections'; END IF;
  INSERT INTO public.reservation_deposits
    (organization_id, branch_id, reservation_id, customer_id, amount, method,
     reference, received_by, idempotency_key, notes, currency)
  VALUES
    (_org, _res.branch_id, _reservation, _res.customer_id, round(_amount,2),
     COALESCE(NULLIF(lower(_method),''),'cash'), NULLIF(btrim(COALESCE(_reference,'')),''),
     auth.uid(), _idempotency_key, _notes, public.neo_fact_currency(_org,_res.branch_id))
  RETURNING id INTO _id;

  UPDATE public.reservations r
     SET deposit_paid = (SELECT COALESCE(sum(d.amount),0) FROM public.reservation_deposits d
                          WHERE d.reservation_id = _reservation AND d.status IN ('held','applied')),
         updated_at = now()
   WHERE r.id = _reservation;

  _post := public.neo_deposit_post(_id, true);
  RETURN jsonb_build_object('deposit_id', _id, 'idempotent', false,
    'position', public.neo_reservation_deposit_position(_reservation), 'finance', _post);
END;
$function$
