BEGIN;
DO $guard$ BEGIN IF md5(pg_get_functiondef(to_regprocedure('public.neo_cash_request_payment(uuid,numeric,text,text,text)'))) IS DISTINCT FROM '518f3792da29a326e556beffc2656b56' THEN RAISE EXCEPTION 'PMS cash request definition differs; inspect before installation'; END IF; END $guard$;
CREATE OR REPLACE FUNCTION public.neo_cash_request_payment(_folio uuid, _amount numeric, _reference text DEFAULT NULL::text, _notes text DEFAULT ''::text, _idempotency_key text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  _org uuid := public.current_org_id();
  _f public.folios;
  _ctx jsonb;
  _shift uuid; _cashier uuid; _req uuid; _existing public.cash_payment_requests;
BEGIN
  IF NOT (public.has_permission('pms','payments.record') OR public.is_org_admin()) THEN
    RAISE EXCEPTION 'Not permitted to record payments';
  END IF;
  IF _amount IS NULL OR _amount <= 0 THEN RAISE EXCEPTION 'Payment amount must be greater than zero'; END IF;

  IF _org='aa17d427-f816-49bc-b02e-1a89e44806a2'::uuid THEN
    IF _idempotency_key IS NOT NULL THEN
      IF nullif(btrim(_idempotency_key),'') IS NULL THEN RAISE EXCEPTION 'A stable collection key is required'; END IF;
      PERFORM pg_advisory_xact_lock(hashtextextended(_org::text||':pms-collection:'||_idempotency_key,0));
    END IF;
    SELECT * INTO _f FROM public.folios WHERE id=_folio AND organization_id=_org FOR UPDATE;
  ELSE
    SELECT * INTO _f FROM public.folios WHERE id=_folio AND organization_id=_org;
  END IF;
  IF _f.id IS NULL THEN RAISE EXCEPTION 'Folio not found'; END IF;

  IF _org='aa17d427-f816-49bc-b02e-1a89e44806a2'::uuid THEN
    IF NOT coalesce(public.neo_branch_in_scope(_f.branch_id),false) THEN RAISE EXCEPTION 'Cash source is outside your property scope' USING ERRCODE='42501'; END IF;
    IF _amount::text IN ('NaN','Infinity','-Infinity') OR _amount<>round(_amount,2) THEN RAISE EXCEPTION 'Cash amount must be finite and positive' USING ERRCODE='22023'; END IF;
  END IF;
  IF _org='aa17d427-f816-49bc-b02e-1a89e44806a2'::uuid AND _idempotency_key IS NOT NULL AND EXISTS(SELECT 1 FROM public.payments p WHERE p.organization_id=_org AND p.idempotency_key=_idempotency_key) THEN RAISE EXCEPTION 'Collection key already belongs to a recorded payment; review the saved collection' USING ERRCODE='23514'; END IF;
  IF _idempotency_key IS NOT NULL THEN
    SELECT * INTO _existing FROM public.cash_payment_requests
     WHERE organization_id=_org AND idempotency_key=_idempotency_key;
    IF _existing.id IS NOT NULL THEN
      IF _org='aa17d427-f816-49bc-b02e-1a89e44806a2'::uuid AND (_existing.folio_id IS DISTINCT FROM _f.id OR _existing.amount IS DISTINCT FROM _amount OR _existing.currency IS DISTINCT FROM coalesce(_f.currency,'KES') OR _existing.method IS DISTINCT FROM 'cash') THEN RAISE EXCEPTION 'Cash collection key was already used for a different amount, currency or folio' USING ERRCODE='23514'; END IF;
      IF _org='aa17d427-f816-49bc-b02e-1a89e44806a2'::uuid AND (_existing.source_record_id IS DISTINCT FROM _f.id OR _existing.source_module IS DISTINCT FROM 'pms' OR _existing.branch_id IS DISTINCT FROM _f.branch_id) THEN RAISE EXCEPTION 'Cash request intent belongs to a different source or property' USING ERRCODE='23514'; END IF;
      IF _org='aa17d427-f816-49bc-b02e-1a89e44806a2'::uuid AND _existing.status='confirmed' THEN RETURN public.neo_cash_settle_request(_existing.id); END IF;
      RETURN jsonb_build_object('status',_existing.status,'request_id',_existing.id,
        'payment_id',_existing.payment_id,'receipt_number',_existing.receipt_number,'amount',_existing.amount);
    END IF;
  END IF;

  IF _org='aa17d427-f816-49bc-b02e-1a89e44806a2'::uuid AND _f.status NOT IN ('open','under-review') THEN RAISE EXCEPTION 'Folio is % and cannot accept new cash requests',_f.status; END IF;
  _ctx := public.neo_cash_till_context(_f.branch_id);

  IF (_ctx->>'self_service')::boolean THEN
    _shift := (_ctx->>'my_shift_id')::uuid;
    _cashier := auth.uid();
  ELSE
    SELECT s.id, s.cashier_id INTO _shift, _cashier
      FROM public.pos_shifts s
     WHERE s.organization_id=_org AND s.status='open'
       AND (CASE WHEN _org='aa17d427-f816-49bc-b02e-1a89e44806a2'::uuid THEN s.branch_id IS NOT DISTINCT FROM _f.branch_id AND coalesce(public.neo_branch_in_scope(s.branch_id),false) ELSE (s.branch_id IS NULL OR _f.branch_id IS NULL OR s.branch_id=_f.branch_id) END)
     ORDER BY (s.branch_id = _f.branch_id) DESC NULLS LAST, s.opened_at DESC
     LIMIT 1;
  END IF;

  IF _shift IS NULL THEN
    RETURN jsonb_build_object('status','no_till',
      'message','No active cash drawer is available for this outlet.',
      'can_open_drawer', _ctx->'can_open_drawer');
  END IF;

  INSERT INTO public.cash_payment_requests (organization_id, branch_id, source_module, source_record_id,
    folio_id, amount, currency, method, reference, notes, status, requested_by,
    assigned_shift_id, assigned_cashier_id, idempotency_key)
  VALUES (_org, _f.branch_id, 'pms', _f.id, _f.id, _amount, COALESCE(_f.currency,'KES'), 'cash',
    _reference, COALESCE(_notes,''), 'pending', auth.uid(), _shift, _cashier, _idempotency_key)
  RETURNING id INTO _req;

  INSERT INTO public.audit_logs (organization_id, user_id, user_name, action, module, record_id, new_value)
  VALUES (_org, auth.uid(), '', 'finance.cash.request.create', 'finance', _req::text,
    jsonb_build_object('folio_id',_f.id,'amount',_amount,'assigned_shift',_shift,'assigned_cashier',_cashier));

  IF (_ctx->>'self_service')::boolean THEN
    RETURN public.neo_cash_settle_request(_req);
  END IF;

  RETURN jsonb_build_object('status','pending','request_id',_req,'assigned_shift_id',_shift,
    'assigned_cashier_id',_cashier,'amount',_amount);
END; $function$
;
COMMIT;
