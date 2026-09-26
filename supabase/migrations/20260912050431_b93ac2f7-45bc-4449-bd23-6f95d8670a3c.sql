CREATE OR REPLACE FUNCTION public.neo_delivery_guest_mpesa_start(_order uuid, _msisdn text DEFAULT NULL)
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
  _txn uuid;
  _ref text;
  _digits text;
  _env text;
  _code text;
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

  _digits := regexp_replace(coalesce(nullif(btrim(coalesce(_msisdn, '')), ''), coalesce(_d.contact_phone, '')), '[^0-9]', '', 'g');
  IF length(_digits) < 9 THEN RAISE EXCEPTION 'A valid mobile number is required'; END IF;

  SELECT * INTO _o FROM public.pos_orders WHERE id = _d.pos_order_id FOR UPDATE;
  IF _o.id IS NULL THEN RAISE EXCEPTION 'Bill not found for this order'; END IF;

  SELECT coalesce(sum(amount) FILTER (WHERE status = 'confirmed'), 0),
         coalesce(sum(amount) FILTER (WHERE status IN ('initiated','pending')), 0)
    INTO _confirmed, _active
    FROM public.pos_payments WHERE order_id = _o.id;

  _due := round(coalesce(_o.grand_total, 0) - _confirmed - _active, 2);
  IF _due <= 0 THEN
    RETURN jsonb_build_object('already_paid', _confirmed >= coalesce(_o.grand_total, 0),
                              'pending', _active > 0, 'order_id', _d.id);
  END IF;

  _ref := 'STK-' || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 12));

  INSERT INTO public.pos_payments (
    organization_id, branch_id, order_id, amount, currency, method,
    external_reference, status, provider_status, customer_id, idempotency_key
  ) VALUES (
    _d.organization_id, _d.branch_id, _o.id, _due, coalesce(_o.currency, 'KES'), 'mpesa',
    _ref, 'pending', 'awaiting-provider', _d.customer_id, 'mpesa:' || _ref
  ) RETURNING id INTO _payment;

  SELECT environment, short_code INTO _env, _code
    FROM public.mpesa_settings WHERE organization_id = _d.organization_id;

  INSERT INTO public.mpesa_transactions (
    organization_id, branch_id, source_module, source_record_id, payment_table, payment_id,
    msisdn, amount, account_reference, description, environment, short_code, status, created_by)
  VALUES (_d.organization_id, _d.branch_id, 'pos_order', _o.id, 'pos_payments', _payment,
          _digits, _due, coalesce(_d.order_number, _o.order_number), 'Delivery order',
          coalesce(_env, 'sandbox'), _code, 'initiated', auth.uid())
  RETURNING id INTO _txn;

  UPDATE public.delivery_orders SET payment_status = 'pending', updated_at = now() WHERE id = _d.id;

  RETURN jsonb_build_object(
    'order_id', _d.id,
    'organization_id', _d.organization_id,
    'transaction_id', _txn,
    'payment_id', _payment,
    'amount', _due,
    'msisdn', _digits,
    'reference', _ref,
    'account_reference', coalesce(_d.order_number, _o.order_number)
  );
END;
$fn$;

REVOKE ALL ON FUNCTION public.neo_delivery_guest_mpesa_start(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.neo_delivery_guest_mpesa_start(uuid, text) TO authenticated;
DROP FUNCTION IF EXISTS public.neo_delivery_guest_mpesa_start(uuid);