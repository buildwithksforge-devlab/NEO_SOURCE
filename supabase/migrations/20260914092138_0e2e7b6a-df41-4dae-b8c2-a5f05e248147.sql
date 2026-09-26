-- =========================================================================
-- Delivery PIN: secure generation, customer delivery, resend, regeneration,
-- attempt limiting and manager recovery. Additive only.
-- =========================================================================

ALTER TABLE public.delivery_order_pins
  ADD COLUMN IF NOT EXISTS pin_hash text,
  ADD COLUMN IF NOT EXISTS pin_secret text,
  ADD COLUMN IF NOT EXISTS version integer NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS issued_at timestamptz,
  ADD COLUMN IF NOT EXISTS expires_at timestamptz,
  ADD COLUMN IF NOT EXISTS attempt_count integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS max_attempts integer NOT NULL DEFAULT 5,
  ADD COLUMN IF NOT EXISTS locked_at timestamptz,
  ADD COLUMN IF NOT EXISTS last_channel text,
  ADD COLUMN IF NOT EXISTS last_sent_at timestamptz,
  ADD COLUMN IF NOT EXISTS last_send_status text,
  ADD COLUMN IF NOT EXISTS last_send_detail text,
  ADD COLUMN IF NOT EXISTS regenerated_count integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS invalidated_at timestamptz,
  ADD COLUMN IF NOT EXISTS is_legacy boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS override_by uuid,
  ADD COLUMN IF NOT EXISTS override_at timestamptz,
  ADD COLUMN IF NOT EXISTS override_reason text;

-- Fingerprint helper. Salted with the order id so the same digits on two
-- deliveries do not share a fingerprint.
CREATE OR REPLACE FUNCTION public.neo_delivery_pin_fingerprint(_pin text, _order uuid)
RETURNS text LANGUAGE sql IMMUTABLE SET search_path = public AS $$
  SELECT encode(extensions.digest(convert_to('neo-delivery-pin:' || _order::text || ':' || coalesce(_pin,''), 'UTF8'), 'sha256'), 'hex');
$$;
REVOKE EXECUTE ON FUNCTION public.neo_delivery_pin_fingerprint(text, uuid) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.neo_delivery_pin_fingerprint(text, uuid) TO authenticated, service_role;

-- Existing PINs keep working; they are migrated, marked legacy and never expire
-- on their own so nothing in flight breaks.
UPDATE public.delivery_order_pins
   SET pin_hash = public.neo_delivery_pin_fingerprint(pin, delivery_order_id),
       pin_secret = pin,
       issued_at = coalesce(issued_at, created_at),
       is_legacy = true
 WHERE pin_hash IS NULL;

-- ---------------------------------------------------------------- history
CREATE TABLE IF NOT EXISTS public.delivery_pin_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  delivery_order_id uuid NOT NULL REFERENCES public.delivery_orders(id) ON DELETE CASCADE,
  pin_version integer NOT NULL DEFAULT 1,
  event_type text NOT NULL,
  channel text,
  reason text,
  detail text,
  actor_id uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS delivery_pin_events_order_idx
  ON public.delivery_pin_events (delivery_order_id, created_at DESC);

GRANT SELECT ON public.delivery_pin_events TO authenticated;
GRANT ALL ON public.delivery_pin_events TO service_role;
ALTER TABLE public.delivery_pin_events ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS delivery_pin_events_read ON public.delivery_pin_events;
CREATE POLICY delivery_pin_events_read ON public.delivery_pin_events FOR SELECT TO authenticated
  USING (organization_id = public.current_org_id()
         AND public.has_permission('delivery', 'dispatch.view'));

-- No client writes: every row is written by a security-definer function.

-- ------------------------------------------------------- issue / notify
-- Enqueues the PIN to the customer through the normal message queue. Never
-- claims a send: the queue processor records the provider's real answer.
CREATE OR REPLACE FUNCTION public.neo_delivery_pin_notify(_order uuid, _event text, _channel text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  p public.delivery_order_pins;
  o public.delivery_orders;
  c public.customers;
  ch text;
  recipient text;
  body text;
  subj text;
BEGIN
  SELECT * INTO p FROM public.delivery_order_pins WHERE delivery_order_id = _order;
  IF p.id IS NULL THEN RETURN jsonb_build_object('ok', false, 'reason', 'no_pin'); END IF;
  SELECT * INTO o FROM public.delivery_orders WHERE id = _order;
  SELECT * INTO c FROM public.customers WHERE id = p.customer_id;

  ch := nullif(btrim(coalesce(_channel, '')), '');
  IF ch IS NULL THEN
    ch := CASE WHEN coalesce(nullif(btrim(coalesce(o.contact_phone, c.phone, '')), ''), '') <> '' THEN 'sms' ELSE 'email' END;
  END IF;
  recipient := CASE WHEN ch = 'email' THEN nullif(btrim(coalesce(c.email, '')), '')
                    ELSE nullif(btrim(coalesce(o.contact_phone, c.phone, '')), '') END;

  IF recipient IS NULL THEN
    UPDATE public.delivery_order_pins
       SET last_channel = ch, last_send_status = 'no_contact',
           last_send_detail = 'No ' || ch || ' contact is stored for this order, so the PIN could not be sent.',
           updated_at = now()
     WHERE id = p.id;
    INSERT INTO public.delivery_pin_events (organization_id, delivery_order_id, pin_version, event_type, channel, detail, actor_id)
    VALUES (p.organization_id, _order, p.version, 'send-skipped', ch,
            'No ' || ch || ' contact stored for this order.', auth.uid());
    RETURN jsonb_build_object('ok', false, 'reason', 'no_contact', 'channel', ch);
  END IF;

  subj := 'Your delivery PIN for order ' || coalesce(o.order_number, '');
  body := 'Your collection PIN for order ' || coalesce(o.order_number, '') || ' is ' || p.pin_secret ||
          '. Give it to the rider when your order arrives. Do not share it with anyone else.';

  INSERT INTO public.communication_queue (
    organization_id, branch_id, customer_id, channel, recipient, subject, rendered_body,
    variables, is_marketing, consent_verified, scheduled_for, status,
    source_module, source_record_id, idempotency_key, created_by
  ) VALUES (
    p.organization_id, o.branch_id, p.customer_id, ch, recipient, subj, body,
    jsonb_build_object('order_number', o.order_number, 'pin_version', p.version),
    false, true, now(), 'queued',
    'delivery', _order,
    'delivery-pin:' || _order::text || ':' || p.version::text || ':' || _event || ':' ||
      to_char(now(), 'YYYYMMDDHH24MISS'),
    auth.uid()
  );

  UPDATE public.delivery_order_pins
     SET last_channel = ch, last_sent_at = now(), last_send_status = 'queued',
         last_send_detail = 'Queued for sending over ' || ch || '.', updated_at = now()
   WHERE id = p.id;

  INSERT INTO public.delivery_pin_events (organization_id, delivery_order_id, pin_version, event_type, channel, detail, actor_id)
  VALUES (p.organization_id, _order, p.version, _event, ch, 'Queued to ' || recipient, auth.uid());

  RETURN jsonb_build_object('ok', true, 'channel', ch);
END; $$;
REVOKE EXECUTE ON FUNCTION public.neo_delivery_pin_notify(uuid, text, text) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.neo_delivery_pin_notify(uuid, text, text) TO authenticated, service_role;

-- Any PIN row written by the existing order-creation paths is upgraded here to
-- a six random digits + fingerprint, so those functions need no rewrite.
CREATE OR REPLACE FUNCTION public.neo_delivery_pin_before_insert()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE fresh text;
BEGIN
  IF NEW.pin_hash IS NOT NULL THEN RETURN NEW; END IF;
  fresh := lpad((floor(random() * 1000000))::int::text, 6, '0');
  NEW.pin_secret := fresh;
  NEW.pin := '';                       -- legacy readable column is left empty
  NEW.pin_hash := public.neo_delivery_pin_fingerprint(fresh, NEW.delivery_order_id);
  NEW.version := 1;
  NEW.issued_at := now();
  NEW.expires_at := now() + interval '24 hours';
  NEW.attempt_count := 0;
  NEW.is_legacy := false;
  RETURN NEW;
END; $$;

DROP TRIGGER IF EXISTS delivery_order_pins_issue ON public.delivery_order_pins;
CREATE TRIGGER delivery_order_pins_issue
  BEFORE INSERT ON public.delivery_order_pins
  FOR EACH ROW EXECUTE FUNCTION public.neo_delivery_pin_before_insert();

CREATE OR REPLACE FUNCTION public.neo_delivery_pin_after_insert()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  INSERT INTO public.delivery_pin_events (organization_id, delivery_order_id, pin_version, event_type, detail, actor_id)
  VALUES (NEW.organization_id, NEW.delivery_order_id, NEW.version, 'issued',
          'Delivery PIN issued.', auth.uid());
  PERFORM public.neo_delivery_pin_notify(NEW.delivery_order_id, 'sent', NULL);
  RETURN NEW;
END; $$;

DROP TRIGGER IF EXISTS delivery_order_pins_issued ON public.delivery_order_pins;
CREATE TRIGGER delivery_order_pins_issued
  AFTER INSERT ON public.delivery_order_pins
  FOR EACH ROW EXECUTE FUNCTION public.neo_delivery_pin_after_insert();

-- ------------------------------------------------------------ customer read
CREATE OR REPLACE FUNCTION public.neo_delivery_pin_for_customer(_order uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE p public.delivery_order_pins;
BEGIN
  SELECT * INTO p FROM public.delivery_order_pins WHERE delivery_order_id = _order;
  IF p.id IS NULL THEN RETURN jsonb_build_object('ok', false, 'reason', 'no_pin'); END IF;
  IF p.customer_id IS DISTINCT FROM public.my_customer_id() THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_your_order');
  END IF;
  RETURN jsonb_build_object(
    'ok', true,
    'pin', coalesce(nullif(p.pin_secret, ''), nullif(p.pin, '')),
    'issued_at', p.issued_at,
    'expires_at', p.expires_at,
    'consumed_at', p.consumed_at,
    'invalidated_at', p.invalidated_at,
    'locked', p.locked_at IS NOT NULL,
    'channel', p.last_channel,
    'sent_at', p.last_sent_at,
    'send_status', p.last_send_status
  );
END; $$;
REVOKE EXECUTE ON FUNCTION public.neo_delivery_pin_for_customer(uuid) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.neo_delivery_pin_for_customer(uuid) TO authenticated;

-- ------------------------------------------------------------ manager view
CREATE OR REPLACE FUNCTION public.neo_delivery_pin_status(_order uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE p public.delivery_order_pins; evs jsonb;
BEGIN
  SELECT * INTO p FROM public.delivery_order_pins WHERE delivery_order_id = _order;
  IF p.id IS NULL THEN RETURN jsonb_build_object('ok', false, 'reason', 'no_pin'); END IF;
  IF p.organization_id IS DISTINCT FROM public.current_org_id()
     OR NOT public.has_permission('delivery', 'dispatch.view') THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_permitted');
  END IF;

  SELECT coalesce(jsonb_agg(to_jsonb(e) ORDER BY e.created_at DESC), '[]'::jsonb) INTO evs
    FROM (SELECT created_at, event_type, channel, reason, detail
            FROM public.delivery_pin_events
           WHERE delivery_order_id = _order
           ORDER BY created_at DESC LIMIT 25) e;

  RETURN jsonb_build_object(
    'ok', true,
    'issued_at', p.issued_at,
    'expires_at', p.expires_at,
    'consumed_at', p.consumed_at,
    'invalidated_at', p.invalidated_at,
    'version', p.version,
    'regenerated_count', p.regenerated_count,
    'attempt_count', p.attempt_count,
    'max_attempts', p.max_attempts,
    'locked', p.locked_at IS NOT NULL,
    'locked_at', p.locked_at,
    'override_at', p.override_at,
    'override_reason', p.override_reason,
    'channel', p.last_channel,
    'sent_at', p.last_sent_at,
    'send_status', p.last_send_status,
    'send_detail', p.last_send_detail,
    'is_legacy', p.is_legacy,
    'events', evs
  );
END; $$;
REVOKE EXECUTE ON FUNCTION public.neo_delivery_pin_status(uuid) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.neo_delivery_pin_status(uuid) TO authenticated;

-- --------------------------------------------------------------- controls
CREATE OR REPLACE FUNCTION public.neo_delivery_pin_resend(_order uuid, _channel text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE p public.delivery_order_pins; res jsonb;
BEGIN
  SELECT * INTO p FROM public.delivery_order_pins WHERE delivery_order_id = _order FOR UPDATE;
  IF p.id IS NULL THEN RETURN jsonb_build_object('ok', false, 'reason', 'no_pin'); END IF;
  IF p.organization_id IS DISTINCT FROM public.current_org_id()
     OR NOT public.has_permission('delivery', 'dispatch.manage') THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_permitted',
      'detail', 'Only a delivery manager can resend a collection PIN.');
  END IF;
  IF p.consumed_at IS NOT NULL OR p.invalidated_at IS NOT NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'pin_closed',
      'detail', 'This PIN has already been used or replaced.');
  END IF;
  res := public.neo_delivery_pin_notify(_order, 'resent', _channel);
  RETURN res;
END; $$;
REVOKE EXECUTE ON FUNCTION public.neo_delivery_pin_resend(uuid, text) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.neo_delivery_pin_resend(uuid, text) TO authenticated;

CREATE OR REPLACE FUNCTION public.neo_delivery_pin_regenerate(_order uuid, _reason text, _channel text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE p public.delivery_order_pins; fresh text;
BEGIN
  IF nullif(btrim(coalesce(_reason, '')), '') IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'reason_required',
      'detail', 'Give a written reason before replacing a customer''s PIN.');
  END IF;
  SELECT * INTO p FROM public.delivery_order_pins WHERE delivery_order_id = _order FOR UPDATE;
  IF p.id IS NULL THEN RETURN jsonb_build_object('ok', false, 'reason', 'no_pin'); END IF;
  IF p.organization_id IS DISTINCT FROM public.current_org_id()
     OR NOT public.has_permission('delivery', 'dispatch.manage') THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_permitted',
      'detail', 'Only a delivery manager can replace a collection PIN.');
  END IF;
  IF p.consumed_at IS NOT NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'already_delivered',
      'detail', 'This delivery is already completed.');
  END IF;

  fresh := lpad((floor(random() * 1000000))::int::text, 6, '0');
  UPDATE public.delivery_order_pins
     SET pin_secret = fresh,
         pin = '',
         pin_hash = public.neo_delivery_pin_fingerprint(fresh, _order),
         version = p.version + 1,
         regenerated_count = p.regenerated_count + 1,
         issued_at = now(),
         expires_at = now() + interval '24 hours',
         attempt_count = 0,
         locked_at = NULL,
         invalidated_at = NULL,
         is_legacy = false,
         updated_at = now()
   WHERE id = p.id;

  INSERT INTO public.delivery_pin_events (organization_id, delivery_order_id, pin_version, event_type, reason, detail, actor_id)
  VALUES (p.organization_id, _order, p.version + 1, 'regenerated', btrim(_reason),
          'Previous PIN invalidated and a new one issued.', auth.uid());

  RETURN public.neo_delivery_pin_notify(_order, 'sent', _channel) || jsonb_build_object('regenerated', true);
END; $$;
REVOKE EXECUTE ON FUNCTION public.neo_delivery_pin_regenerate(uuid, text, text) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.neo_delivery_pin_regenerate(uuid, text, text) TO authenticated;

-- Manager recovery: clears a lockout and authorises one PIN-free handover,
-- which still requires a recipient name and proof from the rider.
CREATE OR REPLACE FUNCTION public.neo_delivery_pin_override(_order uuid, _reason text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE p public.delivery_order_pins;
BEGIN
  IF nullif(btrim(coalesce(_reason, '')), '') IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'reason_required',
      'detail', 'A written reason is required to authorise a handover without the PIN.');
  END IF;
  SELECT * INTO p FROM public.delivery_order_pins WHERE delivery_order_id = _order FOR UPDATE;
  IF p.id IS NULL THEN RETURN jsonb_build_object('ok', false, 'reason', 'no_pin'); END IF;
  IF p.organization_id IS DISTINCT FROM public.current_org_id()
     OR NOT public.has_permission('delivery', 'dispatch.manage') THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_permitted',
      'detail', 'Only a delivery manager can authorise a handover without the PIN.');
  END IF;

  UPDATE public.delivery_order_pins
     SET locked_at = NULL, attempt_count = 0,
         override_by = auth.uid(), override_at = now(), override_reason = btrim(_reason),
         updated_at = now()
   WHERE id = p.id;

  INSERT INTO public.delivery_pin_events (organization_id, delivery_order_id, pin_version, event_type, reason, detail, actor_id)
  VALUES (p.organization_id, _order, p.version, 'override', btrim(_reason),
          'Manager authorised completing this delivery without the PIN.', auth.uid());

  RETURN jsonb_build_object('ok', true);
END; $$;
REVOKE EXECUTE ON FUNCTION public.neo_delivery_pin_override(uuid, text) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.neo_delivery_pin_override(uuid, text) TO authenticated;

-- ------------------------------------------------- proof of delivery rewrite
CREATE OR REPLACE FUNCTION public.delivery_confirm_delivery(
  _order uuid, _pin text, _recipient text, _cash_collected numeric DEFAULT NULL::numeric,
  _lat numeric DEFAULT NULL::numeric, _lng numeric DEFAULT NULL::numeric
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  _d public.delivery_orders;
  _rider uuid := public.my_rider_id();
  _s public.delivery_settings;
  _p public.delivery_order_pins;
  _ok boolean := true;
  _settled boolean := false;
  _method text;
  _remaining int;
BEGIN
  SELECT * INTO _d FROM public.delivery_orders WHERE id = _order;
  IF _d.id IS NULL OR _d.rider_id IS NULL OR _d.rider_id <> _rider THEN RAISE EXCEPTION 'Delivery not assigned to you'; END IF;
  IF _d.dispatch_status NOT IN ('collected','en-route') THEN RAISE EXCEPTION 'Delivery is not in progress'; END IF;
  IF nullif(btrim(coalesce(_recipient, '')), '') IS NULL THEN RAISE EXCEPTION 'Record who received the order'; END IF;
  _s := public.delivery_get_settings(_d.branch_id);
  _method := coalesce(_s.pod_method, 'pin');

  IF _method = 'pin' THEN
    SELECT * INTO _p FROM public.delivery_order_pins WHERE delivery_order_id = _order FOR UPDATE;

    IF _p.id IS NOT NULL AND _p.override_at IS NOT NULL THEN
      -- A delivery manager has authorised this handover without the PIN.
      _ok := false;
      _method := 'manager-override';
    ELSIF _p.id IS NULL THEN
      RAISE EXCEPTION 'No collection PIN exists for this order. Ask the delivery manager to issue one.';
    ELSE
      IF _p.consumed_at IS NOT NULL THEN RAISE EXCEPTION 'This delivery has already been completed'; END IF;
      IF _p.locked_at IS NOT NULL THEN
        RAISE EXCEPTION 'Too many wrong PIN entries. Call the delivery manager to unlock this delivery.';
      END IF;
      IF _p.expires_at IS NOT NULL AND _p.expires_at < now() THEN
        RAISE EXCEPTION 'This collection PIN has expired. Ask the delivery manager to send a new one.';
      END IF;

      IF _p.pin_hash = public.neo_delivery_pin_fingerprint(_pin, _order) THEN
        _ok := true;
        UPDATE public.delivery_order_pins
           SET consumed_at = now(), attempt_count = 0, pin_secret = NULL, pin = '', updated_at = now()
         WHERE id = _p.id;
        INSERT INTO public.delivery_pin_events (organization_id, delivery_order_id, pin_version, event_type, detail, actor_id)
        VALUES (_p.organization_id, _order, _p.version, 'verified', 'PIN accepted at handover.', auth.uid());
      ELSE
        _remaining := greatest(_p.max_attempts - (_p.attempt_count + 1), 0);
        UPDATE public.delivery_order_pins
           SET attempt_count = _p.attempt_count + 1,
               locked_at = CASE WHEN _p.attempt_count + 1 >= _p.max_attempts THEN now() ELSE locked_at END,
               updated_at = now()
         WHERE id = _p.id;
        INSERT INTO public.delivery_pin_events (organization_id, delivery_order_id, pin_version, event_type, detail, actor_id)
        VALUES (_p.organization_id, _order, _p.version,
                CASE WHEN _remaining = 0 THEN 'locked' ELSE 'failed-attempt' END,
                'Wrong PIN entered at handover.', auth.uid());
        IF _remaining = 0 THEN
          RAISE EXCEPTION 'Incorrect delivery PIN. This delivery is now locked — call the delivery manager.';
        END IF;
        RAISE EXCEPTION 'Incorrect delivery PIN. % attempt(s) left before this delivery locks.', _remaining;
      END IF;
    END IF;
  END IF;

  INSERT INTO public.delivery_proofs (organization_id, delivery_order_id, rider_id, method, recipient_name, pin_verified, latitude, longitude, created_by)
  VALUES (_d.organization_id, _order, _rider, _method, btrim(_recipient), _ok, _lat, _lng, auth.uid())
  ON CONFLICT (delivery_order_id) DO NOTHING;

  INSERT INTO public.delivery_attempts (organization_id, delivery_order_id, rider_id, outcome, latitude, longitude, created_by)
  VALUES (_d.organization_id, _order, _rider, 'delivered', _lat, _lng, auth.uid());

  IF _d.payment_method = 'cash' AND _cash_collected IS NOT NULL THEN
    INSERT INTO public.rider_cash_collections (organization_id, branch_id, delivery_order_id, rider_id, expected_amount, collected_amount, created_by)
    VALUES (_d.organization_id, _d.branch_id, _order, _rider, _d.grand_total, _cash_collected, auth.uid())
    ON CONFLICT (delivery_order_id) DO NOTHING;
    _settled := _cash_collected >= _d.grand_total;
  END IF;

  UPDATE public.delivery_orders
     SET dispatch_status = 'delivered', order_status = 'delivered', delivered_at = now(),
         payment_status = CASE WHEN _settled THEN 'paid' ELSE payment_status END
   WHERE id = _order;

  IF _settled AND _d.pos_order_id IS NOT NULL THEN
    UPDATE public.pos_orders SET payment_status = 'paid', updated_at = now()
     WHERE id = _d.pos_order_id AND coalesce(payment_status,'unpaid') <> 'paid';
  END IF;

  -- The PIN can never be reused after a completed handover.
  UPDATE public.delivery_order_pins
     SET consumed_at = coalesce(consumed_at, now()), pin_secret = NULL, pin = '', updated_at = now()
   WHERE delivery_order_id = _order;

  UPDATE public.rider_profiles SET availability_status = 'available' WHERE id = _rider;
  UPDATE public.rider_assignments SET status = 'completed' WHERE delivery_order_id = _order AND status IN ('offered','accepted');
  INSERT INTO public.delivery_order_status_history (organization_id, delivery_order_id, status_kind, previous_status, new_status, source, latitude, longitude, changed_by)
  VALUES (_d.organization_id, _order, 'order', _d.order_status, 'delivered', 'rider', _lat, _lng, auth.uid());
  RETURN jsonb_build_object('ok', true, 'cash_settled', _settled, 'method', _method);
END; $$;
REVOKE EXECUTE ON FUNCTION public.delivery_confirm_delivery(uuid, text, text, numeric, numeric, numeric) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.delivery_confirm_delivery(uuid, text, text, numeric, numeric, numeric) TO authenticated, service_role;

-- The plaintext columns are no longer readable through the Data API; the
-- customer reads their PIN through neo_delivery_pin_for_customer only.
DROP POLICY IF EXISTS delivery_order_pins_customer ON public.delivery_order_pins;
