CREATE OR REPLACE FUNCTION public.delivery_place_order(_cart uuid, _payment_method text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  _c public.carts; _q jsonb; _s public.delivery_settings; _addr public.customer_addresses;
  _pos uuid; _del uuid; _num text; _line jsonb; _item uuid; _cust public.customers;
  _pin text; _pay_status text; _actor uuid; _order_status text;
BEGIN
  SELECT * INTO _c FROM public.carts WHERE id = _cart AND status = 'active';
  IF _c.id IS NULL OR _c.customer_id <> public.my_customer_id() THEN RAISE EXCEPTION 'Cart not found'; END IF;
  _q := public.delivery_quote_cart(_cart);
  IF NOT (_q->>'can_checkout')::boolean THEN RAISE EXCEPTION 'Cart cannot be checked out: %', _q->>'issues'; END IF;

  _s := public.delivery_get_settings(_c.branch_id);
  IF _payment_method <> ALL (coalesce(_s.allowed_payment_methods, ARRAY['cash'])) THEN
    RAISE EXCEPTION 'Payment method not allowed';
  END IF;
  IF _payment_method = 'cash' AND (_q->>'grand_total')::numeric > coalesce(_s.cod_limit, 0) THEN
    RAISE EXCEPTION 'Cash on delivery limit exceeded';
  END IF;

  -- Guest app users have no staff profile; staff-actor FKs must stay NULL for them.
  SELECT p.id INTO _actor FROM public.profiles p WHERE p.id = auth.uid();

  SELECT * INTO _cust FROM public.customers WHERE id = _c.customer_id;
  SELECT * INTO _addr FROM public.customer_addresses WHERE id = _c.address_id;
  _num := public.next_document_number('delivery_order');
  _pay_status := CASE WHEN _payment_method = 'cash' THEN 'unpaid' ELSE 'pending' END;
  _order_status := CASE WHEN _payment_method = 'cash' THEN 'confirmed' ELSE 'pending-payment' END;

  INSERT INTO public.pos_orders (
    organization_id, branch_id, order_number, order_type, order_source,
    customer_id, guest_count, guest_name, contact_phone, status, payment_status,
    subtotal, discount_total, tax_total, grand_total, currency, notes, created_by
  ) VALUES (
    _c.organization_id, _c.branch_id, _num,
    CASE WHEN _c.fulfilment_type = 'pickup' THEN 'takeaway' ELSE 'delivery' END,
    'customer-app', _c.customer_id, 1, _cust.full_name, coalesce(_addr.phone, _cust.phone),
    'confirmed', _pay_status,
    (_q->>'subtotal')::numeric, (_q->>'discount_total')::numeric, (_q->>'tax_total')::numeric,
    (_q->>'grand_total')::numeric, coalesce(_cust.preferred_language, 'KES'), _c.notes, _actor
  ) RETURNING id INTO _pos;
  UPDATE public.pos_orders SET currency = 'KES' WHERE id = _pos;

  FOR _line IN SELECT * FROM jsonb_array_elements(_q->'lines') LOOP
    INSERT INTO public.pos_order_items (
      organization_id, order_id, menu_item_id, station_id, item_name, quantity,
      unit_price, tax_rate, tax_amount, line_total, status, special_instructions, allergy_note, created_by
    ) VALUES (
      _c.organization_id, _pos, (_line->>'menu_item_id')::uuid, nullif(_line->>'station_id','')::uuid,
      _line->>'name', (_line->>'quantity')::numeric, (_line->>'unit_price')::numeric,
      (_line->>'tax_rate')::numeric,
      round((_line->>'quantity')::numeric * (_line->>'unit_price')::numeric * (_line->>'tax_rate')::numeric / 100, 2),
      round((_line->>'quantity')::numeric * (_line->>'unit_price')::numeric, 2),
      'draft', _line->>'special_instructions', _line->>'allergy_note', _actor
    ) RETURNING id INTO _item;

    INSERT INTO public.pos_order_item_modifiers (organization_id, order_item_id, group_id, option_id, group_name, option_name, extra_charge)
    SELECT _c.organization_id, _item, cim.group_id, cim.option_id, cim.group_name, cim.option_name, cim.extra_charge
    FROM public.cart_item_modifiers cim
    WHERE cim.cart_item_id = (_line->>'cart_item_id')::uuid;
  END LOOP;

  INSERT INTO public.delivery_orders (
    organization_id, branch_id, pos_order_id, customer_id, auth_user_id, order_number,
    fulfilment_type, contact_name, contact_phone, address_snapshot, zone_id, latitude, longitude,
    subtotal, tax_total, discount_total, delivery_fee, tip_amount, grand_total,
    payment_method, payment_status, promo_code, promotion_id, scheduled_for,
    estimated_prep_minutes, estimated_delivery_at, order_status, notes, created_by
  ) VALUES (
    _c.organization_id, _c.branch_id, _pos, _c.customer_id, auth.uid(), _num,
    _c.fulfilment_type, coalesce(_addr.recipient_name, _cust.full_name), coalesce(_addr.phone, _cust.phone),
    CASE WHEN _addr.id IS NULL THEN '{}'::jsonb ELSE to_jsonb(_addr) - 'created_by' END,
    (_q->>'zone_id')::uuid, _addr.latitude, _addr.longitude,
    (_q->>'subtotal')::numeric, (_q->>'tax_total')::numeric, (_q->>'discount_total')::numeric,
    (_q->>'delivery_fee')::numeric, (_q->>'tip_amount')::numeric, (_q->>'grand_total')::numeric,
    _payment_method, _pay_status, _c.promo_code, (_q->>'promotion_id')::uuid, _c.scheduled_for,
    coalesce((_q->>'eta_minutes')::int, 45),
    now() + make_interval(mins => coalesce((_q->>'eta_minutes')::int, 45)),
    _order_status,
    _c.notes, _actor
  ) RETURNING id INTO _del;

  _pin := lpad((floor(random() * 10000))::int::text, 4, '0');
  INSERT INTO public.delivery_order_pins (organization_id, delivery_order_id, customer_id, pin)
  VALUES (_c.organization_id, _del, _c.customer_id, _pin);

  IF (_q->>'promotion_id') IS NOT NULL THEN
    INSERT INTO public.promotion_redemptions (organization_id, promotion_id, customer_id, delivery_order_id, discount_amount)
    VALUES (_c.organization_id, (_q->>'promotion_id')::uuid, _c.customer_id, _del, (_q->>'discount_total')::numeric)
    ON CONFLICT DO NOTHING;
    UPDATE public.promotion_codes SET usage_count = usage_count + 1 WHERE id = (_q->>'promotion_id')::uuid;
  END IF;

  INSERT INTO public.delivery_order_status_history (organization_id, delivery_order_id, status_kind, new_status, source, changed_by)
  VALUES (_c.organization_id, _del, 'order', _order_status, 'customer', _actor);

  -- Kitchen handoff: an order that is ready to prepare routes its tickets to the
  -- stations now, exactly as room service does. Orders still awaiting payment
  -- stay unsent until the payment lands.
  IF _order_status = 'confirmed' THEN
    PERFORM public.neo_pos_route_tickets_internal(_pos, _c.organization_id);
    UPDATE public.pos_orders SET status = 'sent' WHERE id = _pos;
    UPDATE public.delivery_orders SET kitchen_status = 'new' WHERE id = _del;
  ELSE
    UPDATE public.delivery_orders SET kitchen_status = 'not-sent' WHERE id = _del;
  END IF;

  UPDATE public.carts SET status = 'converted' WHERE id = _cart;

  RETURN jsonb_build_object('delivery_order_id', _del, 'pos_order_id', _pos, 'order_number', _num, 'pin', _pin);
END; $function$;