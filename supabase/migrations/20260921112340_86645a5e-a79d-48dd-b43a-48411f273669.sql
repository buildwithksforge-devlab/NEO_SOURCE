
ALTER TABLE public.guest_laundry_orders
  ADD COLUMN IF NOT EXISTS source_channel text NOT NULL DEFAULT 'STAFF_POS',
  ADD COLUMN IF NOT EXISTS requested_by_user uuid,
  ADD COLUMN IF NOT EXISTS handover_mode text NOT NULL DEFAULT 'drop_off',
  ADD COLUMN IF NOT EXISTS payment_intent text NOT NULL DEFAULT 'pay_now',
  ADD COLUMN IF NOT EXISTS resident boolean NOT NULL DEFAULT false;

DO $$ BEGIN
  ALTER TABLE public.guest_laundry_orders
    ADD CONSTRAINT guest_laundry_handover_chk
    CHECK (handover_mode IN ('drop_off','collection','delivery'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE public.guest_laundry_orders
    ADD CONSTRAINT guest_laundry_payment_intent_chk
    CHECK (payment_intent IN ('charge_to_room','pay_now','pay_on_collection'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE INDEX IF NOT EXISTS idx_guest_laundry_requested_by
  ON public.guest_laundry_orders (requested_by_user, organization_id);

-- Customers may read their own laundry orders (never anyone else's).
DROP POLICY IF EXISTS guest_laundry_orders_customer_select ON public.guest_laundry_orders;
CREATE POLICY guest_laundry_orders_customer_select
  ON public.guest_laundry_orders FOR SELECT TO authenticated
  USING (
    customer_id IS NOT NULL
    AND EXISTS (
      SELECT 1 FROM public.customers c
      WHERE c.id = guest_laundry_orders.customer_id
        AND c.organization_id = guest_laundry_orders.organization_id
        AND c.auth_user_id = auth.uid()
    )
  );

DROP POLICY IF EXISTS guest_laundry_items_customer_select ON public.guest_laundry_items;
CREATE POLICY guest_laundry_items_customer_select
  ON public.guest_laundry_items FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.guest_laundry_orders o
      JOIN public.customers c ON c.id = o.customer_id
      WHERE o.id = guest_laundry_items.order_id
        AND c.organization_id = o.organization_id
        AND c.auth_user_id = auth.uid()
    )
  );

-- ---------------------------------------------------------------- price list
CREATE OR REPLACE FUNCTION public.neo_guest_laundry_pricelist(_org uuid, _branch uuid)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  _svc jsonb;
  _rows jsonb;
BEGIN
  SELECT services INTO _svc FROM public.neo_public_experience
   WHERE branch_id = _branch AND organization_id = _org;

  IF COALESCE((_svc->>'laundry_resident')::boolean, false) = false
     AND COALESCE((_svc->>'laundry_public')::boolean, false) = false THEN
    RETURN jsonb_build_object('enabled', false, 'items', '[]'::jsonb);
  END IF;

  SELECT COALESCE(jsonb_agg(row_to_json(t) ORDER BY t.name), '[]'::jsonb) INTO _rows
  FROM (
    SELECT p.id, p.name, p.service_type, p.normal_price, p.express_price,
           p.turnaround_hours, p.tax_rate
    FROM public.laundry_price_items p
    WHERE p.organization_id = _org
      AND (p.branch_id = _branch OR p.branch_id IS NULL)
      AND p.active
  ) t;

  RETURN jsonb_build_object(
    'enabled', true,
    'resident', COALESCE((_svc->>'laundry_resident')::boolean, false),
    'public', COALESCE((_svc->>'laundry_public')::boolean, false),
    'collection', COALESCE((_svc->>'laundry_collection')::boolean, false),
    'delivery', COALESCE((_svc->>'laundry_delivery')::boolean, false),
    'items', _rows
  );
END;
$$;

-- ------------------------------------------------------------- place an order
CREATE OR REPLACE FUNCTION public.neo_guest_place_laundry_order(
  _org uuid,
  _branch uuid,
  _items jsonb,
  _express boolean DEFAULT false,
  _handover text DEFAULT 'drop_off',
  _reservation uuid DEFAULT NULL,
  _instructions text DEFAULT NULL,
  _channel text DEFAULT 'NEO_APP'
)
RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  _uid uuid := auth.uid();
  _me uuid;
  _svc jsonb;
  _resident boolean := false;
  _folio uuid;
  _room uuid;
  _order uuid;
  _item jsonb;
  _price public.laundry_price_items%ROWTYPE;
  _qty numeric;
  _unit numeric;
  _line numeric;
  _sub numeric := 0;
  _tax numeric := 0;
  _intent text := 'pay_now';
  _number text;
BEGIN
  IF _uid IS NULL THEN RETURN jsonb_build_object('ok', false, 'reason', 'not_signed_in'); END IF;
  IF _handover NOT IN ('drop_off','collection','delivery') THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'invalid_handover');
  END IF;
  IF _items IS NULL OR jsonb_typeof(_items) <> 'array' OR jsonb_array_length(_items) = 0 THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'no_items');
  END IF;

  SELECT services INTO _svc FROM public.neo_public_experience
   WHERE branch_id = _branch AND organization_id = _org;
  IF _svc IS NULL THEN RETURN jsonb_build_object('ok', false, 'reason', 'laundry_not_offered'); END IF;

  SELECT id INTO _me FROM public.customers
   WHERE auth_user_id = _uid AND organization_id = _org LIMIT 1;
  IF _me IS NULL THEN RETURN jsonb_build_object('ok', false, 'reason', 'no_customer_record'); END IF;

  -- A resident stay must belong to this person, or have been verified by them.
  IF _reservation IS NOT NULL THEN
    SELECT r.id IS NOT NULL, r.room_id INTO _resident, _room
      FROM public.reservations r
      LEFT JOIN public.neo_stay_verifications v
        ON v.reservation_id = r.id AND v.auth_user_id = _uid AND v.revoked_at IS NULL
     WHERE r.id = _reservation
       AND r.organization_id = _org
       AND r.branch_id = _branch
       AND (r.customer_id = _me OR v.id IS NOT NULL)
     LIMIT 1;
    IF NOT COALESCE(_resident, false) THEN
      RETURN jsonb_build_object('ok', false, 'reason', 'stay_not_yours');
    END IF;
  END IF;

  IF _resident AND COALESCE((_svc->>'laundry_resident')::boolean, false) = false THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'resident_laundry_off');
  END IF;
  IF NOT _resident AND COALESCE((_svc->>'laundry_public')::boolean, false) = false THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'public_laundry_off');
  END IF;
  IF _handover = 'collection' AND COALESCE((_svc->>'laundry_collection')::boolean, false) = false AND NOT _resident THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'collection_off');
  END IF;
  IF _handover = 'delivery' AND COALESCE((_svc->>'laundry_delivery')::boolean, false) = false THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'delivery_off');
  END IF;

  IF _resident THEN
    SELECT f.id INTO _folio FROM public.folios f
     WHERE f.reservation_id = _reservation
       AND f.organization_id = _org
       AND COALESCE(f.status, 'open') NOT IN ('closed','void','cancelled')
     ORDER BY f.created_at LIMIT 1;
    IF _folio IS NOT NULL THEN _intent := 'charge_to_room'; END IF;
  ELSIF _handover IN ('collection','delivery') THEN
    _intent := 'pay_on_collection';
  END IF;

  INSERT INTO public.guest_laundry_orders (
    organization_id, branch_id, customer_id, reservation_id, folio_id, room_id,
    service_type, express, special_instructions, status,
    source_channel, requested_by_user, handover_mode, payment_intent, resident, created_by
  ) VALUES (
    _org, _branch, _me, _reservation, _folio, _room,
    'normal', COALESCE(_express, false), NULLIF(_instructions, ''),
    CASE WHEN _handover = 'drop_off' THEN 'requested' ELSE 'awaiting-collection' END,
    COALESCE(NULLIF(_channel, ''), 'NEO_APP'), _uid, _handover, _intent, _resident, _uid
  ) RETURNING id, laundry_number INTO _order, _number;

  FOR _item IN SELECT * FROM jsonb_array_elements(_items) LOOP
    SELECT * INTO _price FROM public.laundry_price_items
     WHERE id = (_item->>'price_item_id')::uuid
       AND organization_id = _org
       AND (branch_id = _branch OR branch_id IS NULL)
       AND active;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Laundry item is not on this hotel''s price list';
    END IF;
    _qty := GREATEST(COALESCE((_item->>'quantity')::numeric, 0), 0);
    IF _qty <= 0 THEN CONTINUE; END IF;
    _unit := CASE WHEN COALESCE(_express, false) AND _price.express_price > 0
                  THEN _price.express_price ELSE _price.normal_price END;
    _line := ROUND(_qty * _unit, 2);
    _sub := _sub + _line;
    _tax := _tax + ROUND(_line * COALESCE(_price.tax_rate, 0) / 100.0, 2);

    INSERT INTO public.guest_laundry_items (
      organization_id, order_id, price_item_id, description, service_type,
      quantity, unit_price, tax_rate, line_total
    ) VALUES (
      _org, _order, _price.id, _price.name, _price.service_type,
      _qty, _unit, COALESCE(_price.tax_rate, 0), _line
    );
  END LOOP;

  IF _sub <= 0 THEN
    RAISE EXCEPTION 'A laundry order needs at least one item with a quantity';
  END IF;

  UPDATE public.guest_laundry_orders
     SET subtotal = _sub, tax_amount = _tax, total = _sub + _tax
   WHERE id = _order;

  RETURN jsonb_build_object(
    'ok', true, 'order_id', _order, 'laundry_number', _number,
    'total', _sub + _tax, 'payment_intent', _intent, 'resident', _resident
  );
END;
$$;

-- ------------------------------------------------------------- my laundry
CREATE OR REPLACE FUNCTION public.neo_guest_my_laundry(_org uuid)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  _uid uuid := auth.uid();
  _me uuid;
  _rows jsonb;
BEGIN
  IF _uid IS NULL THEN RETURN '[]'::jsonb; END IF;
  SELECT id INTO _me FROM public.customers WHERE auth_user_id = _uid AND organization_id = _org LIMIT 1;
  IF _me IS NULL THEN RETURN '[]'::jsonb; END IF;

  SELECT COALESCE(jsonb_agg(row_to_json(t) ORDER BY t.requested_at DESC), '[]'::jsonb) INTO _rows
  FROM (
    SELECT o.id, o.laundry_number, o.status, o.requested_at, o.delivered_at,
           o.total, o.payment_intent, o.handover_mode, o.express, o.resident,
           o.source_channel, b.name AS property_name,
           (SELECT COALESCE(jsonb_agg(jsonb_build_object(
                     'description', i.description, 'quantity', i.quantity,
                     'line_total', i.line_total)), '[]'::jsonb)
              FROM public.guest_laundry_items i WHERE i.order_id = o.id) AS items
    FROM public.guest_laundry_orders o
    LEFT JOIN public.branches b ON b.id = o.branch_id
    WHERE o.organization_id = _org AND o.customer_id = _me
    ORDER BY o.requested_at DESC
    LIMIT 40
  ) t;

  RETURN _rows;
END;
$$;

REVOKE ALL ON FUNCTION public.neo_guest_laundry_pricelist(uuid, uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.neo_guest_place_laundry_order(uuid, uuid, jsonb, boolean, text, uuid, text, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.neo_guest_my_laundry(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.neo_guest_laundry_pricelist(uuid, uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.neo_guest_place_laundry_order(uuid, uuid, jsonb, boolean, text, uuid, text, text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.neo_guest_my_laundry(uuid) TO authenticated, service_role;
