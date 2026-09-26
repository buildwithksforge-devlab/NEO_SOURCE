-- 1. Cash collected at the door must settle the order, not leave it unpaid.
CREATE OR REPLACE FUNCTION public.delivery_confirm_delivery(_order uuid, _pin text, _recipient text, _cash_collected numeric DEFAULT NULL::numeric, _lat numeric DEFAULT NULL::numeric, _lng numeric DEFAULT NULL::numeric)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE _d public.delivery_orders; _rider uuid := public.my_rider_id(); _s public.delivery_settings; _ok boolean := true; _settled boolean := false;
BEGIN
  SELECT * INTO _d FROM public.delivery_orders WHERE id = _order;
  IF _d.id IS NULL OR _d.rider_id IS NULL OR _d.rider_id <> _rider THEN RAISE EXCEPTION 'Delivery not assigned to you'; END IF;
  IF _d.dispatch_status NOT IN ('collected','en-route') THEN RAISE EXCEPTION 'Delivery is not in progress'; END IF;
  _s := public.delivery_get_settings(_d.branch_id);

  IF coalesce(_s.pod_method, 'pin') = 'pin' THEN
    SELECT EXISTS (SELECT 1 FROM public.delivery_order_pins p WHERE p.delivery_order_id = _order AND p.pin = _pin) INTO _ok;
    IF NOT _ok THEN RAISE EXCEPTION 'Incorrect delivery PIN'; END IF;
    UPDATE public.delivery_order_pins SET consumed_at = now() WHERE delivery_order_id = _order;
  END IF;

  INSERT INTO public.delivery_proofs (organization_id, delivery_order_id, rider_id, method, recipient_name, pin_verified, latitude, longitude, created_by)
  VALUES (_d.organization_id, _order, _rider, coalesce(_s.pod_method,'pin'), _recipient, _ok, _lat, _lng, auth.uid())
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

  UPDATE public.rider_profiles SET availability_status = 'available' WHERE id = _rider;
  UPDATE public.rider_assignments SET status = 'completed' WHERE delivery_order_id = _order AND status IN ('offered','accepted');
  INSERT INTO public.delivery_order_status_history (organization_id, delivery_order_id, status_kind, previous_status, new_status, source, latitude, longitude, changed_by)
  VALUES (_d.organization_id, _order, 'order', _d.order_status, 'delivered', 'rider', _lat, _lng, auth.uid());
  RETURN jsonb_build_object('ok', true, 'cash_settled', _settled);
END; $function$;

-- 2. Rider remits cash: the server computes what is owed and links the collections.
CREATE OR REPLACE FUNCTION public.neo_delivery_rider_remit(_declared numeric, _branch uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE _rider uuid := public.my_rider_id(); _org uuid; _branch_id uuid; _expected numeric; _n int; _rem uuid; _ref text;
BEGIN
  IF _rider IS NULL THEN RETURN jsonb_build_object('ok', false, 'reason', 'not_a_rider'); END IF;
  IF _declared IS NULL OR _declared < 0 THEN RETURN jsonb_build_object('ok', false, 'reason', 'invalid_amount'); END IF;

  SELECT organization_id, coalesce(_branch, branch_id) INTO _org, _branch_id
    FROM public.rider_profiles WHERE id = _rider;

  SELECT coalesce(sum(collected_amount), 0), count(*)
    INTO _expected, _n
    FROM public.rider_cash_collections
   WHERE rider_id = _rider AND status = 'collected' AND remittance_id IS NULL
     AND (_branch IS NULL OR branch_id = _branch);

  IF _n = 0 THEN RETURN jsonb_build_object('ok', false, 'reason', 'nothing_to_remit'); END IF;

  _ref := 'REM-' || to_char(now(), 'YYMMDD') || '-' || upper(substr(replace(gen_random_uuid()::text,'-',''), 1, 5));

  INSERT INTO public.rider_cash_remittances
    (organization_id, branch_id, rider_id, reference, expected_amount, declared_amount, variance, status, submitted_at)
  VALUES (_org, _branch_id, _rider, _ref, _expected, _declared, _declared - _expected, 'submitted', now())
  RETURNING id INTO _rem;

  UPDATE public.rider_cash_collections
     SET remittance_id = _rem, status = 'remitted', updated_at = now()
   WHERE rider_id = _rider AND status = 'collected' AND remittance_id IS NULL
     AND (_branch IS NULL OR branch_id = _branch);

  INSERT INTO public.audit_logs (organization_id, user_id, user_name, action, module, record_id, new_value)
  VALUES (_org, auth.uid(), '', 'delivery.cash.remit', 'delivery', _rem::text,
          jsonb_build_object('expected', _expected, 'declared', _declared, 'orders', _n));

  RETURN jsonb_build_object('ok', true, 'remittance_id', _rem, 'reference', _ref,
                            'expected_amount', _expected, 'declared_amount', _declared,
                            'variance', _declared - _expected, 'orders', _n);
END; $function$;

-- 3. Cashier/Finance counts and reconciles. A rider can never reconcile their own cash.
CREATE OR REPLACE FUNCTION public.neo_delivery_remit_reconcile(_remittance uuid, _counted numeric, _reason text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE _org uuid := public.current_org_id(); _r public.rider_cash_remittances; _var numeric;
BEGIN
  IF _org IS NULL THEN RETURN jsonb_build_object('ok', false, 'reason', 'no_organisation'); END IF;
  IF NOT (public.has_permission('delivery','payments.reconcile') OR public.is_org_admin()) THEN
    RAISE EXCEPTION 'The delivery.payments.reconcile permission is required.' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO _r FROM public.rider_cash_remittances
   WHERE id = _remittance AND organization_id = _org FOR UPDATE;
  IF _r.id IS NULL THEN RETURN jsonb_build_object('ok', false, 'reason', 'remittance_not_found'); END IF;
  IF _r.rider_id = public.my_rider_id() THEN
    RAISE EXCEPTION 'A rider cannot reconcile their own cash.' USING ERRCODE = '42501';
  END IF;
  IF NOT public.neo_branch_in_scope(_r.branch_id) THEN
    RAISE EXCEPTION 'That remittance is outside your access scope.' USING ERRCODE = '42501';
  END IF;
  IF _r.status = 'reconciled' THEN
    RETURN jsonb_build_object('ok', true, 'already_reconciled', true, 'remittance_id', _r.id);
  END IF;

  _var := _counted - _r.expected_amount;
  IF _var <> 0 AND nullif(btrim(coalesce(_reason,'')),'') IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'variance_reason_required', 'variance', _var);
  END IF;

  UPDATE public.rider_cash_remittances
     SET counted_amount = _counted, variance = _var, variance_reason = nullif(btrim(coalesce(_reason,'')),''),
         status = CASE WHEN _var = 0 THEN 'reconciled' ELSE 'disputed' END,
         received_by = auth.uid(), received_at = coalesce(received_at, now()),
         reconciled_by = auth.uid(), reconciled_at = now(), updated_at = now()
   WHERE id = _remittance;

  UPDATE public.rider_cash_collections
     SET status = CASE WHEN _var = 0 THEN 'reconciled' ELSE 'disputed' END, updated_at = now()
   WHERE remittance_id = _remittance;

  INSERT INTO public.audit_logs (organization_id, user_id, user_name, action, module, record_id, previous_value, new_value, reason)
  VALUES (_org, auth.uid(), '', 'delivery.cash.reconcile', 'delivery', _remittance::text,
          jsonb_build_object('expected', _r.expected_amount, 'declared', _r.declared_amount),
          jsonb_build_object('counted', _counted, 'variance', _var), nullif(btrim(coalesce(_reason,'')),''));

  RETURN jsonb_build_object('ok', true, 'remittance_id', _remittance, 'counted', _counted,
                            'variance', _var, 'status', CASE WHEN _var = 0 THEN 'reconciled' ELSE 'disputed' END);
END; $function$;

REVOKE ALL ON FUNCTION public.delivery_confirm_delivery(uuid, text, text, numeric, numeric, numeric) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.delivery_confirm_delivery(uuid, text, text, numeric, numeric, numeric) FROM anon;
GRANT EXECUTE ON FUNCTION public.delivery_confirm_delivery(uuid, text, text, numeric, numeric, numeric) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.neo_delivery_rider_remit(numeric, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.neo_delivery_rider_remit(numeric, uuid) FROM anon;
GRANT EXECUTE ON FUNCTION public.neo_delivery_rider_remit(numeric, uuid) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.neo_delivery_remit_reconcile(uuid, numeric, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.neo_delivery_remit_reconcile(uuid, numeric, text) FROM anon;
GRANT EXECUTE ON FUNCTION public.neo_delivery_remit_reconcile(uuid, numeric, text) TO authenticated, service_role;