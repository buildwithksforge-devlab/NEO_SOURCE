CREATE OR REPLACE FUNCTION public.delivery_assign_rider(_order uuid, _rider uuid, _reason text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE _d public.delivery_orders; _r public.rider_profiles; _active int;
BEGIN
  IF NOT public.has_permission('delivery','dispatch.assign') THEN RAISE EXCEPTION 'Not permitted'; END IF;
  -- Lock the delivery for the duration of the assignment. Two dispatchers
  -- assigning different riders at the same moment previously both read an
  -- unassigned order, so both assignments were written and two riders believed
  -- the delivery was theirs. The lock serialises them: the second call sees the
  -- first rider and takes the reassignment path.
  SELECT * INTO _d FROM public.delivery_orders
   WHERE id = _order AND organization_id = public.current_org_id() FOR UPDATE;
  SELECT * INTO _r FROM public.rider_profiles WHERE id = _rider AND organization_id = public.current_org_id();
  IF _d.id IS NULL OR _r.id IS NULL THEN RAISE EXCEPTION 'Order or rider not found'; END IF;
  -- A finished or cancelled delivery is not dispatchable.
  IF _d.dispatch_status IN ('delivered','failed','cancelled','returned')
     OR _d.order_status IN ('delivered','cancelled','refunded') THEN
    RAISE EXCEPTION 'Delivery % is already closed and cannot be assigned', _d.order_number;
  END IF;
  IF _d.rider_id = _rider THEN RETURN jsonb_build_object('ok', true, 'unchanged', true); END IF;
  IF NOT _r.active OR _r.availability_status IN ('offline','unavailable','shift-ended','on-break') THEN
    RAISE EXCEPTION 'Rider is not available';
  END IF;
  SELECT count(*) INTO _active FROM public.delivery_orders
   WHERE rider_id = _rider AND dispatch_status IN ('rider-assigned','pickup-pending','collected','en-route');
  IF _active >= _r.max_active_deliveries THEN RAISE EXCEPTION 'Rider is at capacity'; END IF;

  IF _d.rider_id IS NOT NULL AND _d.rider_id <> _rider THEN
    UPDATE public.rider_assignments SET status = 'reassigned', reassignment_reason = _reason
      WHERE delivery_order_id = _order AND status IN ('offered','accepted');
  END IF;

  INSERT INTO public.rider_assignments (organization_id, branch_id, delivery_order_id, rider_id, previous_rider_id, assigned_by, reassignment_reason)
  VALUES (_d.organization_id, _d.branch_id, _order, _rider, _d.rider_id, auth.uid(), _reason);

  UPDATE public.delivery_orders SET rider_id = _rider, dispatch_status = 'rider-assigned',
    order_status = CASE WHEN order_status IN ('confirmed','in-preparation','ready-for-pickup') THEN 'rider-assigned' ELSE order_status END
  WHERE id = _order;
  UPDATE public.rider_profiles SET availability_status = 'assigned' WHERE id = _rider;

  INSERT INTO public.delivery_order_status_history (organization_id, delivery_order_id, status_kind, previous_status, new_status, reason, changed_by)
  VALUES (_d.organization_id, _order, 'dispatch', _d.dispatch_status, 'rider-assigned', _reason, auth.uid());
  RETURN jsonb_build_object('ok', true);
END; $function$;

CREATE OR REPLACE FUNCTION public.delivery_rider_advance(_order uuid, _to text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE _d public.delivery_orders; _rider uuid := public.my_rider_id();
BEGIN
  -- Locked for the same reason as assignment: two taps of the same button, or
  -- two devices, previously both read the earlier stage and both advanced it.
  SELECT * INTO _d FROM public.delivery_orders WHERE id = _order FOR UPDATE;
  IF _d.id IS NULL OR _d.rider_id IS NULL OR _d.rider_id <> _rider THEN RAISE EXCEPTION 'Delivery not assigned to you'; END IF;
  IF _to NOT IN ('pickup-pending','collected','en-route') THEN RAISE EXCEPTION 'Invalid transition'; END IF;
  IF _d.dispatch_status = _to THEN RETURN jsonb_build_object('ok', true, 'unchanged', true); END IF;
  IF _to = 'collected' AND _d.dispatch_status NOT IN ('rider-assigned','pickup-pending') THEN RAISE EXCEPTION 'Invalid transition'; END IF;
  IF _to = 'en-route' AND _d.dispatch_status <> 'collected' THEN RAISE EXCEPTION 'Collect the order first'; END IF;

  UPDATE public.delivery_orders SET dispatch_status = _to,
    collected_at = CASE WHEN _to = 'collected' THEN now() ELSE collected_at END,
    order_status = CASE WHEN _to = 'collected' THEN 'collected' WHEN _to = 'en-route' THEN 'out-for-delivery' ELSE order_status END
  WHERE id = _order;
  UPDATE public.rider_profiles SET availability_status = CASE WHEN _to = 'en-route' THEN 'delivering' ELSE 'collecting' END WHERE id = _rider;
  INSERT INTO public.delivery_order_status_history (organization_id, delivery_order_id, status_kind, previous_status, new_status, source, changed_by)
  VALUES (_d.organization_id, _order, 'dispatch', _d.dispatch_status, _to, 'rider', auth.uid());
  RETURN jsonb_build_object('ok', true);
END; $function$;