CREATE OR REPLACE FUNCTION public.neo_mpesa_apply_result(_transaction uuid, _result_code integer, _result_desc text, _receipt text, _transaction_date text, _payload jsonb, _source text DEFAULT 'callback'::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE _t public.mpesa_transactions; _status text; _p public.pos_payments; _pay public.payments; _res public.reservations;
        _completion jsonb := NULL; _normalized_date timestamptz; _date_value public.mpesa_transactions.transaction_date%TYPE; _stored_callback jsonb; _callback_receipt text; _callback_date text;
BEGIN
  SELECT * INTO _t FROM public.mpesa_transactions WHERE id = _transaction FOR UPDATE;
  IF _t.id IS NULL THEN RETURN jsonb_build_object('applied', false, 'reason', 'Transaction not found'); END IF;

  -- A fresh successful provider status query may recover metadata from a callback
  -- that already passed tenant/provider/amount checks but failed atomic posting.
  IF _result_code=0 AND _source='status-query' AND nullif(btrim(_receipt),'') IS NULL THEN
    SELECT e.payload,meta.receipt,meta.clock INTO _stored_callback,_callback_receipt,_callback_date
    FROM public.mpesa_callback_events e
    CROSS JOIN LATERAL (
      SELECT max(x->>'Value') FILTER(WHERE x->>'Name'='MpesaReceiptNumber') AS receipt,
             max(x->>'Value') FILTER(WHERE x->>'Name'='TransactionDate') AS clock,
             max(x->>'Value') FILTER(WHERE x->>'Name'='Amount') AS amount,
             count(*) FILTER(WHERE x->>'Name'='Amount') AS amount_count,
             count(*) FILTER(WHERE x->>'Name'='MpesaReceiptNumber') AS receipt_count,
             count(*) FILTER(WHERE x->>'Name'='TransactionDate') AS clock_count
      FROM jsonb_array_elements(CASE WHEN jsonb_typeof(e.payload#>'{Body,stkCallback,CallbackMetadata,Item}')='array'
        THEN e.payload#>'{Body,stkCallback,CallbackMetadata,Item}' ELSE '[]'::jsonb END) x
    ) meta
    WHERE e.organization_id=_t.organization_id AND e.accepted=false AND e.source='callback'
      AND e.detail LIKE 'Could not apply result:%'
      AND (e.transaction_id=_t.id OR e.checkout_request_id=_t.checkout_request_id)
      AND e.payload#>>'{Body,stkCallback,ResultCode}'='0'
      AND e.payload#>>'{Body,stkCallback,CheckoutRequestID}'=_t.checkout_request_id
      AND (_t.merchant_request_id IS NULL OR e.payload#>>'{Body,stkCallback,MerchantRequestID}'=_t.merchant_request_id)
      AND CASE WHEN meta.amount ~ '^[0-9]+([.][0-9]+)?$' THEN meta.amount::numeric ELSE NULL END=_t.amount
      AND meta.amount_count=1 AND meta.receipt_count=1 AND meta.clock_count=1
      AND nullif(btrim(meta.receipt),'') IS NOT NULL
    ORDER BY e.received_at DESC LIMIT 1;
    IF _stored_callback IS NOT NULL THEN
      _receipt:=_callback_receipt;
      _transaction_date:=coalesce(nullif(btrim(_transaction_date),''),_callback_date);
      _payload:=jsonb_build_object('verification',_payload,'callback',_stored_callback);
    END IF;
  END IF;

  -- The existing HTTP RPC accepts a JSON string. Safaricom sends YYYYMMDDHH24MISS
  -- in Kenyan time; normalize it before assigning the timestamptz column.
  IF nullif(btrim(_transaction_date),'') IS NOT NULL THEN
    IF btrim(_transaction_date) ~ '^[0-9]{14}$' THEN
      IF substr(btrim(_transaction_date),1,4)::int<1970
         OR substr(btrim(_transaction_date),9,2)::int>23
         OR substr(btrim(_transaction_date),11,2)::int>59
         OR substr(btrim(_transaction_date),13,2)::int>59 THEN
        RAISE EXCEPTION 'Invalid provider transaction clock' USING ERRCODE='22007';
      END IF;
      _normalized_date:=make_timestamptz(substr(btrim(_transaction_date),1,4)::int,
        substr(btrim(_transaction_date),5,2)::int,substr(btrim(_transaction_date),7,2)::int,
        substr(btrim(_transaction_date),9,2)::int,substr(btrim(_transaction_date),11,2)::int,
        substr(btrim(_transaction_date),13,2)::int,'Africa/Nairobi');
    ELSIF btrim(_transaction_date) ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}([.][0-9]{1,6})?(Z|[+-][0-9]{2}:[0-9]{2})$' THEN
      _normalized_date:=btrim(_transaction_date)::timestamptz;
    ELSE
      RAISE EXCEPTION 'Invalid provider transaction date format' USING ERRCODE='22007';
    END IF;
  END IF;

  IF _normalized_date IS NOT NULL THEN
    _date_value:=to_char(_normalized_date AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"');
  END IF;


  INSERT INTO public.mpesa_callback_events (organization_id, transaction_id, checkout_request_id, source, payload, detail)
  VALUES (_t.organization_id, _t.id, _t.checkout_request_id, _source, COALESCE(_payload, '{}'::jsonb), _result_desc);

  -- A status query can report success without returning the receipt. Preserve
  -- the attempt and its evidence; never invent a receipt or release it for retry.
  IF _result_code=0 AND nullif(btrim(_receipt),'') IS NULL THEN
    IF _t.status='success' AND _t.applied_at IS NOT NULL THEN
      RETURN jsonb_build_object('applied',false,'duplicate',true,'status',_t.status);
    END IF;
    UPDATE public.mpesa_transactions SET status='pending',result_code=0,
      result_desc='Provider reports success; awaiting its verified receipt metadata',
      raw_result=coalesce(_payload,raw_result),applied_at=NULL,last_query_at=now(),updated_at=now()
      WHERE id=_t.id;
    RETURN jsonb_build_object('applied',false,'status','pending','reason','receipt_pending','provider_success',true);
  END IF;
  IF _result_code=0 THEN
    IF _source NOT IN ('callback','status-query') THEN RAISE EXCEPTION 'M-Pesa success requires the verified provider-result workflow'; END IF;
    IF _t.status='success' AND _t.applied_at IS NOT NULL AND nullif(btrim(_t.mpesa_receipt_number),'') IS DISTINCT FROM nullif(btrim(_receipt),'') THEN
      RAISE EXCEPTION 'Provider receipt conflicts with the already applied receipt; review the saved evidence';
    END IF;
    IF _t.amount IS NULL OR _t.amount<=0 OR _t.amount::text IN ('NaN','Infinity','-Infinity') THEN RAISE EXCEPTION 'Invalid saved M-Pesa amount'; END IF;
    PERFORM pg_advisory_xact_lock(hashtextextended('mpesa-receipt:'||_t.organization_id::text||':'||upper(btrim(_receipt)),0));
    IF EXISTS(SELECT 1 FROM public.mpesa_transactions other WHERE other.id<>_t.id
       AND other.organization_id=_t.organization_id AND upper(btrim(other.mpesa_receipt_number))=upper(btrim(_receipt))
       AND other.status='success' AND other.applied_at IS NOT NULL) THEN
      RAISE EXCEPTION 'This provider receipt is already applied to another saved attempt';
    END IF;
  END IF;
  -- A late verified successful callback may supersede an earlier non-success.
  -- Success itself is immutable, and a later failure never reverses received money.
  IF _t.applied_at IS NOT NULL AND NOT (_result_code=0 AND _t.status IN ('failed','cancelled','timeout')) THEN
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
         transaction_date = COALESCE(_date_value, transaction_date),
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
      IF _p.order_id IS NOT NULL THEN PERFORM public.pos_reconcile_settlement_internal(_p.order_id); END IF;
      PERFORM public.neo_mpesa_delivery_sync(_p.order_id, false);
    ELSIF _t.payment_table = 'payments' AND _t.payment_id IS NOT NULL THEN
      UPDATE public.payments SET status = 'failed' WHERE id = _t.payment_id AND status = 'pending';
    END IF;
    RETURN jsonb_build_object('applied', true, 'status', _status);
  END IF;

  IF _t.payment_table = 'pos_payments' AND _t.payment_id IS NOT NULL THEN
    SELECT * INTO _p FROM public.pos_payments WHERE id = _t.payment_id FOR UPDATE;
    IF _p.id IS NULL OR _p.organization_id IS DISTINCT FROM _t.organization_id OR _p.branch_id IS DISTINCT FROM _t.branch_id
       OR _p.amount IS DISTINCT FROM _t.amount OR _p.method IS DISTINCT FROM 'mpesa' OR _p.currency IS DISTINCT FROM 'KES' THEN
      RAISE EXCEPTION 'Verified M-Pesa attempt and saved POS payment do not agree';
    END IF;
    IF _p.status IN ('initiated', 'pending','failed') THEN
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
    IF _pay.id IS NULL OR _pay.organization_id IS DISTINCT FROM _t.organization_id OR _pay.branch_id IS DISTINCT FROM _t.branch_id
       OR _pay.amount IS DISTINCT FROM _t.amount OR _pay.method IS DISTINCT FROM 'mpesa' OR _pay.currency IS DISTINCT FROM 'KES' THEN
      RAISE EXCEPTION 'Verified M-Pesa attempt and saved folio payment do not agree';
    END IF;
    IF _pay.status IN ('pending','failed') THEN
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
