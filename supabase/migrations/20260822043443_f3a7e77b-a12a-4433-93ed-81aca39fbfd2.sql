
-- ============ GROUPS ============
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
  INSERT INTO public.group_block_events (organization_id, group_booking_id, block_id, event_type, detail, actor_id)
  VALUES (_org, g.id, b.id, 'pickup',
          jsonb_build_object('rooming_row', r.id, 'reservation', _res, 'guest', r.guest_name), auth.uid());
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
  INSERT INTO public.group_block_events (organization_id, group_booking_id, block_id, event_type, detail, actor_id)
  VALUES (b.organization_id, b.group_booking_id, b.id, 'release',
          jsonb_build_object('rooms_released', _free, 'reason', _reason), auth.uid());
  RETURN jsonb_build_object('released', _free);
END; $$;

CREATE OR REPLACE FUNCTION public.pms_group_master_folio(_group uuid)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE g public.group_bookings; _f uuid;
BEGIN
  SELECT * INTO g FROM public.group_bookings WHERE id=_group AND organization_id=public.current_org_id();
  IF g.id IS NULL THEN RAISE EXCEPTION 'Group not found'; END IF;
  IF g.master_folio_id IS NOT NULL THEN RETURN g.master_folio_id; END IF;
  INSERT INTO public.folios (organization_id, branch_id, folio_number, folio_type, group_booking_id,
                             corporate_account_id, customer_id, status, billing_instructions, created_by)
  VALUES (g.organization_id, g.branch_id,
          'GM-'||upper(substr(replace(gen_random_uuid()::text,'-',''),1,8)),
          'master', g.id, g.corporate_account_id, g.contact_customer_id, 'open', g.billing_instructions, auth.uid())
  RETURNING id INTO _f;
  UPDATE public.group_bookings SET master_folio_id=_f, updated_at=now() WHERE id=g.id;
  RETURN _f;
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
  INSERT INTO public.group_block_events (organization_id, group_booking_id, event_type, detail, actor_id)
  VALUES (g.organization_id, g.id, 'deposit', jsonb_build_object('amount', _amount, 'method', _method, 'payment', _pay), auth.uid());
  RETURN jsonb_build_object('payment_id', _pay, 'folio_id', _folio);
END; $$;

-- ============ WAITLIST ============
CREATE OR REPLACE FUNCTION public.pms_waitlist_offer(_entry uuid, _rate numeric, _expires timestamptz)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE w public.waitlist_entries;
BEGIN
  SELECT * INTO w FROM public.waitlist_entries WHERE id=_entry AND organization_id=public.current_org_id();
  IF w.id IS NULL THEN RAISE EXCEPTION 'Waitlist entry not found'; END IF;
  IF w.status NOT IN ('waiting','offered') THEN RAISE EXCEPTION 'Entry is % and cannot be offered', w.status; END IF;
  UPDATE public.waitlist_entries
     SET status='offered', quoted_rate=COALESCE(_rate, quoted_rate), offered_at=now(),
         offer_expires_at=COALESCE(_expires, now() + interval '24 hours'), updated_at=now()
   WHERE id=_entry;
  RETURN jsonb_build_object('ok', true);
END; $$;

CREATE OR REPLACE FUNCTION public.pms_waitlist_close(_entry uuid, _status text, _reason text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
BEGIN
  IF _status NOT IN ('cancelled','expired','declined') THEN RAISE EXCEPTION 'Unsupported close status %', _status; END IF;
  IF COALESCE(btrim(_reason),'') = '' THEN RAISE EXCEPTION 'A reason is required to close a waitlist entry'; END IF;
  UPDATE public.waitlist_entries
     SET status=_status, closed_reason=_reason, updated_at=now()
   WHERE id=_entry AND organization_id=public.current_org_id() AND status IN ('waiting','offered');
  IF NOT FOUND THEN RAISE EXCEPTION 'Entry not found or already closed'; END IF;
  RETURN jsonb_build_object('ok', true);
END; $$;

CREATE OR REPLACE FUNCTION public.pms_waitlist_convert(_entry uuid, _room uuid DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE w public.waitlist_entries; _cust uuid; _res uuid; _conf text;
BEGIN
  SELECT * INTO w FROM public.waitlist_entries WHERE id=_entry AND organization_id=public.current_org_id();
  IF w.id IS NULL THEN RAISE EXCEPTION 'Waitlist entry not found'; END IF;
  IF w.converted_reservation_id IS NOT NULL THEN
    RETURN jsonb_build_object('reservation_id', w.converted_reservation_id, 'already', true);
  END IF;
  _cust := w.customer_id;
  IF _cust IS NULL THEN
    INSERT INTO public.customers (organization_id, branch_id, full_name, email, phone, customer_type)
    VALUES (w.organization_id, w.branch_id, COALESCE(NULLIF(w.contact_name,''),'Waitlist guest'),
            NULLIF(w.contact_email,''), NULLIF(w.contact_phone,''), 'individual')
    RETURNING id INTO _cust;
  END IF;
  _conf := 'WL-'||upper(substr(replace(gen_random_uuid()::text,'-',''),1,8));
  INSERT INTO public.reservations (organization_id, branch_id, confirmation_number, customer_id,
     booking_source, reservation_type, arrival_date, departure_date, adults, children,
     room_type_id, room_id, rate_plan_id, nightly_rate, status, created_by, idempotency_key)
  VALUES (w.organization_id, w.branch_id, _conf, _cust, 'waitlist', 'individual',
     w.arrival_date, w.departure_date, COALESCE(w.adults,1), COALESCE(w.children,0),
     w.room_type_id, _room, w.rate_plan_id, COALESCE(w.quoted_rate,0), 'confirmed', auth.uid(),
     'waitlist:'||w.id::text)
  RETURNING id INTO _res;
  UPDATE public.waitlist_entries
     SET status='converted', converted_reservation_id=_res, converted_at=now(),
         converted_by=auth.uid(), customer_id=_cust, updated_at=now()
   WHERE id=w.id;
  RETURN jsonb_build_object('reservation_id', _res, 'confirmation_number', _conf);
END; $$;

-- ============ GUEST REQUESTS ============
CREATE OR REPLACE FUNCTION public.pms_request_assign(_request uuid, _assignee uuid, _department uuid, _reason text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
BEGIN
  UPDATE public.guest_requests
     SET assignee_id = COALESCE(_assignee, assignee_id),
         department_id = COALESCE(_department, department_id),
         status = CASE WHEN status = 'open' THEN 'assigned' ELSE status END,
         notes = COALESCE(notes,'') || CASE WHEN COALESCE(btrim(_reason),'')='' THEN ''
                 ELSE E'\n['||to_char(now(),'YYYY-MM-DD HH24:MI')||'] reassigned: '||_reason END,
         updated_at = now()
   WHERE id=_request AND organization_id=public.current_org_id()
     AND status NOT IN ('completed','cancelled');
  IF NOT FOUND THEN RAISE EXCEPTION 'Request not found or already closed'; END IF;
  RETURN jsonb_build_object('ok', true);
END; $$;

CREATE OR REPLACE FUNCTION public.pms_request_complete(_request uuid, _resolution text, _evidence text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
BEGIN
  IF COALESCE(btrim(_resolution),'') = '' THEN RAISE EXCEPTION 'Describe how the request was resolved'; END IF;
  UPDATE public.guest_requests
     SET status='completed', completed_at=now(), resolution_notes=_resolution,
         evidence_url=NULLIF(_evidence,''), updated_at=now()
   WHERE id=_request AND organization_id=public.current_org_id() AND status <> 'completed';
  IF NOT FOUND THEN RAISE EXCEPTION 'Request not found or already completed'; END IF;
  RETURN jsonb_build_object('ok', true);
END; $$;

CREATE OR REPLACE FUNCTION public.pms_request_feedback(_request uuid, _rating integer, _comment text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
BEGIN
  IF _rating IS NOT NULL AND (_rating < 1 OR _rating > 5) THEN RAISE EXCEPTION 'Rating must be 1-5'; END IF;
  UPDATE public.guest_requests
     SET feedback_rating=_rating, feedback_comment=NULLIF(_comment,''), guest_confirmed=true, updated_at=now()
   WHERE id=_request AND organization_id=public.current_org_id();
  IF NOT FOUND THEN RAISE EXCEPTION 'Request not found'; END IF;
  RETURN jsonb_build_object('ok', true);
END; $$;

REVOKE ALL ON FUNCTION public.pms_group_convert_rooming(uuid, uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.pms_group_release_block(uuid, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.pms_group_master_folio(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.pms_group_record_deposit(uuid, numeric, text, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.pms_waitlist_offer(uuid, numeric, timestamptz) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.pms_waitlist_close(uuid, text, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.pms_waitlist_convert(uuid, uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.pms_request_assign(uuid, uuid, uuid, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.pms_request_complete(uuid, text, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.pms_request_feedback(uuid, integer, text) FROM PUBLIC, anon;

GRANT EXECUTE ON FUNCTION public.pms_group_convert_rooming(uuid, uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.pms_group_release_block(uuid, text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.pms_group_master_folio(uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.pms_group_record_deposit(uuid, numeric, text, text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.pms_waitlist_offer(uuid, numeric, timestamptz) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.pms_waitlist_close(uuid, text, text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.pms_waitlist_convert(uuid, uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.pms_request_assign(uuid, uuid, uuid, text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.pms_request_complete(uuid, text, text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.pms_request_feedback(uuid, integer, text) TO authenticated, service_role;
