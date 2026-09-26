
ALTER TABLE public.payment_attempts
  ADD COLUMN IF NOT EXISTS linked_table text,
  ADD COLUMN IF NOT EXISTS linked_id uuid;

CREATE OR REPLACE FUNCTION public.neo_payment_intent_open(
  _module text, _source_record uuid, _method text, _amount numeric,
  _branch uuid DEFAULT NULL, _currency text DEFAULT NULL, _reference text DEFAULT NULL,
  _link_table text DEFAULT NULL, _link_id uuid DEFAULT NULL)
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
  IF _link_table IS NOT NULL AND _link_table NOT IN ('pos_payments','payments') THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'unsupported_link');
  END IF;

  -- The linked payment must belong to this workspace: a request can never be
  -- pointed at another tenant's money.
  IF _link_table = 'pos_payments' THEN
    IF NOT EXISTS (SELECT 1 FROM public.pos_payments WHERE id = _link_id AND organization_id = org) THEN
      RETURN jsonb_build_object('ok', false, 'reason', 'link_not_found');
    END IF;
  ELSIF _link_table = 'payments' THEN
    IF NOT EXISTS (SELECT 1 FROM public.payments WHERE id = _link_id AND organization_id = org) THEN
      RETURN jsonb_build_object('ok', false, 'reason', 'link_not_found');
    END IF;
  END IF;

  provider := public.neo_payment_provider_code(_method);
  IF provider IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_provider_backed',
      'detail', 'This tender is recorded directly; it has no provider to ask.');
  END IF;
  IF provider = 'daraja' THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'use_mpesa_flow',
      'detail', 'M-Pesa collections run through the Safaricom Daraja prompt.');
  END IF;

  SELECT * INTO conn FROM public.integration_connections
   WHERE organization_id = org AND provider_code = provider
     AND (branch_id IS NULL OR branch_id = _branch)
   ORDER BY branch_id NULLS LAST LIMIT 1;

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

  UPDATE public.payment_attempts
     SET callback_token = token, linked_table = _link_table, linked_id = _link_id
   WHERE id = att;

  RETURN jsonb_build_object('ok', true, 'intent_id', intent, 'attempt_id', att,
    'provider', provider, 'environment', env, 'callback_token', token);
END;
$$;

REVOKE ALL ON FUNCTION public.neo_payment_intent_open(text,uuid,text,numeric,uuid,text,text,text,uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.neo_payment_intent_open(text,uuid,text,numeric,uuid,text,text,text,uuid) TO authenticated;
DROP FUNCTION IF EXISTS public.neo_payment_intent_open(text,uuid,text,numeric,uuid,text,text);

CREATE OR REPLACE FUNCTION public.neo_payment_intent_apply(
  _token text, _outcome text, _provider_reference text DEFAULT NULL,
  _detail text DEFAULT NULL, _payload jsonb DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE a public.payment_attempts; next_state text; settle jsonb := '{}'::jsonb; ord uuid;
BEGIN
  IF coalesce(btrim(coalesce(_token,'')),'') = '' THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'no_token');
  END IF;
  SELECT * INTO a FROM public.payment_attempts WHERE callback_token = _token FOR UPDATE;
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

  IF a.state = next_state THEN
    RETURN jsonb_build_object('ok', true, 'reason', 'already_applied', 'state', a.state);
  END IF;
  IF a.state IN ('confirmed','posted','refunded','voided') AND next_state IN ('failed','cancelled','timed_out') THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'already_confirmed', 'state', a.state);
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

  IF a.linked_table = 'pos_payments' AND a.linked_id IS NOT NULL THEN
    IF next_state = 'confirmed' THEN
      UPDATE public.pos_payments
         SET status = 'confirmed', provider_status = 'provider-confirmed',
             paid_at = coalesce(paid_at, now()),
             external_reference = coalesce(external_reference, nullif(_provider_reference,'')),
             updated_at = now()
       WHERE id = a.linked_id AND status IN ('initiated','pending')
       RETURNING order_id INTO ord;
      IF ord IS NOT NULL THEN
        settle := public.pos_reconcile_settlement_internal(ord);
      END IF;
    ELSIF next_state IN ('failed','cancelled','timed_out') THEN
      UPDATE public.pos_payments
         SET status = CASE WHEN next_state = 'cancelled' THEN 'cancelled' ELSE 'failed' END,
             provider_status = 'provider-' || next_state,
             updated_at = now()
       WHERE id = a.linked_id AND status IN ('initiated','pending');
    END IF;
  ELSIF a.linked_table = 'payments' AND a.linked_id IS NOT NULL THEN
    IF next_state = 'confirmed' THEN
      UPDATE public.payments
         SET status = 'confirmed', paid_at = coalesce(paid_at, now()),
             external_reference = coalesce(external_reference, nullif(_provider_reference,'')),
             updated_at = now()
       WHERE id = a.linked_id AND status IN ('initiated','pending');
    ELSIF next_state IN ('failed','cancelled','timed_out') THEN
      UPDATE public.payments
         SET status = CASE WHEN next_state = 'cancelled' THEN 'cancelled' ELSE 'failed' END,
             updated_at = now()
       WHERE id = a.linked_id AND status IN ('initiated','pending');
    END IF;
  END IF;

  INSERT INTO public.audit_logs (organization_id, branch_id, action, module, record_id, new_value)
  VALUES (a.organization_id, a.branch_id, 'payment.intent.' || next_state, 'finance', a.linked_id,
          jsonb_build_object('attemptId', a.id, 'method', a.method, 'amount', a.amount,
                             'providerReference', nullif(_provider_reference,'')));

  RETURN jsonb_build_object('ok', true, 'state', next_state, 'attempt_id', a.id) || settle;
END;
$$;

REVOKE ALL ON FUNCTION public.neo_payment_intent_apply(text,text,text,text,jsonb) FROM PUBLIC, anon, authenticated;
