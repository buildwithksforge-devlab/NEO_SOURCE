-- Returned live definition, 19 November; normalized body hash independently reproduced.
-- Retains the installed cached-part-payment refusal and legal awaiting-payment transition.
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
  _base numeric;
BEGIN
  IF NOT public.has_permission('pos','room_charge.post') THEN RAISE EXCEPTION 'Not permitted to post room charges'; END IF;
  SELECT * INTO _order FROM public.pos_orders WHERE id = _order_id AND organization_id = _org FOR UPDATE;
  IF _order.id IS NULL THEN RAISE EXCEPTION 'Order not found'; END IF;
  IF _order.folio_post_status = 'posted' THEN
    SELECT id INTO _line FROM public.folio_lines
     WHERE organization_id = _org AND idempotency_key = _idempotency_key LIMIT 1;
    IF _line IS NOT NULL THEN RETURN _line; END IF;
    RAISE EXCEPTION 'Order already posted to a folio';
  END IF;
  IF _order.status NOT IN ('sent','accepted','in-preparation','partially-ready','ready','partially-served','served','awaiting-payment') THEN
    RAISE EXCEPTION 'Bill % cannot be charged to a room from status "%": send it to production first', _order.order_number, _order.status;
  END IF;
  IF coalesce(_order.paid_total, 0) > 0 THEN
    RAISE EXCEPTION 'This bill has a recorded POS payment. Settle the remainder separately before charging it to a room';
  END IF;
  SELECT * INTO _folio FROM public.folios WHERE id = _folio_id AND organization_id = _org FOR UPDATE;
  IF _folio.id IS NULL THEN RAISE EXCEPTION 'Folio not found'; END IF;
  IF _folio.branch_id IS DISTINCT FROM _order.branch_id THEN RAISE EXCEPTION 'Order and folio belong to different properties'; END IF;
  IF _folio.status <> 'open' THEN RAISE EXCEPTION 'Folio is not open'; END IF;
  SELECT id INTO _line FROM public.folio_lines WHERE organization_id = _org AND idempotency_key = _idempotency_key LIMIT 1;
  IF _line IS NOT NULL THEN RETURN _line; END IF;

  _base := round(coalesce(_order.grand_total,0) - coalesce(_order.tax_total,0)
                 - coalesce(_order.service_charge_total,0) + coalesce(_order.discount_total,0), 2);
  IF _base < 0 OR round(_base - coalesce(_order.discount_total,0) + coalesce(_order.tax_total,0)
      + coalesce(_order.service_charge_total,0),2) <> round(coalesce(_order.grand_total,0),2) THEN
    RAISE EXCEPTION 'Posting blocked — source integrity mismatch';
  END IF;

  _prior := coalesce(current_setting('neo.system_posting', true), 'off');
  PERFORM set_config('neo.system_posting', 'on', true);
  _line := public.folio_post_charge(
    _folio_id, 'food-beverage', 'POS ' || _order.order_number || ' (' || _order.order_type || ')',
    1, _base, _order.tax_total, _order.service_charge_total, _order.discount_total,
    'pos', _order_id, 'fnb', _idempotency_key, NULL);
  IF _order.status <> 'awaiting-payment' THEN
    UPDATE public.pos_orders SET status = 'awaiting-payment' WHERE id = _order_id;
  END IF;
  UPDATE public.pos_orders
     SET folio_post_status = 'posted', folio_id = _folio_id, payment_status = 'paid',
         status = 'charged-to-room', closed_at = now()
   WHERE id = _order_id;
  PERFORM set_config('neo.system_posting', _prior, true);

  PERFORM public.emit_domain_event(_org, _order.branch_id, 'pos.room_charge.posted', 'pos', _order_id,
    jsonb_build_object('orderId',_order_id,'folioId',_folio_id,'amount',_order.grand_total,
                       'tax',_order.tax_total,'serviceCharge',_order.service_charge_total),
    _idempotency_key, _order.customer_id);
  INSERT INTO public.audit_logs
    (organization_id, branch_id, user_id, action, module, record_id, new_value)
  VALUES (_org, _order.branch_id, auth.uid(), 'pos.room_charge.post', 'pos', _order_id,
    jsonb_build_object('folioId',_folio_id,'gross',_order.grand_total,'tax',_order.tax_total,
                       'serviceCharge',_order.service_charge_total,'folioLineId',_line));
  RETURN _line;
END;
$function$;
