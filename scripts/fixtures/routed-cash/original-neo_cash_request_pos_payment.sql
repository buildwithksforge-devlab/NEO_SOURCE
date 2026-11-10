CREATE OR REPLACE FUNCTION public.neo_cash_request_pos_payment(_order uuid, _amount numeric, _reference text DEFAULT NULL::text, _notes text DEFAULT ''::text, _idempotency_key text DEFAULT NULL::text)
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

  SELECT * INTO _o FROM public.pos_orders WHERE id=_order AND organization_id=_org;
  IF _o.id IS NULL THEN RAISE EXCEPTION 'Order not found'; END IF;

  IF _idempotency_key IS NOT NULL THEN
    SELECT * INTO _existing FROM public.cash_payment_requests
     WHERE organization_id=_org AND idempotency_key=_idempotency_key;
    IF _existing.id IS NOT NULL THEN
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
       AND (s.branch_id IS NULL OR _o.branch_id IS NULL OR s.branch_id=_o.branch_id)
     ORDER BY (s.branch_id = _o.branch_id) DESC NULLS LAST, s.opened_at DESC LIMIT 1;
  END IF;

  IF _shift IS NULL THEN
    RETURN jsonb_build_object('status','no_till',
      'message','No active cash drawer is available for this outlet.',
      'can_open_drawer', _ctx->'can_open_drawer');
  END IF;

  INSERT INTO public.cash_payment_requests (organization_id, branch_id, source_module, source_record_id,
    folio_id, amount, currency, method, reference, notes, status, requested_by,
    assigned_shift_id, assigned_cashier_id, idempotency_key)
  VALUES (_org, _o.branch_id, 'pos', _o.id, NULL, _amount, COALESCE(_o.currency,'KES'), 'cash',
    COALESCE(_reference, _o.order_number), COALESCE(_notes,''), 'pending', auth.uid(),
    _shift, _cashier, _idempotency_key)
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
