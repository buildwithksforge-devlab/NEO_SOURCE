BEGIN;
DO $guard$ BEGIN IF md5(pg_get_functiondef(to_regprocedure('public.pms_record_payment(uuid,numeric,text,text,text,text,uuid)'))) IS DISTINCT FROM '5d84717f3b671041607d9105f0988744' THEN RAISE EXCEPTION 'PMS payment definition differs; inspect before installation'; END IF; END $guard$;
CREATE OR REPLACE FUNCTION public.pms_record_payment(_folio uuid, _amount numeric, _method text, _reference text DEFAULT NULL::text, _notes text DEFAULT ''::text, _intent_key text DEFAULT NULL::text, _account uuid DEFAULT NULL::uuid)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE _org uuid := public.current_org_id(); _f public.folios; _id uuid; _receipt text; _status text; _shift uuid; _req public.cash_payment_requests; _settled jsonb; _key text; _acct uuid; _saved public.payments;
BEGIN
  IF NOT (public.has_permission('pms','payments.record') OR public.is_org_admin() OR public.neo_system_posting()) THEN RAISE EXCEPTION 'Not permitted to record payments'; END IF;
  IF _amount IS NULL OR _amount <= 0 THEN RAISE EXCEPTION 'Payment amount must be greater than zero'; END IF;
  SELECT * INTO _f FROM public.folios WHERE id=_folio AND organization_id=_org FOR UPDATE;
  IF _f.id IS NULL THEN RAISE EXCEPTION 'Folio not found'; END IF;
  IF _org='aa17d427-f816-49bc-b02e-1a89e44806a2'::uuid THEN
    IF NOT coalesce(public.neo_branch_in_scope(_f.branch_id),false) THEN RAISE EXCEPTION 'Payment source is outside your property scope' USING ERRCODE='42501'; END IF;
    IF _amount::text IN ('NaN','Infinity','-Infinity') OR _amount<>round(_amount,2) THEN RAISE EXCEPTION 'Payment amount must be finite and in currency cents' USING ERRCODE='22023'; END IF;
  END IF;

  IF _account IS NOT NULL THEN
    SELECT b.id INTO _acct FROM public.bank_accounts b
     WHERE b.id = _account AND b.organization_id = _org AND b.active
       AND (b.branch_id IS NULL OR _f.branch_id IS NULL OR b.branch_id = _f.branch_id);
    IF _acct IS NULL THEN RAISE EXCEPTION 'Selected receiving account is not available for this property'; END IF;
  END IF;

  _key := NULLIF(btrim(coalesce(_intent_key,'')), '');
  IF _key IS NULL THEN
    _key := 'pms:payment:' || encode(extensions.digest(
      _folio::text || '|' || round(_amount,2)::text || '|' || _method || '|' ||
      coalesce(_reference,'') || '|' || coalesce(auth.uid()::text,'system') || '|' ||
      to_char(now() at time zone 'utc', 'YYYYMMDD"T"HH24MI'), 'sha256'), 'hex');
  END IF;

  IF _org='aa17d427-f816-49bc-b02e-1a89e44806a2'::uuid THEN
    PERFORM pg_advisory_xact_lock(hashtextextended(_org::text||':pms-collection:'||_key,0));
  END IF;
  SELECT p.* INTO _saved FROM public.payments p WHERE p.organization_id=_org AND p.idempotency_key=_key LIMIT 1;
  IF _saved.id IS NOT NULL THEN
    IF _org='aa17d427-f816-49bc-b02e-1a89e44806a2'::uuid AND (_saved.folio_id IS DISTINCT FROM _f.id OR _saved.branch_id IS DISTINCT FROM _f.branch_id OR _saved.amount IS DISTINCT FROM _amount OR _saved.currency IS DISTINCT FROM _f.currency OR _saved.method IS DISTINCT FROM _method OR _saved.destination_account_id IS DISTINCT FROM _acct) THEN RAISE EXCEPTION 'Payment collection key was already used for different payment details' USING ERRCODE='23514'; END IF;
    RETURN _saved.id;
  END IF;
  IF _org='aa17d427-f816-49bc-b02e-1a89e44806a2'::uuid AND EXISTS(SELECT 1 FROM public.cash_payment_requests r WHERE r.organization_id=_org AND r.idempotency_key=_key) THEN
    SELECT * INTO _req FROM public.cash_payment_requests r WHERE r.organization_id=_org AND r.idempotency_key=_key;
    IF _method IS DISTINCT FROM 'cash' OR _req.folio_id IS DISTINCT FROM _f.id OR _req.amount IS DISTINCT FROM _amount OR _req.currency IS DISTINCT FROM _f.currency THEN RAISE EXCEPTION 'Collection key already belongs to a cash request; review the saved collection' USING ERRCODE='23514'; END IF;
    _settled:=public.neo_cash_settle_request(_req.id); RETURN (_settled->>'payment_id')::uuid;
  END IF;

  IF _f.status NOT IN ('open','under-review') THEN RAISE EXCEPTION 'Folio is % and cannot accept payments', _f.status; END IF;

  IF _method = 'cash' THEN
    SELECT * INTO _req
      FROM public.cash_payment_requests r
     WHERE r.organization_id = _org
       AND r.folio_id = _folio
       AND r.status = 'pending'
       AND r.method = _method
       AND abs(coalesce(r.amount,0) - _amount) < 0.01
     ORDER BY r.created_at ASC
     LIMIT 1;
    IF _req.id IS NOT NULL THEN
      _settled := public.neo_cash_settle_request(_req.id);
      RETURN (_settled ->> 'payment_id')::uuid;
    END IF;
  END IF;

  IF _method = 'cash' THEN
    SELECT s.id INTO _shift
      FROM public.pos_shifts s
     WHERE s.cashier_id = auth.uid()
       AND s.status = 'open'
       AND s.organization_id = _org
       AND (s.branch_id IS NULL OR _f.branch_id IS NULL OR s.branch_id = _f.branch_id)
     ORDER BY (s.branch_id = _f.branch_id) DESC NULLS LAST, s.opened_at DESC
     LIMIT 1;
    IF _shift IS NULL THEN
      RAISE EXCEPTION 'Open your cash drawer before taking cash at this desk';
    END IF;
  END IF;

  _status := CASE WHEN _method IN ('cash','corporate-credit') THEN 'confirmed' ELSE 'pending' END;
  _receipt := public.next_document_number('receipt');

  BEGIN
    INSERT INTO public.payments (organization_id, branch_id, receipt_number, folio_id, reservation_id,
      customer_id, amount, currency, method, external_reference, status, received_by, notes, shift_id,
      source_module, idempotency_key, destination_account_id)
    VALUES (_org, _f.branch_id, _receipt, _folio, _f.reservation_id, _f.customer_id, _amount, _f.currency,
      _method, _reference, _status, auth.uid(), COALESCE(_notes,''), _shift, 'pms', _key, _acct)
    RETURNING id INTO _id;
  EXCEPTION WHEN unique_violation THEN
    SELECT p.* INTO _saved FROM public.payments p WHERE p.organization_id=_org AND p.idempotency_key=_key LIMIT 1;
    IF _saved.id IS NULL THEN RAISE; END IF;
    IF _org='aa17d427-f816-49bc-b02e-1a89e44806a2'::uuid AND (_saved.folio_id IS DISTINCT FROM _f.id OR _saved.branch_id IS DISTINCT FROM _f.branch_id OR _saved.amount IS DISTINCT FROM _amount OR _saved.currency IS DISTINCT FROM _f.currency OR _saved.method IS DISTINCT FROM _method OR _saved.destination_account_id IS DISTINCT FROM _acct) THEN RAISE EXCEPTION 'Payment collection key was already used for different payment details' USING ERRCODE='23514'; END IF;
    RETURN _saved.id;
  END;

  IF _status = 'confirmed' THEN
    INSERT INTO public.payment_allocations (organization_id, payment_id, folio_id, amount, created_by)
    VALUES (_org, _id, _folio, _amount, auth.uid());
    UPDATE public.folios SET total_payments = total_payments + _amount,
      balance = balance - _amount, updated_at = now() WHERE id=_folio;
  END IF;

  INSERT INTO public.audit_logs (organization_id, user_id, user_name, action, module, record_id, new_value, reason)
  VALUES (_org, auth.uid(), '', 'pms.payment.record', 'finance', _id::text,
    jsonb_build_object('folio_id',_folio,'amount',_amount,'method',_method,'status',_status,'shift_id',_shift,'intent_key',_key,'destination_account_id',_acct), _notes);
  RETURN _id;
END $function$
;
COMMIT;
