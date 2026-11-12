-- Keep provider callback bearer tokens out of tenant-readable payment rows
-- and claim provider dispatch atomically before making an external request.

ALTER TABLE public.payment_attempts
  ADD COLUMN IF NOT EXISTS dispatch_started_at timestamptz;

UPDATE public.payment_attempts
   SET callback_token = encode(
     extensions.digest(convert_to(callback_token, 'UTF8'), 'sha256'),
     'hex'
   )
 WHERE callback_token IS NOT NULL
   AND callback_token !~ '^[0-9a-f]{64}$';

CREATE OR REPLACE FUNCTION public.neo_payment_intent_open(
  _module text,
  _source_record uuid,
  _method text,
  _amount numeric,
  _branch uuid DEFAULT NULL,
  _currency text DEFAULT NULL,
  _reference text DEFAULT NULL,
  _link_table text DEFAULT NULL,
  _link_id uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  org uuid;
  provider text;
  conn public.integration_connections;
  att uuid;
  intent uuid;
  env text;
BEGIN
  org := public.current_org_id();
  IF org IS NULL THEN RETURN jsonb_build_object('ok', false, 'reason', 'no_organisation'); END IF;
  IF NOT (
    public.has_permission('pos', 'payments', 'process')
    OR public.has_permission('finance', 'collections', 'record_payment')
    OR public.has_permission('finance', 'edit')
  ) THEN
    RAISE EXCEPTION 'Not permitted to take payments' USING ERRCODE = '42501';
  END IF;
  IF _branch IS NOT NULL AND NOT public.neo_branch_in_scope(_branch) THEN
    RAISE EXCEPTION 'That property is outside your access scope.' USING ERRCODE = '42501';
  END IF;
  IF COALESCE(_amount, 0) <= 0 THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'zero_amount');
  END IF;
  IF _link_table IS NOT NULL AND _link_table NOT IN ('pos_payments', 'payments') THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'unsupported_link');
  END IF;

  IF _link_table = 'pos_payments' THEN
    IF NOT EXISTS (
      SELECT 1 FROM public.pos_payments
       WHERE id = _link_id AND organization_id = org
    ) THEN
      RETURN jsonb_build_object('ok', false, 'reason', 'link_not_found');
    END IF;
  ELSIF _link_table = 'payments' THEN
    IF NOT EXISTS (
      SELECT 1 FROM public.payments
       WHERE id = _link_id AND organization_id = org
    ) THEN
      RETURN jsonb_build_object('ok', false, 'reason', 'link_not_found');
    END IF;
  END IF;

  provider := public.neo_payment_provider_code(_method);
  IF provider IS NULL THEN
    RETURN jsonb_build_object(
      'ok', false, 'reason', 'not_provider_backed',
      'detail', 'This tender is recorded directly; it has no provider to ask.'
    );
  END IF;
  IF provider = 'daraja' THEN
    RETURN jsonb_build_object(
      'ok', false, 'reason', 'use_mpesa_flow',
      'detail', 'M-Pesa collections run through the Safaricom Daraja prompt.'
    );
  END IF;

  SELECT * INTO conn
    FROM public.integration_connections
   WHERE organization_id = org
     AND provider_code = provider
     AND (branch_id IS NULL OR branch_id = _branch)
   ORDER BY branch_id NULLS LAST
   LIMIT 1;
  IF conn.id IS NULL OR NOT COALESCE(conn.enabled, false) OR conn.status IS DISTINCT FROM 'connected' THEN
    RETURN jsonb_build_object(
      'ok', false, 'reason', 'provider_not_connected', 'provider', provider,
      'detail', 'No processor is connected for this method in this workspace, so nothing can be requested.'
    );
  END IF;

  env := COALESCE(conn.environment, 'sandbox');
  intent := gen_random_uuid();
  att := public.neo_payment_attempt_sync(
    org, _branch, COALESCE(_module, 'pos'), _source_record, 'payment_intents', intent,
    _method, _amount, _currency, NULLIF(_reference, ''), 'requested',
    'Waiting for the ' || provider || ' terminal or app to answer.', env,
    NULL, NULL, NULL, now(), auth.uid()
  );

  UPDATE public.payment_attempts
     SET callback_token = NULL,
         dispatch_started_at = NULL,
         linked_table = _link_table,
         linked_id = _link_id
   WHERE id = att;

  RETURN jsonb_build_object(
    'ok', true,
    'intent_id', intent,
    'attempt_id', att,
    'provider', provider,
    'environment', env
  );
END
$function$;

REVOKE ALL ON FUNCTION public.neo_payment_intent_open(
  text, uuid, text, numeric, uuid, text, text, text, uuid
) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.neo_payment_intent_open(
  text, uuid, text, numeric, uuid, text, text, text, uuid
) TO authenticated;

CREATE OR REPLACE FUNCTION public.neo_payment_intent_claim_dispatch(
  _intent uuid,
  _token text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  org uuid := public.current_org_id();
  attempt public.payment_attempts;
BEGIN
  IF org IS NULL THEN RETURN jsonb_build_object('ok', false, 'reason', 'no_organisation'); END IF;
  IF NOT (
    public.has_permission('pos', 'payments', 'process')
    OR public.has_permission('finance', 'collections', 'record_payment')
    OR public.has_permission('finance', 'edit')
  ) THEN
    RAISE EXCEPTION 'Not permitted to take payments' USING ERRCODE = '42501';
  END IF;
  IF COALESCE(length(_token), 0) < 32 THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'invalid_callback_token');
  END IF;

  SELECT * INTO attempt
    FROM public.payment_attempts
   WHERE payment_table = 'payment_intents'
     AND payment_id = _intent
     AND organization_id = org
   FOR UPDATE;
  IF attempt.id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'intent_not_found');
  END IF;
  IF attempt.state <> 'requested' OR attempt.dispatch_started_at IS NOT NULL THEN
    RETURN jsonb_build_object('ok', true, 'claimed', false, 'state', attempt.state);
  END IF;

  UPDATE public.payment_attempts
     SET callback_token = encode(
           extensions.digest(convert_to(_token, 'UTF8'), 'sha256'),
           'hex'
         ),
         dispatch_started_at = now(),
         updated_at = now()
   WHERE id = attempt.id;

  RETURN jsonb_build_object('ok', true, 'claimed', true, 'state', 'requested');
END
$function$;

REVOKE ALL ON FUNCTION public.neo_payment_intent_claim_dispatch(uuid, text)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.neo_payment_intent_claim_dispatch(uuid, text)
  TO authenticated;

CREATE OR REPLACE FUNCTION public.neo_payment_intent_mark_sent(
  _intent uuid,
  _provider_reference text DEFAULT NULL,
  _detail text DEFAULT NULL,
  _failed boolean DEFAULT false
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  org uuid := public.current_org_id();
  attempt public.payment_attempts;
  next_state text;
BEGIN
  IF org IS NULL THEN RETURN jsonb_build_object('ok', false, 'reason', 'no_organisation'); END IF;
  IF NOT (
    public.has_permission('pos', 'payments', 'process')
    OR public.has_permission('finance', 'collections', 'record_payment')
    OR public.has_permission('finance', 'edit')
  ) THEN
    RAISE EXCEPTION 'Not permitted to take payments' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO attempt
    FROM public.payment_attempts
   WHERE payment_table = 'payment_intents'
     AND payment_id = _intent
     AND organization_id = org
   FOR UPDATE;
  IF attempt.id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'intent_not_found');
  END IF;
  IF attempt.dispatch_started_at IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'dispatch_not_claimed');
  END IF;
  IF attempt.state NOT IN ('requested', 'pending') THEN
    RETURN jsonb_build_object('ok', true, 'state', attempt.state, 'detail', 'Already answered.');
  END IF;

  next_state := CASE WHEN _failed THEN 'failed' ELSE 'pending' END;
  UPDATE public.payment_attempts
     SET state = next_state,
         state_detail = COALESCE(
           _detail,
           CASE WHEN _failed THEN 'The processor could not be reached.'
                ELSE 'Sent to the processor; waiting for the customer to complete it.' END
         ),
         provider_reference = COALESCE(NULLIF(_provider_reference, ''), attempt.provider_reference),
         updated_at = now()
   WHERE id = attempt.id;

  INSERT INTO public.payment_attempt_events (attempt_id, organization_id, state, detail, payload, created_by)
  VALUES (
    attempt.id, org, next_state, _detail,
    jsonb_build_object('provider_reference', _provider_reference), auth.uid()
  );

  RETURN jsonb_build_object('ok', true, 'state', next_state);
END
$function$;

REVOKE ALL ON FUNCTION public.neo_payment_intent_mark_sent(uuid, text, text, boolean)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.neo_payment_intent_mark_sent(uuid, text, text, boolean)
  TO authenticated;

CREATE OR REPLACE FUNCTION public.neo_payment_intent_apply(
  _token text,
  _outcome text,
  _provider_reference text DEFAULT NULL,
  _detail text DEFAULT NULL,
  _payload jsonb DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  attempt public.payment_attempts;
  next_state text;
  settle jsonb := '{}'::jsonb;
  ord uuid;
BEGIN
  IF COALESCE(btrim(_token), '') = '' THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'no_token');
  END IF;

  SELECT * INTO attempt
    FROM public.payment_attempts
   WHERE callback_token = encode(
     extensions.digest(convert_to(_token, 'UTF8'), 'sha256'),
     'hex'
   )
   FOR UPDATE;
  IF attempt.id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'unknown_token');
  END IF;

  next_state := CASE lower(COALESCE(_outcome, ''))
    WHEN 'approved' THEN 'confirmed'
    WHEN 'confirmed' THEN 'confirmed'
    WHEN 'declined' THEN 'failed'
    WHEN 'failed' THEN 'failed'
    WHEN 'cancelled' THEN 'cancelled'
    WHEN 'timeout' THEN 'timed_out'
    WHEN 'reversed' THEN 'refunded'
    WHEN 'refunded' THEN 'refunded'
    ELSE NULL
  END;
  IF next_state IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'unknown_outcome');
  END IF;

  IF attempt.state = next_state THEN
    RETURN jsonb_build_object('ok', true, 'reason', 'already_applied', 'state', attempt.state);
  END IF;
  IF attempt.state IN ('confirmed', 'posted', 'refunded', 'voided')
     AND next_state IN ('failed', 'cancelled', 'timed_out') THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'already_confirmed', 'state', attempt.state);
  END IF;

  UPDATE public.payment_attempts
     SET state = next_state,
         state_detail = COALESCE(_detail, state_detail),
         provider_reference = COALESCE(NULLIF(_provider_reference, ''), provider_reference),
         reference = COALESCE(reference, NULLIF(_provider_reference, '')),
         provider_payload = COALESCE(_payload, provider_payload),
         confirmed_at = CASE WHEN next_state = 'confirmed' THEN COALESCE(confirmed_at, now()) ELSE confirmed_at END,
         updated_at = now()
   WHERE id = attempt.id;

  INSERT INTO public.payment_attempt_events (organization_id, attempt_id, from_state, to_state, detail)
  VALUES (
    attempt.organization_id, attempt.id, attempt.state, next_state,
    COALESCE(_detail, 'Provider answered: ' || _outcome)
  );

  IF attempt.linked_table = 'pos_payments' AND attempt.linked_id IS NOT NULL THEN
    IF next_state = 'confirmed' THEN
      UPDATE public.pos_payments
         SET status = 'confirmed',
             provider_status = 'provider-confirmed',
             paid_at = COALESCE(paid_at, now()),
             external_reference = COALESCE(external_reference, NULLIF(_provider_reference, '')),
             updated_at = now()
       WHERE id = attempt.linked_id
         AND status IN ('initiated', 'pending')
       RETURNING order_id INTO ord;
      IF ord IS NOT NULL THEN
        settle := public.pos_reconcile_settlement_internal(ord);
      END IF;
    ELSIF next_state IN ('failed', 'cancelled', 'timed_out') THEN
      UPDATE public.pos_payments
         SET status = CASE WHEN next_state = 'cancelled' THEN 'cancelled' ELSE 'failed' END,
             provider_status = 'provider-' || next_state,
             updated_at = now()
       WHERE id = attempt.linked_id
         AND status IN ('initiated', 'pending');
    END IF;
  ELSIF attempt.linked_table = 'payments' AND attempt.linked_id IS NOT NULL THEN
    IF next_state = 'confirmed' THEN
      UPDATE public.payments
         SET status = 'confirmed',
             paid_at = COALESCE(paid_at, now()),
             external_reference = COALESCE(external_reference, NULLIF(_provider_reference, '')),
             updated_at = now()
       WHERE id = attempt.linked_id
         AND status IN ('initiated', 'pending');
    ELSIF next_state IN ('failed', 'cancelled', 'timed_out') THEN
      UPDATE public.payments
         SET status = CASE WHEN next_state = 'cancelled' THEN 'cancelled' ELSE 'failed' END,
             updated_at = now()
       WHERE id = attempt.linked_id
         AND status IN ('initiated', 'pending');
    END IF;
  END IF;

  INSERT INTO public.audit_logs (organization_id, branch_id, action, module, record_id, new_value)
  VALUES (
    attempt.organization_id, attempt.branch_id, 'payment.intent.' || next_state, 'finance', attempt.linked_id,
    jsonb_build_object(
      'attemptId', attempt.id,
      'method', attempt.method,
      'amount', attempt.amount,
      'providerReference', NULLIF(_provider_reference, '')
    )
  );

  RETURN jsonb_build_object('ok', true, 'state', next_state, 'attempt_id', attempt.id) || settle;
END
$function$;

REVOKE ALL ON FUNCTION public.neo_payment_intent_apply(text, text, text, text, jsonb)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.neo_payment_intent_apply(text, text, text, text, jsonb)
  TO service_role;
