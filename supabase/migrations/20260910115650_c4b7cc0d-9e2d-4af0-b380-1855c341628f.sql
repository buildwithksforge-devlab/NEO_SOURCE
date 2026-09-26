-- ============================================================
-- Courier dispatch gateway
-- ============================================================
INSERT INTO public.integration_providers
  (code, name, category, purpose, required_secret_names, requires_partner_approval, supports_sandbox, supports_webhooks, sort_order, active)
SELECT 'courier_gateway', 'Courier Dispatch', 'logistics',
       'Third-party courier dispatch request and delivery confirmation',
       '{}'::text[], true, true, true, 33, true
WHERE NOT EXISTS (SELECT 1 FROM public.integration_providers WHERE code = 'courier_gateway');

CREATE TABLE IF NOT EXISTS public.delivery_dispatch_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  branch_id uuid,
  delivery_order_id uuid NOT NULL REFERENCES public.delivery_orders(id) ON DELETE CASCADE,
  provider_code text NOT NULL DEFAULT 'courier_gateway',
  environment text NOT NULL DEFAULT 'sandbox',
  state text NOT NULL DEFAULT 'requested',
  state_detail text,
  provider_reference text,
  callback_token text UNIQUE,
  request_payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  provider_payload jsonb,
  requested_by uuid,
  requested_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.delivery_dispatch_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  job_id uuid NOT NULL REFERENCES public.delivery_dispatch_jobs(id) ON DELETE CASCADE,
  from_state text,
  to_state text NOT NULL,
  detail text,
  payload jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS delivery_dispatch_jobs_open_uq
  ON public.delivery_dispatch_jobs (delivery_order_id)
  WHERE state IN ('requested', 'sent', 'accepted', 'picked_up');
CREATE INDEX IF NOT EXISTS delivery_dispatch_jobs_org_idx
  ON public.delivery_dispatch_jobs (organization_id, state, requested_at DESC);
CREATE INDEX IF NOT EXISTS delivery_dispatch_events_job_idx
  ON public.delivery_dispatch_events (job_id, created_at DESC);

GRANT SELECT ON public.delivery_dispatch_jobs TO authenticated;
GRANT SELECT ON public.delivery_dispatch_events TO authenticated;
GRANT ALL ON public.delivery_dispatch_jobs TO service_role;
GRANT ALL ON public.delivery_dispatch_events TO service_role;

ALTER TABLE public.delivery_dispatch_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.delivery_dispatch_events ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Workspace can read courier dispatch jobs" ON public.delivery_dispatch_jobs;
CREATE POLICY "Workspace can read courier dispatch jobs"
  ON public.delivery_dispatch_jobs FOR SELECT TO authenticated
  USING (organization_id = public.current_org_id());

DROP POLICY IF EXISTS "Workspace can read courier dispatch events" ON public.delivery_dispatch_events;
CREATE POLICY "Workspace can read courier dispatch events"
  ON public.delivery_dispatch_events FOR SELECT TO authenticated
  USING (organization_id = public.current_org_id());

CREATE OR REPLACE FUNCTION public.neo_delivery_dispatch_open(_order uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE org uuid; o public.delivery_orders; conn public.integration_connections;
        job public.delivery_dispatch_jobs; token text; env text; new_id uuid;
BEGIN
  org := public.current_org_id();
  IF org IS NULL THEN RETURN jsonb_build_object('ok', false, 'reason', 'no_organisation'); END IF;
  IF NOT (public.has_permission('delivery','dispatch','assign') OR public.has_permission('delivery','edit')) THEN
    RAISE EXCEPTION 'Not permitted to dispatch delivery orders' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO o FROM public.delivery_orders WHERE id = _order AND organization_id = org;
  IF o.id IS NULL THEN RETURN jsonb_build_object('ok', false, 'reason', 'order_not_found'); END IF;
  IF o.branch_id IS NOT NULL AND NOT public.neo_branch_in_scope(o.branch_id) THEN
    RAISE EXCEPTION 'That property is outside your access scope.' USING ERRCODE = '42501';
  END IF;
  IF o.order_status IN ('delivered','cancelled','rejected','failed') THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'order_closed',
      'detail', 'This order is already finished, so no courier can be asked for it.');
  END IF;

  SELECT * INTO job FROM public.delivery_dispatch_jobs
   WHERE delivery_order_id = o.id AND state IN ('requested','sent','accepted','picked_up')
   LIMIT 1;
  IF job.id IS NOT NULL THEN
    RETURN jsonb_build_object('ok', true, 'reason', 'already_open', 'job_id', job.id,
      'state', job.state, 'environment', job.environment);
  END IF;

  SELECT * INTO conn FROM public.integration_connections
   WHERE organization_id = org AND provider_code = 'courier_gateway'
     AND (branch_id IS NULL OR branch_id = o.branch_id)
   ORDER BY branch_id NULLS LAST LIMIT 1;

  IF conn.id IS NULL OR NOT coalesce(conn.enabled,false) OR conn.status IS DISTINCT FROM 'connected' THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'provider_not_connected',
      'detail', 'No courier service is connected for this workspace, so nothing can be sent.');
  END IF;

  env := coalesce(conn.environment, 'sandbox');
  token := public.neo_random_token();
  new_id := gen_random_uuid();

  INSERT INTO public.delivery_dispatch_jobs
    (id, organization_id, branch_id, delivery_order_id, provider_code, environment, state,
     state_detail, callback_token, request_payload, requested_by)
  VALUES (new_id, org, o.branch_id, o.id, 'courier_gateway', env, 'requested',
          'Waiting to be sent to the courier.', token,
          jsonb_build_object(
            'order_number', o.order_number,
            'contact_name', o.contact_name,
            'contact_phone', o.contact_phone,
            'address', o.address_snapshot,
            'latitude', o.latitude,
            'longitude', o.longitude,
            'grand_total', o.grand_total,
            'currency', o.currency,
            'payment_method', o.payment_method,
            'payment_status', o.payment_status),
          auth.uid());

  INSERT INTO public.delivery_dispatch_events (organization_id, job_id, from_state, to_state, detail)
  VALUES (org, new_id, NULL, 'requested', 'Courier dispatch requested in NEØ.');

  INSERT INTO public.audit_logs (organization_id, branch_id, action, module, record_id, new_value)
  VALUES (org, o.branch_id, 'delivery.dispatch.requested', 'delivery', o.id::text,
          jsonb_build_object('job_id', new_id, 'environment', env));

  RETURN jsonb_build_object('ok', true, 'job_id', new_id, 'state', 'requested',
    'environment', env, 'callback_token', token);
END; $$;

CREATE OR REPLACE FUNCTION public.neo_delivery_dispatch_mark_sent(
  _job uuid, _provider_reference text DEFAULT NULL, _detail text DEFAULT NULL, _failed boolean DEFAULT false)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE org uuid; job public.delivery_dispatch_jobs; next_state text;
BEGIN
  org := public.current_org_id();
  IF org IS NULL THEN RETURN jsonb_build_object('ok', false, 'reason', 'no_organisation'); END IF;
  IF NOT (public.has_permission('delivery','dispatch','assign') OR public.has_permission('delivery','edit')) THEN
    RAISE EXCEPTION 'Not permitted to dispatch delivery orders' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO job FROM public.delivery_dispatch_jobs WHERE id = _job AND organization_id = org FOR UPDATE;
  IF job.id IS NULL THEN RETURN jsonb_build_object('ok', false, 'reason', 'job_not_found'); END IF;
  IF job.state <> 'requested' THEN
    RETURN jsonb_build_object('ok', true, 'reason', 'already_sent', 'state', job.state);
  END IF;

  next_state := CASE WHEN _failed THEN 'failed' ELSE 'sent' END;
  UPDATE public.delivery_dispatch_jobs
     SET state = next_state,
         state_detail = coalesce(_detail, CASE WHEN _failed THEN 'The courier could not be reached.'
                                               ELSE 'Sent to the courier; waiting for their answer.' END),
         provider_reference = coalesce(nullif(_provider_reference,''), provider_reference),
         completed_at = CASE WHEN _failed THEN now() ELSE completed_at END,
         updated_at = now()
   WHERE id = job.id;

  INSERT INTO public.delivery_dispatch_events (organization_id, job_id, from_state, to_state, detail)
  VALUES (org, job.id, job.state, next_state, _detail);

  RETURN jsonb_build_object('ok', true, 'state', next_state);
END; $$;

CREATE OR REPLACE FUNCTION public.neo_delivery_dispatch_apply(
  _token text, _outcome text, _provider_reference text DEFAULT NULL,
  _detail text DEFAULT NULL, _payload jsonb DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE job public.delivery_dispatch_jobs; o public.delivery_orders;
        next_state text; new_dispatch text; new_order text;
BEGIN
  IF coalesce(btrim(coalesce(_token,'')),'') = '' THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'no_token');
  END IF;
  SELECT * INTO job FROM public.delivery_dispatch_jobs WHERE callback_token = _token FOR UPDATE;
  IF job.id IS NULL THEN RETURN jsonb_build_object('ok', false, 'reason', 'unknown_token'); END IF;

  next_state := CASE lower(coalesce(_outcome,''))
    WHEN 'accepted' THEN 'accepted'
    WHEN 'assigned' THEN 'accepted'
    WHEN 'picked_up' THEN 'picked_up'
    WHEN 'collected' THEN 'picked_up'
    WHEN 'delivered' THEN 'delivered'
    WHEN 'completed' THEN 'delivered'
    WHEN 'failed' THEN 'failed'
    WHEN 'declined' THEN 'failed'
    WHEN 'rejected' THEN 'failed'
    WHEN 'cancelled' THEN 'cancelled'
    ELSE NULL END;
  IF next_state IS NULL THEN RETURN jsonb_build_object('ok', false, 'reason', 'unknown_outcome'); END IF;

  IF job.state = next_state THEN
    RETURN jsonb_build_object('ok', true, 'reason', 'already_applied', 'state', job.state);
  END IF;
  IF job.state IN ('delivered','cancelled') THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'already_final', 'state', job.state);
  END IF;

  UPDATE public.delivery_dispatch_jobs
     SET state = next_state,
         state_detail = coalesce(_detail, 'Courier answered: ' || next_state),
         provider_reference = coalesce(nullif(_provider_reference,''), provider_reference),
         provider_payload = coalesce(_payload, provider_payload),
         completed_at = CASE WHEN next_state IN ('delivered','failed','cancelled') THEN now() ELSE completed_at END,
         updated_at = now()
   WHERE id = job.id;

  INSERT INTO public.delivery_dispatch_events (organization_id, job_id, from_state, to_state, detail, payload)
  VALUES (job.organization_id, job.id, job.state, next_state,
          coalesce(_detail, 'Courier answered: ' || next_state), _payload);

  SELECT * INTO o FROM public.delivery_orders WHERE id = job.delivery_order_id FOR UPDATE;
  IF o.id IS NOT NULL AND o.order_status NOT IN ('delivered','cancelled','rejected') THEN
    new_dispatch := CASE next_state
      WHEN 'accepted' THEN 'rider-assigned'
      WHEN 'picked_up' THEN 'out-for-delivery'
      WHEN 'delivered' THEN 'delivered'
      WHEN 'failed' THEN 'awaiting-rider'
      WHEN 'cancelled' THEN 'awaiting-rider'
      ELSE NULL END;
    new_order := CASE next_state
      WHEN 'accepted' THEN 'rider-assigned'
      WHEN 'picked_up' THEN 'out-for-delivery'
      WHEN 'delivered' THEN 'delivered'
      ELSE NULL END;

    IF new_dispatch IS NOT NULL AND new_dispatch IS DISTINCT FROM o.dispatch_status THEN
      UPDATE public.delivery_orders
         SET dispatch_status = new_dispatch,
             order_status = coalesce(new_order, order_status),
             collected_at = CASE WHEN next_state = 'picked_up' THEN coalesce(collected_at, now()) ELSE collected_at END,
             delivered_at = CASE WHEN next_state = 'delivered' THEN coalesce(delivered_at, now()) ELSE delivered_at END,
             updated_at = now()
       WHERE id = o.id;

      INSERT INTO public.delivery_order_status_history
        (organization_id, delivery_order_id, previous_status, new_status, status_kind, source, reason)
      VALUES (job.organization_id, o.id, o.dispatch_status, new_dispatch, 'dispatch', 'courier',
              coalesce(_detail, 'Courier answered: ' || next_state));
    END IF;
  END IF;

  INSERT INTO public.audit_logs (organization_id, branch_id, action, module, record_id, new_value)
  VALUES (job.organization_id, job.branch_id, 'delivery.dispatch.' || next_state, 'delivery',
          job.delivery_order_id::text,
          jsonb_build_object('job_id', job.id, 'providerReference', nullif(_provider_reference,'')));

  RETURN jsonb_build_object('ok', true, 'state', next_state, 'job_id', job.id);
END; $$;

CREATE OR REPLACE FUNCTION public.neo_delivery_dispatch_status(_job uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER STABLE SET search_path TO 'public' AS $$
DECLARE org uuid; job public.delivery_dispatch_jobs;
BEGIN
  org := public.current_org_id();
  IF org IS NULL THEN RETURN jsonb_build_object('ok', false, 'reason', 'no_organisation'); END IF;
  SELECT * INTO job FROM public.delivery_dispatch_jobs WHERE id = _job AND organization_id = org;
  IF job.id IS NULL THEN RETURN jsonb_build_object('ok', false, 'reason', 'job_not_found'); END IF;
  RETURN jsonb_build_object('ok', true, 'state', job.state, 'detail', job.state_detail,
    'provider_reference', job.provider_reference, 'environment', job.environment,
    'delivery_order_id', job.delivery_order_id);
END; $$;

REVOKE ALL ON FUNCTION public.neo_delivery_dispatch_open(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.neo_delivery_dispatch_mark_sent(uuid, text, text, boolean) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.neo_delivery_dispatch_status(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.neo_delivery_dispatch_apply(text, text, text, text, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.neo_delivery_dispatch_open(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.neo_delivery_dispatch_mark_sent(uuid, text, text, boolean) TO authenticated;
GRANT EXECUTE ON FUNCTION public.neo_delivery_dispatch_status(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.neo_delivery_dispatch_apply(text, text, text, text, jsonb) TO service_role;

-- ============================================================
-- Manual bank reconciliation
-- ============================================================
CREATE OR REPLACE FUNCTION public.neo_bank_mark_transfer_reconciled(_attempt uuid, _reason text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE org uuid; a public.payment_attempts;
BEGIN
  org := public.current_org_id();
  IF org IS NULL THEN RETURN jsonb_build_object('ok', false, 'reason', 'no_organisation'); END IF;
  IF NOT (public.has_permission('finance','banking','manage') OR public.has_permission('finance','edit')) THEN
    RAISE EXCEPTION 'Not permitted to reconcile bank transfers' USING ERRCODE = '42501';
  END IF;
  IF length(btrim(coalesce(_reason,''))) < 8 THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'reason_required',
      'detail', 'Say in writing why this transfer is being reconciled without a bank line.');
  END IF;

  SELECT * INTO a FROM public.payment_attempts WHERE id = _attempt AND organization_id = org FOR UPDATE;
  IF a.id IS NULL THEN RETURN jsonb_build_object('ok', false, 'reason', 'payment_not_found'); END IF;
  IF a.verified_at IS NOT NULL THEN
    RETURN jsonb_build_object('ok', true, 'reason', 'already_verified', 'state', a.state);
  END IF;

  UPDATE public.payment_attempts
     SET state = 'confirmed', verified_by = auth.uid(), verified_at = now(),
         verification_note = 'Manually reconciled: ' || btrim(_reason),
         state_detail = 'Reconciled by Finance without a bank statement line.',
         confirmed_at = coalesce(a.confirmed_at, now()), updated_at = now()
   WHERE id = a.id;

  INSERT INTO public.payment_attempt_events (organization_id, attempt_id, from_state, to_state, detail)
  VALUES (org, a.id, a.state, 'confirmed', 'Manually reconciled: ' || btrim(_reason));

  INSERT INTO public.audit_logs (organization_id, branch_id, action, module, record_id, new_value, reason)
  VALUES (org, a.branch_id, 'bank.transfer.reconciled.manual', 'finance', a.id::text,
          jsonb_build_object('amount', a.amount, 'reference', a.reference), btrim(_reason));

  RETURN jsonb_build_object('ok', true, 'attempt_id', a.id, 'state', 'confirmed');
END; $$;

CREATE OR REPLACE FUNCTION public.neo_bank_mark_line_reconciled(_entry uuid, _reason text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE org uuid; e public.bank_statement_entries;
BEGIN
  org := public.current_org_id();
  IF org IS NULL THEN RETURN jsonb_build_object('ok', false, 'reason', 'no_organisation'); END IF;
  IF NOT (public.has_permission('finance','banking','manage') OR public.has_permission('finance','edit')) THEN
    RAISE EXCEPTION 'Not permitted to reconcile bank statement lines' USING ERRCODE = '42501';
  END IF;
  IF length(btrim(coalesce(_reason,''))) < 8 THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'reason_required',
      'detail', 'Say in writing what this bank line is.');
  END IF;

  SELECT * INTO e FROM public.bank_statement_entries WHERE id = _entry AND organization_id = org FOR UPDATE;
  IF e.id IS NULL THEN RETURN jsonb_build_object('ok', false, 'reason', 'statement_line_not_found'); END IF;
  IF e.status = 'matched' THEN RETURN jsonb_build_object('ok', false, 'reason', 'line_already_matched'); END IF;
  IF e.status = 'explained' THEN RETURN jsonb_build_object('ok', true, 'reason', 'already_explained'); END IF;

  UPDATE public.bank_statement_entries
     SET status = 'explained', matched_at = now(), matched_by = auth.uid(), updated_at = now()
   WHERE id = e.id;

  INSERT INTO public.audit_logs (organization_id, action, module, record_id, new_value, reason)
  VALUES (org, 'bank.line.explained', 'finance', e.id::text,
          jsonb_build_object('amount', e.amount, 'reference', e.external_reference), btrim(_reason));

  RETURN jsonb_build_object('ok', true, 'entry_id', e.id, 'status', 'explained');
END; $$;

REVOKE ALL ON FUNCTION public.neo_bank_mark_transfer_reconciled(uuid, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.neo_bank_mark_line_reconciled(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.neo_bank_mark_transfer_reconciled(uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.neo_bank_mark_line_reconciled(uuid, text) TO authenticated;

-- ============================================================
-- QR payment details returned by the provider
-- ============================================================
CREATE OR REPLACE FUNCTION public.neo_payment_intent_set_provider_payload(_intent uuid, _payload jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE org uuid; a public.payment_attempts;
BEGIN
  org := public.current_org_id();
  IF org IS NULL THEN RETURN jsonb_build_object('ok', false, 'reason', 'no_organisation'); END IF;
  SELECT * INTO a FROM public.payment_attempts
   WHERE payment_table = 'payment_intents' AND payment_id = _intent AND organization_id = org FOR UPDATE;
  IF a.id IS NULL THEN RETURN jsonb_build_object('ok', false, 'reason', 'intent_not_found'); END IF;
  IF a.state NOT IN ('requested','pending') THEN
    RETURN jsonb_build_object('ok', true, 'reason', 'not_open', 'state', a.state);
  END IF;
  UPDATE public.payment_attempts
     SET provider_payload = coalesce(a.provider_payload, '{}'::jsonb) || coalesce(_payload, '{}'::jsonb),
         updated_at = now()
   WHERE id = a.id;
  RETURN jsonb_build_object('ok', true, 'attempt_id', a.id);
END; $$;

REVOKE ALL ON FUNCTION public.neo_payment_intent_set_provider_payload(uuid, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.neo_payment_intent_set_provider_payload(uuid, jsonb) TO authenticated;
