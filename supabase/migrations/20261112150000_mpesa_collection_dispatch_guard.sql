-- Forward-only, local candidate: no payment is dispatched by this migration.
BEGIN;

ALTER TABLE public.mpesa_transactions ADD COLUMN IF NOT EXISTS dispatch_claimed_at timestamptz;
-- Existing attempts may already have reached the provider. Never resend them
-- merely because the new claim column was not present when they were created.
UPDATE public.mpesa_transactions SET dispatch_claimed_at = now()
 WHERE dispatch_claimed_at IS NULL AND applied_at IS NULL
   AND status IN ('initiated', 'pending', 'unknown');

CREATE OR REPLACE FUNCTION public.neo_mpesa_claim_dispatch(_transaction uuid, _organization uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE _t public.mpesa_transactions;
BEGIN
  UPDATE public.mpesa_transactions SET dispatch_claimed_at = now()
   WHERE id = _transaction AND organization_id = _organization
     AND dispatch_claimed_at IS NULL AND applied_at IS NULL
     AND checkout_request_id IS NULL AND status = 'initiated'
   RETURNING * INTO _t;
  IF _t.id IS NOT NULL THEN
    RETURN jsonb_build_object('claimed', true, 'status', _t.status);
  END IF;
  SELECT * INTO _t FROM public.mpesa_transactions
   WHERE id = _transaction AND organization_id = _organization;
  IF _t.id IS NULL THEN RAISE EXCEPTION 'Payment attempt not found'; END IF;
  RETURN jsonb_build_object('claimed', false, 'status', _t.status);
END $$;
REVOKE ALL ON FUNCTION public.neo_mpesa_claim_dispatch(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.neo_mpesa_claim_dispatch(uuid, uuid) TO service_role;

-- Hold the bill lock across both payment and transaction creation. A second
-- request reuses the outstanding attempt even if phone/amount inputs changed.
CREATE OR REPLACE FUNCTION public.neo_mpesa_collection_start(
  _source_module text, _source_record uuid, _msisdn text, _amount numeric,
  _description text DEFAULT NULL, _organization uuid DEFAULT NULL
)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  _org uuid; _branch uuid; _reference text; _currency text; _balance numeric; _bill_status text;
  _payment uuid; _table text; _txn uuid; _existing public.mpesa_transactions;
  _result jsonb; _provider_ref text; _pending numeric; _env text; _code text;
BEGIN
  IF _source_module = 'guest_folio' THEN
    _org := _organization;
    IF public.my_customer_id() IS NULL THEN RAISE EXCEPTION 'Guest profile required'; END IF;
    SELECT branch_id, folio_number, currency, balance, status
      INTO _branch, _reference, _currency, _balance, _bill_status FROM public.folios
     WHERE id = _source_record AND organization_id = _org
       AND customer_id = public.my_customer_id() FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Folio not found'; END IF;
  ELSE
    _org := public.current_org_id();
    IF _org IS NULL OR _source_module IS NULL OR _source_module NOT IN ('pos_order', 'folio')
       OR NOT coalesce(public.neo_mpesa_can_collect(_source_module), false) THEN
      RAISE EXCEPTION 'Not permitted to collect M-Pesa here';
    END IF;
    IF _source_module = 'pos_order' THEN
      SELECT branch_id, order_number, currency INTO _branch, _reference, _currency
        FROM public.pos_orders WHERE id = _source_record AND organization_id = _org FOR UPDATE;
    ELSE
      SELECT branch_id, folio_number, currency, balance INTO _branch, _reference, _currency, _balance
        FROM public.folios WHERE id = _source_record AND organization_id = _org FOR UPDATE;
    END IF;
    IF NOT FOUND OR NOT coalesce(public.neo_branch_in_scope(_branch), false) THEN
      RAISE EXCEPTION 'Bill not found in your property access';
    END IF;
  END IF;
  SELECT * INTO _existing FROM public.mpesa_transactions
   WHERE organization_id = _org AND source_record_id = _source_record
     AND ((_source_module = 'pos_order' AND source_module = 'pos_order')
       OR (_source_module IN ('folio', 'guest_folio') AND source_module IN ('folio', 'guest_folio')))
     AND status IN ('initiated', 'pending', 'unknown') AND applied_at IS NULL
   ORDER BY created_at DESC LIMIT 1;
  IF _existing.id IS NOT NULL THEN
    RETURN jsonb_build_object('transaction_id', _existing.id, 'organization_id', _org,
      'amount', _existing.amount, 'account_reference', _existing.account_reference,
      'status', _existing.status, 'reused', true);
  END IF;
  IF coalesce(_currency, 'KES') <> 'KES' THEN RAISE EXCEPTION 'M-Pesa collection requires a KES bill'; END IF;
  _msisdn := regexp_replace(coalesce(_msisdn, ''), '[^0-9]', '', 'g');
  IF _msisdn !~ '^254[17][0-9]{8}$' THEN RAISE EXCEPTION 'A valid Kenyan mobile number is required'; END IF;
  IF _source_module = 'guest_folio' AND coalesce(_bill_status, '') NOT IN ('open', 'under-review') THEN
    RAISE EXCEPTION 'This folio cannot accept a new collection';
  END IF;
  IF _source_module = 'guest_folio' THEN _amount := coalesce(_amount, _balance); END IF;
  IF _amount IS NULL OR _amount <= 0 OR _amount > 9007199254740991 OR _amount <> trunc(_amount) THEN
    RAISE EXCEPTION 'Enter a whole KES amount for M-Pesa';
  END IF;
  IF _source_module IN ('folio', 'guest_folio') THEN
    SELECT coalesce(sum(amount), 0) INTO _pending FROM public.payments
     WHERE organization_id = _org AND folio_id = _source_record AND status IN ('pending', 'initiated');
    IF _amount > greatest(coalesce(_balance, 0) - _pending, 0) THEN
      RAISE EXCEPTION 'Amount exceeds the folio balance available for collection';
    END IF;
  END IF;
  IF _source_module = 'guest_folio' THEN
    SELECT environment, short_code INTO _env, _code FROM public.mpesa_settings
     WHERE organization_id = _org AND coalesce(enabled, false);
    IF _code IS NULL THEN RAISE EXCEPTION 'Mobile payment is not configured for this property'; END IF;
    _provider_ref := 'STK-' || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 12));
    -- Active-attempt reuse above is the deduplication boundary. A completed
    -- installment must not cause the next equal installment to reuse its paid row.
    INSERT INTO public.payments(organization_id, branch_id, receipt_number, folio_id,
      customer_id, amount, currency, method, status, paid_at, received_by, notes,
      idempotency_key, source_module, source_record_id)
    VALUES(_org, _branch, 'PENDING-' || _provider_ref, _source_record, public.my_customer_id(),
      _amount, 'KES', 'mpesa', 'pending', now(), NULL, 'Guest folio collection awaiting provider',
      'guest-folio-mpesa:' || gen_random_uuid()::text, 'guest_folio', _source_record::text)
    RETURNING id INTO _payment;
    INSERT INTO public.mpesa_transactions(organization_id, branch_id, source_module, source_record_id,
      payment_table, payment_id, msisdn, amount, account_reference, description, environment, short_code, status, created_by)
    VALUES(_org, _branch, 'guest_folio', _source_record, 'payments', _payment, _msisdn, _amount,
      _reference, 'Guest folio payment', coalesce(_env, 'sandbox'), _code, 'initiated', NULL)
    RETURNING id INTO _txn;
    RETURN jsonb_build_object('transaction_id', _txn, 'organization_id', _org,
      'amount', _amount, 'account_reference', _reference, 'reused', false);
  END IF;
  _provider_ref := 'STK-' || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 12));
  IF _source_module = 'pos_order' THEN
    _table := 'pos_payments';
    _result := public.pos_record_payment_attempt(
      _order_id => _source_record, _amount => _amount, _method => 'mpesa',
      _reference => _provider_ref, _idempotency_key => 'mpesa:' || _provider_ref);
    _payment := (_result->>'payment_id')::uuid;
  ELSE
    _table := 'payments';
    _payment := public.pms_record_payment(_folio => _source_record, _amount => _amount,
      _method => 'mpesa', _reference => _provider_ref, _notes => 'M-Pesa collection awaiting provider',
      _intent_key => 'mpesa:' || _provider_ref);
  END IF;
  IF _payment IS NULL THEN RAISE EXCEPTION 'Payment creation was not confirmed'; END IF;
  _txn := public.neo_mpesa_txn_start(_source_module, _source_record, _table, _payment,
    _branch, _msisdn, _amount, _reference, coalesce(_description, 'NEO payment'));
  IF _txn IS NULL THEN RAISE EXCEPTION 'Transaction creation was not confirmed'; END IF;
  RETURN jsonb_build_object('transaction_id', _txn, 'organization_id', _org,
    'amount', _amount, 'account_reference', _reference, 'reused', false);
END $$;
REVOKE ALL ON FUNCTION public.neo_mpesa_collection_start(text, uuid, text, numeric, text, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.neo_mpesa_collection_start(text, uuid, text, numeric, text, uuid) TO authenticated;

CREATE OR REPLACE FUNCTION public.neo_mpesa_guest_deposit_start(
  _org uuid, _reference text, _msisdn text, _amount numeric DEFAULT NULL
)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE _res public.reservations; _t public.mpesa_transactions;
BEGIN
  IF public.my_customer_id() IS NULL THEN RAISE EXCEPTION 'Guest profile required'; END IF;
  SELECT * INTO _res FROM public.reservations
   WHERE organization_id = _org AND confirmation_number = _reference
     AND customer_id = public.my_customer_id() FOR UPDATE;
  IF _res.id IS NULL THEN RAISE EXCEPTION 'Reservation not found'; END IF;
  SELECT * INTO _t FROM public.mpesa_transactions
   WHERE organization_id = _org AND source_record_id = _res.id AND source_module = 'reservation_deposit'
     AND status IN ('initiated', 'pending', 'unknown') AND applied_at IS NULL
   ORDER BY created_at DESC LIMIT 1;
  IF _t.id IS NOT NULL THEN
    RETURN jsonb_build_object('transaction_id', _t.id, 'amount', _t.amount, 'status', _t.status, 'reused', true);
  END IF;
  RETURN public.neo_guest_deposit_pay(_org, _reference, _msisdn, _amount);
END $$;
REVOKE ALL ON FUNCTION public.neo_mpesa_guest_deposit_start(uuid, text, text, numeric) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.neo_mpesa_guest_deposit_start(uuid, text, text, numeric) TO authenticated;
-- Legacy callback replay trusted a stored ResultCode without a fresh Daraja
-- check. Recovery must use the authenticated server reconciliation path.
CREATE OR REPLACE FUNCTION public.neo_mpesa_retry_callback(_event uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  RAISE EXCEPTION 'Direct callback replay is disabled; check this collection with Safaricom'
    USING ERRCODE = '42501';
END $$;
REVOKE ALL ON FUNCTION public.neo_mpesa_retry_callback(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.neo_mpesa_retry_callback(uuid) TO service_role;
COMMIT;
