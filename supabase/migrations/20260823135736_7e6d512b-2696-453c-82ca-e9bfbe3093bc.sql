CREATE OR REPLACE FUNCTION public.pms_check_in(_reservation uuid, _keys integer DEFAULT 1, _notes text DEFAULT ''::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE _org uuid := public.current_org_id(); _res public.reservations; _stay uuid; _folio uuid;
  _room public.rooms; _key text; _folio_no text; _tax_rate numeric; _tax numeric; _line uuid;
BEGIN
  IF NOT public.has_permission('pms','checkin.perform') THEN RAISE EXCEPTION 'Not permitted to check in guests'; END IF;
  SELECT * INTO _res FROM public.reservations WHERE id=_reservation AND organization_id=_org FOR UPDATE;
  IF _res.id IS NULL THEN RAISE EXCEPTION 'Reservation not found'; END IF;
  _key := 'checkin:' || _reservation::text;

  SELECT id INTO _stay FROM public.stays WHERE reservation_id=_reservation;
  IF _stay IS NOT NULL THEN
    SELECT id INTO _folio FROM public.folios WHERE stay_id=_stay AND folio_type='guest';
    RETURN jsonb_build_object('stay_id',_stay,'folio_id',_folio,'idempotent',true);
  END IF;

  IF _res.status NOT IN ('confirmed','guaranteed','tentative','pending-deposit') THEN
    RAISE EXCEPTION 'Reservation status % is not eligible for check-in', _res.status;
  END IF;
  IF _res.room_id IS NULL THEN RAISE EXCEPTION 'Assign a room before check-in'; END IF;
  SELECT * INTO _room FROM public.rooms WHERE id=_res.room_id FOR UPDATE;
  IF _room.room_condition IN ('out-of-order','out-of-service','maintenance','blocked') THEN
    RAISE EXCEPTION 'Room % is not available (%).', _room.room_number, _room.room_condition;
  END IF;
  IF _room.occupancy_status = 'occupied' THEN
    RAISE EXCEPTION 'Room % is already occupied', _room.room_number;
  END IF;

  INSERT INTO public.stays (organization_id, branch_id, reservation_id, customer_id, room_id,
    checked_in_by, expected_departure)
  VALUES (_org, _res.branch_id, _reservation, _res.customer_id, _res.room_id, auth.uid(), _res.departure_date)
  RETURNING id INTO _stay;

  _folio_no := public.next_document_number('invoice');
  INSERT INTO public.folios (organization_id, branch_id, folio_number, reservation_id, stay_id,
    customer_id, corporate_account_id, group_booking_id, created_by)
  VALUES (_org, _res.branch_id, _folio_no, _reservation, _stay, _res.customer_id,
          _res.corporate_account_id, _res.group_booking_id, auth.uid())
  RETURNING id INTO _folio;

  UPDATE public.reservations SET status='checked-in', updated_at=now() WHERE id=_reservation;
  UPDATE public.rooms SET occupancy_status='occupied', room_condition='occupied-clean',
    housekeeping_status='occupied', updated_at=now() WHERE id=_res.room_id;
  UPDATE public.room_assignments SET stay_id=_stay, updated_at=now()
    WHERE reservation_id=_reservation AND status='active';

  -- The arrival night is charged immediately so the folio carries a real
  -- balance from check-in; the nightly posting run skips it via the
  -- one-night-per-reservation unique index.
  SELECT COALESCE(rp.tax_rate, 0) INTO _tax_rate
  FROM public.rate_plans rp WHERE rp.id = _res.rate_plan_id;
  _tax_rate := COALESCE(_tax_rate, 0);
  IF COALESCE(_res.nightly_rate,0) > 0 AND _res.arrival_date < _res.departure_date THEN
    _tax := round(_res.nightly_rate * _tax_rate / 100, 2);
    BEGIN
      INSERT INTO public.folio_lines (organization_id, branch_id, folio_id, reservation_id, line_type,
        category, source_module, description, operational_date, quantity, unit_price,
        gross_amount, tax_amount, net_amount, posted_by)
      VALUES (_org, _res.branch_id, _folio, _reservation, 'charge', 'accommodation', 'pms',
        'Accommodation — room ' || _room.room_number || ' · ' || _res.arrival_date::text,
        _res.arrival_date, 1, _res.nightly_rate, _res.nightly_rate, _tax, _res.nightly_rate + _tax, auth.uid())
      RETURNING id INTO _line;
      UPDATE public.folios SET total_charges = total_charges + _res.nightly_rate,
        total_taxes = total_taxes + _tax, balance = balance + _res.nightly_rate + _tax, updated_at=now()
      WHERE id=_folio;
      PERFORM public.pkg_allocate_folio_line(_line, 'check-in');
    EXCEPTION WHEN unique_violation THEN
      NULL;
    END;
  END IF;

  INSERT INTO public.room_status_history (organization_id, branch_id, room_id, field, previous_value, new_value, reason, changed_by)
  VALUES (_org, _res.branch_id, _res.room_id, 'occupancy_status', _room.occupancy_status, 'occupied', 'Guest checked in', auth.uid());

  INSERT INTO public.tasks (organization_id, branch_id, reference, title, description, created_by, priority, status)
  VALUES (_org, _res.branch_id, 'HK-IN-' || left(_reservation::text,8),
    'Room ' || _room.room_number || ' is now occupied',
    'Guest checked in. Service the room per housekeeping schedule.', auth.uid(), 'normal', 'open');

  INSERT INTO public.notifications (organization_id, branch_id, category, title, body, link)
  VALUES (_org, _res.branch_id, 'operations', 'Guest checked in',
    'Room ' || _room.room_number || ' — folio ' || _folio_no || ' is now active.', '/pms/in-house');

  INSERT INTO public.customer_timeline_events (organization_id, branch_id, customer_id, event_type,
    description, source_module, source_record_id, staff_user_id)
  SELECT _org, _res.branch_id, _res.customer_id, 'stay',
    'Checked in · room ' || _room.room_number || ' · ' || _res.arrival_date::text || ' → ' || _res.departure_date::text,
    'front-office', _reservation::text, auth.uid()
  WHERE _res.customer_id IS NOT NULL;

  INSERT INTO public.pms_workflow_events (organization_id, branch_id, event_type, reservation_id, stay_id, folio_id, idempotency_key, created_by)
  VALUES (_org, _res.branch_id, 'guest.checked-in', _reservation, _stay, _folio, _key, auth.uid())
  ON CONFLICT DO NOTHING;

  INSERT INTO public.audit_logs (organization_id, user_id, user_name, action, module, record_id, new_value, reason)
  VALUES (_org, auth.uid(), '', 'pms.checkin', 'front-office', _reservation::text,
    jsonb_build_object('stay_id',_stay,'folio_id',_folio,'room',_room.room_number,'keys',_keys), _notes);

  RETURN jsonb_build_object('stay_id',_stay,'folio_id',_folio,'folio_number',_folio_no,'idempotent',false);
END; $function$;

REVOKE ALL ON FUNCTION public.pms_check_in(uuid, integer, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.pms_check_in(uuid, integer, text) TO authenticated, service_role;