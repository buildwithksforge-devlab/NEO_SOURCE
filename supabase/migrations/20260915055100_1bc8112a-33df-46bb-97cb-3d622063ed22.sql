
CREATE OR REPLACE FUNCTION public.neo_pos_status_rules()
 RETURNS jsonb
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO 'public'
AS $function$
  SELECT jsonb_build_object(
    'draft', jsonb_build_array('held','confirmed','sent','cancelled'),
    'held', jsonb_build_array('draft','confirmed','cancelled'),
    'confirmed', jsonb_build_array('sent','awaiting-payment','cancelled'),
    -- Guests routinely settle before the food arrives, so every in-service
    -- state may also move straight to awaiting payment.
    'sent', jsonb_build_array('accepted','in-preparation','partially-ready','ready','awaiting-payment','cancelled','void-pending'),
    'accepted', jsonb_build_array('in-preparation','partially-ready','ready','awaiting-payment','void-pending'),
    'in-preparation', jsonb_build_array('partially-ready','ready','awaiting-payment','void-pending'),
    'partially-ready', jsonb_build_array('ready','partially-served','awaiting-payment','void-pending'),
    'ready', jsonb_build_array('partially-served','served','awaiting-payment','void-pending'),
    'partially-served', jsonb_build_array('served','awaiting-payment','void-pending'),
    'served', jsonb_build_array('awaiting-payment','void-pending'),
    'awaiting-payment', jsonb_build_array('paid','charged-to-room','credit','void-pending'),
    'paid', jsonb_build_array('closed','void-pending'),
    'charged-to-room', jsonb_build_array('closed','void-pending'),
    'credit', jsonb_build_array('closed','void-pending'),
    'closed', jsonb_build_array('awaiting-payment'),
    'void-pending', jsonb_build_array('voided','served','awaiting-payment')
  )
$function$;

CREATE OR REPLACE FUNCTION public.neo_pos_apply_settlement_status(_order uuid, _fully boolean)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE _status text;
BEGIN
  IF NOT _fully THEN RETURN; END IF;
  SELECT status INTO _status FROM public.pos_orders WHERE id = _order;
  IF _status IS NULL OR _status IN ('paid','closed','charged-to-room','credit','cancelled','voided') THEN
    RETURN;
  END IF;
  IF _status <> 'awaiting-payment' THEN
    UPDATE public.pos_orders SET status='awaiting-payment', updated_at=now() WHERE id=_order;
  END IF;
  UPDATE public.pos_orders SET status='paid', updated_at=now() WHERE id=_order;
END; $function$;

REVOKE EXECUTE ON FUNCTION public.neo_pos_apply_settlement_status(uuid, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.neo_pos_apply_settlement_status(uuid, boolean) TO service_role;

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
  _pay uuid; _receipt text; _paid numeric; _fully boolean;
BEGIN
  SELECT * INTO _r FROM public.cash_payment_requests WHERE id=_request AND organization_id=_org FOR UPDATE;
  IF _r.id IS NULL THEN RAISE EXCEPTION 'Cash request not found'; END IF;

  IF _r.status = 'confirmed' THEN
    RETURN jsonb_build_object('status','confirmed','request_id',_r.id,
      'payment_id',_r.payment_id,'receipt_number',_r.receipt_number,'amount',_r.amount);
  END IF;
  IF _r.status <> 'pending' THEN RAISE EXCEPTION 'Cash request is % and cannot be settled', _r.status; END IF;

  SELECT * INTO _s FROM public.pos_shifts WHERE id=_r.assigned_shift_id AND organization_id=_org FOR UPDATE;
  IF _s.id IS NULL OR _s.status <> 'open' THEN
    RAISE EXCEPTION 'The assigned cash drawer is no longer open';
  END IF;

  _receipt := public.next_document_number('receipt');

  IF _r.source_module = 'pos' THEN
    SELECT * INTO _o FROM public.pos_orders WHERE id=_r.source_record_id AND organization_id=_org FOR UPDATE;
    IF _o.id IS NULL THEN RAISE EXCEPTION 'Order not found'; END IF;

    INSERT INTO public.pos_payments (organization_id, branch_id, order_id, receipt_number, customer_id,
      amount, tendered, currency, method, external_reference, status, paid_at, cashier_id, shift_id,
      created_by, idempotency_key)
    VALUES (_org, _o.branch_id, _o.id, _receipt, _o.customer_id, _r.amount, _r.amount,
      COALESCE(_o.currency,_r.currency), _r.method, _r.reference, 'confirmed', now(), _s.cashier_id, _s.id,
      auth.uid(), 'cash-request:' || _r.id::text)
    RETURNING id INTO _pay;

    _paid := COALESCE(_o.paid_total,0) + _r.amount;
    _fully := _paid >= COALESCE(_o.grand_total,0);

    UPDATE public.pos_orders
       SET paid_total = _paid,
           payment_status = CASE WHEN _fully THEN 'paid' ELSE 'partial' END,
           updated_at = now()
     WHERE id = _o.id;

    -- A fully settled bill may not stay in a service state; step it through the
    -- lifecycle so the status, the receipt and the till all agree.
    PERFORM public.neo_pos_apply_settlement_status(_o.id, _fully);
  ELSE
    SELECT * INTO _f FROM public.folios WHERE id=_r.folio_id AND organization_id=_org FOR UPDATE;
    IF _f.id IS NULL THEN RAISE EXCEPTION 'Folio not found'; END IF;
    IF _f.status NOT IN ('open','under-review') THEN
      RAISE EXCEPTION 'Folio is % and cannot accept payments', _f.status;
    END IF;

    INSERT INTO public.payments (organization_id, branch_id, receipt_number, folio_id, reservation_id,
      customer_id, amount, currency, method, external_reference, status, received_by, notes, shift_id,
      station_id, source_module, source_record_id, idempotency_key)
    VALUES (_org, _f.branch_id, _receipt, _f.id, _f.reservation_id, _f.customer_id, _r.amount,
      COALESCE(_f.currency,_r.currency), _r.method, _r.reference, 'confirmed', _s.cashier_id,
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
END; $function$;
