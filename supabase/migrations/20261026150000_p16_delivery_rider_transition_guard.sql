-- NEO P1.6 - DELIVERY RIDER TRANSITION GUARD
-- LOCAL DRAFT - NOT DEPLOYED
--
-- Protect terminal delivery orders and pickup transitions.
-- Preserve existing rider and kitchen readiness checks.
CREATE OR REPLACE FUNCTION public.delivery_rider_advance(_order uuid, _to text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  _d public.delivery_orders;
  _rider uuid := public.my_rider_id();
BEGIN
  SELECT * INTO _d FROM public.delivery_orders WHERE id = _order FOR UPDATE;
  IF _d.id IS NULL OR _d.rider_id IS NULL OR _d.rider_id <> _rider THEN RAISE EXCEPTION 'Delivery not assigned to you'; END IF;
  IF _to NOT IN ('pickup-pending','collected','en-route') THEN RAISE EXCEPTION 'Invalid transition'; END IF;
  IF _d.dispatch_status = _to THEN RETURN jsonb_build_object('ok', true, 'unchanged', true); END IF;

  -- P1.6: Terminal orders must never re-enter rider dispatch.
  IF _d.order_status IN (
      'cancelled', 'rejected', 'failed', 'delivered', 'completed'
  ) THEN
    RAISE EXCEPTION 'Cannot advance a terminal delivery order';
  END IF;

  -- Only an assigned rider may request pickup preparation.
  IF _to = 'pickup-pending'
     AND _d.dispatch_status <> 'rider-assigned' THEN
    RAISE EXCEPTION 'Pickup preparation requires rider assignment';
  END IF;

  -- Reject backwards or repeated rider dispatch transitions.
  IF _to = 'collected'
     AND _d.dispatch_status NOT IN (
         'rider-assigned', 'pickup-pending'
     ) THEN
    RAISE EXCEPTION 'Invalid pickup transition';
  END IF;

  IF _to = 'collected' THEN
    IF _d.dispatch_status NOT IN ('rider-assigned','pickup-pending') THEN RAISE EXCEPTION 'Invalid transition'; END IF;
    IF coalesce(_d.kitchen_status,'') NOT IN ('ready','completed') THEN
      RAISE EXCEPTION 'Order is not ready for pickup';
    END IF;
  END IF;

  IF _to = 'en-route' AND _d.dispatch_status <> 'collected' THEN
    RAISE EXCEPTION 'Collect the order first';
  END IF;

  UPDATE public.delivery_orders SET dispatch_status = _to,
    collected_at = CASE WHEN _to = 'collected' THEN now() ELSE collected_at END,
    order_status = CASE WHEN _to = 'collected' THEN 'collected' WHEN _to = 'en-route' THEN 'out-for-delivery' ELSE order_status END
  WHERE id = _order;

  UPDATE public.rider_profiles
     SET availability_status = CASE WHEN _to = 'en-route' THEN 'delivering' ELSE 'collecting' END
   WHERE id = _rider;

  INSERT INTO public.delivery_order_status_history
    (organization_id, delivery_order_id, status_kind, previous_status, new_status, source, changed_by)
  VALUES (_d.organization_id, _order, 'dispatch', _d.dispatch_status, _to, 'rider', auth.uid());

  RETURN jsonb_build_object('ok', true);
END;
$function$;

