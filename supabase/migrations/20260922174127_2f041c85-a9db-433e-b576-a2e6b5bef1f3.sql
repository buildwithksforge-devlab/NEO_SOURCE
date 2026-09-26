CREATE OR REPLACE FUNCTION public.neo_guest_order_tracking(_org uuid, _reference text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  _cust uuid := public.my_customer_id(); _d public.delivery_orders; _rider public.rider_profiles;
  _pay public.pos_payments; _svc numeric; _started boolean;
BEGIN
  IF _cust IS NULL THEN RETURN NULL; END IF;
  SELECT * INTO _d FROM public.delivery_orders
   WHERE organization_id = _org AND order_number = _reference AND customer_id = _cust;
  IF _d.id IS NULL THEN RETURN NULL; END IF;

  IF _d.rider_id IS NOT NULL THEN
    SELECT * INTO _rider FROM public.rider_profiles WHERE id = _d.rider_id;
  END IF;

  SELECT * INTO _pay FROM public.pos_payments
   WHERE order_id = _d.pos_order_id AND status IN ('paid','completed','captured')
   ORDER BY created_at DESC LIMIT 1;

  _svc := coalesce(_d.service_charge_total, 0);

  -- "Started" means a station has taken the work on, so the guest can no
  -- longer cancel it themselves.
  _started := EXISTS (
    SELECT 1 FROM public.kitchen_tickets t
     WHERE t.order_id = _d.pos_order_id
       AND t.status NOT IN ('new','queued','pending','cancelled')
  );

  RETURN jsonb_build_object(
    'id', _d.id,
    'order_number', _d.order_number,
    'fulfilment_type', _d.fulfilment_type,
    'order_status', _d.order_status,
    'kitchen_status', _d.kitchen_status,
    'dispatch_status', _d.dispatch_status,
    'payment_status', _d.payment_status,
    'payment_method', _d.payment_method,
    'subtotal', _d.subtotal,
    'tax_total', _d.tax_total,
    'service_charge', _svc,
    'discount_total', _d.discount_total,
    'delivery_fee', _d.delivery_fee,
    'grand_total', _d.grand_total,
    'currency', coalesce(_d.currency, 'KES'),
    'receipt_number', _pay.receipt_number,
    'paid_at', _pay.paid_at,
    'created_at', _d.created_at,
    'estimated_delivery_at', _d.estimated_delivery_at,
    'delivered_at', _d.delivered_at,
    'cancelled_at', _d.cancelled_at,
    'can_cancel', (
      _d.order_status NOT IN ('cancelled','rejected','delivered','completed','collected')
      AND coalesce(_d.dispatch_status, '') NOT IN ('picked-up','on-the-way','delivered')
      AND _d.payment_status NOT IN ('paid','charged','refunded')
      AND NOT _started
    ),
    'courier', CASE WHEN _rider.id IS NULL THEN NULL ELSE jsonb_build_object(
        'display_name', split_part(coalesce(_rider.display_name, 'Courier'), ' ', 1),
        'vehicle_type', _rider.vehicle_type,
        'availability_status', _rider.availability_status) END,
    'items', (SELECT coalesce(jsonb_agg(jsonb_build_object(
                  'name', oi.item_name, 'quantity', oi.quantity,
                  'line_total', oi.line_total, 'status', oi.status) ORDER BY oi.created_at), '[]'::jsonb)
                FROM public.pos_order_items oi WHERE oi.order_id = _d.pos_order_id),
    'timeline', (SELECT coalesce(jsonb_agg(jsonb_build_object(
                  'status', h.new_status, 'kind', h.status_kind, 'at', h.created_at)
                  ORDER BY h.created_at), '[]'::jsonb)
                FROM public.delivery_order_status_history h WHERE h.delivery_order_id = _d.id)
  );
END $function$;

CREATE OR REPLACE FUNCTION public.neo_guest_order_cancel(_org uuid, _reference text, _reason text DEFAULT NULL)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  _cust uuid := public.my_customer_id(); _d public.delivery_orders; _started boolean;
BEGIN
  IF _cust IS NULL THEN RETURN jsonb_build_object('ok', false, 'reason', 'not_signed_in'); END IF;

  SELECT * INTO _d FROM public.delivery_orders
   WHERE organization_id = _org AND order_number = _reference AND customer_id = _cust
   FOR UPDATE;
  IF _d.id IS NULL THEN RETURN jsonb_build_object('ok', false, 'reason', 'unknown_order'); END IF;

  IF _d.order_status = 'cancelled' THEN
    RETURN jsonb_build_object('ok', true, 'already_cancelled', true);
  END IF;

  _started := EXISTS (
    SELECT 1 FROM public.kitchen_tickets t
     WHERE t.order_id = _d.pos_order_id
       AND t.status NOT IN ('new','queued','pending','cancelled')
  );

  IF _d.payment_status IN ('paid','charged','refunded')
     OR _d.order_status IN ('delivered','completed','collected','rejected')
     OR coalesce(_d.dispatch_status,'') IN ('picked-up','on-the-way','delivered')
     OR _started THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'already_started');
  END IF;

  UPDATE public.kitchen_tickets
     SET status = 'cancelled'
   WHERE order_id = _d.pos_order_id
     AND status IN ('new','queued','pending');

  UPDATE public.pos_orders
     SET status = 'cancelled'
   WHERE id = _d.pos_order_id
     AND status <> 'cancelled';

  UPDATE public.delivery_orders
     SET order_status = 'cancelled',
         kitchen_status = 'cancelled',
         cancelled_at = now(),
         cancellation_reason = nullif(trim(coalesce(_reason, '')), '')
   WHERE id = _d.id;

  INSERT INTO public.delivery_order_status_history
    (organization_id, delivery_order_id, status_kind, previous_status, new_status, source, reason)
  VALUES (_org, _d.id, 'order', _d.order_status, 'cancelled', 'customer',
          nullif(trim(coalesce(_reason, '')), ''));

  RETURN jsonb_build_object('ok', true, 'order_number', _d.order_number);
END $function$;

REVOKE EXECUTE ON FUNCTION public.neo_guest_order_cancel(uuid, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.neo_guest_order_cancel(uuid, text, text) TO authenticated;