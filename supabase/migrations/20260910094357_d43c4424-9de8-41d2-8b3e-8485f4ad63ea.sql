
-- ---------- intent support on the shared register ----------
ALTER TABLE public.payment_attempts
  ADD COLUMN IF NOT EXISTS provider_reference text,
  ADD COLUMN IF NOT EXISTS callback_token text,
  ADD COLUMN IF NOT EXISTS provider_payload jsonb;

CREATE UNIQUE INDEX IF NOT EXISTS payment_attempts_callback_token_idx
  ON public.payment_attempts (callback_token) WHERE callback_token IS NOT NULL;

-- ---------- open a provider payment intent ----------
CREATE OR REPLACE FUNCTION public.neo_payment_intent_open(
  _module text, _source_record uuid, _method text, _amount numeric,
  _branch uuid DEFAULT NULL, _currency text DEFAULT NULL, _reference text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE org uuid; provider text; conn public.integration_connections; att uuid; intent uuid; token text; env text;
BEGIN
  org := public.current_org_id();
  IF org IS NULL THEN RETURN jsonb_build_object('ok', false, 'reason', 'no_organisation'); END IF;
  IF NOT (public.has_permission('pos','payments','process')
          OR public.has_permission('finance','collections','record_payment')
          OR public.has_permission('finance','edit')) THEN
    RAISE EXCEPTION 'Not permitted to take payments' USING ERRCODE = '42501';
  END IF;
  IF _branch IS NOT NULL AND NOT public.neo_branch_in_scope(_branch) THEN
    RAISE EXCEPTION 'That property is outside your access scope.' USING ERRCODE = '42501';
  END IF;
  IF coalesce(_amount,0) <= 0 THEN RETURN jsonb_build_object('ok', false, 'reason', 'zero_amount'); END IF;

  provider := public.neo_payment_provider_code(_method);
  IF provider IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_provider_backed',
      'detail', 'This tender is recorded directly; it has no provider to ask.');
  END IF;

  SELECT * INTO conn FROM public.integration_connections
   WHERE organization_id = org AND provider_code = provider
     AND (branch_id IS NULL OR branch_id = _branch)
   ORDER BY branch_id NULLS LAST LIMIT 1;

  IF provider = 'daraja' THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'use_mpesa_flow',
      'detail', 'M-Pesa collections run through the Safaricom Daraja prompt.');
  END IF;

  IF conn.id IS NULL OR NOT coalesce(conn.enabled,false) OR conn.status IS DISTINCT FROM 'connected' THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'provider_not_connected',
      'provider', provider,
      'detail', 'No processor is connected for this method in this workspace, so nothing can be requested.');
  END IF;

  env := coalesce(conn.environment, 'sandbox');
  intent := gen_random_uuid();
  token := public.neo_random_token();

  att := public.neo_payment_attempt_sync(
    org, _branch, coalesce(_module,'pos'), _source_record, 'payment_intents', intent,
    _method, _amount, _currency, nullif(_reference,''), 'requested',
    'Waiting for the ' || provider || ' terminal or app to answer.', env,
    NULL, NULL, NULL, now(), auth.uid());

  UPDATE public.payment_attempts SET callback_token = token WHERE id = att;

  RETURN jsonb_build_object('ok', true, 'intent_id', intent, 'attempt_id', att,
    'provider', provider, 'environment', env, 'callback_token', token);
END;
$$;

REVOKE ALL ON FUNCTION public.neo_payment_intent_open(text,uuid,text,numeric,uuid,text,text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.neo_payment_intent_open(text,uuid,text,numeric,uuid,text,text) TO authenticated;

-- ---------- apply a provider's own answer (token-authenticated) ----------
CREATE OR REPLACE FUNCTION public.neo_payment_intent_apply(
  _token text, _outcome text, _provider_reference text DEFAULT NULL,
  _detail text DEFAULT NULL, _payload jsonb DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE a public.payment_attempts; next_state text;
BEGIN
  IF coalesce(btrim(coalesce(_token,'')),'') = '' THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'no_token');
  END IF;
  SELECT * INTO a FROM public.payment_attempts WHERE callback_token = _token;
  IF a.id IS NULL THEN RETURN jsonb_build_object('ok', false, 'reason', 'unknown_token'); END IF;

  next_state := CASE lower(coalesce(_outcome,''))
    WHEN 'approved' THEN 'confirmed'
    WHEN 'confirmed' THEN 'confirmed'
    WHEN 'declined' THEN 'failed'
    WHEN 'failed' THEN 'failed'
    WHEN 'cancelled' THEN 'cancelled'
    WHEN 'timeout' THEN 'timed_out'
    WHEN 'reversed' THEN 'refunded'
    WHEN 'refunded' THEN 'refunded'
    ELSE NULL END;
  IF next_state IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'unknown_outcome');
  END IF;

  IF a.state IN ('confirmed','posted','refunded','voided') AND next_state = a.state THEN
    RETURN jsonb_build_object('ok', true, 'reason', 'already_applied', 'state', a.state);
  END IF;

  UPDATE public.payment_attempts
     SET state = next_state,
         state_detail = coalesce(_detail, state_detail),
         provider_reference = coalesce(nullif(_provider_reference,''), provider_reference),
         reference = coalesce(reference, nullif(_provider_reference,'')),
         provider_payload = coalesce(_payload, provider_payload),
         confirmed_at = CASE WHEN next_state = 'confirmed' THEN coalesce(confirmed_at, now()) ELSE confirmed_at END,
         updated_at = now()
   WHERE id = a.id;

  INSERT INTO public.payment_attempt_events (organization_id, attempt_id, from_state, to_state, detail)
  VALUES (a.organization_id, a.id, a.state, next_state,
          coalesce(_detail, 'Provider answered: ' || _outcome));

  RETURN jsonb_build_object('ok', true, 'state', next_state, 'attempt_id', a.id);
END;
$$;

REVOKE ALL ON FUNCTION public.neo_payment_intent_apply(text,text,text,text,jsonb) FROM PUBLIC, anon, authenticated;

-- ---------- read one intent back (for the waiting checkout screen) ----------
CREATE OR REPLACE FUNCTION public.neo_payment_intent_status(_intent uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE a public.payment_attempts; org uuid;
BEGIN
  org := public.current_org_id();
  SELECT * INTO a FROM public.payment_attempts
   WHERE payment_table = 'payment_intents' AND payment_id = _intent AND organization_id = org;
  IF a.id IS NULL THEN RETURN jsonb_build_object('ok', false, 'reason', 'not_found'); END IF;
  RETURN jsonb_build_object('ok', true, 'state', a.state, 'detail', a.state_detail,
    'provider_reference', a.provider_reference, 'amount', a.amount, 'method', a.method,
    'environment', a.environment);
END;
$$;

REVOKE ALL ON FUNCTION public.neo_payment_intent_status(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.neo_payment_intent_status(uuid) TO authenticated;

-- ---------- till tenders: recorded means recorded, provider means provider ----------
CREATE OR REPLACE FUNCTION public.pos_record_payment_attempt(
  _order_id uuid, _amount numeric, _method text, _tendered numeric DEFAULT NULL::numeric,
  _reference text DEFAULT NULL::text, _shift_id uuid DEFAULT NULL::uuid,
  _idempotency_key text DEFAULT NULL::text, _manual_confirm boolean DEFAULT false,
  _note text DEFAULT NULL::text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  _org uuid := public.current_org_id();
  _o public.pos_orders;
  _existing public.pos_payments;
  _confirmed numeric := 0;
  _active numeric := 0;
  _balance numeric;
  _headroom numeric;
  _status text;
  _provider boolean;
  _needs_reference boolean;
  _change numeric := 0;
  _payment uuid;
  _key text := coalesce(nullif(_idempotency_key,''), 'pos-pay:' || _order_id::text || ':' || gen_random_uuid()::text);
BEGIN
  IF NOT public.has_permission('pos','payments','process') THEN
    RAISE EXCEPTION 'Not permitted to take payments';
  END IF;

  SELECT * INTO _existing FROM public.pos_payments
   WHERE organization_id = _org AND idempotency_key = _key;
  IF _existing.id IS NOT NULL THEN
    RETURN jsonb_build_object('payment_id', _existing.id, 'status', _existing.status, 'duplicate', true)
        || public.pos_reconcile_settlement_internal(_existing.order_id);
  END IF;

  SELECT * INTO _o FROM public.pos_orders WHERE id = _order_id AND organization_id = _org FOR UPDATE;
  IF _o.id IS NULL THEN RAISE EXCEPTION 'Order not found'; END IF;
  IF NOT public.neo_branch_in_scope(_o.branch_id) THEN
    RAISE EXCEPTION 'That bill belongs to a property outside your access';
  END IF;
  IF _o.status IN ('closed','cancelled','voided','charged-to-room') THEN
    RAISE EXCEPTION 'Bill is % and cannot take further payment', _o.status;
  END IF;

  SELECT coalesce(sum(amount) FILTER (WHERE status = 'confirmed'), 0),
         coalesce(sum(amount) FILTER (WHERE status IN ('initiated','pending')), 0)
    INTO _confirmed, _active
    FROM public.pos_payments WHERE order_id = _order_id;

  _balance := round(coalesce(_o.grand_total,0) - _confirmed, 2);
  _headroom := round(_balance - _active, 2);

  IF coalesce(_amount,0) <= 0 THEN RAISE EXCEPTION 'Payment amount must be greater than zero'; END IF;
  IF _amount > _headroom + 0.005 THEN
    RAISE EXCEPTION 'Payment of % exceeds the settleable balance of % (outstanding %, awaiting provider %)',
      _amount, greatest(_headroom,0), greatest(_balance,0), _active;
  END IF;

  -- A provider-backed tender is only ever confirmed by the provider itself.
  _provider := _method IN ('mpesa','card-terminal','qr');
  -- Every tender except cash carries an outside reference: a slip, a transfer
  -- reference, a voucher number. It is recorded, and a person verifies it later.
  _needs_reference := _method <> 'cash' AND _method <> 'complimentary';

  IF _needs_reference AND coalesce(btrim(coalesce(_reference,'')),'') = '' THEN
    RAISE EXCEPTION 'A reference is required for a % payment', _method;
  END IF;

  IF _manual_confirm THEN
    IF NOT public.has_permission('pos','payments','manual-confirm') THEN
      RAISE EXCEPTION 'Not permitted to confirm payments manually';
    END IF;
    IF NOT _provider THEN
      RAISE EXCEPTION 'Manual confirmation applies to provider-backed payments only';
    END IF;
    IF coalesce(btrim(coalesce(_note,'')),'') = '' THEN
      RAISE EXCEPTION 'A verification note is required for a manually confirmed payment';
    END IF;
    _status := 'confirmed';
  ELSE
    _status := CASE WHEN _provider THEN 'pending' ELSE 'confirmed' END;
  END IF;

  IF _method = 'cash' AND _tendered IS NOT NULL THEN
    _change := greatest(0, _tendered - _amount);
  END IF;

  INSERT INTO public.pos_payments (
    organization_id, branch_id, order_id, amount, tendered, change_due, currency, method,
    external_reference, status, provider_status, paid_at, cashier_id, shift_id, customer_id,
    created_by, verified_by, verification_note, idempotency_key
  ) VALUES (
    _org, _o.branch_id, _order_id, round(_amount,2), _tendered, _change, _o.currency, _method,
    nullif(btrim(coalesce(_reference,'')),''), _status,
    CASE WHEN _manual_confirm THEN 'manual-confirmed'
         WHEN _provider THEN 'awaiting-provider'
         WHEN _method = 'cash' THEN NULL
         ELSE 'recorded-unverified' END,
    CASE WHEN _status = 'confirmed' THEN now() ELSE NULL END,
    auth.uid(), _shift_id, _o.customer_id, auth.uid(),
    CASE WHEN _manual_confirm THEN auth.uid() ELSE NULL END,
    nullif(btrim(coalesce(_note,'')),''), _key
  ) RETURNING id INTO _payment;

  INSERT INTO public.audit_logs (organization_id, branch_id, user_id, action, module, record_id, new_value)
  VALUES (_org, _o.branch_id, auth.uid(), 'pos.payment.record', 'pos', _order_id,
          jsonb_build_object('paymentId', _payment, 'amount', round(_amount,2), 'method', _method,
                             'status', _status, 'manualConfirm', _manual_confirm,
                             'providerBacked', _provider,
                             'reference', nullif(btrim(coalesce(_reference,'')),'')));

  RETURN jsonb_build_object('payment_id', _payment, 'status', _status, 'duplicate', false,
                            'provider_backed', _provider)
      || public.pos_reconcile_settlement_internal(_order_id);
END $function$;
