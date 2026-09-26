
-- 1. ONE canonical kitchen routing implementation ---------------------------
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
      (SELECT pt.target_minutes FROM public.preparation_targets pt
        WHERE pt.organization_id = _org AND pt.active
          AND (pt.branch_id IS NULL OR pt.branch_id = _o.branch_id)
          AND ((pt.scope='menu-item' AND pt.menu_item_id = _it.menu_item_id)
            OR (pt.scope='station' AND pt.station_id = _station)
            OR (pt.scope='order-type' AND pt.order_type = _o.order_type)
            OR (pt.scope='branch'))
        ORDER BY CASE pt.scope WHEN 'menu-item' THEN 1 WHEN 'station' THEN 2 WHEN 'order-type' THEN 3 ELSE 4 END
        LIMIT 1),
      (SELECT mi.prep_minutes FROM public.menu_items mi WHERE mi.id = _it.menu_item_id),
      15) INTO _target;

    INSERT INTO public.station_tickets (
      organization_id, branch_id, department_id, order_id, station_id, ticket_number, course,
      priority, status, target_minutes, received_at, created_by, routing_note)
    VALUES (_org, _o.branch_id,
      (SELECT s.department_id FROM public.operational_stations s WHERE s.id = _station),
      _order, _station,
      'KT-' || upper(substr(replace(_order::text,'-',''),1,6)) || '-' ||
        upper(substr(md5(COALESCE(_station::text,'unassigned') || _it.course), 1, 4)),
      _it.course, COALESCE(_o.order_type,'dine-in'), 'new', _target, now(), auth.uid(),
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

  RETURN jsonb_build_object('ok', true, 'order_id', _order, 'tickets_created', _tickets,
                            'items_created', _created, 'items_reused', _reused,
                            'unassigned_station', _unassigned);
END $function$;

-- staff entry point keeps its guards and delegates to the canonical body
CREATE OR REPLACE FUNCTION public.neo_pos_send_to_kitchen(_order uuid, _attempt uuid DEFAULT gen_random_uuid())
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  _org uuid := public.current_org_id();
  _o public.pos_orders;
  _supervisor boolean;
  _res jsonb;
BEGIN
  IF _org IS NULL THEN RAISE EXCEPTION 'no_organisation' USING ERRCODE = '42501'; END IF;
  IF _attempt IS NULL THEN RAISE EXCEPTION 'attempt_key_required' USING ERRCODE = '22023'; END IF;

  SELECT * INTO _o FROM public.pos_orders WHERE id = _order AND organization_id = _org;
  IF _o.id IS NULL THEN RAISE EXCEPTION 'order_not_found' USING ERRCODE = 'P0002'; END IF;
  IF NOT public.neo_branch_in_scope(_o.branch_id) THEN
    RAISE EXCEPTION 'branch_out_of_scope' USING ERRCODE = '42501';
  END IF;

  _supervisor := public.has_permission('restaurant','orders.manage')
                 OR public.has_permission('kitchen','queue.manage')
                 OR public.is_org_admin();

  IF NOT (_supervisor
          OR ((_o.waiter_id = auth.uid() OR _o.created_by = auth.uid())
              AND public.has_permission('pos','orders.create'))) THEN
    RAISE EXCEPTION 'insufficient_privilege' USING ERRCODE = '42501';
  END IF;

  IF _o.status IN ('draft','held','cancelled','voided') THEN
    RAISE EXCEPTION 'order_not_sendable' USING ERRCODE = '22023';
  END IF;

  _res := public.neo_pos_route_tickets_internal(_order, _org);
  RETURN _res || jsonb_build_object('attempt', _attempt);
END $function$;

-- 2. Guest-safe folio / receipt projection ----------------------------------
CREATE OR REPLACE FUNCTION public.neo_guest_folio_projection(_org uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE _cust uuid; _folios jsonb;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Authentication required'; END IF;
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
      'total_charges', fo.total_charges,
      'total_discounts', fo.total_discounts,
      'total_taxes', fo.total_taxes,
      'total_payments', fo.total_payments,
      'balance', fo.balance,
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
        WHERE fl.folio_id = fo.id AND coalesce(fl.status,'posted') <> 'void'
      )) AS f
    FROM public.folios fo
    WHERE fo.organization_id = _org AND fo.customer_id = _cust
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
      FROM public.payments p
      WHERE p.organization_id = _org AND p.customer_id = _cust
        AND coalesce(p.status,'completed') NOT IN ('void','voided','failed')
      LIMIT 50));
END $function$;

-- 3. Guest-safe published modifier projection --------------------------------
CREATE OR REPLACE FUNCTION public.neo_public_menu_modifiers(_org uuid, _items uuid[])
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT coalesce(jsonb_object_agg(t.menu_item_id, t.groups), '{}'::jsonb)
  FROM (
    SELECT mig.menu_item_id,
           jsonb_agg(jsonb_build_object(
             'group_id', g.id,
             'name', g.name,
             'required', g.required,
             'multi_select', g.multi_select,
             'min_select', g.min_select,
             'max_select', g.max_select,
             'options', (
               SELECT coalesce(jsonb_agg(jsonb_build_object(
                        'option_id', o.id, 'name', o.name, 'extra_charge', o.extra_charge)
                        ORDER BY o.display_order, o.name), '[]'::jsonb)
               FROM public.modifier_options o
               WHERE o.group_id = g.id AND o.active AND o.organization_id = _org)
           ) ORDER BY mig.display_order) AS groups
    FROM public.menu_item_modifier_groups mig
    JOIN public.modifier_groups g ON g.id = mig.group_id AND g.active AND g.organization_id = _org
    WHERE mig.organization_id = _org
      AND auth.uid() IS NOT NULL
      AND mig.menu_item_id = ANY(_items)
    GROUP BY mig.menu_item_id
  ) t;
$function$;

-- 4. Server-priced guest basket line ----------------------------------------
CREATE OR REPLACE FUNCTION public.neo_guest_cart_add_item(
  _org uuid, _fulfilment text, _menu_item uuid, _quantity numeric DEFAULT 1,
  _special_instructions text DEFAULT NULL, _allergy_note text DEFAULT NULL,
  _branch uuid DEFAULT NULL, _options uuid[] DEFAULT '{}')
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE _cust uuid; _cart uuid; _item public.menu_items; _line uuid;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Authentication required'; END IF;
  IF _fulfilment NOT IN ('room-service','pickup','delivery') THEN
    RAISE EXCEPTION 'Unsupported fulfilment type';
  END IF;
  IF coalesce(_quantity,0) <= 0 OR _quantity > 50 THEN RAISE EXCEPTION 'Invalid quantity'; END IF;

  SELECT id INTO _cust FROM public.customers
   WHERE organization_id = _org AND auth_user_id = auth.uid() AND merged_into_id IS NULL LIMIT 1;
  IF _cust IS NULL THEN RAISE EXCEPTION 'No guest profile for this property'; END IF;

  SELECT * INTO _item FROM public.menu_items
   WHERE id = _menu_item AND organization_id = _org AND availability = 'available';
  IF _item.id IS NULL THEN RAISE EXCEPTION 'Item is not available'; END IF;

  SELECT id INTO _cart FROM public.carts
   WHERE customer_id = _cust AND organization_id = _org AND status = 'active' LIMIT 1;
  IF _cart IS NULL THEN
    INSERT INTO public.carts (organization_id, customer_id, branch_id, fulfilment_type)
    VALUES (_org, _cust, coalesce(_branch, _item.branch_id), _fulfilment)
    RETURNING id INTO _cart;
  ELSE
    UPDATE public.carts SET fulfilment_type = _fulfilment WHERE id = _cart AND fulfilment_type IS DISTINCT FROM _fulfilment;
  END IF;

  INSERT INTO public.cart_items (organization_id, cart_id, menu_item_id, quantity,
                                 special_instructions, allergy_note)
  VALUES (_org, _cart, _menu_item, _quantity,
          nullif(btrim(coalesce(_special_instructions,'')),''),
          nullif(btrim(coalesce(_allergy_note,'')),''))
  RETURNING id INTO _line;

  -- prices come from the published catalogue, never from the browser
  INSERT INTO public.cart_item_modifiers (organization_id, cart_item_id, group_id, option_id,
                                          group_name, option_name, extra_charge)
  SELECT _org, _line, g.id, o.id, g.name, o.name, o.extra_charge
  FROM public.modifier_options o
  JOIN public.modifier_groups g ON g.id = o.group_id
  JOIN public.menu_item_modifier_groups mig ON mig.group_id = g.id AND mig.menu_item_id = _menu_item
  WHERE o.id = ANY(coalesce(_options,'{}')) AND o.active AND g.active
    AND o.organization_id = _org;

  RETURN _line;
END $function$;

-- 5. Room service: single-flight per basket ---------------------------------
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

  -- serialise repeat submissions of the same basket
  PERFORM pg_advisory_xact_lock(hashtextextended(_cart::text, 77));

  SELECT * INTO _c FROM public.carts WHERE id = _cart AND status = 'active';
  IF _c.id IS NULL OR _c.customer_id IS DISTINCT FROM public.my_customer_id() THEN
    -- already converted by a previous submission: return that order, do not duplicate
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

-- 6. Transport: rider candidates, rider-scoped jobs, rider progression -------
CREATE OR REPLACE FUNCTION public.neo_transport_rider_candidates(_request uuid)
 RETURNS TABLE(rider_id uuid, rider_code text, display_name text, vehicle_type text,
               availability_status text, active_load bigint, eligible boolean)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE _r public.transport_requests; _org uuid := public.current_org_id();
BEGIN
  IF _org IS NULL THEN RAISE EXCEPTION 'Not permitted'; END IF;
  SELECT * INTO _r FROM public.transport_requests WHERE id = _request AND organization_id = _org;
  IF _r.id IS NULL THEN RAISE EXCEPTION 'Transport request not found'; END IF;
  IF NOT (public.is_org_admin() OR public.has_permission('front-office','requests.manage')
          OR public.has_permission('delivery','dispatch.manage')) THEN
    RAISE EXCEPTION 'Not permitted to assign drivers';
  END IF;
  IF NOT public.in_my_branch_scope(_r.organization_id, _r.branch_id) THEN
    RAISE EXCEPTION 'Transport request is outside your property scope';
  END IF;

  RETURN QUERY
  SELECT rp.id, rp.rider_code, rp.display_name, rp.vehicle_type, rp.availability_status,
         (SELECT count(*) FROM public.delivery_orders d
           WHERE d.rider_id = rp.id AND d.dispatch_status NOT IN ('delivered','delivery-failed','returned')),
         (rp.availability_status IN ('available','on-shift','busy'))
  FROM public.rider_profiles rp
  WHERE rp.organization_id = _org AND rp.active
    AND (_r.branch_id IS NULL OR rp.branch_id IS NULL OR rp.branch_id = _r.branch_id)
  ORDER BY rp.display_name;
END $function$;

CREATE OR REPLACE FUNCTION public.neo_rider_transport_jobs()
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE _rider uuid;
BEGIN
  SELECT id INTO _rider FROM public.rider_profiles WHERE profile_id = auth.uid() AND active LIMIT 1;
  IF _rider IS NULL THEN RETURN '[]'::jsonb; END IF;
  RETURN (
    SELECT coalesce(jsonb_agg(jsonb_build_object(
      'id', t.id, 'request_number', t.request_number, 'status', t.status, 'category', t.category,
      'pickup_at', t.pickup_at, 'pickup_point', t.pickup_point, 'destination', t.destination,
      'passengers', t.passengers, 'luggage_count', t.luggage_count,
      'guest_name', (SELECT c.full_name FROM public.customers c WHERE c.id = t.customer_id),
      'guest_phone', (SELECT c.phone FROM public.customers c WHERE c.id = t.customer_id),
      'notes', t.notes) ORDER BY t.pickup_at), '[]'::jsonb)
    FROM public.transport_requests t
    WHERE t.assigned_rider_id = _rider
      AND t.status IN ('driver-assigned','arriving','picked-up','confirmed'));
END $function$;

CREATE OR REPLACE FUNCTION public.neo_rider_transport_advance(_request uuid, _status text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE _rider uuid; _t public.transport_requests;
BEGIN
  IF _status NOT IN ('arriving','picked-up','completed') THEN
    RAISE EXCEPTION 'Unsupported status for a driver';
  END IF;
  SELECT id INTO _rider FROM public.rider_profiles WHERE profile_id = auth.uid() AND active LIMIT 1;
  IF _rider IS NULL THEN RAISE EXCEPTION 'No rider profile'; END IF;
  SELECT * INTO _t FROM public.transport_requests WHERE id = _request AND assigned_rider_id = _rider;
  IF _t.id IS NULL THEN RAISE EXCEPTION 'Transfer is not assigned to you'; END IF;
  IF _t.status IN ('completed','cancelled','declined') THEN RAISE EXCEPTION 'Transfer is closed'; END IF;

  UPDATE public.transport_requests
     SET status = _status, updated_at = now()
   WHERE id = _request;

  INSERT INTO public.audit_logs (organization_id, user_id, user_name, action, module, record_id,
                                 previous_value, new_value)
  VALUES (_t.organization_id, auth.uid(), '', 'transport.request.status', 'delivery', _request::text,
          jsonb_build_object('status', _t.status), jsonb_build_object('status', _status, 'by', 'rider'));

  RETURN jsonb_build_object('ok', true, 'status', _status);
END $function$;

-- 7. Staff-side factual guest digital summary -------------------------------
CREATE OR REPLACE FUNCTION public.neo_customer_digital_summary(_customer uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE _c public.customers; _org uuid := public.current_org_id();
BEGIN
  IF _org IS NULL THEN RAISE EXCEPTION 'Not permitted'; END IF;
  SELECT * INTO _c FROM public.customers WHERE id = _customer AND organization_id = _org;
  IF _c.id IS NULL THEN RAISE EXCEPTION 'Customer not found'; END IF;
  IF NOT (public.is_org_admin() OR public.has_permission('crm','customers.view')) THEN
    RAISE EXCEPTION 'Not permitted to read guest activity';
  END IF;
  IF NOT public.in_my_branch_scope(_c.organization_id, _c.primary_branch_id) THEN
    RAISE EXCEPTION 'Guest is outside your property scope';
  END IF;

  RETURN jsonb_build_object(
    'account_status', _c.guest_account_status,
    'linked_at', _c.guest_linked_at,
    'last_activity_at', _c.last_guest_app_activity_at,
    'event_count', (SELECT count(*) FROM public.customer_digital_events e WHERE e.customer_id = _c.id),
    'recent_events', (
      SELECT coalesce(jsonb_agg(jsonb_build_object(
               'event_type', e.event_type, 'surface', e.surface,
               'subject_type', e.subject_type, 'subject_id', e.subject_id,
               'occurred_at', e.occurred_at) ORDER BY e.occurred_at DESC), '[]'::jsonb)
      FROM (SELECT * FROM public.customer_digital_events
             WHERE customer_id = _c.id ORDER BY occurred_at DESC LIMIT 15) e),
    'app_orders', (
      SELECT coalesce(jsonb_agg(jsonb_build_object(
               'id', d.id, 'order_number', d.order_number, 'fulfilment_type', d.fulfilment_type,
               'order_status', d.order_status, 'grand_total', d.grand_total,
               'created_at', d.created_at) ORDER BY d.created_at DESC), '[]'::jsonb)
      FROM (SELECT * FROM public.delivery_orders WHERE customer_id = _c.id
             ORDER BY created_at DESC LIMIT 10) d),
    'stays', (
      SELECT coalesce(jsonb_agg(jsonb_build_object(
               'id', r.id, 'confirmation_number', r.confirmation_number, 'status', r.status,
               'arrival_date', r.arrival_date, 'departure_date', r.departure_date)
               ORDER BY r.arrival_date DESC), '[]'::jsonb)
      FROM (SELECT * FROM public.reservations WHERE customer_id = _c.id
             ORDER BY arrival_date DESC LIMIT 10) r),
    'service_requests', (
      SELECT coalesce(jsonb_agg(jsonb_build_object(
               'id', g.id, 'category', g.category, 'status', g.status, 'created_at', g.created_at)
               ORDER BY g.created_at DESC), '[]'::jsonb)
      FROM (SELECT * FROM public.guest_requests WHERE customer_id = _c.id
             ORDER BY created_at DESC LIMIT 10) g),
    'transport_requests', (
      SELECT coalesce(jsonb_agg(jsonb_build_object(
               'id', t.id, 'request_number', t.request_number, 'status', t.status,
               'pickup_at', t.pickup_at) ORDER BY t.pickup_at DESC), '[]'::jsonb)
      FROM (SELECT * FROM public.transport_requests WHERE customer_id = _c.id
             ORDER BY pickup_at DESC LIMIT 10) t),
    'favourites', (
      SELECT coalesce(jsonb_agg(jsonb_build_object('menu_item', mi.name)), '[]'::jsonb)
      FROM public.customer_favourites f
      JOIN public.menu_items mi ON mi.id = f.menu_item_id
      WHERE f.customer_id = _c.id),
    'consents', (
      SELECT coalesce(jsonb_agg(jsonb_build_object(
               'consent_type', cs.consent_type, 'granted', cs.granted,
               'effective_at', cs.effective_at) ORDER BY cs.effective_at DESC), '[]'::jsonb)
      FROM public.customer_consents cs WHERE cs.customer_id = _c.id));
END $function$;

-- 8. Callable surface --------------------------------------------------------
REVOKE ALL ON FUNCTION public.neo_pos_route_tickets_internal(uuid, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.neo_guest_folio_projection(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.neo_public_menu_modifiers(uuid, uuid[]) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.neo_guest_cart_add_item(uuid, text, uuid, numeric, text, text, uuid, uuid[]) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.neo_transport_rider_candidates(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.neo_rider_transport_jobs() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.neo_rider_transport_advance(uuid, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.neo_customer_digital_summary(uuid) FROM PUBLIC, anon;

GRANT EXECUTE ON FUNCTION public.neo_guest_folio_projection(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.neo_public_menu_modifiers(uuid, uuid[]) TO authenticated;
GRANT EXECUTE ON FUNCTION public.neo_guest_cart_add_item(uuid, text, uuid, numeric, text, text, uuid, uuid[]) TO authenticated;
GRANT EXECUTE ON FUNCTION public.neo_transport_rider_candidates(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.neo_rider_transport_jobs() TO authenticated;
GRANT EXECUTE ON FUNCTION public.neo_rider_transport_advance(uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.neo_customer_digital_summary(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.neo_pos_route_tickets_internal(uuid, uuid) TO service_role;
