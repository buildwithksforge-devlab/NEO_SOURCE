CREATE OR REPLACE FUNCTION public.neo_guest_reservation_position(_org uuid, _reference text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE _cust uuid := public.my_customer_id(); _res public.reservations;
        _held numeric := 0; _applied numeric := 0; _required numeric := 0; _short text;
BEGIN
  IF _cust IS NULL THEN RETURN jsonb_build_object('ok', false, 'reason', 'not-linked'); END IF;

  SELECT * INTO _res FROM public.reservations
   WHERE organization_id = _org AND confirmation_number = _reference AND customer_id = _cust;
  IF _res.id IS NULL THEN RETURN jsonb_build_object('ok', false, 'reason', 'not-found'); END IF;

  SELECT COALESCE(sum(amount) FILTER (WHERE status = 'held'), 0),
         COALESCE(sum(amount) FILTER (WHERE status = 'applied'), 0)
    INTO _held, _applied
    FROM public.reservation_deposits WHERE reservation_id = _res.id;

  _required := GREATEST(COALESCE(_res.deposit_required, 0), 0);
  SELECT short_code INTO _short FROM public.mpesa_settings WHERE organization_id = _org AND COALESCE(enabled, true);

  RETURN jsonb_build_object(
    'ok', true,
    'reservation_id', _res.id,
    'confirmation_number', _res.confirmation_number,
    'status', _res.status,
    'currency', 'KES',
    'total_amount', COALESCE(_res.total_amount, 0),
    'required', _required,
    'paid', _held + _applied,
    'outstanding', GREATEST(_required - (_held + _applied), 0),
    'can_pay_online', (_short IS NOT NULL AND GREATEST(_required - (_held + _applied), 0) > 0)
  );
END $function$;

REVOKE ALL ON FUNCTION public.neo_guest_reservation_position(uuid, text) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.neo_guest_reservation_position(uuid, text) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.neo_guest_deposit_pay(_org uuid, _reference text, _msisdn text, _amount numeric DEFAULT NULL)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE _cust uuid := public.my_customer_id(); _res public.reservations;
        _pos jsonb; _due numeric; _take numeric; _digits text; _env text; _code text; _txn uuid;
BEGIN
  IF _cust IS NULL THEN RAISE EXCEPTION 'This account is not linked to a guest profile'; END IF;

  SELECT * INTO _res FROM public.reservations
   WHERE organization_id = _org AND confirmation_number = _reference AND customer_id = _cust;
  IF _res.id IS NULL THEN RAISE EXCEPTION 'Reservation not found'; END IF;

  _pos := public.neo_guest_reservation_position(_org, _reference);
  _due := COALESCE((_pos->>'outstanding')::numeric, 0);
  IF _due <= 0 THEN RAISE EXCEPTION 'No deposit is outstanding on this booking'; END IF;

  _take := LEAST(COALESCE(NULLIF(_amount, 0), _due), _due);
  IF _take <= 0 THEN RAISE EXCEPTION 'Payment amount must be greater than zero'; END IF;

  _digits := regexp_replace(COALESCE(_msisdn, ''), '[^0-9]', '', 'g');
  IF length(_digits) < 9 THEN RAISE EXCEPTION 'A valid mobile number is required'; END IF;

  SELECT environment, short_code INTO _env, _code
    FROM public.mpesa_settings WHERE organization_id = _org AND COALESCE(enabled, true);
  IF _code IS NULL THEN RAISE EXCEPTION 'This property cannot take a mobile payment yet — please settle at the front desk'; END IF;

  INSERT INTO public.mpesa_transactions (
    organization_id, branch_id, source_module, source_record_id, payment_table, payment_id,
    msisdn, amount, account_reference, description, environment, short_code, status, created_by)
  VALUES (_org, _res.branch_id, 'reservation_deposit', _res.id, NULL, NULL,
          _digits, round(_take, 2), _res.confirmation_number,
          'Booking deposit ' || _res.confirmation_number, COALESCE(_env, 'sandbox'), _code,
          'initiated', NULL)
  RETURNING id INTO _txn;

  RETURN jsonb_build_object('ok', true, 'transaction_id', _txn, 'amount', round(_take, 2),
                            'reservation_id', _res.id, 'confirmation_number', _res.confirmation_number);
END $function$;

REVOKE ALL ON FUNCTION public.neo_guest_deposit_pay(uuid, text, text, numeric) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.neo_guest_deposit_pay(uuid, text, text, numeric) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.neo_mpesa_apply_result(_transaction uuid, _result_code integer, _result_desc text, _receipt text, _transaction_date text, _payload jsonb, _source text DEFAULT 'callback'::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE _t public.mpesa_transactions; _status text; _p public.pos_payments; _pay public.payments; _res public.reservations;
BEGIN
  SELECT * INTO _t FROM public.mpesa_transactions WHERE id = _transaction FOR UPDATE;
  IF _t.id IS NULL THEN RETURN jsonb_build_object('applied', false, 'reason', 'Transaction not found'); END IF;

  INSERT INTO public.mpesa_callback_events (organization_id, transaction_id, checkout_request_id, source, payload, detail)
  VALUES (_t.organization_id, _t.id, _t.checkout_request_id, _source, COALESCE(_payload, '{}'::jsonb), _result_desc);

  IF _t.applied_at IS NOT NULL THEN
    RETURN jsonb_build_object('applied', false, 'duplicate', true, 'status', _t.status);
  END IF;

  _status := CASE
    WHEN _result_code = 0 THEN 'success'
    WHEN _result_code = 1032 THEN 'cancelled'
    WHEN _result_code IN (1037, 1019) THEN 'timeout'
    ELSE 'failed' END;

  UPDATE public.mpesa_transactions
     SET status = _status,
         result_code = _result_code,
         result_desc = _result_desc,
         mpesa_receipt_number = COALESCE(NULLIF(btrim(COALESCE(_receipt, '')), ''), mpesa_receipt_number),
         transaction_date = COALESCE(_transaction_date, transaction_date),
         raw_result = COALESCE(_payload, raw_result),
         reconciled_at = now(),
         applied_at = now(),
         failure_detail = CASE WHEN _result_code = 0 THEN NULL ELSE _result_desc END,
         updated_at = now()
   WHERE id = _t.id;

  IF _status <> 'success' THEN
    IF _t.payment_table = 'pos_payments' AND _t.payment_id IS NOT NULL THEN
      UPDATE public.pos_payments SET status = 'failed', provider_status = COALESCE(_result_desc, 'provider-declined')
       WHERE id = _t.payment_id AND status IN ('initiated', 'pending');
    ELSIF _t.payment_table = 'payments' AND _t.payment_id IS NOT NULL THEN
      UPDATE public.payments SET status = 'failed' WHERE id = _t.payment_id AND status = 'pending';
    END IF;
    RETURN jsonb_build_object('applied', true, 'status', _status);
  END IF;

  IF _t.payment_table = 'pos_payments' AND _t.payment_id IS NOT NULL THEN
    SELECT * INTO _p FROM public.pos_payments WHERE id = _t.payment_id FOR UPDATE;
    IF _p.id IS NOT NULL AND _p.status IN ('initiated', 'pending') THEN
      UPDATE public.pos_payments
         SET status = 'confirmed', provider_status = 'provider-confirmed', paid_at = now(),
             external_reference = COALESCE(NULLIF(btrim(COALESCE(_receipt, '')), ''), external_reference)
       WHERE id = _p.id;
      PERFORM public.pos_reconcile_settlement_internal(_p.order_id);
    END IF;
  ELSIF _t.payment_table = 'payments' AND _t.payment_id IS NOT NULL THEN
    SELECT * INTO _pay FROM public.payments WHERE id = _t.payment_id FOR UPDATE;
    IF _pay.id IS NOT NULL AND _pay.status = 'pending' THEN
      UPDATE public.payments
         SET status = 'confirmed',
             external_reference = COALESCE(NULLIF(btrim(COALESCE(_receipt, '')), ''), external_reference)
       WHERE id = _pay.id;
      IF _pay.folio_id IS NOT NULL THEN
        INSERT INTO public.payment_allocations (organization_id, payment_id, folio_id, amount, created_by)
        VALUES (_pay.organization_id, _pay.id, _pay.folio_id, _pay.amount, _pay.received_by);
        UPDATE public.folios
           SET total_payments = total_payments + _pay.amount,
               balance = balance - _pay.amount,
               updated_at = now()
         WHERE id = _pay.folio_id;
      END IF;
    END IF;
  ELSIF _t.source_module = 'reservation_deposit' AND _t.source_record_id IS NOT NULL THEN
    -- Guest-app booking deposit: the deposit exists only once the provider has
    -- confirmed the money, and exactly once per provider transaction.
    SELECT * INTO _res FROM public.reservations WHERE id = _t.source_record_id;
    IF _res.id IS NOT NULL THEN
      INSERT INTO public.reservation_deposits (
        organization_id, branch_id, reservation_id, customer_id, amount, currency, method,
        reference, status, idempotency_key, notes)
      VALUES (_t.organization_id, COALESCE(_t.branch_id, _res.branch_id), _res.id, _res.customer_id,
              _t.amount, 'KES', 'mpesa',
              COALESCE(NULLIF(btrim(COALESCE(_receipt, '')), ''), _t.id::text), 'held',
              'mpesa-deposit:' || _t.id::text, 'Guest app booking deposit')
      ON CONFLICT DO NOTHING;
    END IF;
  END IF;

  INSERT INTO public.audit_logs (organization_id, branch_id, user_id, action, module, record_id, new_value)
  VALUES (_t.organization_id, _t.branch_id, _t.created_by, 'integration.mpesa.confirmed', 'finance', _t.id::text,
          jsonb_build_object('receipt', _receipt, 'amount', _t.amount, 'source', _source,
                             'sourceModule', _t.source_module, 'sourceRecord', _t.source_record_id));

  RETURN jsonb_build_object('applied', true, 'status', _status);
END; $function$;