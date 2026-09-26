
-- The older overload (text transaction date) predates delivery syncing and can be
-- chosen ahead of the current routine. Remove it so one path handles confirmations.
DROP FUNCTION IF EXISTS public.neo_mpesa_apply_result(uuid, integer, text, text, text, jsonb, text);

-- Everything that must follow a confirmed payment on a point-of-sale order.
-- Runs inside the trusted callback context; each step is independent so one
-- failure never undoes the money that was actually received.
CREATE OR REPLACE FUNCTION public.neo_mpesa_complete_pos_order(_pos_order uuid, _org uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  _o public.pos_orders;
  _pay record;
  _receipts int := 0;
  _kitchen text := 'not-required';
  _finance text := 'not-attempted';
  _prior_org text;
  _prior_posting text;
  _res jsonb;
BEGIN
  IF _pos_order IS NULL OR _org IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'missing_arguments');
  END IF;
  SELECT * INTO _o FROM public.pos_orders WHERE id = _pos_order AND organization_id = _org;
  IF _o.id IS NULL THEN RETURN jsonb_build_object('ok', false, 'reason', 'not_found'); END IF;

  _prior_org := coalesce(current_setting('neo.system_org', true), '');
  _prior_posting := coalesce(current_setting('neo.system_posting', true), 'off');
  PERFORM set_config('neo.system_org', _org::text, true);
  PERFORM set_config('neo.system_posting', 'on', true);

  -- 1. A numbered receipt for every confirmed payment that does not have one.
  FOR _pay IN
    SELECT id FROM public.pos_payments
     WHERE order_id = _pos_order AND organization_id = _org
       AND status = 'confirmed' AND coalesce(btrim(coalesce(receipt_number, '')), '') = ''
  LOOP
    BEGIN
      UPDATE public.pos_payments
         SET receipt_number = public.next_document_number('receipt', 'RCP', _o.branch_id)
       WHERE id = _pay.id;
      _receipts := _receipts + 1;
    EXCEPTION WHEN OTHERS THEN
      NULL; -- a numbering failure must not undo a confirmed payment
    END;
  END LOOP;

  -- 2. Send to the kitchen when the order has sendable lines and no tickets yet.
  IF public.neo_pos_order_is_kitchen_bound(_pos_order, _org)
     AND NOT EXISTS (SELECT 1 FROM public.station_tickets WHERE order_id = _pos_order) THEN
    BEGIN
      PERFORM public.neo_pos_route_tickets_internal(_pos_order, _org);
      _kitchen := 'sent';
    EXCEPTION WHEN OTHERS THEN
      _kitchen := 'failed: ' || SQLERRM;
    END;
  ELSIF EXISTS (SELECT 1 FROM public.station_tickets WHERE order_id = _pos_order) THEN
    _kitchen := 'already-sent';
  END IF;

  -- 3. Post the sale to Finance.
  BEGIN
    _res := public.neo_finance_post_source('pos', _pos_order, true);
    _finance := CASE WHEN coalesce((_res->>'ok')::boolean, false)
                     THEN coalesce(_res->>'reason', 'posted')
                     ELSE 'blocked: ' || coalesce(_res->>'reason', 'unknown') END;
  EXCEPTION WHEN OTHERS THEN
    _finance := 'failed: ' || SQLERRM;
  END;

  PERFORM set_config('neo.system_posting', _prior_posting, true);
  PERFORM set_config('neo.system_org', _prior_org, true);

  INSERT INTO public.audit_logs (organization_id, branch_id, user_id, action, module, record_id, new_value)
  VALUES (_org, _o.branch_id, NULL, 'pos.payment.completed', 'pos', _pos_order::text,
          jsonb_build_object('receipts_issued', _receipts, 'kitchen', _kitchen, 'finance', _finance));

  RETURN jsonb_build_object('ok', true, 'receipts_issued', _receipts,
                            'kitchen', _kitchen, 'finance', _finance);
END $function$;

REVOKE ALL ON FUNCTION public.neo_mpesa_complete_pos_order(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.neo_mpesa_complete_pos_order(uuid, uuid) TO service_role;

-- Confirmation routine: same as before, plus the completion chain on success.
CREATE OR REPLACE FUNCTION public.neo_mpesa_apply_result(_transaction uuid, _result_code integer, _result_desc text, _receipt text, _transaction_date timestamp with time zone, _payload jsonb, _source text DEFAULT 'callback'::text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE _t public.mpesa_transactions; _status text; _p public.pos_payments; _pay public.payments; _res public.reservations;
        _completion jsonb := NULL;
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
       WHERE id = _t.payment_id AND status IN ('initiated', 'pending')
       RETURNING order_id INTO _p.order_id;
      PERFORM public.neo_mpesa_delivery_sync(_p.order_id, false);
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
      PERFORM public.neo_mpesa_delivery_sync(_p.order_id, true);
      _completion := public.neo_mpesa_complete_pos_order(_p.order_id, _t.organization_id);
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
                             'sourceModule', _t.source_module, 'sourceRecord', _t.source_record_id,
                             'completion', _completion));

  RETURN jsonb_build_object('applied', true, 'status', _status, 'completion', _completion);
END $function$;

REVOKE ALL ON FUNCTION public.neo_mpesa_apply_result(uuid, integer, text, text, timestamp with time zone, jsonb, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.neo_mpesa_apply_result(uuid, integer, text, text, timestamp with time zone, jsonb, text) TO service_role;
