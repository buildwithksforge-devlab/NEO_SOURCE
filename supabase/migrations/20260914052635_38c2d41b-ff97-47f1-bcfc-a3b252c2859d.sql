CREATE OR REPLACE FUNCTION public.neo_delivery_claim(_order uuid, _collect boolean DEFAULT false)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  r public.rider_profiles;
  o public.delivery_orders;
  active_load int;
BEGIN
  SELECT * INTO r FROM public.rider_profiles
   WHERE profile_id = auth.uid() AND active LIMIT 1;
  IF r.id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_a_rider',
      'detail', 'Only an active rider can pick up a waiting order.');
  END IF;

  SELECT * INTO o FROM public.delivery_orders
   WHERE id = _order AND organization_id = r.organization_id FOR UPDATE;
  IF o.id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'order_not_found');
  END IF;
  IF o.branch_id IS DISTINCT FROM r.branch_id THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'other_property',
      'detail', 'That order belongs to another property.');
  END IF;
  IF o.rider_id IS NOT NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'already_taken',
      'detail', CASE WHEN o.rider_id = r.id THEN 'You already hold this order.'
                     ELSE 'Another rider has already taken this order.' END);
  END IF;
  IF o.order_status NOT IN ('confirmed','in-preparation','ready-for-pickup') THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_claimable',
      'detail', 'That order is ' || o.order_status || ' and cannot be picked up.');
  END IF;

  SELECT count(*) INTO active_load FROM public.delivery_orders d
   WHERE d.rider_id = r.id
     AND d.order_status IN ('rider-assigned','collected','out-for-delivery','en-route','arrived');
  IF active_load >= coalesce(r.max_active_deliveries, 1) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'at_capacity',
      'detail', 'You are already carrying the maximum number of deliveries.');
  END IF;
  IF lower(coalesce(o.payment_method,'')) = 'cash' AND r.cash_handling_allowed IS NOT TRUE THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'cash_not_allowed',
      'detail', 'This is a cash order and you are not cleared to carry cash.');
  END IF;

  -- Taking the order only puts it in the rider's name. Recording the pick-up
  -- is a separate fact, so the caller must say it happened; the food is only
  -- collected once the rider actually has it.
  IF _collect AND o.order_status NOT IN ('ready-for-pickup') THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_ready',
      'detail', 'The kitchen has not marked this order ready for pick-up yet.');
  END IF;

  UPDATE public.delivery_orders
     SET rider_id = r.id,
         dispatch_status = CASE WHEN _collect THEN 'collected' ELSE 'rider-assigned' END,
         order_status = CASE WHEN _collect THEN 'collected' ELSE 'rider-assigned' END,
         accepted_at = coalesce(accepted_at, now()),
         collected_at = CASE WHEN _collect THEN coalesce(o.collected_at, now()) ELSE o.collected_at END,
         updated_at = now()
   WHERE id = _order;

  UPDATE public.rider_profiles
     SET availability_status = CASE WHEN _collect THEN 'collecting' ELSE availability_status END
   WHERE id = r.id;

  INSERT INTO public.delivery_order_status_history
    (organization_id, delivery_order_id, status_kind, previous_status, new_status, reason, changed_by)
  VALUES (o.organization_id, _order, 'dispatch', 'unassigned',
          coalesce(r.display_name, 'rider'),
          CASE WHEN _collect THEN 'Taken and picked up by the rider from the zone queue'
               ELSE 'Picked up by the rider from the zone queue' END,
          auth.uid());

  INSERT INTO public.audit_logs
    (organization_id, branch_id, user_id, user_name, action, module, record_id,
     previous_value, new_value, reason)
  VALUES (o.organization_id, o.branch_id, auth.uid(), coalesce(r.display_name,''),
    'delivery.dispatch.self-claim', 'delivery', _order::text,
    jsonb_build_object('rider_id', NULL),
    jsonb_build_object('rider_id', r.id, 'rider', r.display_name, 'collected', _collect),
    'Rider claimed a waiting order');

  RETURN jsonb_build_object('ok', true, 'order_id', _order, 'rider_id', r.id,
    'collected', _collect, 'order_number', o.order_number);
END;
$function$;

REVOKE ALL ON FUNCTION public.neo_delivery_claim(uuid, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.neo_delivery_claim(uuid, boolean) TO authenticated;