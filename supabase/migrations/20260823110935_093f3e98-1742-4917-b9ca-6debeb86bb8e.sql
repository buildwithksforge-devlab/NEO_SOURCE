CREATE OR REPLACE FUNCTION public.pms_check_in(_reservation uuid, _keys integer DEFAULT 1, _notes text DEFAULT ''::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE _org uuid := public.current_org_id(); _res public.reservations; _stay uuid; _folio uuid;
  _room public.rooms; _key text; _folio_no text;
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

CREATE OR REPLACE FUNCTION public.pms_check_out(_reservation uuid, _force boolean DEFAULT false, _notes text DEFAULT ''::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  _org uuid := public.current_org_id();
  _stay public.stays; _f public.folios; _room public.rooms; _key text;
  _outstanding numeric := 0;
BEGIN
  IF NOT public.has_permission('pms','checkout.perform') THEN RAISE EXCEPTION 'Not permitted to check out guests'; END IF;
  SELECT * INTO _stay FROM public.stays WHERE reservation_id=_reservation AND organization_id=_org FOR UPDATE;
  IF _stay.id IS NULL THEN RAISE EXCEPTION 'No stay found for this reservation'; END IF;
  IF _stay.status = 'checked-out' THEN
    RETURN jsonb_build_object('stay_id',_stay.id,'idempotent',true);
  END IF;

  SELECT * INTO _f FROM public.folios WHERE stay_id=_stay.id AND folio_type='guest' FOR UPDATE;

  SELECT COALESCE(SUM(l.net_amount), 0) INTO _outstanding
    FROM public.folio_lines l
    JOIN public.folios f ON f.id = l.folio_id
   WHERE f.stay_id = _stay.id
     AND COALESCE(l.status,'posted') NOT IN ('void','voided','reversed');

  IF round(_outstanding, 2) > 0 THEN
    IF NOT _force THEN
      RAISE EXCEPTION 'Folio is not settled — outstanding balance of %. Settle the bill before check-out.', round(_outstanding, 2);
    END IF;
    IF NOT public.has_permission('pms','folio.override') THEN
      RAISE EXCEPTION 'Checking out with an unsettled balance of % requires folio override authority.', round(_outstanding, 2);
    END IF;
    IF COALESCE(btrim(_notes), '') = '' THEN
      RAISE EXCEPTION 'A written reason is required to check out with an unsettled balance.';
    END IF;
  END IF;

  _key := 'checkout:' || _reservation::text;
  UPDATE public.stays SET status='checked-out', checked_out_at=now(), checked_out_by=auth.uid(), updated_at=now()
   WHERE id=_stay.id;
  UPDATE public.reservations SET status='checked-out', updated_at=now() WHERE id=_reservation;
  UPDATE public.room_assignments SET status='released', updated_at=now()
   WHERE reservation_id=_reservation AND status='active';

  UPDATE public.folios
     SET status = CASE WHEN round(_outstanding, 2) <= 0 THEN 'settled' ELSE 'under-review' END,
         balance = _outstanding,
         closed_at = CASE WHEN round(_outstanding, 2) <= 0 THEN now() ELSE NULL END,
         updated_at = now()
   WHERE stay_id = _stay.id;

  SELECT * INTO _room FROM public.rooms WHERE id=_stay.room_id FOR UPDATE;
  UPDATE public.rooms SET occupancy_status='vacant', room_condition='vacant-dirty',
    housekeeping_status='dirty', updated_at=now() WHERE id=_stay.room_id;

  INSERT INTO public.room_status_history (organization_id, branch_id, room_id, field, previous_value, new_value, reason, changed_by)
  VALUES (_org, _stay.branch_id, _stay.room_id, 'room_condition', _room.room_condition, 'vacant-dirty', 'Guest checked out', auth.uid());

  INSERT INTO public.pms_workflow_events (organization_id, branch_id, event_type, reservation_id, stay_id, folio_id, idempotency_key, created_by)
  VALUES (_org, _stay.branch_id, 'guest.checked-out', _reservation, _stay.id, _f.id, _key, auth.uid())
  ON CONFLICT DO NOTHING;

  INSERT INTO public.tasks (organization_id, branch_id, reference, title, description, created_by, priority, status)
  VALUES (_org, _stay.branch_id, 'HK-OUT-' || left(_stay.id::text,8),
    'Clean room ' || COALESCE(_room.room_number,''), 'Departure cleaning required.', auth.uid(), 'high', 'open');

  INSERT INTO public.notifications (organization_id, branch_id, category, title, body, link)
  VALUES (_org, _stay.branch_id, 'operations', 'Guest checked out',
    'Room ' || COALESCE(_room.room_number,'') || ' is now vacant dirty.', '/pms/departures');

  INSERT INTO public.customer_timeline_events (organization_id, branch_id, customer_id, event_type,
    description, source_module, source_record_id, staff_user_id)
  SELECT _org, _stay.branch_id, _stay.customer_id, 'stay',
    'Checked out · room ' || COALESCE(_room.room_number,'') || ' · folio ' || COALESCE(_f.folio_number,'—'),
    'front-office', _reservation::text, auth.uid()
  WHERE _stay.customer_id IS NOT NULL;

  INSERT INTO public.audit_logs (organization_id, user_id, user_name, action, module, record_id, new_value, reason)
  VALUES (_org, auth.uid(), '', 'pms.checkout', 'front-office', _reservation::text,
    jsonb_build_object('stay_id',_stay.id,'folio_id',_f.id,'outstanding',_outstanding,'forced',_force AND round(_outstanding,2) > 0), _notes);

  RETURN jsonb_build_object('stay_id',_stay.id,'folio_id',_f.id,'outstanding',_outstanding,'idempotent',false);
END; $function$;