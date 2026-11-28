BEGIN;
DO $guard$ BEGIN
 IF md5(pg_get_functiondef(to_regprocedure('public.neo_cash_settle_request(uuid)'))) IS DISTINCT FROM 'c38bd26dca6fc57ae0bf4a8a3b3fb87b' OR md5(pg_get_functiondef(to_regprocedure('public.neo_cash_request_pos_payment(uuid,numeric,text,text,text)'))) IS DISTINCT FROM 'fd97015abbb7c524905ec33fb5160ae8' OR to_regprocedure('public.neo_cash_request_pos_payment(uuid,numeric,text,text,text,numeric)') IS NOT NULL THEN RAISE EXCEPTION 'Cash tender definitions differ; inspect before installation'; END IF;
END $guard$;
ALTER TABLE public.cash_payment_requests ADD COLUMN tendered numeric, ADD COLUMN change_due numeric;
CREATE OR REPLACE FUNCTION public.neo_cash_request_pos_payment(_order uuid, _amount numeric, _reference text, _notes text, _idempotency_key text, _tendered numeric)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  _org uuid := public.current_org_id();
  _o public.pos_orders;
  _ctx jsonb; _shift uuid; _cashier uuid; _req uuid; _existing public.cash_payment_requests;
BEGIN
  IF NOT (public.has_permission('pos','payments.record') OR public.has_permission('pos','orders.edit')
          OR public.is_org_admin()) THEN
    RAISE EXCEPTION 'Not permitted to record payments' USING ERRCODE = '42501';
  END IF;
  IF _amount IS NULL OR _amount <= 0 THEN RAISE EXCEPTION 'Payment amount must be greater than zero'; END IF;

  IF _amount::text IN ('NaN','Infinity','-Infinity') OR _amount<>round(_amount,2) OR _tendered IS NULL OR _tendered::text IN ('NaN','Infinity','-Infinity') OR _tendered<_amount OR _tendered<>round(_tendered,2) THEN RAISE EXCEPTION 'Cash tender must be finite, in cents and at least the payment amount' USING ERRCODE='22023'; END IF;
  IF nullif(btrim(_idempotency_key),'') IS NULL THEN RAISE EXCEPTION 'A stable cash collection key is required' USING ERRCODE='22023'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(_org::text||':cash-intent:'||_idempotency_key,0));
  SELECT * INTO _o FROM public.pos_orders WHERE id=_order AND organization_id=_org FOR UPDATE;
  IF _o.id IS NULL THEN RAISE EXCEPTION 'Order not found'; END IF;

  IF _org='aa17d427-f816-49bc-b02e-1a89e44806a2'::uuid THEN
    IF NOT coalesce(public.neo_branch_in_scope(_o.branch_id),false) THEN RAISE EXCEPTION 'Cash source is outside your property scope' USING ERRCODE='42501'; END IF;
    IF _amount::text IN ('NaN','Infinity','-Infinity') THEN RAISE EXCEPTION 'Cash amount must be finite and positive' USING ERRCODE='22023'; END IF;
  END IF;
  IF _idempotency_key IS NOT NULL THEN
    SELECT * INTO _existing FROM public.cash_payment_requests
     WHERE organization_id=_org AND idempotency_key=_idempotency_key;
    IF _existing.id IS NOT NULL THEN
      IF _existing.source_record_id IS DISTINCT FROM _o.id OR _existing.source_module IS DISTINCT FROM 'pos' OR _existing.branch_id IS DISTINCT FROM _o.branch_id OR _existing.currency IS DISTINCT FROM _o.currency OR _existing.amount IS DISTINCT FROM _amount OR coalesce(_existing.tendered,_existing.amount) IS DISTINCT FROM _tendered THEN RAISE EXCEPTION 'Cash collection key was already used for a different payment or tender' USING ERRCODE='23514'; END IF;
      IF _org='aa17d427-f816-49bc-b02e-1a89e44806a2'::uuid AND (_existing.source_record_id IS DISTINCT FROM _o.id OR _existing.source_module IS DISTINCT FROM 'pos' OR _existing.branch_id IS DISTINCT FROM _o.branch_id) THEN RAISE EXCEPTION 'Cash request intent belongs to a different source or property' USING ERRCODE='23514'; END IF;
      IF _org='aa17d427-f816-49bc-b02e-1a89e44806a2'::uuid AND _existing.status='confirmed' THEN RETURN public.neo_cash_settle_request(_existing.id); END IF;
      RETURN jsonb_build_object('status',_existing.status,'request_id',_existing.id,
        'payment_id',_existing.payment_id,'receipt_number',_existing.receipt_number);
    END IF;
  END IF;

  _ctx := public.neo_cash_till_context(_o.branch_id);

  IF (_ctx->>'self_service')::boolean THEN
    _shift := (_ctx->>'my_shift_id')::uuid; _cashier := auth.uid();
  ELSE
    SELECT s.id, s.cashier_id INTO _shift, _cashier
      FROM public.pos_shifts s
     WHERE s.organization_id=_org AND s.status='open'
       AND (CASE WHEN _org='aa17d427-f816-49bc-b02e-1a89e44806a2'::uuid THEN s.branch_id IS NOT DISTINCT FROM _o.branch_id AND coalesce(public.neo_branch_in_scope(s.branch_id),false) ELSE (s.branch_id IS NULL OR _o.branch_id IS NULL OR s.branch_id=_o.branch_id) END)
     ORDER BY (s.branch_id = _o.branch_id) DESC NULLS LAST, s.opened_at DESC LIMIT 1;
  END IF;

  IF _shift IS NULL THEN
    RETURN jsonb_build_object('status','no_till',
      'message','No active cash drawer is available for this outlet.',
      'can_open_drawer', _ctx->'can_open_drawer');
  END IF;

  INSERT INTO public.cash_payment_requests (organization_id, branch_id, source_module, source_record_id,
    folio_id, amount, currency, method, reference, notes, status, requested_by,
    assigned_shift_id, assigned_cashier_id, idempotency_key, tendered, change_due)
  VALUES (_org, _o.branch_id, 'pos', _o.id, NULL, _amount, COALESCE(_o.currency,'KES'), 'cash',
    COALESCE(_reference, _o.order_number), COALESCE(_notes,''), 'pending', auth.uid(),
    _shift, _cashier, _idempotency_key, _tendered, _tendered-_amount)
  RETURNING id INTO _req;

  INSERT INTO public.audit_logs (organization_id, user_id, user_name, action, module, record_id, new_value)
  VALUES (_org, auth.uid(), '', 'finance.cash.request.create', 'pos', _req::text,
    jsonb_build_object('order_id',_o.id,'amount',_amount,'assigned_shift',_shift,'assigned_cashier',_cashier));

  IF (_ctx->>'self_service')::boolean THEN
    RETURN public.neo_cash_settle_request(_req);
  END IF;

  RETURN jsonb_build_object('status','pending','request_id',_req,'assigned_shift_id',_shift,
    'assigned_cashier_id',_cashier,'amount',_amount);
END; $function$
;
REVOKE ALL ON FUNCTION public.neo_cash_request_pos_payment(uuid,numeric,text,text,text,numeric) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.neo_cash_request_pos_payment(uuid,numeric,text,text,text,numeric) TO authenticated;
CREATE OR REPLACE FUNCTION public.neo_cash_settle_request(_request uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  _org uuid := public.current_org_id();
  _r public.cash_payment_requests;
  _f public.folios;
  _o public.pos_orders;
  _s public.pos_shifts;
  _pay uuid; _receipt text; _paid numeric; _fully boolean; _pending numeric; _headroom numeric;
BEGIN
  SELECT * INTO _r FROM public.cash_payment_requests WHERE id=_request AND organization_id=_org FOR UPDATE;
  IF _r.id IS NULL THEN RAISE EXCEPTION 'Cash request not found'; END IF;

  IF _org='aa17d427-f816-49bc-b02e-1a89e44806a2'::uuid THEN
    IF NOT coalesce(public.neo_branch_in_scope(_r.branch_id),false) THEN RAISE EXCEPTION 'Cash request is outside your property scope' USING ERRCODE='42501'; END IF;
    IF _r.amount IS NULL OR _r.amount<=0 OR _r.amount::text IN ('NaN','Infinity','-Infinity') THEN RAISE EXCEPTION 'Cash amount must be finite and positive'; END IF;
    IF _r.status='confirmed' THEN
      IF auth.uid() IS NULL OR NOT (coalesce(_r.requested_by=auth.uid(),false) OR coalesce(_r.assigned_cashier_id=auth.uid(),false) OR public.has_permission('finance','view') OR public.has_permission('pos','payments.record') OR public.is_org_admin()) THEN RAISE EXCEPTION 'Not permitted to view this cash confirmation' USING ERRCODE='42501'; END IF;
      IF _r.payment_id IS NULL OR nullif(btrim(_r.receipt_number),'') IS NULL OR
         (_r.source_module='pos' AND NOT EXISTS(SELECT 1 FROM public.pos_payments p WHERE p.id=_r.payment_id AND p.organization_id=_org AND p.branch_id IS NOT DISTINCT FROM _r.branch_id AND p.order_id=_r.source_record_id AND p.receipt_number=_r.receipt_number AND p.amount=_r.amount AND p.currency=_r.currency)) OR
         (coalesce(_r.source_module,'')<>'pos' AND NOT EXISTS(SELECT 1 FROM public.payments p WHERE p.id=_r.payment_id AND p.organization_id=_org AND p.branch_id IS NOT DISTINCT FROM _r.branch_id AND p.folio_id=_r.folio_id AND p.receipt_number=_r.receipt_number AND p.amount=_r.amount AND p.currency=_r.currency)) THEN
        RAISE EXCEPTION 'Confirmed cash request lacks matching saved payment and receipt evidence';
      END IF;
    END IF;
  END IF;
  IF _r.status = 'confirmed' THEN
    RETURN jsonb_build_object('status','confirmed','request_id',_r.id,
      'payment_id',_r.payment_id,'receipt_number',_r.receipt_number,'amount',_r.amount);
  END IF;
  IF _r.status <> 'pending' THEN RAISE EXCEPTION 'Cash request is % and cannot be settled', _r.status; END IF;

  SELECT * INTO _s FROM public.pos_shifts WHERE id=_r.assigned_shift_id AND organization_id=_org FOR UPDATE;
  IF _s.id IS NULL OR _s.status <> 'open' THEN
    RAISE EXCEPTION 'The assigned cash drawer is no longer open';
  END IF;

  IF _org='aa17d427-f816-49bc-b02e-1a89e44806a2'::uuid THEN
    IF auth.uid() IS NULL OR _s.status IS DISTINCT FROM 'open' OR _s.branch_id IS DISTINCT FROM _r.branch_id OR _s.cashier_id IS DISTINCT FROM auth.uid() OR (_r.assigned_cashier_id IS NOT NULL AND _r.assigned_cashier_id IS DISTINCT FROM _s.cashier_id) THEN RAISE EXCEPTION 'Only the assigned cashier with an open till in this property may confirm cash' USING ERRCODE='42501'; END IF;
    IF NOT (public.has_permission('finance','till.confirm_cash') OR public.has_permission('finance','till.edit') OR public.has_permission('pos','shifts.open')) THEN RAISE EXCEPTION 'Not permitted to confirm cash' USING ERRCODE='42501'; END IF;
  END IF;
  IF _r.source_module='pos' AND (coalesce(_r.tendered,_r.amount)::text IN ('NaN','Infinity','-Infinity') OR coalesce(_r.tendered,_r.amount)<_r.amount OR coalesce(_r.tendered,_r.amount)<>round(coalesce(_r.tendered,_r.amount),2) OR (_r.change_due IS NOT NULL AND _r.change_due IS DISTINCT FROM coalesce(_r.tendered,_r.amount)-_r.amount)) THEN RAISE EXCEPTION 'Saved cash tender does not agree with payment and change'; END IF;
  _receipt := public.next_document_number('receipt');

  IF _r.source_module = 'pos' THEN
    SELECT * INTO _o FROM public.pos_orders WHERE id=_r.source_record_id AND organization_id=_org FOR UPDATE;
    IF _o.id IS NULL THEN RAISE EXCEPTION 'Order not found'; END IF;
    IF _org='aa17d427-f816-49bc-b02e-1a89e44806a2'::uuid THEN
      IF _o.branch_id IS DISTINCT FROM _r.branch_id OR _o.currency IS DISTINCT FROM _r.currency THEN RAISE EXCEPTION 'Cash source property or currency changed'; END IF;
      IF _o.status IN ('closed','cancelled','voided','charged-to-room') THEN RAISE EXCEPTION 'This order cannot accept further cash'; END IF;
      SELECT coalesce(sum(amount) FILTER(WHERE status='confirmed'),0),coalesce(sum(amount) FILTER(WHERE status IN ('initiated','pending')),0) INTO _paid,_pending FROM public.pos_payments WHERE organization_id=_org AND order_id=_o.id;
      IF _o.grand_total IS NULL OR _o.grand_total::text IN ('NaN','Infinity','-Infinity') OR _paid::text IN ('NaN','Infinity','-Infinity') OR _pending::text IN ('NaN','Infinity','-Infinity') THEN RAISE EXCEPTION 'Order payment amounts are incomplete or non-finite'; END IF;
      _headroom:=round(_o.grand_total-_paid-_pending,2);
      IF _r.amount>_headroom+0.005 THEN RAISE EXCEPTION 'Cash request exceeds the current payment headroom'; END IF;
    END IF;

    INSERT INTO public.pos_payments (organization_id, branch_id, order_id, receipt_number, customer_id,
      amount, tendered, change_due, currency, method, external_reference, status, paid_at, cashier_id, shift_id,
      created_by, idempotency_key)
    VALUES (_org, _o.branch_id, _o.id, _receipt, _o.customer_id, _r.amount, coalesce(_r.tendered,_r.amount), coalesce(_r.tendered,_r.amount)-_r.amount,
      COALESCE(_o.currency,_r.currency), _r.method, CASE WHEN _r.method='cash' THEN NULL ELSE _r.reference END, 'confirmed', now(), _s.cashier_id, _s.id,
      auth.uid(), 'cash-request:' || _r.id::text)
    RETURNING id INTO _pay;

    _paid := CASE WHEN _org='aa17d427-f816-49bc-b02e-1a89e44806a2'::uuid THEN _paid+_r.amount ELSE COALESCE(_o.paid_total,0)+_r.amount END;
    _fully := _paid >= COALESCE(_o.grand_total,0);

    -- Move out of the service state BEFORE marking the bill paid: the lifecycle
    -- guard refuses a fully paid order that is still sent/preparing.
    IF _fully AND _o.status NOT IN ('awaiting-payment','paid','closed','charged-to-room','credit','cancelled','voided') THEN
      UPDATE public.pos_orders SET status='awaiting-payment', updated_at=now() WHERE id=_o.id;
    END IF;

    UPDATE public.pos_orders
       SET paid_total = _paid,
           payment_status = CASE WHEN _fully THEN 'paid' ELSE 'partial' END,
           updated_at = now()
     WHERE id = _o.id;

    IF _fully THEN
      UPDATE public.pos_orders SET status='paid', updated_at=now()
       WHERE id=_o.id AND status='awaiting-payment';
    END IF;
  ELSE
    SELECT * INTO _f FROM public.folios WHERE id=_r.folio_id AND organization_id=_org FOR UPDATE;
    IF _f.id IS NULL THEN RAISE EXCEPTION 'Folio not found'; END IF;
    IF _org='aa17d427-f816-49bc-b02e-1a89e44806a2'::uuid AND (_f.branch_id IS DISTINCT FROM _r.branch_id OR _f.currency IS DISTINCT FROM _r.currency) THEN RAISE EXCEPTION 'Cash folio property or currency changed'; END IF;
    IF _f.status NOT IN ('open','under-review') THEN
      RAISE EXCEPTION 'Folio is % and cannot accept payments', _f.status;
    END IF;

    INSERT INTO public.payments (organization_id, branch_id, receipt_number, folio_id, reservation_id,
      customer_id, amount, currency, method, external_reference, status, received_by, notes, shift_id,
      station_id, source_module, source_record_id, idempotency_key)
    VALUES (_org, _f.branch_id, _receipt, _f.id, _f.reservation_id, _f.customer_id, _r.amount,
      COALESCE(_f.currency,_r.currency), _r.method, CASE WHEN _r.method='cash' THEN NULL ELSE _r.reference END, 'confirmed', _s.cashier_id,
      COALESCE(_r.notes,''), _s.id, _s.station_id, _r.source_module, _r.source_record_id,
      'cash-request:' || _r.id::text)
    RETURNING id INTO _pay;

    INSERT INTO public.payment_allocations (organization_id, payment_id, folio_id, amount, created_by)
    VALUES (_org, _pay, _f.id, _r.amount, _s.cashier_id);

    UPDATE public.folios SET total_payments = COALESCE(total_payments,0) + _r.amount,
      balance = COALESCE(balance,0) - _r.amount, updated_at = now() WHERE id=_f.id;
  END IF;

  UPDATE public.cash_payment_requests
     SET status='confirmed', payment_id=_pay, receipt_number=_receipt,
         assigned_cashier_id=COALESCE(assigned_cashier_id,_s.cashier_id), confirmed_at=now(), updated_at=now()
   WHERE id=_r.id;

  INSERT INTO public.audit_logs (organization_id, user_id, user_name, action, module, record_id, new_value, reason)
  VALUES (_org, auth.uid(), '', 'finance.cash.receipt.confirm', 'finance', _pay::text,
    jsonb_build_object('request_id',_r.id,'folio_id',_r.folio_id,'source_module',_r.source_module,
      'source_record_id',_r.source_record_id,'amount',_r.amount,'method',_r.method,
      'shift_id',_s.id,'collected_by',_s.cashier_id,'initiated_by',_r.requested_by,
      'receipt_number',_receipt), _r.notes);

  RETURN jsonb_build_object('status','confirmed','request_id',_r.id,'payment_id',_pay,
    'receipt_number',_receipt,'amount',_r.amount,'shift_id',_s.id,'collected_by',_s.cashier_id);
END; $function$
;

NOTIFY pgrst,'reload schema';
COMMIT;
