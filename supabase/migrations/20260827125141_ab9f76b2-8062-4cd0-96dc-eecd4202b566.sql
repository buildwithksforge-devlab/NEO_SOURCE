CREATE OR REPLACE FUNCTION public.pos_post_room_charge(_order_id uuid, _folio_id uuid, _idempotency_key text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  _org uuid := public.current_org_id();
  _order public.pos_orders;
  _folio public.folios;
  _line uuid;
  _prior text;
BEGIN
  IF NOT public.has_permission('pos','room_charge.post') THEN
    RAISE EXCEPTION 'Not permitted to post room charges';
  END IF;
  SELECT * INTO _order FROM public.pos_orders WHERE id = _order_id AND organization_id = _org;
  IF _order.id IS NULL THEN RAISE EXCEPTION 'Order not found'; END IF;
  IF _order.folio_post_status = 'posted' THEN RAISE EXCEPTION 'Order already posted to a folio'; END IF;
  IF _order.status NOT IN ('served','awaiting-payment','partially-served') THEN
    RAISE EXCEPTION 'Bill is not finalised for posting';
  END IF;

  SELECT * INTO _folio FROM public.folios WHERE id = _folio_id AND organization_id = _org;
  IF _folio.id IS NULL THEN RAISE EXCEPTION 'Folio not found'; END IF;
  IF _folio.status <> 'open' THEN RAISE EXCEPTION 'Folio is not open'; END IF;

  IF EXISTS (SELECT 1 FROM public.folio_lines WHERE organization_id = _org AND idempotency_key = _idempotency_key) THEN
    RAISE EXCEPTION 'Duplicate room charge blocked';
  END IF;

  -- Post through the canonical folio charge routine so the folio totals and
  -- balance move with the line, and so the charge reaches Finance the same way
  -- every other folio charge does. A raw INSERT here left folio balances stale.
  _prior := COALESCE(current_setting('neo.system_posting', true), 'off');
  PERFORM set_config('neo.system_posting', 'on', true);
  _line := public.folio_post_charge(
    _folio_id, 'food-beverage',
    'POS ' || _order.order_number || ' (' || _order.order_type || ')',
    1, _order.subtotal, _order.tax_total, _order.service_charge_total, _order.discount_total,
    'pos', _order_id, 'fnb', _idempotency_key, NULL);

  -- Settlement always passes through 'awaiting-payment', exactly like the cash
  -- path in pos_reconcile_settlement_internal.
  IF _order.status IN ('served','partially-served') THEN
    UPDATE public.pos_orders SET status = 'awaiting-payment' WHERE id = _order_id;
  END IF;

  UPDATE public.pos_orders
     SET folio_post_status = 'posted', folio_id = _folio_id, payment_status = 'paid',
         status = 'charged-to-room', closed_at = now()
   WHERE id = _order_id;
  PERFORM set_config('neo.system_posting', _prior, true);

  PERFORM public.emit_domain_event(_org, _order.branch_id, 'pos.room_charge.posted', 'pos', _order_id,
    jsonb_build_object('orderId', _order_id, 'folioId', _folio_id, 'amount', _order.grand_total),
    _idempotency_key, _order.customer_id);

  INSERT INTO public.audit_logs (organization_id, branch_id, user_id, action, module, record_id, new_value)
  VALUES (_org, _order.branch_id, auth.uid(), 'pos.room_charge.post', 'pos', _order_id,
          jsonb_build_object('folioId', _folio_id, 'amount', _order.grand_total));

  RETURN _line;
END; $function$;