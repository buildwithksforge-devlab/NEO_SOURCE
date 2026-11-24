BEGIN;

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
  outcome text := lower(btrim(COALESCE(_outcome, '')));
  refund_reference text := NULLIF(btrim(_provider_reference), '');
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

  -- The generic callback has no verified refund amount or journal. Save the
  -- observation for Finance without changing the collection or its accounting.
  IF outcome IN ('reversed', 'refunded') THEN
    IF NOT EXISTS (
      SELECT 1 FROM public.audit_logs AS observation
      WHERE observation.organization_id = attempt.organization_id
        AND observation.action = 'payment.intent.refund_observed'
        AND observation.new_value->>'attemptId' = attempt.id::text
        AND observation.new_value->>'providerReference' IS NOT DISTINCT FROM refund_reference
    ) THEN
      INSERT INTO public.audit_logs (organization_id, branch_id, action, module, record_id, new_value)
      VALUES (attempt.organization_id, attempt.branch_id, 'payment.intent.refund_observed', 'finance',
        COALESCE(attempt.linked_id, attempt.id), jsonb_build_object(
          'attemptId', attempt.id, 'method', attempt.method, 'providerReference', refund_reference,
          'refundReconciliationRequired', true
        )
      );
    END IF;
    RETURN jsonb_build_object(
      'ok', true, 'state', attempt.state, 'attempt_id', attempt.id,
      'refund_reconciliation_required', true
    );
  END IF;

  next_state := CASE outcome
    WHEN 'approved' THEN 'confirmed'
    WHEN 'confirmed' THEN 'confirmed'
    WHEN 'declined' THEN 'failed'
    WHEN 'failed' THEN 'failed'
    WHEN 'cancelled' THEN 'cancelled'
    WHEN 'timeout' THEN 'timed_out'

    ELSE NULL
  END;
  IF next_state IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'unknown_outcome');
  END IF;

  IF next_state = 'confirmed' AND attempt.state IN ('refunded', 'voided') THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'payment_closed', 'state', attempt.state);
  END IF;
  IF attempt.state = next_state OR (attempt.state = 'posted' AND next_state = 'confirmed') THEN
    RETURN jsonb_build_object('ok', true, 'reason', 'already_applied', 'state', attempt.state);
  END IF;
  IF attempt.state IN ('confirmed', 'posted', 'refunded', 'voided')
     AND next_state IN ('failed', 'cancelled', 'timed_out') THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'already_confirmed', 'state', attempt.state);
  END IF;

  IF next_state = 'confirmed' AND EXISTS (
    SELECT 1 FROM public.audit_logs AS observation
    WHERE observation.organization_id = attempt.organization_id
      AND observation.action = 'payment.intent.refund_observed'
      AND observation.new_value->>'attemptId' = attempt.id::text
  ) THEN
    RETURN jsonb_build_object(
      'ok', false, 'reason', 'refund_reconciliation_required', 'state', attempt.state,
      'refund_reconciliation_required', true
    );
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

COMMIT;
