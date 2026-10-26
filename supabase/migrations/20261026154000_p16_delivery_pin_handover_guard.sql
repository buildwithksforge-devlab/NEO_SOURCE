-- NEO P1.6 - DELIVERY PIN HANDOVER CORRECTION
-- LOCAL DRAFT - NOT DEPLOYED
--
-- Serialize concurrent delivery confirmations.
-- Preserve failed PIN attempts.
-- Prevent repeated completed handovers.
-- Finance posting is unchanged.
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
  SELECT * INTO _d FROM public.delivery_orders WHERE id = _order FOR UPDATE;
  IF _d.id IS NULL OR _d.rider_id IS NULL OR _d.rider_id <> _rider THEN RAISE EXCEPTION 'Delivery not assigned to you'; END IF;
  IF _d.dispatch_status = 'delivered'
   OR _d.order_status IN ('delivered','completed') THEN
  RETURN jsonb_build_object(
    'ok', true,
    'already_delivered', true,
    'order_id', _order
  );
END IF;

IF _d.order_status IN ('cancelled','rejected','failed') THEN
  RAISE EXCEPTION 'This delivery order is no longer active';
END IF;

IF _d.dispatch_status NOT IN ('collected','en-route') THEN
  RAISE EXCEPTION 'Delivery is not in progress';
END IF;
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
        RETURN jsonb_build_object(
          'ok', false,
          'reason', CASE
            WHEN _remaining = 0 THEN 'pin_locked'
            ELSE 'invalid_pin'
          END,
          'remaining_attempts', _remaining,
          'detail', CASE
            WHEN _remaining = 0
              THEN 'Incorrect PIN. Delivery is now locked. Contact the delivery manager.'
            ELSE 'Incorrect PIN. Try again.'
          END
        );
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
     -- Rider cash collection establishes custody, not Finance settlement.
     -- Do not mark delivery/POS financially paid at handover.
     _settled := false;
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

REVOKE EXECUTE ON FUNCTION public.delivery_confirm_delivery(
  uuid, text, text, numeric, numeric, numeric
) FROM PUBLIC, anon;

GRANT EXECUTE ON FUNCTION public.delivery_confirm_delivery(
  uuid, text, text, numeric, numeric, numeric
) TO authenticated, service_role;

