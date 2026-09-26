
CREATE OR REPLACE FUNCTION public.neo_delivery_staff_place_order(
  _branch uuid,
  _contact_name text,
  _contact_phone text,
  _items jsonb,
  _fulfilment text DEFAULT 'delivery',
  _zone uuid DEFAULT NULL,
  _address jsonb DEFAULT '{}'::jsonb,
  _payment_method text DEFAULT 'cash',
  _notes text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _org uuid; _actor uuid := auth.uid(); _cust uuid; _addr uuid; _zrec public.delivery_zones;
  _s public.delivery_settings; _line jsonb; _mi public.menu_items;
  _sub numeric := 0; _tax numeric := 0; _fee numeric := 0; _qty numeric;
  _pos uuid; _del uuid; _num text; _pin text; _eta int;
  _pay_status text; _order_status text; _addr_snapshot jsonb := '{}'::jsonb;
BEGIN
  PERFORM public.neo_assert_capability('delivery','orders','create-assisted');

  SELECT b.organization_id INTO _org FROM public.branches b WHERE b.id = _branch;
  IF _org IS NULL OR _org <> public.current_org_id() THEN
    RAISE EXCEPTION 'Property not found in this workspace';
  END IF;
  IF coalesce(btrim(_contact_name), '') = '' OR coalesce(btrim(_contact_phone), '') = '' THEN
    RAISE EXCEPTION 'A customer name and phone number are required';
  END IF;
  IF _fulfilment NOT IN ('delivery','pickup') THEN
    RAISE EXCEPTION 'Choose delivery or pickup';
  END IF;
  IF jsonb_typeof(_items) <> 'array' OR jsonb_array_length(_items) = 0 THEN
    RAISE EXCEPTION 'Add at least one item to the order';
  END IF;

  _s := public.delivery_get_settings(_branch);
  IF _payment_method <> ALL (coalesce(_s.allowed_payment_methods, ARRAY['cash'])) THEN
    RAISE EXCEPTION 'Payment method not allowed for this property';
  END IF;

  -- Customer: reuse the workspace record for this phone number, otherwise create one.
  SELECT c.id INTO _cust FROM public.customers c
   WHERE c.organization_id = _org
     AND regexp_replace(coalesce(c.phone,''), '\D', '', 'g') = regexp_replace(_contact_phone, '\D', '', 'g')
     AND regexp_replace(coalesce(c.phone,''), '\D', '', 'g') <> ''
   ORDER BY c.created_at LIMIT 1;

  IF _cust IS NULL THEN
    INSERT INTO public.customers (organization_id, customer_number, full_name, phone, customer_type, source)
    VALUES (_org, public.next_document_number('customer'), btrim(_contact_name), btrim(_contact_phone), 'individual', 'staff-phone-order')
    RETURNING id INTO _cust;
  END IF;

  IF _fulfilment = 'delivery' THEN
    SELECT * INTO _zrec FROM public.delivery_zones WHERE id = _zone AND branch_id = _branch AND active;
    IF _zrec.id IS NULL THEN
      RAISE EXCEPTION 'Select a served delivery zone for this property';
    END IF;
    IF coalesce(btrim(_address->>'address_line'), '') = '' THEN
      RAISE EXCEPTION 'A delivery address is required';
    END IF;
    INSERT INTO public.customer_addresses (
      organization_id, customer_id, label, address_line, city, county, building, house_number,
      landmark, delivery_instructions, recipient_name, phone, zone_id, latitude, longitude, created_by
    ) VALUES (
      _org, _cust, coalesce(nullif(btrim(_address->>'label'),''), 'Phone order'),
      btrim(_address->>'address_line'), nullif(btrim(_address->>'city'),''), nullif(btrim(_address->>'county'),''),
      nullif(btrim(_address->>'building'),''), nullif(btrim(_address->>'house_number'),''),
      nullif(btrim(_address->>'landmark'),''), nullif(btrim(_address->>'delivery_instructions'),''),
      btrim(_contact_name), btrim(_contact_phone), _zrec.id,
      nullif(_address->>'latitude','')::numeric, nullif(_address->>'longitude','')::numeric, _actor
    ) RETURNING id INTO _addr;
    SELECT to_jsonb(a) - 'created_by' INTO _addr_snapshot FROM public.customer_addresses a WHERE a.id = _addr;
  END IF;

  _num := public.next_document_number('delivery_order');
  _pay_status := CASE WHEN _payment_method = 'cash' THEN 'unpaid' ELSE 'pending' END;
  _order_status := CASE WHEN _payment_method = 'cash' THEN 'confirmed' ELSE 'pending-payment' END;

  INSERT INTO public.pos_orders (
    organization_id, branch_id, order_number, order_type, order_source,
    customer_id, guest_count, guest_name, contact_phone, status, payment_status,
    subtotal, discount_total, tax_total, grand_total, currency, notes, created_by
  ) VALUES (
    _org, _branch, _num,
    CASE WHEN _fulfilment = 'pickup' THEN 'takeaway' ELSE 'delivery' END,
    'staff-assisted', _cust, 1, btrim(_contact_name), btrim(_contact_phone),
    'confirmed', _pay_status, 0, 0, 0, 0, 'KES', _notes, _actor
  ) RETURNING id INTO _pos;

  FOR _line IN SELECT * FROM jsonb_array_elements(_items) LOOP
    SELECT * INTO _mi FROM public.menu_items
     WHERE id = (_line->>'menu_item_id')::uuid AND organization_id = _org AND branch_id = _branch;
    IF _mi.id IS NULL THEN RAISE EXCEPTION 'Menu item not available at this property'; END IF;
    IF _mi.availability <> 'available' THEN
      RAISE EXCEPTION '% is not available right now', _mi.name;
    END IF;
    IF _fulfilment = 'delivery' AND NOT coalesce(_mi.available_delivery, false) THEN
      RAISE EXCEPTION '% is not offered for delivery', _mi.name;
    END IF;
    IF _fulfilment = 'pickup' AND NOT coalesce(_mi.available_takeaway, false) THEN
      RAISE EXCEPTION '% is not offered for pickup', _mi.name;
    END IF;
    _qty := coalesce((_line->>'quantity')::numeric, 0);
    IF _qty <= 0 THEN RAISE EXCEPTION 'Quantity must be more than zero'; END IF;

    _sub := _sub + round(_qty * _mi.base_price, 2);
    _tax := _tax + round(_qty * _mi.base_price * coalesce(_mi.tax_rate, 0) / 100, 2);

    INSERT INTO public.pos_order_items (
      organization_id, order_id, menu_item_id, station_id, item_name, quantity,
      unit_price, tax_rate, tax_amount, line_total, status, special_instructions, created_by
    ) VALUES (
      _org, _pos, _mi.id, _mi.station_id, _mi.name, _qty, _mi.base_price, coalesce(_mi.tax_rate, 0),
      round(_qty * _mi.base_price * coalesce(_mi.tax_rate, 0) / 100, 2),
      round(_qty * _mi.base_price, 2), 'draft', nullif(btrim(_line->>'special_instructions'),''), _actor
    );
  END LOOP;

  IF _fulfilment = 'delivery' THEN
    _fee := coalesce(_zrec.base_fee, 0);
    IF _zrec.free_delivery_threshold IS NOT NULL AND _sub >= _zrec.free_delivery_threshold THEN _fee := 0; END IF;
    IF _sub < greatest(coalesce(_zrec.min_order, 0), coalesce(_s.min_order, 0)) THEN
      RAISE EXCEPTION 'Minimum order for this zone is %', greatest(coalesce(_zrec.min_order,0), coalesce(_s.min_order,0));
    END IF;
    _eta := coalesce(_zrec.eta_minutes, 45) + coalesce(_s.prep_buffer_minutes, 0);
  ELSE
    _eta := coalesce(_s.prep_buffer_minutes, 20);
  END IF;

  IF _payment_method = 'cash' AND (_sub + _tax + _fee) > coalesce(_s.cod_limit, 0) THEN
    RAISE EXCEPTION 'Cash on delivery limit exceeded for this property';
  END IF;

  UPDATE public.pos_orders
     SET subtotal = _sub, tax_total = _tax, grand_total = _sub + _tax + _fee
   WHERE id = _pos;

  INSERT INTO public.delivery_orders (
    organization_id, branch_id, pos_order_id, customer_id, order_number,
    fulfilment_type, contact_name, contact_phone, address_snapshot, zone_id,
    subtotal, tax_total, discount_total, delivery_fee, grand_total,
    payment_method, payment_status, estimated_prep_minutes, estimated_delivery_at,
    order_status, notes, created_by
  ) VALUES (
    _org, _branch, _pos, _cust, _num, _fulfilment, btrim(_contact_name), btrim(_contact_phone),
    _addr_snapshot, _zrec.id, _sub, _tax, 0, _fee, _sub + _tax + _fee,
    _payment_method, _pay_status, _eta, now() + make_interval(mins => _eta),
    _order_status, _notes, _actor
  ) RETURNING id INTO _del;

  _pin := lpad((floor(random() * 10000))::int::text, 4, '0');
  INSERT INTO public.delivery_order_pins (organization_id, delivery_order_id, customer_id, pin)
  VALUES (_org, _del, _cust, _pin);

  INSERT INTO public.delivery_order_status_history (organization_id, delivery_order_id, status_kind, new_status, source, changed_by)
  VALUES (_org, _del, 'order', _order_status, 'staff', _actor);

  IF _order_status = 'confirmed' THEN
    PERFORM public.neo_pos_route_tickets_internal(_pos, _org);
    UPDATE public.pos_orders SET status = 'sent' WHERE id = _pos;
    UPDATE public.delivery_orders SET kitchen_status = 'new' WHERE id = _del;
  ELSE
    UPDATE public.delivery_orders SET kitchen_status = 'not-sent' WHERE id = _del;
  END IF;

  RETURN jsonb_build_object(
    'delivery_order_id', _del, 'pos_order_id', _pos, 'order_number', _num,
    'pin', _pin, 'customer_id', _cust, 'delivery_fee', _fee,
    'grand_total', _sub + _tax + _fee, 'eta_minutes', _eta, 'order_status', _order_status
  );
END;
$$;

REVOKE ALL ON FUNCTION public.neo_delivery_staff_place_order(uuid, text, text, jsonb, text, uuid, jsonb, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.neo_delivery_staff_place_order(uuid, text, text, jsonb, text, uuid, jsonb, text, text) TO authenticated;
