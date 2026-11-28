-- Property-scoped guest operations. Existing signatures remain for existing clients.
BEGIN;

CREATE OR REPLACE FUNCTION public.neo_guest_active_stay(_org uuid, _branch uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE _cust uuid; _r public.reservations; _f public.folios;
BEGIN
  IF auth.uid() IS NULL THEN RETURN NULL; END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.branches b
    WHERE b.id = _branch AND b.organization_id = _org AND b.active IS TRUE
  ) THEN
    RAISE EXCEPTION 'Select an active property in this organisation' USING ERRCODE = '42501';
  END IF;
  SELECT id INTO _cust FROM public.customers
   WHERE auth_user_id = auth.uid() AND organization_id = _org AND merged_into_id IS NULL LIMIT 1;
  IF _cust IS NULL THEN RETURN NULL; END IF;
  SELECT * INTO _r FROM public.reservations
   WHERE customer_id = _cust AND organization_id = _org AND branch_id = _branch
     AND status IN ('checked_in','in_house','checked-in','in-house')
   ORDER BY arrival_date DESC, id LIMIT 1;
  IF _r.id IS NULL THEN RETURN NULL; END IF;

  SELECT * INTO _f FROM public.folios
   WHERE reservation_id = _r.id AND customer_id = _cust AND organization_id = _org
     AND branch_id = _branch AND status = 'open'
   ORDER BY created_at, id LIMIT 1;

  RETURN jsonb_build_object(
    'reservation_id', _r.id,
    'confirmation_number', _r.confirmation_number,
    'branch_id', _r.branch_id,
    'arrival_date', _r.arrival_date,
    'departure_date', _r.departure_date,
    'status', _r.status,
    'room_number', (SELECT rm.room_number FROM public.rooms rm WHERE rm.id = _r.room_id AND rm.organization_id = _org AND rm.branch_id = _branch),
    'folio_id', _f.id,
    'folio_number', _f.folio_number,
    'folio_balance', _f.balance,
    'can_charge_to_room', (_f.id IS NOT NULL AND _f.status = 'open')
  );
END $function$;

CREATE OR REPLACE FUNCTION public.neo_guest_place_room_service(_cart uuid, _payment_intent text DEFAULT 'room-charge'::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  _c public.carts; _q jsonb; _cust public.customers; _stay jsonb;
  _pos uuid; _del uuid; _num text; _line jsonb; _item uuid; _folio uuid; _line_id uuid; _tip_line uuid;
BEGIN
  IF _payment_intent IS NULL OR _payment_intent NOT IN ('room-charge','pay-at-property') THEN
    RAISE EXCEPTION 'Unsupported payment option';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(_cart::text, 77));

  SELECT * INTO _c FROM public.carts WHERE id = _cart AND status = 'active' FOR UPDATE;
  IF _c.id IS NULL OR NOT EXISTS(SELECT 1 FROM public.customers owner WHERE owner.id=_c.customer_id AND owner.organization_id=_c.organization_id AND owner.auth_user_id=auth.uid() AND owner.merged_into_id IS NULL) THEN
    SELECT jsonb_build_object('delivery_order_id', d.id, 'pos_order_id', d.pos_order_id,
                              'order_number', d.order_number, 'folio_line_id', NULL,
                              'charged_to_room', d.payment_method = 'room-charge',
                              'duplicate_suppressed', true)
      INTO _q
      FROM public.delivery_orders d
      JOIN public.carts c2 ON c2.id = _cart JOIN public.customers owner ON owner.id=c2.customer_id AND owner.organization_id=c2.organization_id AND owner.auth_user_id=auth.uid() AND owner.merged_into_id IS NULL
     WHERE d.customer_id = c2.customer_id AND d.organization_id=c2.organization_id AND d.source_cart_id=c2.id AND d.fulfilment_type = 'room-service'
     ORDER BY d.created_at DESC LIMIT 1;
    IF _q IS NOT NULL THEN RETURN _q; END IF;
    RAISE EXCEPTION 'Cart is unavailable or has no exact saved order link. Review existing orders before retrying.';
  END IF;
  IF _c.fulfilment_type <> 'room-service' THEN RAISE EXCEPTION 'Cart is not a room-service order'; END IF;

  PERFORM public.neo_guest_lock_cart_pricing(_cart);
  _q := public.delivery_quote_cart(_cart);
  IF NOT (_q->>'can_checkout')::boolean THEN
    RAISE EXCEPTION 'Order cannot be placed: %', _q->>'issues';
  END IF;

  IF _c.branch_id IS NULL THEN RAISE EXCEPTION 'Select a property before placing room service'; END IF;
  _stay := public.neo_guest_active_stay(_c.organization_id, _c.branch_id);
  IF _stay IS NULL THEN RAISE EXCEPTION 'Room service is available during an in-house stay only'; END IF;
  _folio := nullif(_stay->>'folio_id','')::uuid;
  IF _payment_intent = 'room-charge' THEN
    PERFORM 1 FROM public.folios f
    WHERE f.id = _folio AND f.organization_id = _c.organization_id AND f.branch_id = _c.branch_id
      AND f.customer_id = _c.customer_id AND f.reservation_id = (_stay->>'reservation_id')::uuid
      AND f.currency IS NOT DISTINCT FROM (_q->>'currency') AND f.status = 'open'
    FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'No matching open room bill is available at this property'; END IF;
  END IF;

  SELECT * INTO _cust FROM public.customers WHERE id = _c.customer_id;
  _num := public.next_document_number('delivery_order', NULL, NULL, _c.organization_id);

  INSERT INTO public.pos_orders (
    organization_id, branch_id, order_number, order_type, order_source, customer_id,
    stay_id, room_id, folio_id, guest_count, guest_name, contact_phone, status, payment_status,
    subtotal, discount_total, tax_total, grand_total, currency, notes)
  VALUES (
    _c.organization_id, _c.branch_id, _num,
    'room-service', 'guest-app', _c.customer_id,
    NULL, (SELECT r.room_id FROM public.reservations r WHERE r.id = (_stay->>'reservation_id')::uuid AND r.organization_id = _c.organization_id AND r.branch_id = _c.branch_id),
    CASE WHEN _payment_intent = 'room-charge' THEN _folio ELSE NULL END,
    1, _cust.full_name, _cust.phone, 'confirmed',
    CASE WHEN _payment_intent = 'room-charge' THEN 'credit' ELSE 'unpaid' END,
    (_q->>'subtotal')::numeric, (_q->>'discount_total')::numeric, (_q->>'tax_total')::numeric,
    (_q->>'grand_total')::numeric, _q->>'currency', _c.notes)
  RETURNING id INTO _pos;

  FOR _line IN SELECT * FROM jsonb_array_elements(_q->'lines') LOOP
    INSERT INTO public.pos_order_items (
      organization_id, order_id, menu_item_id, station_id, item_name, quantity,
      selection_modifiers, unit_price, tax_rate, tax_amount, line_total, status, special_instructions, allergy_note)
    VALUES (
      _c.organization_id, _pos, (_line->>'menu_item_id')::uuid, nullif(_line->>'station_id','')::uuid,
      _line->>'name', (_line->>'quantity')::numeric, _line->'selection_modifiers', (_line->>'unit_price')::numeric,
      (_line->>'tax_rate')::numeric,
      round((_line->>'quantity')::numeric * (_line->>'unit_price')::numeric * (_line->>'tax_rate')::numeric / nullif(100 + (_line->>'tax_rate')::numeric, 0), 2),
      round((_line->>'quantity')::numeric * (_line->>'unit_price')::numeric, 2),
      'draft', _line->>'special_instructions', _line->>'allergy_note')
    RETURNING id INTO _item;

  END LOOP;

  INSERT INTO public.delivery_orders (
    source_cart_id, currency, organization_id, branch_id, pos_order_id, customer_id, auth_user_id, order_number,
    fulfilment_type, contact_name, contact_phone, subtotal, tax_total, discount_total,
    service_charge_total, delivery_fee, tip_amount, grand_total, payment_method, payment_status,
    estimated_prep_minutes, estimated_delivery_at, order_status, kitchen_status, notes)
  VALUES (
    _cart, _q->>'currency', _c.organization_id, _c.branch_id, _pos,
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

  UPDATE public.pos_orders SET discount_total=(_q->>'discount_total')::numeric, updated_at=now() WHERE id=_pos;
  IF NOT EXISTS(SELECT 1 FROM public.pos_orders p WHERE p.id=_pos AND p.organization_id=_c.organization_id
      AND p.currency=_q->>'currency' AND p.subtotal=(_q->>'subtotal')::numeric
      AND p.tax_total=(_q->>'tax_total')::numeric AND p.discount_total=(_q->>'discount_total')::numeric
      AND p.service_charge_total=(_q->>'service_charge')::numeric AND p.grand_total=(_q->>'grand_total')::numeric) THEN
    RAISE EXCEPTION 'Saved order amounts differ from the quote; checkout rolled back before collection';
  END IF;

  PERFORM public.neo_pos_route_tickets_internal(_pos, _c.organization_id);
  UPDATE public.delivery_orders SET kitchen_status = 'new' WHERE id = _del;

  IF _payment_intent = 'room-charge' THEN
    PERFORM set_config('neo.system_posting', 'on', true);
    _line_id := public.folio_post_charge(
      _folio, 'restaurant',
      'Room service order ' || _num,
      1, (_q->>'subtotal')::numeric - (_q->>'discount_total')::numeric - (_q->>'tax_total')::numeric,
      (_q->>'tax_total')::numeric, coalesce((_q->>'service_charge')::numeric, 0), 0,
      'pos_order', _pos, 'restaurant', 'guest_room_service:' || _pos::text, NULL);
    IF (_q->>'tip_amount')::numeric>0 THEN
      _tip_line:=public.folio_post_charge(_folio,'gratuity','Staff tip for room service '||_num,
        1,(_q->>'tip_amount')::numeric,0,0,0,'pos_order',_pos,'restaurant','guest_room_service_tip:'||_pos::text,NULL);
    END IF;
    IF NOT EXISTS(SELECT 1 FROM public.folio_lines fl WHERE fl.id=_line_id AND fl.folio_id=_folio
      AND fl.organization_id=_c.organization_id AND fl.branch_id=_c.branch_id AND fl.net_amount=(_q->>'grand_total')::numeric-(_q->>'tip_amount')::numeric)
      OR ((_q->>'tip_amount')::numeric>0 AND NOT EXISTS(SELECT 1 FROM public.folio_lines fl WHERE fl.id=_tip_line
        AND fl.folio_id=_folio AND fl.organization_id=_c.organization_id AND fl.branch_id=_c.branch_id AND fl.net_amount=(_q->>'tip_amount')::numeric)) THEN
      RAISE EXCEPTION 'Saved room charge does not agree with the order; checkout rolled back';
    END IF;
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

CREATE OR REPLACE FUNCTION public.neo_guest_create_request(
  _org uuid, _branch uuid, _category text, _description text, _priority text
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  uid uuid := auth.uid();
  c public.customers;
  res record;
  new_id uuid;
BEGIN
  IF uid IS NULL THEN RAISE EXCEPTION 'Authentication required'; END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.branches b
    WHERE b.id = _branch AND b.organization_id = _org AND b.active IS TRUE
  ) THEN
    RAISE EXCEPTION 'Select an active property in this organisation' USING ERRCODE = '42501';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.neo_public_experience e
    WHERE e.branch_id = _branch AND e.organization_id = _org AND e.discoverable
      AND coalesce((e.doors->>'stay_dine')::boolean, true)
  ) THEN
    RAISE EXCEPTION 'Guest services are unavailable at this property' USING ERRCODE = '42501';
  END IF;
  IF _description IS NULL OR btrim(_description) = '' THEN
    RAISE EXCEPTION 'Describe what you need so the team can act on it';
  END IF;
  IF _category NOT IN ('housekeeping','maintenance','concierge','amenities','laundry','food-beverage','front-office','transport') THEN
    RAISE EXCEPTION 'Unsupported request category';
  END IF;

  SELECT * INTO c FROM public.customers
   WHERE organization_id = _org AND auth_user_id = uid AND merged_into_id IS NULL
   LIMIT 1;
  IF c.id IS NULL THEN RAISE EXCEPTION 'No guest profile found for this account'; END IF;

  -- The stay that gives this request its property and room: either booked
  -- under this customer, or one they have proved is theirs.
  SELECT r.id, r.branch_id, r.room_id,
         (SELECT s.id FROM public.stays s WHERE s.reservation_id = r.id
            AND s.status IN ('in-house','checked-in','checked_in','in_house')
          ORDER BY s.created_at DESC LIMIT 1) AS stay_id
    INTO res
    FROM public.reservations r
    LEFT JOIN public.neo_stay_verifications v
      ON v.reservation_id = r.id AND v.auth_user_id = uid AND v.revoked_at IS NULL
   WHERE r.organization_id = _org AND r.branch_id = _branch
     AND (r.customer_id = c.id OR v.reservation_id IS NOT NULL)
     AND r.status IN ('checked_in','in_house','checked-in','in-house')
   ORDER BY r.arrival_date DESC
   LIMIT 1;

  INSERT INTO public.guest_requests (
    organization_id, branch_id, reservation_id, stay_id, customer_id, room_id,
    category, description, priority, status, request_type, created_by)
  VALUES (
    _org, _branch, res.id, res.stay_id, c.id, res.room_id,
    _category, btrim(_description), COALESCE(NULLIF(btrim(_priority), ''), 'normal'),
    'new', 'service', uid)
  RETURNING id INTO new_id;

  UPDATE public.customers SET last_guest_app_activity_at = now() WHERE id = c.id;

  PERFORM public.neo_guest_record_event(
    _org, 'request.created', 'guest_request', new_id::text,
    jsonb_build_object('category', _category), 'request:' || new_id::text, 'guest_app');

  RETURN new_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.neo_guest_request_transport(
  _org uuid, _branch uuid, _product uuid, _pickup_at timestamptz, _pickup_point text, _destination text,
  _passengers integer, _luggage integer,
  _travel_reference text, _notes text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE _cust public.customers; _p public.transport_products; _res public.reservations;
        _num text; _id uuid; _currency text;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Authentication required'; END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.branches b
    WHERE b.id = _branch AND b.organization_id = _org AND b.active IS TRUE
  ) THEN
    RAISE EXCEPTION 'Select an active property in this organisation' USING ERRCODE = '42501';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.neo_public_experience e
    WHERE e.branch_id = _branch AND e.organization_id = _org AND e.discoverable
      AND coalesce((e.doors->>'stay_dine')::boolean, true)
  ) THEN
    RAISE EXCEPTION 'Guest services are unavailable at this property' USING ERRCODE = '42501';
  END IF;
  SELECT b.currency INTO _currency FROM public.branches b WHERE b.id = _branch AND b.organization_id = _org;
  SELECT * INTO _cust FROM public.customers
   WHERE auth_user_id = auth.uid() AND organization_id = _org AND merged_into_id IS NULL LIMIT 1;
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
     WHERE id = _product AND organization_id = _org AND active
       AND (branch_id IS NULL OR branch_id = _branch);
    IF _p.id IS NULL THEN RAISE EXCEPTION 'Transfer option is not available'; END IF;
    IF _p.max_passengers IS NOT NULL AND _passengers > _p.max_passengers THEN
      RAISE EXCEPTION 'That transfer seats up to % passenger(s)', _p.max_passengers;
    END IF;
  END IF;

  SELECT * INTO _res FROM public.reservations
   WHERE customer_id = _cust.id AND organization_id = _org AND branch_id = _branch
     AND status IN ('checked_in','in_house','checked-in','in-house','confirmed','guaranteed','tentative')
   ORDER BY arrival_date DESC LIMIT 1;

  IF coalesce(_p.currency, nullif(_currency, '')) IS NULL THEN
    RAISE EXCEPTION 'The property needs a currency before it can quote a transfer';
  END IF;
  _num := 'TRF-' || to_char(now(),'YYYYMMDD') || '-' || upper(substr(md5(gen_random_uuid()::text),1,5));

  INSERT INTO public.transport_requests (
    organization_id, branch_id, customer_id, reservation_id, product_id, request_number,
    category, pickup_at, pickup_point, destination, passengers, luggage_count,
    travel_reference, notes, quoted_amount, currency, status, created_by)
  VALUES (_org, _branch, _cust.id, _res.id, _p.id, _num,
    coalesce(_p.category,'custom'), _pickup_at, btrim(_pickup_point), btrim(_destination),
    _passengers, coalesce(_luggage,0), nullif(btrim(coalesce(_travel_reference,'')),''),
    nullif(btrim(coalesce(_notes,'')),''), _p.base_price, coalesce(_p.currency, nullif(_currency, '')),
    CASE WHEN _p.base_price IS NULL THEN 'requested' ELSE 'quoted' END, auth.uid())
  RETURNING id INTO _id;

  RETURN jsonb_build_object('id', _id, 'request_number', _num,
                            'quoted_amount', _p.base_price,
                            'status', CASE WHEN _p.base_price IS NULL THEN 'requested' ELSE 'quoted' END);
END $function$;

CREATE OR REPLACE FUNCTION public.neo_guest_folio_projection(_org uuid, _branch uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE _cust uuid; _folios jsonb;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Authentication required'; END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.branches b
    WHERE b.id = _branch AND b.organization_id = _org AND b.active IS TRUE
  ) THEN
    RAISE EXCEPTION 'Select an active property in this organisation' USING ERRCODE = '42501';
  END IF;
  SELECT id INTO _cust FROM public.customers
   WHERE organization_id = _org AND auth_user_id = auth.uid() AND merged_into_id IS NULL
   LIMIT 1;
  IF _cust IS NULL THEN
    RETURN jsonb_build_object('folios', '[]'::jsonb, 'payments', '[]'::jsonb);
  END IF;

  SELECT coalesce(jsonb_agg(f ORDER BY f->>'opened_at' DESC), '[]'::jsonb) INTO _folios
  FROM (
    SELECT jsonb_build_object(
      'id', fo.id,
      'folio_number', fo.folio_number,
      'status', fo.status,
      'currency', fo.currency,
      'opened_at', fo.opened_at,
      'closed_at', fo.closed_at,
      'lines', (
        SELECT coalesce(jsonb_agg(jsonb_build_object(
                 'id', fl.id,
                 'description', coalesce(fl.description, fl.category),
                 'quantity', fl.quantity,
                 'unit_price', fl.unit_price,
                 'tax_amount', fl.tax_amount,
                 'discount_amount', fl.discount_amount,
                 'net_amount', fl.net_amount,
                 'posting_date', fl.posting_date) ORDER BY fl.posting_date), '[]'::jsonb)
        FROM public.folio_lines fl
        WHERE fl.folio_id = fo.id AND fl.organization_id=fo.organization_id
          AND coalesce(fl.status,'posted') NOT IN ('void','voided','reversed')
          AND coalesce(fl.line_type,'charge') NOT IN ('payment','deposit','refund')
      )) || position.value AS f
    FROM public.folios fo
    CROSS JOIN LATERAL(SELECT public.neo_folio_financial_components(fo.id,fo.organization_id) AS value) position
    WHERE fo.organization_id = _org AND fo.customer_id = _cust AND fo.branch_id = _branch
  ) s;

  RETURN jsonb_build_object(
    'folios', _folios,
    'payments', (
      SELECT coalesce(jsonb_agg(jsonb_build_object(
               'id', p.id,
               'receipt_number', p.receipt_number,
               'amount', p.amount,
               'currency', p.currency,
               'method', p.method,
               'paid_at', p.paid_at,
               'folio_id', p.folio_id) ORDER BY p.paid_at DESC), '[]'::jsonb)
      FROM (
        SELECT pm.id, pm.receipt_number, pm.amount, pm.currency, pm.method, pm.paid_at, pm.folio_id
        FROM public.payments pm
        WHERE pm.organization_id = _org AND pm.customer_id = _cust
          AND pm.status IN ('confirmed', 'posted', 'completed')
          AND ((pm.folio_id IS NULL AND pm.branch_id = _branch) OR EXISTS (
            SELECT 1 FROM public.folios fo WHERE fo.id = pm.folio_id AND fo.organization_id = _org
              AND fo.customer_id = _cust AND fo.branch_id = _branch
              AND (pm.branch_id IS NULL OR pm.branch_id = _branch)
          ))
        ORDER BY pm.paid_at DESC NULLS LAST, pm.id
        LIMIT 50
      ) p));
END;
$function$;

CREATE OR REPLACE FUNCTION public.neo_guest_my_stays(_org uuid, _branch uuid)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  _uid uuid := auth.uid();
  _me uuid;
  _rows jsonb;
BEGIN
  IF _uid IS NULL THEN RETURN '[]'::jsonb; END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.branches b
    WHERE b.id = _branch AND b.organization_id = _org AND b.active IS TRUE
  ) THEN
    RAISE EXCEPTION 'Select an active property in this organisation' USING ERRCODE = '42501';
  END IF;
  SELECT id INTO _me FROM public.customers WHERE auth_user_id = _uid AND organization_id = _org AND merged_into_id IS NULL LIMIT 1;
  IF _me IS NULL THEN RETURN '[]'::jsonb; END IF;

  SELECT COALESCE(jsonb_agg(row_to_json(t) ORDER BY t.arrival_date DESC), '[]'::jsonb) INTO _rows
  FROM (
    SELECT r.id, r.confirmation_number, r.status, r.arrival_date, r.departure_date,
           r.nights, r.adults, r.children, r.total_amount, r.balance, r.payment_status,
           rm.room_number, b.name AS property_name,
           (v.reservation_id IS NOT NULL) AS verified
    FROM public.reservations r
    LEFT JOIN public.rooms rm ON rm.id = r.room_id
      AND rm.organization_id = r.organization_id AND rm.branch_id = r.branch_id
    LEFT JOIN public.branches b ON b.id = r.branch_id
    LEFT JOIN public.neo_stay_verifications v
      ON v.reservation_id = r.id AND v.auth_user_id = _uid AND v.revoked_at IS NULL
    WHERE r.organization_id = _org AND r.branch_id = _branch
      AND (r.customer_id = _me OR v.reservation_id IS NOT NULL)
    ORDER BY r.arrival_date DESC
    LIMIT 25
  ) t;

  RETURN _rows;
END;
$$;

CREATE OR REPLACE FUNCTION public.neo_guest_verify_stay(_org uuid, _branch uuid, _reference text, _detail text)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  _uid uuid := auth.uid();
  _me public.customers%ROWTYPE;
  _res public.reservations%ROWTYPE;
  _owner public.customers%ROWTYPE;
  _detail text := lower(btrim(_detail));
  _recent integer;
BEGIN
  IF _uid IS NULL THEN RETURN jsonb_build_object('verified', false, 'reason', 'not_signed_in'); END IF;
  IF _reference IS NULL OR btrim(_reference) = '' OR nullif(_detail, '') IS NULL THEN
    RETURN jsonb_build_object('verified', false, 'reason', 'incomplete');
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.branches b
    WHERE b.id = _branch AND b.organization_id = _org AND b.active IS TRUE
  ) THEN
    RAISE EXCEPTION 'Select an active property in this organisation' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO _me FROM public.customers
  WHERE auth_user_id = _uid AND organization_id = _org LIMIT 1;
  IF _me.id IS NULL THEN RETURN jsonb_build_object('verified', false, 'reason', 'no_customer_record'); END IF;

  -- Simple abuse ceiling: no more than 10 successful links an hour per person.
  SELECT count(*) INTO _recent FROM public.neo_stay_verifications
  WHERE auth_user_id = _uid AND verified_at > now() - interval '1 hour';
  IF _recent >= 10 THEN RETURN jsonb_build_object('verified', false, 'reason', 'too_many_attempts'); END IF;

  SELECT * INTO _res FROM public.reservations
  WHERE organization_id = _org AND branch_id = _branch
    AND upper(btrim(confirmation_number)) = upper(btrim(_reference))
  LIMIT 1;
  IF _res.id IS NULL THEN RETURN jsonb_build_object('verified', false, 'reason', 'no_match'); END IF;

  SELECT * INTO _owner FROM public.customers WHERE id = _res.customer_id;
  IF _owner.id IS NULL THEN RETURN jsonb_build_object('verified', false, 'reason', 'no_match'); END IF;

  -- The supplied detail must match something already recorded on the booking.
  IF NOT (
    position(_detail in lower(COALESCE(_owner.full_name, ''))) > 0
    OR lower(COALESCE(_owner.email, '')) = _detail
    OR (regexp_replace(_detail, '\D', '', 'g') <> ''
        AND regexp_replace(COALESCE(_owner.phone, ''), '\D', '', 'g') = regexp_replace(_detail, '\D', '', 'g'))
    OR (length(regexp_replace(_detail, '\D', '', 'g')) >= 4
        AND right(regexp_replace(COALESCE(_owner.phone, ''), '\D', '', 'g'), 4) =
            right(regexp_replace(_detail, '\D', '', 'g'), 4))
  ) THEN
    RETURN jsonb_build_object('verified', false, 'reason', 'no_match');
  END IF;

  INSERT INTO public.neo_stay_verifications (
    organization_id, branch_id, reservation_id, customer_id, auth_user_id, method
  ) VALUES (_org, _res.branch_id, _res.id, _me.id, _uid, 'reference_and_detail')
  ON CONFLICT (reservation_id, auth_user_id) DO UPDATE
    SET revoked_at = NULL, verified_at = now();

  RETURN jsonb_build_object(
    'verified', true,
    'reservation_id', _res.id,
    'confirmation_number', _res.confirmation_number
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.neo_guest_verify_stay(_org uuid, _reference text, _detail text)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  _uid uuid := auth.uid();
  _me public.customers%ROWTYPE;
  _res public.reservations%ROWTYPE;
  _owner public.customers%ROWTYPE;
  _detail text := lower(btrim(_detail));
  _recent integer;
BEGIN
  IF _uid IS NULL THEN RETURN jsonb_build_object('verified', false, 'reason', 'not_signed_in'); END IF;
  IF _reference IS NULL OR btrim(_reference) = '' OR nullif(_detail, '') IS NULL THEN
    RETURN jsonb_build_object('verified', false, 'reason', 'incomplete');
  END IF;

  SELECT * INTO _me FROM public.customers
  WHERE auth_user_id = _uid AND organization_id = _org LIMIT 1;
  IF _me.id IS NULL THEN RETURN jsonb_build_object('verified', false, 'reason', 'no_customer_record'); END IF;

  -- Simple abuse ceiling: no more than 10 successful links an hour per person.
  SELECT count(*) INTO _recent FROM public.neo_stay_verifications
  WHERE auth_user_id = _uid AND verified_at > now() - interval '1 hour';
  IF _recent >= 10 THEN RETURN jsonb_build_object('verified', false, 'reason', 'too_many_attempts'); END IF;

  SELECT * INTO _res FROM public.reservations
  WHERE organization_id = _org
    AND upper(btrim(confirmation_number)) = upper(btrim(_reference))
  LIMIT 1;
  IF _res.id IS NULL THEN RETURN jsonb_build_object('verified', false, 'reason', 'no_match'); END IF;

  SELECT * INTO _owner FROM public.customers WHERE id = _res.customer_id;
  IF _owner.id IS NULL THEN RETURN jsonb_build_object('verified', false, 'reason', 'no_match'); END IF;

  -- The supplied detail must match something already recorded on the booking.
  IF NOT (
    position(_detail in lower(COALESCE(_owner.full_name, ''))) > 0
    OR lower(COALESCE(_owner.email, '')) = _detail
    OR (regexp_replace(_detail, '\D', '', 'g') <> ''
        AND regexp_replace(COALESCE(_owner.phone, ''), '\D', '', 'g') = regexp_replace(_detail, '\D', '', 'g'))
    OR (length(regexp_replace(_detail, '\D', '', 'g')) >= 4
        AND right(regexp_replace(COALESCE(_owner.phone, ''), '\D', '', 'g'), 4) =
            right(regexp_replace(_detail, '\D', '', 'g'), 4))
  ) THEN
    RETURN jsonb_build_object('verified', false, 'reason', 'no_match');
  END IF;

  INSERT INTO public.neo_stay_verifications (
    organization_id, branch_id, reservation_id, customer_id, auth_user_id, method
  ) VALUES (_org, _res.branch_id, _res.id, _me.id, _uid, 'reference_and_detail')
  ON CONFLICT (reservation_id, auth_user_id) DO UPDATE
    SET revoked_at = NULL, verified_at = now();

  RETURN jsonb_build_object(
    'verified', true,
    'reservation_id', _res.id,
    'confirmation_number', _res.confirmation_number
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.neo_scoped_workers(_branch uuid DEFAULT NULL::uuid, _department uuid DEFAULT NULL::uuid, _department_key text DEFAULT NULL::text)
 RETURNS TABLE(id uuid, full_name text, staff_id text, job_title text, department_id uuid, department_name text, branch_id uuid, branch_name text)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  WITH requested_department AS (
    SELECT d.id,
           coalesce(
             nullif(btrim(coalesce(d.catalogue_key,'')),''),
             public.neo_department_catalogue_key(d.name),
             lower(btrim(d.name))
           ) AS ident,
           d.branch_id
      FROM public.departments d
     WHERE _department IS NOT NULL
       AND d.id = _department
       AND d.organization_id = public.current_org_id()
       AND coalesce(d.active, true)
       AND coalesce(d.department_status, 'active') <> 'archived'
       AND (_branch IS NULL OR d.branch_id IS NULL OR d.branch_id = _branch)
       AND (d.branch_id IS NULL OR public.neo_branch_in_scope(d.branch_id))
  ), wanted AS (
    SELECT CASE WHEN _department IS NULL THEN nullif(btrim(_department_key), '')
                ELSE (SELECT ident FROM requested_department) END AS ident,
           coalesce(_branch, (SELECT branch_id FROM requested_department)) AS branch_id
    WHERE _department IS NULL OR EXISTS (SELECT 1 FROM requested_department)
  ), active_staff AS (
    SELECT DISTINCT ON (p.id)
           p.id,
           p.full_name,
           p.staff_id,
           coalesce(nullif(p.job_title, ''), nullif(e.job_title, '')) AS job_title,
           coalesce(p.department_id, e.department_id) AS staff_department_id,
           coalesce(p.branch_id, e.branch_id) AS staff_branch_id
      FROM public.profiles p
      JOIN public.employees e
        ON e.profile_id = p.id
       AND e.organization_id = p.organization_id
       AND coalesce(e.employment_status, 'active') NOT IN ('terminated', 'exited', 'resigned')
       AND coalesce(e.system_access_status, 'active') NOT IN ('disabled', 'revoked', 'suspended')
     CROSS JOIN wanted scope
     WHERE p.organization_id = public.current_org_id()
       AND coalesce(p.account_status, 'active') = 'active'
       AND coalesce(p.employment_status, 'active') NOT IN ('terminated', 'exited', 'resigned')
       AND (scope.branch_id IS NULL OR coalesce(p.branch_id, e.branch_id) = scope.branch_id)
       AND public.neo_branch_in_scope(coalesce(p.branch_id, e.branch_id))
       AND EXISTS (
         SELECT 1
           FROM public.user_roles ur
           JOIN public.roles r
             ON r.id = ur.role_id
            AND r.organization_id = p.organization_id
            AND coalesce(r.active, true)
            AND coalesce(r.role_status, 'active') <> 'archived'
           LEFT JOIN public.departments rd
             ON rd.id = r.department_id
          CROSS JOIN wanted w
          WHERE ur.user_id = p.id
            AND ur.organization_id = p.organization_id
            AND (
              w.ident IS NULL
              OR (
                rd.id IS NOT NULL
                AND coalesce(
                  nullif(btrim(coalesce(rd.catalogue_key,'')),''),
                  public.neo_department_catalogue_key(rd.name),
                  lower(btrim(rd.name))
                ) = w.ident
              )
            )
       )
       AND (
         (SELECT ident FROM wanted) IS NULL
         OR EXISTS (
           SELECT 1
             FROM public.departments sd
            WHERE sd.id IN (p.department_id, e.department_id)
              AND sd.organization_id = p.organization_id
              AND coalesce(sd.active, true)
              AND coalesce(sd.department_status, 'active') <> 'archived'
              AND (scope.branch_id IS NULL OR sd.branch_id IS NULL OR sd.branch_id = scope.branch_id)
              AND coalesce(
                nullif(btrim(coalesce(sd.catalogue_key,'')),''),
                public.neo_department_catalogue_key(sd.name),
                lower(btrim(sd.name))
              ) = (SELECT ident FROM wanted)
         )
       )
     ORDER BY p.id, (p.department_id IS NOT NULL) DESC, (p.branch_id IS NOT NULL) DESC
  )
  SELECT a.id,
         a.full_name,
         a.staff_id,
         a.job_title,
         a.staff_department_id,
         d.name,
         a.staff_branch_id,
         b.name
    FROM active_staff a
    LEFT JOIN public.departments d ON d.id = a.staff_department_id
    LEFT JOIN public.branches b ON b.id = a.staff_branch_id
   ORDER BY a.full_name, a.staff_id;
$function$;

REVOKE ALL ON FUNCTION public.neo_guest_active_stay(uuid,uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.neo_guest_active_stay(uuid,uuid) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.neo_guest_create_request(uuid,uuid,text,text,text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.neo_guest_create_request(uuid,uuid,text,text,text) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.neo_guest_request_transport(uuid,uuid,uuid,timestamptz,text,text,integer,integer,text,text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.neo_guest_request_transport(uuid,uuid,uuid,timestamptz,text,text,integer,integer,text,text) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.neo_guest_folio_projection(uuid,uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.neo_guest_folio_projection(uuid,uuid) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.neo_guest_my_stays(uuid,uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.neo_guest_my_stays(uuid,uuid) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.neo_guest_verify_stay(uuid,uuid,text,text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.neo_guest_verify_stay(uuid,uuid,text,text) TO authenticated, service_role;

COMMIT;
