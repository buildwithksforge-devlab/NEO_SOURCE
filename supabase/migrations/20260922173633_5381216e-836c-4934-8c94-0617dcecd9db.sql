ALTER TABLE public.delivery_orders
  ADD COLUMN IF NOT EXISTS service_charge_total numeric(14,2) NOT NULL DEFAULT 0;

-- The one place the configured trading rule is read, so the basket quote, the
-- till order and the room bill can never disagree about it again.
CREATE OR REPLACE FUNCTION public.neo_service_charge_percent(_org uuid, _branch uuid)
RETURNS numeric
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  SELECT COALESCE((s.settings->>'serviceChargePercent')::numeric, 0)
  FROM public.pos_settings s
  WHERE s.organization_id = _org
    AND (s.branch_id = _branch OR s.branch_id IS NULL)
  ORDER BY (s.branch_id IS NULL)
  LIMIT 1;
$function$;

GRANT EXECUTE ON FUNCTION public.neo_service_charge_percent(uuid, uuid) TO authenticated, anon, service_role;

CREATE OR REPLACE FUNCTION public.delivery_quote_cart(_cart uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  _c public.carts; _s public.delivery_settings; _z public.delivery_zones;
  _sub numeric := 0; _tax numeric := 0; _mods numeric := 0;
  _fee numeric := 0; _disc numeric := 0; _svc numeric := 0; _promo public.promotion_codes;
  _issues text[] := '{}'; _lines jsonb := '[]'::jsonb; _uses int;
BEGIN
  SELECT * INTO _c FROM public.carts WHERE id = _cart;
  IF _c.id IS NULL OR _c.customer_id <> public.my_customer_id() THEN
    RAISE EXCEPTION 'Cart not found';
  END IF;
  _s := public.delivery_get_settings(_c.branch_id);

  SELECT
    coalesce(sum(ci.quantity * mi.base_price), 0),
    coalesce(sum(ci.quantity * mi.base_price * mi.tax_rate / 100), 0),
    coalesce(jsonb_agg(jsonb_build_object(
      'cart_item_id', ci.id, 'menu_item_id', mi.id, 'name', mi.name,
      'quantity', ci.quantity, 'unit_price', mi.base_price, 'tax_rate', mi.tax_rate,
      'station_id', mi.station_id, 'availability', mi.availability,
      'delivery_eligible', mi.available_delivery,
      'special_instructions', ci.special_instructions, 'allergy_note', ci.allergy_note
    ) ORDER BY ci.created_at), '[]'::jsonb)
  INTO _sub, _tax, _lines
  FROM public.cart_items ci JOIN public.menu_items mi ON mi.id = ci.menu_item_id
  WHERE ci.cart_id = _cart;

  SELECT coalesce(sum(cim.extra_charge * ci.quantity), 0) INTO _mods
  FROM public.cart_item_modifiers cim
  JOIN public.cart_items ci ON ci.id = cim.cart_item_id
  WHERE ci.cart_id = _cart;
  _sub := _sub + _mods;

  IF EXISTS (SELECT 1 FROM public.cart_items ci JOIN public.menu_items mi ON mi.id = ci.menu_item_id
             WHERE ci.cart_id = _cart
               AND (mi.availability <> 'available'
                 OR (_c.fulfilment_type = 'delivery' AND NOT mi.available_delivery)
                 OR (_c.fulfilment_type = 'pickup' AND NOT coalesce(mi.available_takeaway, false))
                 OR (_c.fulfilment_type = 'room-service' AND NOT coalesce(mi.available_room_service, false)))) THEN
    _issues := _issues || array['Some items are unavailable for this fulfilment type and must be removed.'];
  END IF;

  IF _c.fulfilment_type = 'room-service' THEN
    IF NOT EXISTS (
      SELECT 1 FROM public.reservations r
       WHERE r.customer_id = _c.customer_id
         AND r.organization_id = _c.organization_id
         AND r.status IN ('checked_in','in_house','checked-in')
    ) THEN
      _issues := _issues || array['Room service is available during an in-house stay only.'];
    END IF;
  END IF;

  IF _c.fulfilment_type = 'delivery' THEN
    SELECT * INTO _z FROM public.delivery_zones WHERE id = _c.zone_id AND active;
    IF _z.id IS NULL THEN
      _issues := _issues || array['Select a delivery address inside a served zone.'];
    ELSE
      _fee := _z.base_fee;
      IF _z.free_delivery_threshold IS NOT NULL AND _sub >= _z.free_delivery_threshold THEN _fee := 0; END IF;
      IF _sub < greatest(_z.min_order, coalesce(_s.min_order, 0)) THEN
        _issues := _issues || array[format('Minimum order for this zone is %s.', greatest(_z.min_order, coalesce(_s.min_order,0)))];
      END IF;
      IF localtime NOT BETWEEN _z.service_start AND _z.service_end AND _c.scheduled_for IS NULL THEN
        _issues := _issues || array['This zone is outside its service hours right now — schedule the order instead.'];
      END IF;
    END IF;
  ELSIF _c.fulfilment_type = 'pickup' AND coalesce(_s.pickup_enabled, true) = false THEN
    _issues := _issues || array['Pickup is not enabled for this branch.'];
  END IF;

  IF _c.promo_code IS NOT NULL AND length(trim(_c.promo_code)) > 0 THEN
    SELECT * INTO _promo FROM public.promotion_codes
    WHERE organization_id = _c.organization_id AND upper(code) = upper(trim(_c.promo_code))
      AND active AND approval_status = 'approved';
    IF _promo.id IS NULL THEN
      _issues := _issues || array['Promo code is not valid.'];
    ELSIF (_promo.starts_at IS NOT NULL AND now() < _promo.starts_at)
       OR (_promo.ends_at IS NOT NULL AND now() > _promo.ends_at) THEN
      _issues := _issues || array['Promo code is outside its validity period.'];
    ELSIF _sub < _promo.min_order THEN
      _issues := _issues || array['Order value is below the promo minimum.'];
    ELSE
      SELECT count(*) INTO _uses FROM public.promotion_redemptions
      WHERE promotion_id = _promo.id AND customer_id = _c.customer_id;
      IF _uses >= _promo.per_customer_limit THEN
        _issues := _issues || array['Promo usage limit reached for this customer.'];
      ELSIF _promo.total_usage_limit IS NOT NULL AND _promo.usage_count >= _promo.total_usage_limit THEN
        _issues := _issues || array['Promo code is fully redeemed.'];
      ELSE
        IF _promo.discount_type = 'percentage' THEN _disc := _sub * _promo.discount_value / 100;
        ELSIF _promo.discount_type = 'fixed' THEN _disc := _promo.discount_value;
        END IF;
        IF _promo.max_discount IS NOT NULL THEN _disc := least(_disc, _promo.max_discount); END IF;
        IF _promo.free_delivery OR _promo.discount_type = 'free-delivery' THEN _fee := 0; END IF;
        _disc := least(_disc, _sub);
      END IF;
    END IF;
  END IF;

  -- The property's configured service charge, on the discounted value, exactly
  -- as the restaurant till computes it.
  _svc := round(greatest(_sub - _disc, 0)
                * coalesce(public.neo_service_charge_percent(_c.organization_id, _c.branch_id), 0) / 100.0, 2);

  RETURN jsonb_build_object(
    'cart_id', _c.id,
    'branch_id', _c.branch_id,
    'fulfilment_type', _c.fulfilment_type,
    'lines', _lines,
    'subtotal', round(_sub, 2),
    'tax_total', round(_tax, 2),
    'discount_total', round(_disc, 2),
    'service_charge', _svc,
    'delivery_fee', round(_fee, 2),
    'tip_amount', round(coalesce(_c.tip_amount, 0), 2),
    'grand_total', round(greatest(_sub + _tax + _svc + _fee + coalesce(_c.tip_amount,0) - _disc, 0), 2),
    'promotion_id', _promo.id,
    'zone_id', _z.id,
    'eta_minutes', coalesce(_z.eta_minutes, 45),
    'issues', to_jsonb(_issues),
    'can_checkout', (cardinality(_issues) = 0 AND jsonb_array_length(_lines) > 0)
  );
END; $function$;

CREATE OR REPLACE FUNCTION public.neo_guest_place_room_service(_cart uuid, _payment_intent text DEFAULT 'room-charge'::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  _c public.carts; _q jsonb; _cust public.customers; _stay jsonb;
  _pos uuid; _del uuid; _num text; _line jsonb; _item uuid; _folio uuid; _line_id uuid;
BEGIN
  IF _payment_intent NOT IN ('room-charge','pay-at-property') THEN
    RAISE EXCEPTION 'Unsupported payment option';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(_cart::text, 77));

  SELECT * INTO _c FROM public.carts WHERE id = _cart AND status = 'active';
  IF _c.id IS NULL OR _c.customer_id IS DISTINCT FROM public.my_customer_id() THEN
    SELECT jsonb_build_object('delivery_order_id', d.id, 'pos_order_id', d.pos_order_id,
                              'order_number', d.order_number, 'folio_line_id', NULL,
                              'charged_to_room', d.payment_method = 'room-charge',
                              'duplicate_suppressed', true)
      INTO _q
      FROM public.delivery_orders d
      JOIN public.carts c2 ON c2.id = _cart AND c2.customer_id = public.my_customer_id()
     WHERE d.customer_id = c2.customer_id AND d.fulfilment_type = 'room-service'
     ORDER BY d.created_at DESC LIMIT 1;
    IF _q IS NOT NULL THEN RETURN _q; END IF;
    RAISE EXCEPTION 'Cart not found';
  END IF;
  IF _c.fulfilment_type <> 'room-service' THEN RAISE EXCEPTION 'Cart is not a room-service order'; END IF;

  _q := public.delivery_quote_cart(_cart);
  IF NOT (_q->>'can_checkout')::boolean THEN
    RAISE EXCEPTION 'Order cannot be placed: %', _q->>'issues';
  END IF;

  _stay := public.neo_guest_active_stay(_c.organization_id);
  IF _stay IS NULL THEN RAISE EXCEPTION 'Room service is available during an in-house stay only'; END IF;
  _folio := nullif(_stay->>'folio_id','')::uuid;
  IF _payment_intent = 'room-charge' AND _folio IS NULL THEN
    RAISE EXCEPTION 'No open room bill is available — please choose to settle at the property';
  END IF;

  SELECT * INTO _cust FROM public.customers WHERE id = _c.customer_id;
  _num := public.next_document_number('delivery_order');

  INSERT INTO public.pos_orders (
    organization_id, branch_id, order_number, order_type, order_source, customer_id,
    stay_id, room_id, folio_id, guest_count, guest_name, contact_phone, status, payment_status,
    subtotal, discount_total, tax_total, grand_total, currency, notes)
  VALUES (
    _c.organization_id, coalesce(_c.branch_id, nullif(_stay->>'branch_id','')::uuid), _num,
    'room-service', 'guest-app', _c.customer_id,
    NULL, (SELECT r.room_id FROM public.reservations r WHERE r.id = (_stay->>'reservation_id')::uuid),
    CASE WHEN _payment_intent = 'room-charge' THEN _folio ELSE NULL END,
    1, _cust.full_name, _cust.phone, 'confirmed',
    CASE WHEN _payment_intent = 'room-charge' THEN 'credit' ELSE 'unpaid' END,
    (_q->>'subtotal')::numeric, (_q->>'discount_total')::numeric, (_q->>'tax_total')::numeric,
    (_q->>'grand_total')::numeric, 'KES', _c.notes)
  RETURNING id INTO _pos;

  FOR _line IN SELECT * FROM jsonb_array_elements(_q->'lines') LOOP
    INSERT INTO public.pos_order_items (
      organization_id, order_id, menu_item_id, station_id, item_name, quantity,
      unit_price, tax_rate, tax_amount, line_total, status, special_instructions, allergy_note)
    VALUES (
      _c.organization_id, _pos, (_line->>'menu_item_id')::uuid, nullif(_line->>'station_id','')::uuid,
      _line->>'name', (_line->>'quantity')::numeric, (_line->>'unit_price')::numeric,
      (_line->>'tax_rate')::numeric,
      round((_line->>'quantity')::numeric * (_line->>'unit_price')::numeric * (_line->>'tax_rate')::numeric / 100, 2),
      round((_line->>'quantity')::numeric * (_line->>'unit_price')::numeric, 2),
      'draft', _line->>'special_instructions', _line->>'allergy_note')
    RETURNING id INTO _item;

    INSERT INTO public.pos_order_item_modifiers (organization_id, order_item_id, group_id, option_id, group_name, option_name, extra_charge)
    SELECT _c.organization_id, _item, cim.group_id, cim.option_id, cim.group_name, cim.option_name, cim.extra_charge
    FROM public.cart_item_modifiers cim
    WHERE cim.cart_item_id = (_line->>'cart_item_id')::uuid;
  END LOOP;

  INSERT INTO public.delivery_orders (
    organization_id, branch_id, pos_order_id, customer_id, auth_user_id, order_number,
    fulfilment_type, contact_name, contact_phone, subtotal, tax_total, discount_total,
    service_charge_total, delivery_fee, tip_amount, grand_total, payment_method, payment_status,
    estimated_prep_minutes, estimated_delivery_at, order_status, kitchen_status, notes)
  VALUES (
    _c.organization_id, coalesce(_c.branch_id, nullif(_stay->>'branch_id','')::uuid), _pos,
    _c.customer_id, auth.uid(), _num, 'room-service', _cust.full_name, _cust.phone,
    (_q->>'subtotal')::numeric, (_q->>'tax_total')::numeric, (_q->>'discount_total')::numeric,
    coalesce((_q->>'service_charge')::numeric, 0),
    0, (_q->>'tip_amount')::numeric, (_q->>'grand_total')::numeric,
    CASE WHEN _payment_intent = 'room-charge' THEN 'room-charge' ELSE 'cash' END,
    CASE WHEN _payment_intent = 'room-charge' THEN 'charged' ELSE 'unpaid' END,
    coalesce((_q->>'eta_minutes')::int, 30),
    now() + make_interval(mins => coalesce((_q->>'eta_minutes')::int, 30)),
    'confirmed', 'not-sent', _c.notes)
  RETURNING id INTO _del;

  PERFORM public.neo_pos_route_tickets_internal(_pos, _c.organization_id);
  UPDATE public.delivery_orders SET kitchen_status = 'new' WHERE id = _del;

  IF _payment_intent = 'room-charge' THEN
    PERFORM set_config('neo.system_posting', 'on', true);
    _line_id := public.folio_post_charge(
      _folio, 'restaurant',
      'Room service order ' || _num,
      1, (_q->>'subtotal')::numeric - (_q->>'discount_total')::numeric,
      (_q->>'tax_total')::numeric, coalesce((_q->>'service_charge')::numeric, 0), 0,
      'pos_order', _pos, 'restaurant', 'guest_room_service:' || _pos::text, NULL);
    PERFORM set_config('neo.system_posting', 'off', true);
    UPDATE public.pos_orders SET folio_post_status = 'posted', status = 'sent' WHERE id = _pos;
  END IF;

  INSERT INTO public.delivery_order_status_history (organization_id, delivery_order_id, status_kind, new_status, source)
  VALUES (_c.organization_id, _del, 'order', 'confirmed', 'customer');

  UPDATE public.carts SET status = 'converted' WHERE id = _cart;

  RETURN jsonb_build_object('delivery_order_id', _del, 'pos_order_id', _pos,
                            'order_number', _num, 'folio_line_id', _line_id,
                            'charged_to_room', (_payment_intent = 'room-charge'));
END $function$;

CREATE OR REPLACE FUNCTION public.delivery_place_order(_cart uuid, _payment_method text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  _c public.carts; _q jsonb; _s public.delivery_settings; _addr public.customer_addresses;
  _pos uuid; _del uuid; _num text; _line jsonb; _item uuid; _cust public.customers;
  _pin text; _pay_status text; _actor uuid; _order_status text; _collect boolean;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended(_cart::text, 77));

  SELECT * INTO _c FROM public.carts WHERE id = _cart AND status = 'active';
  IF _c.id IS NULL OR _c.customer_id <> public.my_customer_id() THEN
    -- Already converted by an earlier submission: return that order rather
    -- than creating a second one for the same basket.
    SELECT jsonb_build_object('delivery_order_id', d.id, 'pos_order_id', d.pos_order_id,
                              'order_number', d.order_number, 'pin', NULL,
                              'duplicate_suppressed', true)
      INTO _q
      FROM public.delivery_orders d
      JOIN public.carts c2 ON c2.id = _cart AND c2.customer_id = public.my_customer_id()
     WHERE d.customer_id = c2.customer_id
     ORDER BY d.created_at DESC LIMIT 1;
    IF _q IS NOT NULL THEN RETURN _q; END IF;
    RAISE EXCEPTION 'Cart not found';
  END IF;
  _q := public.delivery_quote_cart(_cart);
  IF NOT (_q->>'can_checkout')::boolean THEN RAISE EXCEPTION 'Cart cannot be checked out: %', _q->>'issues'; END IF;

  _s := public.delivery_get_settings(_c.branch_id);

  _collect := _c.fulfilment_type = 'pickup' AND _payment_method = 'pay-on-collection';

  IF NOT _collect THEN
    IF _payment_method <> ALL (coalesce(_s.allowed_payment_methods, ARRAY['cash'])) THEN
      RAISE EXCEPTION 'Payment method not allowed';
    END IF;
    IF _payment_method = 'cash' AND (_q->>'grand_total')::numeric > coalesce(_s.cod_limit, 0) THEN
      RAISE EXCEPTION 'Cash on delivery limit exceeded';
    END IF;
  END IF;

  SELECT p.id INTO _actor FROM public.profiles p WHERE p.id = auth.uid();

  SELECT * INTO _cust FROM public.customers WHERE id = _c.customer_id;
  SELECT * INTO _addr FROM public.customer_addresses WHERE id = _c.address_id;
  _num := public.next_document_number('delivery_order');
  _pay_status := CASE WHEN _payment_method IN ('cash', 'pay-on-collection') THEN 'unpaid' ELSE 'pending' END;
  _order_status := CASE WHEN _payment_method IN ('cash', 'pay-on-collection') THEN 'confirmed' ELSE 'pending-payment' END;

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
    subtotal, tax_total, discount_total, service_charge_total, delivery_fee, tip_amount, grand_total,
    payment_method, payment_status, promo_code, promotion_id, scheduled_for,
    estimated_prep_minutes, estimated_delivery_at, order_status, notes, created_by
  ) VALUES (
    _c.organization_id, _c.branch_id, _pos, _c.customer_id, auth.uid(), _num,
    _c.fulfilment_type, coalesce(_addr.recipient_name, _cust.full_name), coalesce(_addr.phone, _cust.phone),
    CASE WHEN _addr.id IS NULL THEN '{}'::jsonb ELSE to_jsonb(_addr) - 'created_by' END,
    (_q->>'zone_id')::uuid, _addr.latitude, _addr.longitude,
    (_q->>'subtotal')::numeric, (_q->>'tax_total')::numeric, (_q->>'discount_total')::numeric,
    coalesce((_q->>'service_charge')::numeric, 0),
    (_q->>'delivery_fee')::numeric, (_q->>'tip_amount')::numeric, (_q->>'grand_total')::numeric,
    _payment_method, _pay_status, _c.promo_code, (_q->>'promotion_id')::uuid, _c.scheduled_for,
    coalesce((_q->>'eta_minutes')::int, 45),
    now() + make_interval(mins => coalesce((_q->>'eta_minutes')::int, 45)),
    _order_status,
    _c.notes, _actor
  ) RETURNING id INTO _del;

  SELECT nullif(p.pin_secret, '') INTO _pin
    FROM public.delivery_order_pins p WHERE p.delivery_order_id = _del;

  IF (_q->>'promotion_id') IS NOT NULL THEN
    INSERT INTO public.promotion_redemptions (organization_id, promotion_id, customer_id, delivery_order_id, discount_amount)
    VALUES (_c.organization_id, (_q->>'promotion_id')::uuid, _c.customer_id, _del, (_q->>'discount_total')::numeric)
    ON CONFLICT DO NOTHING;
    UPDATE public.promotion_codes SET usage_count = usage_count + 1 WHERE id = (_q->>'promotion_id')::uuid;
  END IF;

  INSERT INTO public.delivery_order_status_history (organization_id, delivery_order_id, status_kind, new_status, source, changed_by)
  VALUES (_c.organization_id, _del, 'order', _order_status, 'customer', _actor);

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