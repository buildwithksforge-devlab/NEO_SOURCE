-- 1. Guest-initiated M-Pesa for their own delivery order.
CREATE OR REPLACE FUNCTION public.neo_delivery_guest_mpesa_start(_order uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  _d public.delivery_orders;
  _o public.pos_orders;
  _confirmed numeric := 0;
  _active numeric := 0;
  _due numeric;
  _payment uuid;
  _ref text;
  _key text;
BEGIN
  SELECT * INTO _d FROM public.delivery_orders WHERE id = _order;
  IF _d.id IS NULL THEN RAISE EXCEPTION 'Order not found'; END IF;
  IF NOT public.customer_owns_delivery(_d.id) THEN
    RAISE EXCEPTION 'That order does not belong to you';
  END IF;
  IF coalesce(_d.payment_method, '') <> 'mpesa' THEN
    RAISE EXCEPTION 'This order is not set to be paid by M-Pesa';
  END IF;
  IF _d.payment_status = 'paid' THEN
    RETURN jsonb_build_object('already_paid', true, 'order_id', _d.id);
  END IF;

  SELECT * INTO _o FROM public.pos_orders WHERE id = _d.pos_order_id FOR UPDATE;
  IF _o.id IS NULL THEN RAISE EXCEPTION 'Bill not found for this order'; END IF;

  SELECT coalesce(sum(amount) FILTER (WHERE status = 'confirmed'), 0),
         coalesce(sum(amount) FILTER (WHERE status IN ('initiated','pending')), 0)
    INTO _confirmed, _active
    FROM public.pos_payments WHERE order_id = _o.id;

  _due := round(coalesce(_o.grand_total, 0) - _confirmed - _active, 2);
  IF _due <= 0 THEN
    RETURN jsonb_build_object('already_paid', _confirmed >= coalesce(_o.grand_total,0),
                              'pending', _active > 0, 'order_id', _d.id);
  END IF;

  _ref := 'STK-' || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 12));
  _key := 'mpesa:' || _ref;

  INSERT INTO public.pos_payments (
    organization_id, branch_id, order_id, amount, currency, method,
    external_reference, status, provider_status, customer_id, idempotency_key
  ) VALUES (
    _d.organization_id, _d.branch_id, _o.id, _due, coalesce(_o.currency, 'KES'), 'mpesa',
    _ref, 'pending', 'awaiting-provider', _d.customer_id, _key
  ) RETURNING id INTO _payment;

  RETURN jsonb_build_object(
    'order_id', _d.id,
    'organization_id', _d.organization_id,
    'branch_id', _d.branch_id,
    'pos_order_id', _o.id,
    'payment_id', _payment,
    'amount', _due,
    'reference', _ref,
    'account_reference', coalesce(_d.order_number, _o.order_number),
    'msisdn', _d.contact_phone
  );
END;
$fn$;

REVOKE ALL ON FUNCTION public.neo_delivery_guest_mpesa_start(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.neo_delivery_guest_mpesa_start(uuid) TO authenticated;

-- 2. Provider outcome must also move the delivery order itself.
CREATE OR REPLACE FUNCTION public.neo_mpesa_delivery_sync(_pos_order uuid, _paid boolean)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
BEGIN
  IF _pos_order IS NULL THEN RETURN; END IF;
  IF _paid THEN
    UPDATE public.delivery_orders
       SET payment_status = 'paid',
           order_status = CASE WHEN order_status = 'pending-payment' THEN 'confirmed' ELSE order_status END,
           updated_at = now()
     WHERE pos_order_id = _pos_order
       AND coalesce(payment_status, '') <> 'paid';
  ELSE
    UPDATE public.delivery_orders
       SET payment_status = 'failed', updated_at = now()
     WHERE pos_order_id = _pos_order
       AND coalesce(payment_status, '') IN ('pending', 'unpaid', '');
  END IF;
END;
$fn$;

REVOKE ALL ON FUNCTION public.neo_mpesa_delivery_sync(uuid, boolean) FROM PUBLIC, anon, authenticated;
