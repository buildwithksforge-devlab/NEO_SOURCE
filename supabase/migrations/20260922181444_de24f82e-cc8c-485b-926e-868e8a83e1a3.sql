CREATE OR REPLACE FUNCTION public.pos_reconcile_settlement_internal(_order_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  _o public.pos_orders;
  _paid numeric := 0;
  _pending numeric := 0;
  _balance numeric;
  _open_items int;
  _closed boolean := false;
  _pay_status text;
  _settleable boolean;
BEGIN
  SELECT * INTO _o FROM public.pos_orders WHERE id = _order_id FOR UPDATE;
  IF _o.id IS NULL THEN RAISE EXCEPTION 'Order not found'; END IF;

  SELECT coalesce(sum(amount) FILTER (WHERE status = 'confirmed'), 0),
         coalesce(sum(amount) FILTER (WHERE status IN ('initiated','pending')), 0)
    INTO _paid, _pending
    FROM public.pos_payments WHERE order_id = _order_id;

  _balance := round(coalesce(_o.grand_total, 0) - _paid, 2);

  SELECT count(*) INTO _open_items
    FROM public.pos_order_items
   WHERE order_id = _order_id AND status NOT IN ('served','cancelled','voided');

  _pay_status := CASE
    WHEN _balance <= 0.005 AND coalesce(_o.grand_total,0) > 0 THEN 'paid'
    WHEN _paid > 0 THEN 'partial'
    WHEN _pending > 0 THEN 'pending'
    ELSE 'unpaid' END;

  _settleable := _balance <= 0.005 AND coalesce(_o.grand_total,0) > 0 AND _open_items = 0
                 AND _o.status NOT IN ('closed','cancelled','voided','charged-to-room','credit');

  IF _settleable THEN
    -- move the order out of the service states BEFORE marking it paid, so the
    -- lifecycle guard never sees a fully paid order sitting in 'served'.
    IF _o.status IN ('served','partially-served') THEN
      UPDATE public.pos_orders SET status = 'awaiting-payment' WHERE id = _order_id;
      _o.status := 'awaiting-payment';
    END IF;

    IF _o.status = 'awaiting-payment' THEN
      UPDATE public.pos_orders
         SET status = 'paid', paid_total = _paid, payment_status = _pay_status
       WHERE id = _order_id;
      UPDATE public.pos_orders SET status = 'closed', closed_at = now() WHERE id = _order_id;
      _closed := true;
    ELSE
      UPDATE public.pos_orders
         SET paid_total = _paid, payment_status = _pay_status
       WHERE id = _order_id
         AND (paid_total IS DISTINCT FROM _paid OR payment_status IS DISTINCT FROM _pay_status);
    END IF;
  ELSE
    UPDATE public.pos_orders
       SET paid_total = _paid, payment_status = _pay_status
     WHERE id = _order_id
       AND (paid_total IS DISTINCT FROM _paid OR payment_status IS DISTINCT FROM _pay_status);
  END IF;

  RETURN jsonb_build_object(
    'order_id', _order_id,
    'grand_total', coalesce(_o.grand_total,0),
    'paid_total', _paid,
    'pending_total', _pending,
    'balance', greatest(_balance, 0),
    'payment_status', _pay_status,
    'open_items', _open_items,
    'closed', _closed
  );
END $function$;