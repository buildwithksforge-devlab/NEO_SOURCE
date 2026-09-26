CREATE OR REPLACE FUNCTION public.neo_delivery_assign(_order uuid, _rider uuid, _reason text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  _org uuid := public.current_org_id();
  _o public.delivery_orders; _new public.rider_profiles; _prev public.rider_profiles;
  _cand record; _found boolean := false; _reason_clean text := nullif(btrim(coalesce(_reason,'')),'');
BEGIN
  IF _org IS NULL THEN RETURN jsonb_build_object('ok', false, 'reason', 'no_organisation'); END IF;
  IF NOT (public.has_permission('delivery','dispatch.assign') OR public.is_org_admin()) THEN
    RAISE EXCEPTION 'The delivery.dispatch.assign permission is required.' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO _o FROM public.delivery_orders
   WHERE id = _order AND organization_id = _org FOR UPDATE;
  IF _o.id IS NULL THEN RETURN jsonb_build_object('ok', false, 'reason', 'order_not_found'); END IF;
  IF NOT public.neo_branch_in_scope(_o.branch_id) THEN
    RAISE EXCEPTION 'That order is outside your access scope.' USING ERRCODE = '42501';
  END IF;
  IF _o.order_status IN ('delivered','cancelled','rejected','failed') THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'order_closed',
      'detail', 'That order is already ' || _o.order_status || '.');
  END IF;
  IF _o.rider_id = _rider THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'already_assigned',
      'detail', 'That rider already holds this order.');
  END IF;
  IF _o.rider_id IS NOT NULL AND _reason_clean IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'reason_required',
      'detail', 'Reassigning an order requires a written reason.');
  END IF;

  FOR _cand IN SELECT * FROM public.neo_delivery_dispatch_candidates(_order) c WHERE c.rider_id = _rider LOOP
    _found := true;
    IF _cand.eligible IS NOT TRUE THEN
      RETURN jsonb_build_object('ok', false, 'reason', 'rider_ineligible',
        'detail', array_to_string(_cand.reasons, '; '), 'reasons', to_jsonb(_cand.reasons));
    END IF;
  END LOOP;
  IF NOT _found THEN RETURN jsonb_build_object('ok', false, 'reason', 'rider_not_found'); END IF;

  SELECT * INTO _new FROM public.rider_profiles WHERE id = _rider;
  IF _o.rider_id IS NOT NULL THEN
    SELECT * INTO _prev FROM public.rider_profiles WHERE id = _o.rider_id;
  END IF;

  UPDATE public.delivery_orders
     SET rider_id = _rider,
         dispatch_status = 'rider-assigned',
         order_status = CASE WHEN order_status IN ('ready-for-pickup','confirmed','in-preparation')
                             THEN 'rider-assigned' ELSE order_status END,
         accepted_at = coalesce(accepted_at, now()),
         updated_at = now()
   WHERE id = _order;

  INSERT INTO public.delivery_order_status_history
    (organization_id, delivery_order_id, status_kind, previous_status, new_status, reason, changed_by)
  VALUES (_org, _order, 'dispatch', coalesce(_prev.display_name, 'unassigned'),
          coalesce(_new.display_name, 'rider'), _reason_clean, auth.uid());

  PERFORM public.neo_delivery_rider_notify(
    _org, _rider, 'delivery.assigned', 'Delivery assigned to you',
    _o.order_number || coalesce(' · ' || _o.contact_name, '') ||
      coalesce(' · reassigned: ' || _reason_clean, ''),
    'delivery.assign:' || _order::text || ':' || _rider::text,
    _order, _prev.id, _rider, 'high', '/rider');

  IF _prev.id IS NOT NULL THEN
    PERFORM public.neo_delivery_rider_notify(
      _org, _prev.id, 'delivery.reassigned', 'Delivery reassigned',
      _o.order_number || ' is now with ' || coalesce(_new.display_name,'another rider') ||
        coalesce(' — ' || _reason_clean, ''),
      'delivery.unassign:' || _order::text || ':' || _prev.id::text || ':' || _rider::text,
      _order, _prev.id, _rider, 'normal', '/rider');
  END IF;

  INSERT INTO public.audit_logs
    (organization_id, user_id, user_name, action, module, record_id, previous_value, new_value, reason)
  VALUES (_org, auth.uid(), '',
    CASE WHEN _prev.id IS NULL THEN 'delivery.dispatch.assign' ELSE 'delivery.dispatch.reassign' END,
    'delivery', _order::text,
    jsonb_build_object('rider_id', _prev.id, 'rider', _prev.display_name),
    jsonb_build_object('rider_id', _rider, 'rider', _new.display_name),
    _reason_clean);

  RETURN jsonb_build_object('ok', true, 'order_id', _order, 'rider_id', _rider,
    'previous_rider_id', _prev.id, 'reassigned', _prev.id IS NOT NULL);
END $function$;

REVOKE ALL ON FUNCTION public.neo_delivery_assign(uuid, uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.neo_delivery_assign(uuid, uuid, text) TO authenticated;