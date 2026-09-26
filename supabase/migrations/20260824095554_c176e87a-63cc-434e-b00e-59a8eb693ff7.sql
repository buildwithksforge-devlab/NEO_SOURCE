-- 1. Fulfilment types now include room service
ALTER TABLE public.carts DROP CONSTRAINT IF EXISTS carts_fulfilment_chk;
ALTER TABLE public.carts ADD CONSTRAINT carts_fulfilment_chk
  CHECK (fulfilment_type = ANY (ARRAY['delivery'::text,'pickup'::text,'room-service'::text]));
ALTER TABLE public.delivery_orders DROP CONSTRAINT IF EXISTS delivery_orders_fulfilment_chk;
ALTER TABLE public.delivery_orders ADD CONSTRAINT delivery_orders_fulfilment_chk
  CHECK (fulfilment_type = ANY (ARRAY['delivery'::text,'pickup'::text,'room-service'::text]));

-- 2. Fulfilment-aware quoting (delivery/pickup behaviour unchanged)
CREATE OR REPLACE FUNCTION public.delivery_quote_cart(_cart uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  _c public.carts; _s public.delivery_settings; _z public.delivery_zones;
  _sub numeric := 0; _tax numeric := 0; _mods numeric := 0;
  _fee numeric := 0; _disc numeric := 0; _promo public.promotion_codes;
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
    _issues := _issues || 'Some items are unavailable for this fulfilment type and must be removed.';
  END IF;

  IF _c.fulfilment_type = 'room-service' THEN
    IF NOT EXISTS (
      SELECT 1 FROM public.reservations r
       WHERE r.customer_id = _c.customer_id
         AND r.organization_id = _c.organization_id
         AND r.status IN ('checked_in','in_house','checked-in')
    ) THEN
      _issues := _issues || 'Room service is available during an in-house stay only.';
    END IF;
  END IF;

  IF _c.fulfilment_type = 'delivery' THEN
    SELECT * INTO _z FROM public.delivery_zones WHERE id = _c.zone_id AND active;
    IF _z.id IS NULL THEN
      _issues := _issues || 'Select a delivery address inside a served zone.';
    ELSE
      _fee := _z.base_fee;
      IF _z.free_delivery_threshold IS NOT NULL AND _sub >= _z.free_delivery_threshold THEN _fee := 0; END IF;
      IF _sub < greatest(_z.min_order, coalesce(_s.min_order, 0)) THEN
        _issues := _issues || format('Minimum order for this zone is %s.', greatest(_z.min_order, coalesce(_s.min_order,0)));
      END IF;
      IF localtime NOT BETWEEN _z.service_start AND _z.service_end AND _c.scheduled_for IS NULL THEN
        _issues := _issues || 'This zone is outside its service hours right now — schedule the order instead.';
      END IF;
    END IF;
  ELSIF _c.fulfilment_type = 'pickup' AND coalesce(_s.pickup_enabled, true) = false THEN
    _issues := _issues || 'Pickup is not enabled for this branch.';
  END IF;

  IF _c.promo_code IS NOT NULL AND length(trim(_c.promo_code)) > 0 THEN
    SELECT * INTO _promo FROM public.promotion_codes
    WHERE organization_id = _c.organization_id AND upper(code) = upper(trim(_c.promo_code))
      AND active AND approval_status = 'approved';
    IF _promo.id IS NULL THEN
      _issues := _issues || 'Promo code is not valid.';
    ELSIF (_promo.starts_at IS NOT NULL AND now() < _promo.starts_at)
       OR (_promo.ends_at IS NOT NULL AND now() > _promo.ends_at) THEN
      _issues := _issues || 'Promo code is outside its validity period.';
    ELSIF _sub < _promo.min_order THEN
      _issues := _issues || 'Order value is below the promo minimum.';
    ELSE
      SELECT count(*) INTO _uses FROM public.promotion_redemptions
      WHERE promotion_id = _promo.id AND customer_id = _c.customer_id;
      IF _uses >= _promo.per_customer_limit THEN
        _issues := _issues || 'Promo usage limit reached for this customer.';
      ELSIF _promo.total_usage_limit IS NOT NULL AND _promo.usage_count >= _promo.total_usage_limit THEN
        _issues := _issues || 'Promo code is fully redeemed.';
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

  RETURN jsonb_build_object(
    'cart_id', _c.id,
    'branch_id', _c.branch_id,
    'fulfilment_type', _c.fulfilment_type,
    'lines', _lines,
    'subtotal', round(_sub, 2),
    'tax_total', round(_tax, 2),
    'discount_total', round(_disc, 2),
    'delivery_fee', round(_fee, 2),
    'tip_amount', round(coalesce(_c.tip_amount, 0), 2),
    'grand_total', round(greatest(_sub + _tax + _fee + coalesce(_c.tip_amount,0) - _disc, 0), 2),
    'promotion_id', _promo.id,
    'zone_id', _z.id,
    'eta_minutes', coalesce(_z.eta_minutes, 45),
    'issues', to_jsonb(_issues),
    'can_checkout', (cardinality(_issues) = 0 AND jsonb_array_length(_lines) > 0)
  );
END; $function$;

-- 3. Folio posting under the trusted system-posting context (guest room charge)
CREATE OR REPLACE FUNCTION public.folio_post_charge(_folio uuid, _category text, _description text, _quantity numeric, _unit_price numeric, _tax numeric DEFAULT 0, _service_charge numeric DEFAULT 0, _discount numeric DEFAULT 0, _source_module text DEFAULT 'manual'::text, _source_record uuid DEFAULT NULL::uuid, _revenue_centre text DEFAULT 'rooms'::text, _idempotency_key text DEFAULT NULL::text, _correlation uuid DEFAULT NULL::uuid)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE _org uuid := COALESCE(public.current_org_id(),
          CASE WHEN public.neo_system_posting()
            THEN (SELECT organization_id FROM public.folios WHERE id = _folio) END); _f public.folios; _gross numeric; _net numeric; _id uuid;
        _key text := COALESCE(
          _idempotency_key,
          CASE
            WHEN _source_record IS NOT NULL
              THEN _source_module || ':' || _source_record::text
            ELSE 'auto:' || _folio::text
                 || ':' || COALESCE(_category, '')
                 || ':' || md5(COALESCE(_description, ''))
                 || ':' || to_char(round(COALESCE(_quantity,1) * COALESCE(_unit_price,0), 2), 'FM9999999999990.00')
                 || ':' || to_char(date_trunc('minute', now() AT TIME ZONE 'UTC'), 'YYYYMMDDHH24MI')
          END);
BEGIN
  IF NOT (public.has_permission('pms','folios.post_charge') OR public.neo_system_posting()) THEN
    RAISE EXCEPTION 'Not permitted to post charges';
  END IF;
  SELECT * INTO _f FROM public.folios WHERE id=_folio AND organization_id=_org FOR UPDATE;
  IF _f.id IS NULL THEN RAISE EXCEPTION 'Folio not found'; END IF;
  IF _f.status <> 'open' THEN RAISE EXCEPTION 'Folio is % and cannot accept charges', _f.status; END IF;

  SELECT id INTO _id FROM public.folio_lines WHERE organization_id=_org AND idempotency_key=_key;
  IF _id IS NOT NULL THEN RETURN _id; END IF;

  IF _f.corporate_account_id IS NOT NULL THEN
    PERFORM public.corp_assert_credit(_f.corporate_account_id, _f.branch_id, _f.customer_id,
      round(COALESCE(_quantity,1)*COALESCE(_unit_price,0),2) + COALESCE(_tax,0) + COALESCE(_service_charge,0));
  END IF;

  _gross := round(COALESCE(_quantity,1) * COALESCE(_unit_price,0), 2);
  _net := _gross - COALESCE(_discount,0) + COALESCE(_tax,0) + COALESCE(_service_charge,0);

  INSERT INTO public.folio_lines (organization_id, branch_id, folio_id, reservation_id, customer_id, line_type,
    category, revenue_centre, reference, source_module, source_record_id, source_record_uuid, idempotency_key,
    description, quantity, unit_price, gross_amount, discount_amount, tax_amount, service_charge_amount,
    net_amount, posted_by, actor_id, correlation_id, status)
  VALUES (_org, _f.branch_id, _folio, _f.reservation_id, _f.customer_id, 'charge',
    _category, COALESCE(_revenue_centre,'rooms'), COALESCE(_source_record::text,''), _source_module,
    _source_record::text, _source_record, _key, _description, COALESCE(_quantity,1), COALESCE(_unit_price,0),
    _gross, COALESCE(_discount,0), COALESCE(_tax,0), COALESCE(_service_charge,0), _net,
    auth.uid(), auth.uid(), COALESCE(_correlation, gen_random_uuid()), 'posted')
  RETURNING id INTO _id;

  UPDATE public.folios SET
    total_charges = total_charges + _gross,
    total_discounts = total_discounts + COALESCE(_discount,0),
    total_taxes = total_taxes + COALESCE(_tax,0),
    balance = balance + _net, updated_at = now()
  WHERE id=_folio;

  INSERT INTO public.audit_logs (organization_id, user_id, user_name, action, module, record_id, new_value)
  VALUES (_org, auth.uid(), '', 'pms.folio.post_charge', 'finance', _folio::text,
    jsonb_build_object('line_id',_id,'category',_category,'amount',_net,'source',_source_module,'revenue_centre',_revenue_centre));
  RETURN _id;
END; $function$;

-- 4. Internal station routing used by trusted guest ordering (mirrors neo_pos_send_to_kitchen ticketing)
CREATE OR REPLACE FUNCTION public.neo_pos_route_tickets_internal(_order uuid, _org uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  _o public.pos_orders; _it record; _station uuid; _ticket uuid; _target int;
  _created int := 0; _reused int := 0; _tickets int := 0; _unassigned int := 0;
BEGIN
  SELECT * INTO _o FROM public.pos_orders WHERE id = _order AND organization_id = _org;
  IF _o.id IS NULL THEN RAISE EXCEPTION 'order_not_found' USING ERRCODE = 'P0002'; END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(_order::text, 42));

  FOR _it IN
    SELECT oi.* FROM public.pos_order_items oi
     WHERE oi.order_id = _order AND oi.organization_id = _org
       AND oi.held = false AND coalesce(oi.status,'draft') NOT IN ('cancelled','voided')
     ORDER BY oi.created_at
  LOOP
    IF EXISTS (SELECT 1 FROM public.station_ticket_items sti
                WHERE sti.order_item_id = _it.id AND sti.remake_of_id IS NULL) THEN
      _reused := _reused + 1; CONTINUE;
    END IF;

    _station := nullif(public.neo_kitchen_route_order_item(_it.id)->>'station_id','')::uuid;
    IF _station IS NULL THEN _unassigned := _unassigned + 1; END IF;
    IF _station IS DISTINCT FROM _it.station_id THEN
      UPDATE public.pos_order_items SET station_id = _station WHERE id = _it.id;
    END IF;

    SELECT COALESCE(
      (SELECT mi.prep_minutes FROM public.menu_items mi WHERE mi.id = _it.menu_item_id), 15)
      INTO _target;

    INSERT INTO public.station_tickets (
      organization_id, branch_id, department_id, order_id, station_id, ticket_number, course,
      priority, status, target_minutes, received_at, created_by, routing_note)
    VALUES (_org, _o.branch_id,
      (SELECT s.department_id FROM public.operational_stations s WHERE s.id = _station),
      _order, _station,
      'KT-' || upper(substr(replace(_order::text,'-',''),1,6)) || '-' ||
        upper(substr(md5(COALESCE(_station::text,'unassigned') || _it.course), 1, 4)),
      _it.course, COALESCE(_o.order_type,'room-service'), 'new', _target, now(), NULL,
      CASE WHEN _station IS NULL THEN 'unassigned-station' ELSE NULL END)
    ON CONFLICT (order_id, COALESCE(station_id, '00000000-0000-0000-0000-000000000000'::uuid), course)
      DO NOTHING;
    IF FOUND THEN _tickets := _tickets + 1; END IF;

    SELECT id INTO _ticket FROM public.station_tickets
      WHERE order_id = _order AND course = _it.course
        AND COALESCE(station_id,'00000000-0000-0000-0000-000000000000'::uuid)
            = COALESCE(_station,'00000000-0000-0000-0000-000000000000'::uuid);
    IF _ticket IS NULL THEN CONTINUE; END IF;

    BEGIN
      INSERT INTO public.station_ticket_items (organization_id, ticket_id, order_item_id, status)
      VALUES (_org, _ticket, _it.id, 'new');
      _created := _created + 1;
    EXCEPTION WHEN unique_violation THEN
      _reused := _reused + 1;
    END;

    UPDATE public.pos_order_items
       SET status = CASE WHEN status IN ('draft','new','held') THEN 'sent' ELSE status END,
           sent_at = COALESCE(sent_at, now())
     WHERE id = _it.id;
  END LOOP;

  UPDATE public.pos_orders
     SET status = 'sent', sent_at = COALESCE(sent_at, now())
   WHERE id = _order AND (status IS NULL OR status IN ('open','new','draft-sent','confirmed'));

  RETURN jsonb_build_object('ok', true, 'tickets_created', _tickets, 'items_created', _created,
                            'items_reused', _reused, 'unassigned_station', _unassigned);
END $function$;

-- 5. The signed-in guest's current stay (ownership resolved from auth.uid())
CREATE OR REPLACE FUNCTION public.neo_guest_active_stay(_org uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE _cust uuid := public.my_customer_id(); _r public.reservations; _f public.folios;
BEGIN
  IF _cust IS NULL THEN RETURN NULL; END IF;
  SELECT * INTO _r FROM public.reservations
   WHERE customer_id = _cust AND organization_id = _org
     AND status IN ('checked_in','in_house','checked-in')
   ORDER BY arrival_date DESC LIMIT 1;
  IF _r.id IS NULL THEN RETURN NULL; END IF;

  SELECT * INTO _f FROM public.folios
   WHERE reservation_id = _r.id AND customer_id = _cust AND status = 'open'
   ORDER BY created_at LIMIT 1;

  RETURN jsonb_build_object(
    'reservation_id', _r.id,
    'confirmation_number', _r.confirmation_number,
    'branch_id', _r.branch_id,
    'arrival_date', _r.arrival_date,
    'departure_date', _r.departure_date,
    'status', _r.status,
    'room_number', (SELECT rm.room_number FROM public.rooms rm WHERE rm.id = _r.room_id),
    'folio_id', _f.id,
    'folio_number', _f.folio_number,
    'folio_balance', _f.balance,
    'can_charge_to_room', (_f.id IS NOT NULL AND _f.status = 'open')
  );
END $function$;

-- 6. Guest room-service placement: canonical POS order + kitchen tickets + optional room charge
CREATE OR REPLACE FUNCTION public.neo_guest_place_room_service(_cart uuid, _payment_intent text DEFAULT 'room-charge')
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

  SELECT * INTO _c FROM public.carts WHERE id = _cart AND status = 'active';
  IF _c.id IS NULL OR _c.customer_id IS DISTINCT FROM public.my_customer_id() THEN
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
    delivery_fee, tip_amount, grand_total, payment_method, payment_status,
    estimated_prep_minutes, estimated_delivery_at, order_status, kitchen_status, notes)
  VALUES (
    _c.organization_id, coalesce(_c.branch_id, nullif(_stay->>'branch_id','')::uuid), _pos,
    _c.customer_id, auth.uid(), _num, 'room-service', _cust.full_name, _cust.phone,
    (_q->>'subtotal')::numeric, (_q->>'tax_total')::numeric, (_q->>'discount_total')::numeric,
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
      (_q->>'tax_total')::numeric, 0, 0,
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

-- 7. Guest-safe order tracking (own orders only; no private staff/rider fields)
CREATE OR REPLACE FUNCTION public.neo_guest_order_tracking(_org uuid, _reference text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE _cust uuid := public.my_customer_id(); _d public.delivery_orders; _rider public.rider_profiles;
BEGIN
  IF _cust IS NULL THEN RETURN NULL; END IF;
  SELECT * INTO _d FROM public.delivery_orders
   WHERE organization_id = _org AND order_number = _reference AND customer_id = _cust;
  IF _d.id IS NULL THEN RETURN NULL; END IF;

  IF _d.rider_id IS NOT NULL THEN
    SELECT * INTO _rider FROM public.rider_profiles WHERE id = _d.rider_id;
  END IF;

  RETURN jsonb_build_object(
    'id', _d.id,
    'order_number', _d.order_number,
    'fulfilment_type', _d.fulfilment_type,
    'order_status', _d.order_status,
    'kitchen_status', _d.kitchen_status,
    'dispatch_status', _d.dispatch_status,
    'payment_status', _d.payment_status,
    'payment_method', _d.payment_method,
    'grand_total', _d.grand_total,
    'currency', coalesce(_d.currency, 'KES'),
    'created_at', _d.created_at,
    'estimated_delivery_at', _d.estimated_delivery_at,
    'delivered_at', _d.delivered_at,
    'cancelled_at', _d.cancelled_at,
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

-- 8. Rider self-service view of their own record
CREATE OR REPLACE FUNCTION public.neo_rider_me()
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE _r public.rider_profiles;
BEGIN
  SELECT * INTO _r FROM public.rider_profiles WHERE profile_id = auth.uid() AND active LIMIT 1;
  IF _r.id IS NULL THEN RETURN NULL; END IF;
  RETURN jsonb_build_object(
    'rider_id', _r.id,
    'organization_id', _r.organization_id,
    'branch_id', _r.branch_id,
    'rider_code', _r.rider_code,
    'display_name', _r.display_name,
    'work_phone', _r.work_phone,
    'vehicle_type', _r.vehicle_type,
    'vehicle_registration', _r.vehicle_registration,
    'availability_status', _r.availability_status,
    'cash_handling_allowed', _r.cash_handling_allowed,
    'avatar_url', (SELECT p.avatar_url FROM public.profiles p WHERE p.id = _r.profile_id),
    'full_name', (SELECT p.full_name FROM public.profiles p WHERE p.id = _r.profile_id),
    'stats', jsonb_build_object(
      'assigned_open', (SELECT count(*) FROM public.delivery_orders d
                         WHERE d.rider_id = _r.id AND d.dispatch_status NOT IN ('delivered','delivery-failed','returned')),
      'delivered_total', (SELECT count(*) FROM public.delivery_orders d
                           WHERE d.rider_id = _r.id AND d.dispatch_status = 'delivered'),
      'delivered_30d', (SELECT count(*) FROM public.delivery_orders d
                         WHERE d.rider_id = _r.id AND d.dispatch_status = 'delivered'
                           AND d.delivered_at > now() - interval '30 days'))
  );
END $function$;

-- 9. Hospitality transport: property-configured products
CREATE TABLE IF NOT EXISTS public.transport_products (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  branch_id uuid REFERENCES public.branches(id) ON DELETE CASCADE,
  code text,
  name text NOT NULL,
  category text NOT NULL DEFAULT 'custom'
    CHECK (category = ANY (ARRAY['airport','train','bus','town','attraction','custom'])),
  description text,
  base_price numeric,
  currency text NOT NULL DEFAULT 'KES',
  max_passengers integer,
  active boolean NOT NULL DEFAULT true,
  display_order integer NOT NULL DEFAULT 0,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.transport_products TO authenticated;
GRANT ALL ON public.transport_products TO service_role;
ALTER TABLE public.transport_products ENABLE ROW LEVEL SECURITY;

CREATE POLICY transport_products_guest_read ON public.transport_products
  FOR SELECT TO authenticated
  USING (active AND organization_id = public.my_customer_org_id());
CREATE POLICY transport_products_staff_read ON public.transport_products
  FOR SELECT TO authenticated
  USING (organization_id = public.current_org_id() AND public.is_staff());
CREATE POLICY transport_products_manage ON public.transport_products
  FOR ALL TO authenticated
  USING (organization_id = public.current_org_id()
         AND (public.is_org_admin() OR public.has_permission('front-office','requests.manage')))
  WITH CHECK (organization_id = public.current_org_id()
         AND (public.is_org_admin() OR public.has_permission('front-office','requests.manage')));

-- 10. Hospitality transport: guest requests
CREATE TABLE IF NOT EXISTS public.transport_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  branch_id uuid REFERENCES public.branches(id) ON DELETE SET NULL,
  customer_id uuid REFERENCES public.customers(id) ON DELETE SET NULL,
  reservation_id uuid REFERENCES public.reservations(id) ON DELETE SET NULL,
  product_id uuid REFERENCES public.transport_products(id) ON DELETE SET NULL,
  request_number text NOT NULL,
  category text NOT NULL DEFAULT 'custom',
  pickup_at timestamptz NOT NULL,
  pickup_point text NOT NULL,
  destination text NOT NULL,
  passengers integer NOT NULL DEFAULT 1,
  luggage_count integer NOT NULL DEFAULT 0,
  travel_reference text,
  notes text,
  quoted_amount numeric,
  currency text NOT NULL DEFAULT 'KES',
  status text NOT NULL DEFAULT 'requested'
    CHECK (status = ANY (ARRAY['requested','quoted','confirmed','driver-assigned','arriving','picked-up','completed','cancelled','declined'])),
  assigned_rider_id uuid REFERENCES public.rider_profiles(id) ON DELETE SET NULL,
  assignment_note text,
  handled_by uuid,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS transport_requests_number_key
  ON public.transport_requests (organization_id, request_number);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.transport_requests TO authenticated;
GRANT ALL ON public.transport_requests TO service_role;
ALTER TABLE public.transport_requests ENABLE ROW LEVEL SECURITY;

CREATE POLICY transport_requests_guest_read ON public.transport_requests
  FOR SELECT TO authenticated
  USING (customer_id IS NOT NULL AND customer_id = public.my_customer_id());
CREATE POLICY transport_requests_staff_read ON public.transport_requests
  FOR SELECT TO authenticated
  USING (public.is_staff() AND public.in_my_branch_scope(organization_id, branch_id));
CREATE POLICY transport_requests_staff_write ON public.transport_requests
  FOR ALL TO authenticated
  USING (public.in_my_branch_scope(organization_id, branch_id)
         AND (public.is_org_admin() OR public.has_permission('front-office','requests.manage')))
  WITH CHECK (public.in_my_branch_scope(organization_id, branch_id)
         AND (public.is_org_admin() OR public.has_permission('front-office','requests.manage')));
CREATE POLICY transport_requests_rider_read ON public.transport_requests
  FOR SELECT TO authenticated
  USING (assigned_rider_id IS NOT NULL AND assigned_rider_id = public.my_rider_id());

CREATE TRIGGER transport_products_touch BEFORE UPDATE ON public.transport_products
  FOR EACH ROW EXECUTE FUNCTION public.neo_touch_updated_at();
CREATE TRIGGER transport_requests_touch BEFORE UPDATE ON public.transport_requests
  FOR EACH ROW EXECUTE FUNCTION public.neo_touch_updated_at();

-- 11. Guest raises a transport request (ownership resolved server-side; no invented fare)
CREATE OR REPLACE FUNCTION public.neo_guest_request_transport(
  _org uuid, _product uuid, _pickup_at timestamptz, _pickup_point text, _destination text,
  _passengers integer DEFAULT 1, _luggage integer DEFAULT 0,
  _travel_reference text DEFAULT NULL, _notes text DEFAULT NULL)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE _cust public.customers; _p public.transport_products; _res public.reservations;
        _num text; _id uuid; _branch uuid;
BEGIN
  SELECT * INTO _cust FROM public.customers WHERE id = public.my_customer_id() AND organization_id = _org;
  IF _cust.id IS NULL THEN RAISE EXCEPTION 'No guest account for this property'; END IF;
  IF _pickup_at IS NULL OR _pickup_at < now() - interval '1 hour' THEN
    RAISE EXCEPTION 'Choose a pickup time in the future';
  END IF;
  IF coalesce(btrim(_pickup_point),'') = '' OR coalesce(btrim(_destination),'') = '' THEN
    RAISE EXCEPTION 'Pickup point and destination are required';
  END IF;
  IF coalesce(_passengers,1) < 1 THEN RAISE EXCEPTION 'At least one passenger is required'; END IF;

  IF _product IS NOT NULL THEN
    SELECT * INTO _p FROM public.transport_products
     WHERE id = _product AND organization_id = _org AND active;
    IF _p.id IS NULL THEN RAISE EXCEPTION 'Transfer option is not available'; END IF;
    IF _p.max_passengers IS NOT NULL AND _passengers > _p.max_passengers THEN
      RAISE EXCEPTION 'That transfer seats up to % passenger(s)', _p.max_passengers;
    END IF;
  END IF;

  SELECT * INTO _res FROM public.reservations
   WHERE customer_id = _cust.id AND organization_id = _org
     AND status IN ('checked_in','in_house','checked-in','confirmed','guaranteed','tentative')
   ORDER BY arrival_date DESC LIMIT 1;

  _branch := coalesce(_p.branch_id, _res.branch_id, _cust.primary_branch_id);
  _num := 'TRF-' || to_char(now(),'YYYYMMDD') || '-' || upper(substr(md5(gen_random_uuid()::text),1,5));

  INSERT INTO public.transport_requests (
    organization_id, branch_id, customer_id, reservation_id, product_id, request_number,
    category, pickup_at, pickup_point, destination, passengers, luggage_count,
    travel_reference, notes, quoted_amount, currency, status, created_by)
  VALUES (_org, _branch, _cust.id, _res.id, _p.id, _num,
    coalesce(_p.category,'custom'), _pickup_at, btrim(_pickup_point), btrim(_destination),
    _passengers, coalesce(_luggage,0), nullif(btrim(coalesce(_travel_reference,'')),''),
    nullif(btrim(coalesce(_notes,'')),''), _p.base_price, coalesce(_p.currency,'KES'),
    CASE WHEN _p.base_price IS NULL THEN 'requested' ELSE 'quoted' END, auth.uid())
  RETURNING id INTO _id;

  RETURN jsonb_build_object('id', _id, 'request_number', _num,
                            'quoted_amount', _p.base_price,
                            'status', CASE WHEN _p.base_price IS NULL THEN 'requested' ELSE 'quoted' END);
END $function$;

-- 12. Operations move a transport request forward
CREATE OR REPLACE FUNCTION public.neo_transport_set_status(
  _request uuid, _status text, _rider uuid DEFAULT NULL,
  _amount numeric DEFAULT NULL, _note text DEFAULT NULL)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE _r public.transport_requests; _org uuid := public.current_org_id();
BEGIN
  IF _org IS NULL THEN RAISE EXCEPTION 'Not permitted'; END IF;
  SELECT * INTO _r FROM public.transport_requests WHERE id = _request AND organization_id = _org;
  IF _r.id IS NULL THEN RAISE EXCEPTION 'Transport request not found'; END IF;
  IF NOT (public.is_org_admin() OR public.has_permission('front-office','requests.manage')) THEN
    RAISE EXCEPTION 'Not permitted to manage transport requests';
  END IF;
  IF NOT public.in_my_branch_scope(_r.organization_id, _r.branch_id) THEN
    RAISE EXCEPTION 'Transport request is outside your property scope';
  END IF;
  IF _status NOT IN ('requested','quoted','confirmed','driver-assigned','arriving','picked-up','completed','cancelled','declined') THEN
    RAISE EXCEPTION 'Unsupported status';
  END IF;

  UPDATE public.transport_requests
     SET status = _status,
         assigned_rider_id = coalesce(_rider, assigned_rider_id),
         quoted_amount = coalesce(_amount, quoted_amount),
         assignment_note = coalesce(nullif(btrim(coalesce(_note,'')),''), assignment_note),
         handled_by = auth.uid(),
         updated_at = now()
   WHERE id = _request;

  INSERT INTO public.audit_logs (organization_id, user_id, user_name, action, module, record_id, previous_value, new_value)
  VALUES (_org, auth.uid(), '', 'transport.request.status', 'front-office', _request::text,
          jsonb_build_object('status', _r.status),
          jsonb_build_object('status', _status, 'rider', _rider, 'amount', _amount));

  RETURN jsonb_build_object('ok', true, 'status', _status);
END $function$;

-- 13. Execution rights: authenticated callers only; every routine resolves its own caller
REVOKE ALL ON FUNCTION public.neo_pos_route_tickets_internal(uuid, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.neo_guest_active_stay(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.neo_guest_place_room_service(uuid, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.neo_guest_order_tracking(uuid, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.neo_rider_me() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.neo_guest_request_transport(uuid, uuid, timestamptz, text, text, integer, integer, text, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.neo_transport_set_status(uuid, text, uuid, numeric, text) FROM PUBLIC, anon;

GRANT EXECUTE ON FUNCTION public.neo_guest_active_stay(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.neo_guest_place_room_service(uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.neo_guest_order_tracking(uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.neo_rider_me() TO authenticated;
GRANT EXECUTE ON FUNCTION public.neo_guest_request_transport(uuid, uuid, timestamptz, text, text, integer, integer, text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.neo_transport_set_status(uuid, text, uuid, numeric, text) TO authenticated;