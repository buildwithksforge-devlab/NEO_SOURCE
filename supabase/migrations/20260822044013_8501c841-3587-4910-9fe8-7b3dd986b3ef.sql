
CREATE OR REPLACE FUNCTION public.pms_group_convert_rooming(_row uuid, _room uuid DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE r public.group_rooming_list; g public.group_bookings; b public.group_room_blocks;
        _cust uuid; _res uuid; _conf text; _org uuid := public.current_org_id();
BEGIN
  SELECT * INTO r FROM public.group_rooming_list WHERE id=_row AND organization_id=_org;
  IF r.id IS NULL THEN RAISE EXCEPTION 'Rooming list row not found'; END IF;
  IF r.reservation_id IS NOT NULL THEN
    RETURN jsonb_build_object('reservation_id', r.reservation_id, 'already', true);
  END IF;
  SELECT * INTO g FROM public.group_bookings WHERE id=r.group_booking_id;
  IF g.status IN ('cancelled','released') THEN RAISE EXCEPTION 'Group is % and cannot take new rooms', g.status; END IF;
  SELECT * INTO b FROM public.group_room_blocks WHERE id=r.block_id;
  IF b.id IS NOT NULL AND COALESCE(b.rooms_picked_up,0) >= COALESCE(b.rooms_blocked,0) THEN
    RAISE EXCEPTION 'The block for this room type is fully picked up';
  END IF;

  _cust := r.customer_id;
  IF _cust IS NULL AND COALESCE(btrim(r.guest_name),'') <> '' THEN
    INSERT INTO public.customers (organization_id, branch_id, full_name, email, phone, customer_type)
    VALUES (_org, r.branch_id, r.guest_name, NULLIF(r.email,''), NULLIF(r.phone,''), 'individual')
    RETURNING id INTO _cust;
  END IF;

  _conf := 'GRP-' || upper(substr(replace(gen_random_uuid()::text,'-',''),1,8));
  INSERT INTO public.reservations (
    organization_id, branch_id, confirmation_number, customer_id, corporate_account_id,
    group_booking_id, booking_source, reservation_type, arrival_date, departure_date,
    adults, children, room_type_id, room_id, rate_plan_id, meal_plan_id,
    nightly_rate, special_requests, status, created_by, idempotency_key)
  VALUES (_org, COALESCE(r.branch_id,g.branch_id), _conf, _cust, g.corporate_account_id,
    g.id, 'group', 'group', r.arrival_date, r.departure_date,
    COALESCE(r.adults,1), COALESCE(r.children,0), r.room_type_id, _room,
    COALESCE(b.rate_plan_id, g.rate_plan_id), COALESCE(b.meal_plan_id, g.meal_plan_id),
    CASE WHEN r.complimentary THEN 0 ELSE COALESCE(b.rate_amount,0) END,
    r.special_requests, 'confirmed', auth.uid(), 'rooming:'||r.id::text)
  RETURNING id INTO _res;

  UPDATE public.group_rooming_list
     SET reservation_id=_res, room_id=_room, status='confirmed', updated_at=now() WHERE id=r.id;
  IF b.id IS NOT NULL THEN
    UPDATE public.group_room_blocks
       SET rooms_picked_up = COALESCE(rooms_picked_up,0)+1, updated_at=now() WHERE id=b.id;
  END IF;
  INSERT INTO public.group_block_events (organization_id, group_booking_id, block_id, event_type, new_value, actor_id, reason)
  VALUES (_org, g.id, b.id, 'pickup',
          jsonb_build_object('rooming_row', r.id, 'reservation', _res, 'guest', r.guest_name), auth.uid(),
          'Rooming list conversion');
  RETURN jsonb_build_object('reservation_id', _res, 'confirmation_number', _conf);
END; $$;

CREATE OR REPLACE FUNCTION public.pms_group_release_block(_block uuid, _reason text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE b public.group_room_blocks; _free int;
BEGIN
  IF COALESCE(btrim(_reason),'') = '' THEN RAISE EXCEPTION 'A release reason is required'; END IF;
  SELECT * INTO b FROM public.group_room_blocks WHERE id=_block AND organization_id=public.current_org_id();
  IF b.id IS NULL THEN RAISE EXCEPTION 'Block not found'; END IF;
  IF b.status = 'released' THEN RETURN jsonb_build_object('released', 0, 'already', true); END IF;
  _free := GREATEST(COALESCE(b.rooms_blocked,0) - COALESCE(b.rooms_picked_up,0), 0);
  UPDATE public.group_room_blocks
     SET rooms_released = COALESCE(rooms_released,0) + _free,
         rooms_blocked = COALESCE(rooms_picked_up,0),
         status = 'released', released_at = now(), release_reason = _reason, updated_at = now()
   WHERE id = b.id;
  INSERT INTO public.group_block_events (organization_id, group_booking_id, block_id, event_type, previous_value, new_value, actor_id, reason)
  VALUES (b.organization_id, b.group_booking_id, b.id, 'release',
          jsonb_build_object('rooms_blocked', b.rooms_blocked),
          jsonb_build_object('rooms_released', _free), auth.uid(), _reason);
  RETURN jsonb_build_object('released', _free);
END; $$;

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
          NULLIF(_reference,''), 'confirmed', auth.uid(), 'pms.groups', _group::text, _idem, 'Group deposit')
  ON CONFLICT (organization_id, idempotency_key) DO NOTHING
  RETURNING id INTO _pay;
  IF _pay IS NULL THEN RETURN jsonb_build_object('duplicate', true, 'folio_id', _folio); END IF;
  UPDATE public.group_bookings SET deposit_paid = COALESCE(deposit_paid,0) + _amount, updated_at=now() WHERE id=g.id;
  INSERT INTO public.group_block_events (organization_id, group_booking_id, event_type, new_value, actor_id, reason)
  VALUES (g.organization_id, g.id, 'deposit',
          jsonb_build_object('amount', _amount, 'method', _method, 'payment', _pay), auth.uid(), 'Group deposit received');
  RETURN jsonb_build_object('payment_id', _pay, 'folio_id', _folio);
END; $$;
