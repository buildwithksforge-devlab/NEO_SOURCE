-- Front Office connected workflow fixes — certification 2026-09-24

CREATE OR REPLACE FUNCTION public.neo_guest_create_request(
  _org uuid, _category text, _description text, _priority text DEFAULT 'normal'
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  uid uuid := auth.uid();
  c public.customers;
  res record;
  new_id uuid;
BEGIN
  IF uid IS NULL THEN RAISE EXCEPTION 'Authentication required'; END IF;
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
   WHERE r.organization_id = _org
     AND (r.customer_id = c.id OR v.id IS NOT NULL)
     AND r.status IN ('checked_in','in_house','checked-in','in-house')
   ORDER BY r.arrival_date DESC
   LIMIT 1;

  INSERT INTO public.guest_requests (
    organization_id, branch_id, reservation_id, stay_id, customer_id, room_id,
    category, description, priority, status, request_type, created_by)
  VALUES (
    _org, COALESCE(res.branch_id, c.primary_branch_id), res.id, res.stay_id, c.id, res.room_id,
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

CREATE OR REPLACE FUNCTION public.neo_guest_room_offers(
  _org uuid, _branch uuid, _arrival date, _departure date,
  _adults integer DEFAULT 1, _children integer DEFAULT 0)
RETURNS TABLE(
  room_type_id uuid, room_type_name text, description text, max_occupancy integer,
  amenities jsonb, rooms_available integer, rate_plan_id uuid, rate_plan_name text,
  nightly_rate numeric, currency text, tax_rate numeric, service_charge_rate numeric,
  nights integer, total_amount numeric)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _nights integer;
BEGIN
  IF _org IS NULL OR _branch IS NULL THEN RETURN; END IF;
  IF _arrival IS NULL OR _departure IS NULL OR _departure <= _arrival THEN RETURN; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.branches b WHERE b.id = _branch AND b.organization_id = _org) THEN RETURN; END IF;
  _nights := (_departure - _arrival);

  RETURN QUERY
  WITH bounds AS (SELECT _arrival AS a, _departure AS d),
  types AS (
    SELECT rt.id, rt.name, rt.description, rt.max_occupancy,
           to_jsonb(COALESCE(rt.amenities, ARRAY[]::text[])) AS amenities
      FROM public.room_types rt
     WHERE rt.organization_id = _org
       AND rt.branch_id = _branch
       AND COALESCE(rt.status,'active') = 'active'
       AND COALESCE(rt.max_occupancy, 99) >= (COALESCE(_adults,1) + COALESCE(_children,0))
  ),
  candidates AS (
    SELECT r.id, r.room_type_id AS rt_id,
           row_number() OVER (PARTITION BY r.room_type_id ORDER BY r.room_number DESC) AS rn
      FROM public.rooms r
      JOIN types t ON t.id = r.room_type_id
      CROSS JOIN bounds
     WHERE r.organization_id = _org
       AND r.branch_id = _branch
       AND r.status = 'active'
       AND r.maintenance_status = 'operational'
       AND (bounds.a > current_date
            OR (public.hk_canonical_condition(r.housekeeping_status) IN ('clean','inspected')
                AND coalesce(r.inspection_status,'not-required') IN ('not-required','passed')
                AND coalesce(r.occupancy_status,'vacant') = 'vacant'))
       AND NOT (r.out_of_order_from IS NOT NULL
                AND daterange(r.out_of_order_from, coalesce(r.out_of_order_to,'infinity'::date), '[]')
                    && daterange(bounds.a, bounds.d, '[)'))
       AND NOT EXISTS (
         SELECT 1 FROM public.reservations res
          WHERE res.room_id = r.id
            AND res.status IN ('confirmed','guaranteed','checked-in','in-house')
            AND daterange(res.arrival_date, res.departure_date, '[)') && daterange(bounds.a, bounds.d, '[)'))
       AND NOT EXISTS (
         SELECT 1 FROM public.room_assignments a
          WHERE a.room_id = r.id AND a.status = 'active'
            AND daterange(a.start_date, a.end_date, '[)') && daterange(bounds.a, bounds.d, '[)'))
       AND NOT EXISTS (
         SELECT 1 FROM public.room_blocks bl
          WHERE bl.room_id = r.id AND bl.status = 'active'
            AND daterange(bl.start_date, bl.end_date, '[]') && daterange(bounds.a, bounds.d, '[)'))
       AND NOT EXISTS (
         SELECT 1 FROM public.reservation_holds h
          WHERE h.room_id = r.id AND h.status = 'active' AND h.hold_expires_at > now()
            AND daterange(h.arrival_date, h.departure_date, '[)') && daterange(bounds.a, bounds.d, '[)'))
  ),
  held AS (
    SELECT gb.room_type_id AS rt_id,
           COALESCE(sum(GREATEST(gb.rooms_blocked - gb.rooms_picked_up - gb.rooms_released,0)),0)::int AS qty
      FROM public.group_room_blocks gb
      JOIN public.group_bookings g ON g.id = gb.group_booking_id
      CROSS JOIN bounds
     WHERE gb.status = 'active' AND g.organization_id = _org AND g.branch_id = _branch
       AND g.status NOT IN ('cancelled','closed')
       AND daterange(gb.start_date, gb.end_date, '[]') && daterange(bounds.a, bounds.d, '[)')
     GROUP BY gb.room_type_id
  ),
  demand AS (
    SELECT res.room_type_id AS rt_id, count(*)::int AS qty
      FROM public.reservations res
      CROSS JOIN bounds
     WHERE res.organization_id = _org AND res.branch_id = _branch
       AND res.room_id IS NULL AND res.room_type_id IS NOT NULL
       AND res.status IN ('confirmed','guaranteed')
       AND daterange(res.arrival_date, res.departure_date, '[)') && daterange(bounds.a, bounds.d, '[)')
     GROUP BY res.room_type_id
  ),
  avail AS (
    SELECT t.id,
           (SELECT count(*) FROM candidates c
             LEFT JOIN held h ON h.rt_id = c.rt_id
             LEFT JOIN demand dm ON dm.rt_id = c.rt_id
            WHERE c.rt_id = t.id AND c.rn > COALESCE(h.qty,0) + COALESCE(dm.qty,0))::integer AS free
      FROM types t
  ),
  plan AS (
    SELECT DISTINCT ON (rp.room_type_id)
           rp.room_type_id, rp.id, rp.name, rp.base_rate, rp.currency,
           COALESCE(rp.tax_rate,0) AS tax_rate, COALESCE(rp.service_charge_rate,0) AS service_charge_rate,
           COALESCE(rp.tax_treatment,'exclusive') AS tax_treatment
      FROM public.rate_plans rp
     WHERE rp.organization_id = _org
       AND rp.branch_id = _branch
       AND COALESCE(rp.status,'active') = 'active'
       AND (rp.valid_from IS NULL OR rp.valid_from <= _arrival)
       AND (rp.valid_to IS NULL OR rp.valid_to >= _departure)
       AND rp.room_type_id IS NOT NULL
     ORDER BY rp.room_type_id, rp.base_rate ASC NULLS LAST
  )
  SELECT t.id, t.name, t.description, t.max_occupancy, t.amenities,
         a.free,
         p.id, p.name,
         COALESCE(p.base_rate,0),
         COALESCE(p.currency,'KES'),
         COALESCE(p.tax_rate,0),
         COALESCE(p.service_charge_rate,0),
         _nights,
         CASE WHEN lower(COALESCE(p.tax_treatment,'exclusive')) = 'exclusive'
              THEN ROUND(COALESCE(p.base_rate,0) * _nights
                     * (1 + COALESCE(p.service_charge_rate,0)/100)
                     * (1 + COALESCE(p.tax_rate,0)/100), 2)
              ELSE ROUND(COALESCE(p.base_rate,0) * _nights, 2) END
    FROM types t
    JOIN avail a ON a.id = t.id
    LEFT JOIN plan p ON p.room_type_id = t.id
   WHERE a.free > 0
   ORDER BY COALESCE(p.base_rate, 0) ASC, t.name;
END;
$$;

CREATE OR REPLACE FUNCTION public.neo_minibar_post(_folio uuid, _location uuid, _lines jsonb, _room uuid DEFAULT NULL::uuid, _notes text DEFAULT NULL::text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  v_folio public.folios;
  v_loc public.stock_locations;
  v_posting uuid := gen_random_uuid();
  v_number text;
  v_line jsonb; v_idx integer := 0;
  v_menu public.menu_items;
  v_recipe public.recipes;
  v_stock public.stock_items;
  v_item uuid; v_qty numeric; v_price numeric; v_unit text; v_desc text;
  v_total numeric := 0; v_lines integer := 0;
  v_charge uuid; v_actor text;
  v_mode text; v_components jsonb; v_comp record; v_comp_idx integer;
  v_line_location uuid; v_ml numeric; v_batches numeric; v_store_name text; v_note text;
BEGIN
  SELECT * INTO v_folio FROM public.folios WHERE id = _folio;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'reason', 'folio_not_found'); END IF;
  IF v_folio.organization_id IS DISTINCT FROM public.current_org_id() THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'forbidden');
  END IF;
  IF NOT public.has_permission('front-office', 'folios', 'create') THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_permitted');
  END IF;
  IF v_folio.status <> 'open' THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'folio_not_open', 'status', v_folio.status);
  END IF;

  SELECT * INTO v_loc FROM public.stock_locations WHERE id = _location;
  IF v_loc IS NULL OR v_loc.organization_id IS DISTINCT FROM v_folio.organization_id THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'location_not_found');
  END IF;
  IF _lines IS NULL OR jsonb_array_length(_lines) = 0 THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'no_lines');
  END IF;

  -- Minibar itself is the authorised workflow actor for stock/folio side effects.
  PERFORM set_config('neo.system_posting', 'on', true);

  SELECT 'MB-' || to_char(now(), 'YYMM') || '-' ||
         lpad((count(*) + 1)::text, 5, '0') INTO v_number
    FROM public.minibar_postings
   WHERE organization_id = v_folio.organization_id;

  SELECT COALESCE(p.full_name, p.email) INTO v_actor FROM public.profiles p WHERE p.id = auth.uid();

  INSERT INTO public.minibar_postings (id, organization_id, branch_id, posting_number, folio_id, room_id,
                                       location_id, currency, notes, posted_by)
  VALUES (v_posting, v_folio.organization_id, v_folio.branch_id, v_number, _folio, _room, _location,
          v_folio.currency, _notes, auth.uid());

  FOR v_line IN SELECT * FROM jsonb_array_elements(_lines)
  LOOP
    v_idx := v_idx + 1;
    v_qty := COALESCE((v_line->>'quantity')::numeric, 0);
    IF v_qty <= 0 THEN
      RAISE EXCEPTION 'Minibar line % has no quantity', v_idx USING ERRCODE = 'data_exception';
    END IF;

    v_menu := NULL; v_recipe := NULL; v_stock := NULL; v_components := NULL;
    IF v_line ? 'menu_item_id' AND NULLIF(v_line->>'menu_item_id', '') IS NOT NULL THEN
      SELECT * INTO v_menu FROM public.menu_items
       WHERE id = (v_line->>'menu_item_id')::uuid AND organization_id = v_folio.organization_id;
      IF v_menu IS NULL THEN
        RAISE EXCEPTION 'Minibar line % refers to an unknown menu item', v_idx USING ERRCODE = 'data_exception';
      END IF;
      SELECT * INTO v_recipe FROM public.recipes
       WHERE organization_id = v_folio.organization_id
         AND menu_item_id = v_menu.id
         AND recipe_type IN ('menu_item','direct_sale')
         AND status = 'active'
       ORDER BY (recipe_type = 'menu_item') DESC, version DESC LIMIT 1;
    END IF;

    v_price := COALESCE(NULLIF(v_line->>'unit_price', '')::numeric, v_menu.base_price);
    IF v_price IS NULL THEN
      RAISE EXCEPTION 'Minibar line % has no price', v_idx USING ERRCODE = 'data_exception';
    END IF;

    -- Which consumption model applies: an explicit stock item, the menu item's
    -- own mode, or the recipe attached to it. Never guessed.
    v_item := NULLIF(v_line->>'stock_item_id', '')::uuid;
    v_mode := COALESCE(NULLIF(v_menu.consumption_mode, ''), 'none');
    IF v_item IS NOT NULL THEN
      v_mode := 'direct_stock';
    ELSIF v_mode = 'none' AND v_recipe IS NOT NULL THEN
      v_mode := CASE WHEN v_recipe.recipe_type = 'direct_sale' THEN 'direct_stock' ELSE 'recipe' END;
    END IF;

    IF v_mode IN ('direct_stock','batch') THEN
      v_item := COALESCE(v_item, v_menu.stock_item_id, v_recipe.output_stock_item_id);
      IF v_item IS NULL THEN
        RAISE EXCEPTION 'Minibar line % (%) is not mapped to a stock item', v_idx,
          COALESCE(v_menu.name, 'item') USING ERRCODE = 'data_exception';
      END IF;
      SELECT * INTO v_stock FROM public.stock_items
       WHERE id = v_item AND organization_id = v_folio.organization_id;
      IF v_stock IS NULL THEN
        RAISE EXCEPTION 'Minibar line % refers to an unknown stock item', v_idx USING ERRCODE = 'data_exception';
      END IF;
      v_unit := COALESCE(NULLIF(v_line->>'unit', ''), NULLIF(v_menu.stock_unit, ''),
                         NULLIF(v_recipe.yield_unit, ''), v_stock.base_unit, 'unit');
      v_components := jsonb_build_array(jsonb_build_object(
        'item_id', v_item,
        'qty', public.inventory_round_for_item(
                 v_qty * COALESCE(NULLIF(v_menu.stock_quantity_per_sale, 0),
                                  NULLIF(v_recipe.yield_quantity, 0), 1), v_unit, v_item),
        'unit', v_unit,
        'kind', 'use'));
    ELSIF v_mode = 'recipe' THEN
      IF v_recipe IS NULL OR COALESCE(v_recipe.yield_quantity, 0) <= 0 THEN
        RAISE EXCEPTION 'Minibar line % (%) has no usable recipe', v_idx,
          COALESCE(v_menu.name, 'item') USING ERRCODE = 'data_exception';
      END IF;
      v_batches := v_qty / v_recipe.yield_quantity;
      SELECT COALESCE(jsonb_agg(jsonb_build_object(
               'item_id', x.stock_item_id, 'qty', x.qty, 'unit', x.unit, 'kind', x.kind)), '[]'::jsonb)
        INTO v_components
        FROM (SELECT e.stock_item_id, e.kind, sum(e.quantity) AS qty, min(e.unit) AS unit
                FROM public.recipe_expand_to_stock_kinds(v_recipe.id, v_batches, v_folio.branch_id) e
               GROUP BY e.stock_item_id, e.kind) x;
      IF v_components IS NULL OR jsonb_array_length(v_components) = 0 THEN
        RAISE EXCEPTION 'Minibar line % (%) has a recipe with no ingredients', v_idx,
          COALESCE(v_menu.name, 'item') USING ERRCODE = 'data_exception';
      END IF;
      v_item := COALESCE(v_menu.stock_item_id, (v_components->0->>'item_id')::uuid);
      v_unit := COALESCE(NULLIF(v_line->>'unit', ''), NULLIF(v_recipe.yield_unit, ''), 'unit');
    ELSE
      RAISE EXCEPTION 'Minibar line % (%) is not mapped to stock', v_idx,
        COALESCE(v_menu.name, 'item') USING ERRCODE = 'data_exception';
    END IF;

    v_desc := COALESCE(NULLIF(v_line->>'description', ''), v_menu.name, 'Minibar item');

    v_comp_idx := 0;
    FOR v_comp IN
      SELECT (e->>'item_id')::uuid AS item_id, (e->>'qty')::numeric AS qty, e->>'unit' AS unit,
             COALESCE(e->>'kind','use') AS kind
        FROM jsonb_array_elements(v_components) e
    LOOP
      v_comp_idx := v_comp_idx + 1;
      SELECT * INTO v_stock FROM public.stock_items WHERE id = v_comp.item_id;
      IF v_stock IS NULL THEN
        RAISE EXCEPTION 'Minibar line % refers to an unknown stock item', v_idx USING ERRCODE = 'data_exception';
      END IF;

      v_line_location := COALESCE(
        v_menu.issuing_location_id,
        public.neo_item_group_store(v_folio.organization_id, v_comp.item_id, v_folio.branch_id),
        _location);
      SELECT sl.name INTO v_store_name FROM public.stock_locations sl WHERE sl.id = v_line_location;

      v_note := CASE WHEN v_comp.kind = 'waste' THEN 'Minibar wastage allowance · ' ELSE 'Minibar ' END
                || v_number || ' · ' || v_desc
                || ' · folio ' || COALESCE(v_folio.folio_number, _folio::text)
                || CASE WHEN v_store_name IS NOT NULL THEN ' · from ' || v_store_name ELSE '' END
                || CASE WHEN v_actor IS NOT NULL THEN ' · recorded by ' || v_actor ELSE '' END;

      IF lower(COALESCE(v_comp.unit,'')) IN ('ml','millilitre','millilitres','cl','l','litre','litres')
         AND COALESCE(v_stock.tracking_method,'whole') IN ('volume','both')
         AND COALESCE(v_stock.container_volume_ml,0) > 0 THEN
        v_ml := v_comp.qty * CASE lower(v_comp.unit)
                               WHEN 'cl' THEN 10
                               WHEN 'l' THEN 1000 WHEN 'litre' THEN 1000 WHEN 'litres' THEN 1000
                               ELSE 1 END;
        PERFORM public.inventory_consume_volume(
          v_comp.item_id, v_line_location, v_ml, v_note,
          CASE WHEN v_comp.kind = 'waste' THEN 'wastage' ELSE 'pour' END,
          'minibar_posting', v_posting,
          'minibar-pour:' || v_posting::text || ':' || v_idx::text || ':' || v_comp.item_id::text
            || ':' || v_comp.kind);
      ELSE
        PERFORM public.inventory_apply_movement(
          v_comp.item_id, v_line_location, -v_comp.qty,
          COALESCE(NULLIF(v_comp.unit,''), v_stock.base_unit, 'unit'),
          CASE WHEN v_comp.kind = 'waste' THEN 'wastage' ELSE 'consumption' END,
          COALESCE(v_stock.average_cost, 0),
          'minibar_posting', v_posting, v_note,
          'minibar:' || v_posting::text || ':' || v_idx::text || ':' || v_comp.item_id::text
            || ':' || v_comp.kind, NULL, NULL);
      END IF;

      PERFORM public.neo_evaluate_low_stock(v_folio.organization_id, v_folio.branch_id,
                                            v_comp.item_id, 'minibar', v_posting);
    END LOOP;

    v_charge := public.folio_post_charge(
      _folio, 'minibar', v_desc, v_qty, v_price, 0, 0, 0,
      'minibar', v_posting, 'minibar',
      'minibar:' || v_posting::text || ':' || v_idx::text, NULL);

    INSERT INTO public.minibar_posting_lines (organization_id, posting_id, menu_item_id, stock_item_id,
                                              description, quantity, unit, unit_price, amount, folio_line_id)
    VALUES (v_folio.organization_id, v_posting, v_menu.id, v_item, v_desc, v_qty,
            COALESCE(v_unit, 'unit'), v_price, v_qty * v_price, v_charge);

    v_total := v_total + v_qty * v_price;
    v_lines := v_lines + 1;
  END LOOP;

  UPDATE public.minibar_postings SET total_amount = v_total, updated_at = now() WHERE id = v_posting;

  INSERT INTO public.audit_logs (organization_id, branch_id, user_id, action, module, record_id, new_value)
  VALUES (v_folio.organization_id, v_folio.branch_id, auth.uid(), 'pms.minibar.posted', 'front-office',
          v_posting::text,
          jsonb_build_object('posting_number', v_number, 'folio_id', _folio, 'room_id', _room,
                             'location_id', _location, 'lines', v_lines, 'total', v_total,
                             'posted_by', COALESCE(v_actor, 'system')));

  PERFORM set_config('neo.system_posting', 'off', true);
  RETURN jsonb_build_object('ok', true, 'posting_id', v_posting, 'posting_number', v_number,
                            'lines', v_lines, 'total', v_total);
END;
$function$;

CREATE OR REPLACE FUNCTION public.pms_group_record_deposit(_group uuid, _amount numeric, _method text, _reference text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE g public.group_bookings; _folio uuid; _pay uuid; _idem text;
BEGIN
  IF COALESCE(_amount,0) <= 0 THEN RAISE EXCEPTION 'Deposit amount must be greater than zero'; END IF;
  SELECT * INTO g FROM public.group_bookings WHERE id=_group AND organization_id=public.current_org_id();
  IF g.id IS NULL THEN RAISE EXCEPTION 'Group not found'; END IF;
  _folio := public.pms_group_master_folio(_group);
  _idem := 'group-deposit:'||_group::text||':'||COALESCE(NULLIF(btrim(_reference),''), _amount::text||':'||now()::date::text);
  INSERT INTO public.payments (organization_id, branch_id, folio_id, customer_id, amount, method,
                               external_reference, status, received_by, source_module, source_record_id,
                               idempotency_key, notes)
  VALUES (g.organization_id, g.branch_id, _folio, g.contact_customer_id, _amount, COALESCE(_method,'cash'),
          NULLIF(_reference,''), 'confirmed', auth.uid(), 'pms.groups', _group, _idem, 'Group deposit')
  ON CONFLICT (organization_id, idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING
  RETURNING id INTO _pay;
  IF _pay IS NULL THEN RETURN jsonb_build_object('duplicate', true, 'folio_id', _folio); END IF;
  UPDATE public.group_bookings SET deposit_paid = COALESCE(deposit_paid,0) + _amount, updated_at=now() WHERE id=g.id;
  INSERT INTO public.group_block_events (organization_id, group_booking_id, event_type, new_value, actor_id, reason)
  VALUES (g.organization_id, g.id, 'deposit',
          jsonb_build_object('amount', _amount, 'method', _method, 'payment', _pay), auth.uid(), 'Group deposit received');
  RETURN jsonb_build_object('payment_id', _pay, 'folio_id', _folio);
END; $$;

CREATE OR REPLACE FUNCTION public.neo_department_requisition_create(
  _branch uuid,
  _lines jsonb,
  _department uuid DEFAULT NULL,
  _required_date date DEFAULT NULL,
  _priority text DEFAULT 'normal',
  _reason text DEFAULT NULL,
  _destination uuid DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_org uuid := current_org_id();
  v_req uuid;
  v_line jsonb;
  v_count int := 0;
  v_number text;
  v_status text;
  v_dest uuid := _destination;
  v_self boolean := public.neo_requisition_supervisor_authority();
BEGIN
  IF v_org IS NULL THEN RAISE EXCEPTION 'No organisation context'; END IF;
  IF NOT (has_permission('restaurant','requisitions.create')
          OR has_permission('restaurant','create')
          OR has_permission('stores','create')
          OR has_permission('pms','requisitions.create')
          OR has_permission('front-office','requisitions','create')
          OR is_org_admin()) THEN
    RAISE EXCEPTION 'Not permitted to raise a requisition';
  END IF;
  IF _branch IS NULL OR NOT (_branch = ANY (current_branch_ids())) THEN
    RAISE EXCEPTION 'Requisitions may only be raised for your own property';
  END IF;
  IF _lines IS NULL OR jsonb_array_length(_lines) = 0 THEN
    RAISE EXCEPTION 'Add at least one item';
  END IF;

  IF v_dest IS NOT NULL THEN
    IF NOT EXISTS (SELECT 1 FROM public.stock_locations sl
                    WHERE sl.id = v_dest AND sl.organization_id = v_org
                      AND (sl.branch_id IS NULL OR sl.branch_id = _branch)) THEN
      RAISE EXCEPTION 'The receiving store must belong to this property';
    END IF;
  ELSIF _department IS NOT NULL THEN
    SELECT sl.id INTO v_dest
      FROM public.stock_locations sl
     WHERE sl.organization_id = v_org
       AND sl.department_id = _department
       AND sl.is_mini_store
       AND sl.active
       AND (sl.branch_id IS NULL OR sl.branch_id = _branch)
     ORDER BY sl.created_at
     LIMIT 1;
  END IF;

  v_number := 'REQ-' || to_char(now(), 'YYMMDD') || '-' || upper(substr(replace(gen_random_uuid()::text,'-',''), 1, 5));
  v_status := CASE WHEN v_self THEN 'awaiting-stores' ELSE 'pending-supervisor' END;

  INSERT INTO public.internal_requisitions
    (organization_id, branch_id, request_number, department_id, destination_location_id,
     fulfilment_model, requested_by, request_date, required_date, priority, reason, status,
     supervisor_approved_by, supervisor_approved_at)
  VALUES (v_org, _branch, v_number, _department, v_dest,
          'stores-issue', auth.uid(), current_date, _required_date,
          coalesce(_priority, 'normal'), _reason, v_status,
          CASE WHEN v_self THEN auth.uid() END,
          CASE WHEN v_self THEN now() END)
  RETURNING id INTO v_req;

  FOR v_line IN SELECT * FROM jsonb_array_elements(_lines) LOOP
    IF coalesce((v_line->>'quantity_requested')::numeric, 0) <= 0 THEN CONTINUE; END IF;
    INSERT INTO public.internal_requisition_lines
      (organization_id, requisition_id, stock_item_id, description, unit, quantity_requested, notes)
    VALUES (v_org, v_req,
            nullif(v_line->>'stock_item_id','')::uuid,
            nullif(v_line->>'description',''),
            nullif(v_line->>'unit',''),
            (v_line->>'quantity_requested')::numeric,
            nullif(v_line->>'notes',''));
    v_count := v_count + 1;
  END LOOP;

  IF v_count = 0 THEN RAISE EXCEPTION 'Add at least one item with a quantity'; END IF;

  PERFORM public.neo_notify(v_org, NULL, _branch, 'operational-alert',
    CASE WHEN v_self THEN 'Requisition awaiting Stores — ' || v_number
         ELSE 'Requisition awaiting departmental approval — ' || v_number END,
    coalesce(_reason, 'A department has requested stock from Stores.'),
    '/inventory/requisitions', coalesce(_priority,'normal'), true,
    'stores', v_req, 'stores.requisition_raised', 'req:' || v_req::text || ':raised');

  RETURN jsonb_build_object('ok', true, 'requisition_id', v_req,
                            'request_number', v_number, 'lines', v_count,
                            'destination_location_id', v_dest,
                            'status', v_status);
END;
$$;

CREATE OR REPLACE FUNCTION public.pms_waitlist_create(_payload jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_org uuid := public.current_org_id(); v_branch uuid := nullif(_payload->>'branch_id','')::uuid; v_id uuid;
BEGIN
  IF v_org IS NULL THEN RAISE EXCEPTION 'No organisation context'; END IF;
  IF NOT (public.has_permission('front-office','waitlist','create') OR public.has_permission('pms','write') OR public.is_org_admin()) THEN RAISE EXCEPTION 'Not permitted to add guests to the waitlist'; END IF;
  IF v_branch IS NULL OR NOT (v_branch = ANY(public.current_branch_ids())) THEN RAISE EXCEPTION 'Waitlist entry must belong to your property'; END IF;
  IF coalesce(btrim(_payload->>'contact_name'),'')='' THEN RAISE EXCEPTION 'Guest/contact name is required'; END IF;
  IF nullif(_payload->>'arrival_date','')::date IS NULL OR nullif(_payload->>'departure_date','')::date IS NULL OR (_payload->>'departure_date')::date <= (_payload->>'arrival_date')::date THEN RAISE EXCEPTION 'Choose a valid stay date range'; END IF;
  INSERT INTO public.waitlist_entries(organization_id,branch_id,customer_id,arrival_date,departure_date,room_type_id,rate_plan_id,adults,children,rate_preference,contact_method,priority,expires_on,notes,status,contact_name,contact_phone,contact_email,created_by)
  VALUES(v_org,v_branch,nullif(_payload->>'customer_id','')::uuid,(_payload->>'arrival_date')::date,(_payload->>'departure_date')::date,nullif(_payload->>'room_type_id','')::uuid,nullif(_payload->>'rate_plan_id','')::uuid,greatest(coalesce(nullif(_payload->>'adults','')::int,1),1),greatest(coalesce(nullif(_payload->>'children','')::int,0),0),nullif(_payload->>'rate_preference',''),coalesce(nullif(_payload->>'contact_method',''),'phone'),coalesce(nullif(_payload->>'priority',''),'normal'),nullif(_payload->>'expires_on','')::date,nullif(_payload->>'notes',''),'waiting',btrim(_payload->>'contact_name'),nullif(btrim(coalesce(_payload->>'contact_phone','')),''),nullif(btrim(coalesce(_payload->>'contact_email','')),''),auth.uid()) RETURNING id INTO v_id;
  INSERT INTO public.waitlist_events(organization_id,waitlist_entry_id,event_type,new_value,actor_id,reason) VALUES(v_org,v_id,'created',jsonb_build_object('status','waiting','branch_id',v_branch),auth.uid(),'Front Office waitlist entry created');
  RETURN jsonb_build_object('ok',true,'id',v_id);
END; $$;

CREATE OR REPLACE FUNCTION public.pms_group_create(_payload jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_org uuid := public.current_org_id(); v_branch uuid := nullif(_payload->>'branch_id','')::uuid; v_id uuid; v_ref text;
BEGIN
  IF v_org IS NULL THEN RAISE EXCEPTION 'No organisation context'; END IF;
  IF NOT (public.has_permission('front-office','groups','create') OR public.has_permission('pms','write') OR public.is_org_admin()) THEN RAISE EXCEPTION 'Not permitted to create group bookings'; END IF;
  IF v_branch IS NULL OR NOT (v_branch = ANY(public.current_branch_ids())) THEN RAISE EXCEPTION 'Group booking must belong to your property'; END IF;
  IF coalesce(btrim(_payload->>'name'),'')='' THEN RAISE EXCEPTION 'Group name is required'; END IF;
  IF nullif(_payload->>'arrival_date','')::date IS NULL OR nullif(_payload->>'departure_date','')::date IS NULL OR (_payload->>'departure_date')::date <= (_payload->>'arrival_date')::date THEN RAISE EXCEPTION 'Choose a valid group stay date range'; END IF;
  v_ref := 'GRP-' || to_char(now(),'YYMMDD') || '-' || upper(substr(replace(gen_random_uuid()::text,'-',''),1,5));
  INSERT INTO public.group_bookings(organization_id,branch_id,reference,name,group_type,organizer,corporate_account_id,contact_customer_id,arrival_date,departure_date,rooms_count,guests_count,cutoff_date,rate_plan_id,meal_plan_id,deposit_policy,billing_instructions,status,deposit_required,deposit_paid,cancellation_terms,created_by)
  VALUES(v_org,v_branch,v_ref,btrim(_payload->>'name'),coalesce(nullif(_payload->>'group_type',''),'group'),nullif(btrim(coalesce(_payload->>'organizer','')),''),nullif(_payload->>'corporate_account_id','')::uuid,nullif(_payload->>'contact_customer_id','')::uuid,(_payload->>'arrival_date')::date,(_payload->>'departure_date')::date,greatest(coalesce(nullif(_payload->>'rooms_count','')::int,0),0),greatest(coalesce(nullif(_payload->>'guests_count','')::int,0),0),nullif(_payload->>'cutoff_date','')::date,nullif(_payload->>'rate_plan_id','')::uuid,nullif(_payload->>'meal_plan_id','')::uuid,nullif(_payload->>'deposit_policy',''),nullif(_payload->>'billing_instructions',''),coalesce(nullif(_payload->>'status',''),'tentative'),coalesce(nullif(_payload->>'deposit_required','')::numeric,0),0,nullif(_payload->>'cancellation_terms',''),auth.uid()) RETURNING id INTO v_id;
  INSERT INTO public.group_block_events(organization_id,group_booking_id,event_type,new_value,actor_id,reason) VALUES(v_org,v_id,'created',jsonb_build_object('reference',v_ref,'status',coalesce(nullif(_payload->>'status',''),'tentative')),auth.uid(),'Group booking created');
  RETURN jsonb_build_object('ok',true,'id',v_id,'reference',v_ref);
END; $$;

REVOKE ALL ON FUNCTION public.pms_waitlist_create(jsonb) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.pms_group_create(jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.pms_waitlist_create(jsonb) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.pms_group_create(jsonb) TO authenticated, service_role;
