CREATE OR REPLACE FUNCTION public.pms_revert_check_in(_reservation uuid, _reason text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $fn$
DECLARE
  _org uuid := public.current_org_id();
  _res public.reservations;
  _stay public.stays;
  _folio public.folios;
  _charges int := 0;
  _room public.rooms;
  _prev text;
BEGIN
  IF _org IS NULL THEN RETURN jsonb_build_object('ok', false, 'reason', 'no_organisation'); END IF;
  IF NOT (public.has_permission('pms','checkin.revert') OR public.has_permission('pms','checkin.perform')) THEN
    RAISE EXCEPTION 'The pms.checkin.revert permission is required.' USING ERRCODE = '42501';
  END IF;
  IF coalesce(trim(_reason),'') = '' THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'reason_required',
      'detail', 'Reverting a check-in requires a written reason for the audit trail.');
  END IF;

  SELECT * INTO _res FROM public.reservations
   WHERE id = _reservation AND organization_id = _org FOR UPDATE;
  IF _res.id IS NULL THEN RETURN jsonb_build_object('ok', false, 'reason', 'not_found'); END IF;
  IF NOT public.neo_branch_in_scope(_res.branch_id) THEN
    RAISE EXCEPTION 'That property is outside your access scope.' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO _stay FROM public.stays WHERE reservation_id = _reservation FOR UPDATE;
  IF _stay.id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_checked_in',
      'detail', 'This reservation has no open stay to revert.');
  END IF;
  IF _stay.checked_out_at IS NOT NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'already_checked_out',
      'detail', 'The guest has already departed. Reverse the departure before the arrival.');
  END IF;

  SELECT * INTO _folio FROM public.folios
   WHERE stay_id = _stay.id AND folio_type = 'guest' FOR UPDATE;

  IF _folio.id IS NOT NULL THEN
    SELECT count(*) INTO _charges FROM public.folio_lines
     WHERE folio_id = _folio.id AND coalesce(status,'posted') <> 'reversed';
    IF _charges > 0 THEN
      RETURN jsonb_build_object('ok', false, 'reason', 'folio_has_activity', 'charges', _charges,
        'detail', 'This folio already carries ' || _charges ||
                  ' posted line(s). Reverse or transfer them before reverting the check-in.');
    END IF;
  END IF;

  SELECT * INTO _room FROM public.rooms WHERE id = _stay.room_id FOR UPDATE;

  IF _folio.id IS NOT NULL THEN
    DELETE FROM public.folio_lines WHERE folio_id = _folio.id;
    DELETE FROM public.folios WHERE id = _folio.id;
  END IF;

  UPDATE public.room_assignments SET stay_id = NULL, updated_at = now()
   WHERE reservation_id = _reservation AND stay_id = _stay.id;

  DELETE FROM public.stays WHERE id = _stay.id;

  UPDATE public.reservations
     SET status = 'confirmed', updated_at = now()
   WHERE id = _reservation;

  IF _room.id IS NOT NULL THEN
    SELECT h.previous_value INTO _prev
      FROM public.room_status_history h
     WHERE h.room_id = _room.id AND h.field = 'occupancy_status' AND h.new_value = 'occupied'
     ORDER BY h.created_at DESC LIMIT 1;

    UPDATE public.rooms
       SET occupancy_status = coalesce(nullif(_prev,''), 'vacant'),
           room_condition = 'vacant-clean',
           housekeeping_status = 'clean',
           updated_at = now()
     WHERE id = _room.id;

    INSERT INTO public.room_status_history
      (organization_id, branch_id, room_id, field, previous_value, new_value, reason, changed_by)
    VALUES (_org, _res.branch_id, _room.id, 'occupancy_status', 'occupied',
            coalesce(nullif(_prev,''), 'vacant'), 'Check-in reverted — ' || _reason, auth.uid());
  END IF;

  DELETE FROM public.pms_workflow_events
   WHERE organization_id = _org AND event_type = 'guest.checked-in'
     AND idempotency_key = 'checkin:' || _reservation::text;

  INSERT INTO public.customer_timeline_events
    (organization_id, branch_id, customer_id, event_type, description,
     source_module, source_record_id, staff_user_id)
  SELECT _org, _res.branch_id, _res.customer_id, 'stay',
         'Check-in reverted — ' || _reason, 'front-office', _reservation::text, auth.uid()
   WHERE _res.customer_id IS NOT NULL;

  INSERT INTO public.notifications (organization_id, branch_id, category, title, body, link)
  VALUES (_org, _res.branch_id, 'operations', 'Check-in reverted',
          'Reservation ' || coalesce(_res.reservation_number, _reservation::text) ||
          ' was returned to confirmed — ' || _reason, '/pms/arrivals');

  INSERT INTO public.audit_logs
    (organization_id, user_id, user_name, action, module, record_id, previous_value, new_value, reason)
  VALUES (_org, auth.uid(), '', 'pms.checkin.revert', 'front-office', _reservation::text,
          jsonb_build_object('stay_id', _stay.id, 'folio_id', _folio.id, 'status', 'checked-in'),
          jsonb_build_object('status', 'confirmed'), _reason);

  RETURN jsonb_build_object('ok', true, 'reservation_id', _reservation,
                            'stay_removed', _stay.id, 'folio_removed', _folio.id);
END $fn$;

REVOKE EXECUTE ON FUNCTION public.pms_revert_check_in(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.pms_revert_check_in(uuid, text) TO authenticated;

CREATE OR REPLACE FUNCTION public.neo_checkin_reconciliation(_branch uuid DEFAULT NULL)
RETURNS TABLE(
  issue text, severity text, reservation_id uuid, reference text,
  room_number text, detail text, required_action text, drill_to text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $fn$
DECLARE org uuid := public.current_org_id();
BEGIN
  IF org IS NULL OR NOT (public.has_permission('pms','arrivals.view')
                         OR public.has_permission('pms','in-house.view')
                         OR public.is_org_admin()) THEN
    RAISE EXCEPTION 'insufficient_privilege' USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
  -- A reservation says the guest arrived, but no stay exists: in-house counts miss them.
  SELECT 'checked_in_without_stay'::text, 'critical'::text, r.id,
         coalesce(r.reservation_number, r.id::text),
         rm.room_number,
         'The reservation is marked checked-in but no stay record exists, so in-house counts exclude this guest.'::text,
         'Revert the check-in and perform it again so the stay and folio are created.'::text,
         '/pms/arrivals'::text
    FROM public.reservations r
    LEFT JOIN public.rooms rm ON rm.id = r.room_id
   WHERE r.organization_id = org AND (_branch IS NULL OR r.branch_id = _branch)
     AND r.status = 'checked-in'
     AND NOT EXISTS (SELECT 1 FROM public.stays s WHERE s.reservation_id = r.id)

  UNION ALL
  -- An open stay with no guest folio: charges have nowhere to land.
  SELECT 'stay_without_folio', 'critical', s.reservation_id,
         coalesce(r.reservation_number, s.reservation_id::text), rm.room_number,
         'The guest is in house but no guest folio was opened, so charges cannot be posted.',
         'Open a guest folio for the stay, or revert and repeat the check-in.',
         '/pms/in-house'
    FROM public.stays s
    LEFT JOIN public.reservations r ON r.id = s.reservation_id
    LEFT JOIN public.rooms rm ON rm.id = s.room_id
   WHERE s.organization_id = org AND (_branch IS NULL OR s.branch_id = _branch)
     AND s.checked_out_at IS NULL
     AND NOT EXISTS (SELECT 1 FROM public.folios f WHERE f.stay_id = s.id AND f.folio_type = 'guest')

  UNION ALL
  -- The guest is in house but the room is not showing as occupied.
  SELECT 'room_not_occupied', 'warning', s.reservation_id,
         coalesce(r.reservation_number, s.reservation_id::text), rm.room_number,
         'Room ' || coalesce(rm.room_number,'—') || ' shows ' || coalesce(rm.occupancy_status,'unknown') ||
           ' while a stay is open, so occupancy and housekeeping disagree.',
         'Set the room to occupied from the room rack, or revert the check-in if it was made in error.',
         '/pms/rooms'
    FROM public.stays s
    JOIN public.rooms rm ON rm.id = s.room_id
    LEFT JOIN public.reservations r ON r.id = s.reservation_id
   WHERE s.organization_id = org AND (_branch IS NULL OR s.branch_id = _branch)
     AND s.checked_out_at IS NULL
     AND coalesce(rm.occupancy_status,'') <> 'occupied'

  UNION ALL
  -- A room is occupied with nobody in house against it.
  SELECT 'occupied_without_stay', 'warning', NULL::uuid, rm.room_number, rm.room_number,
         'Room ' || rm.room_number || ' is flagged occupied but no open stay is attached to it.',
         'Release the room, or check the guest in properly so the stay exists.',
         '/pms/rooms'
    FROM public.rooms rm
   WHERE rm.organization_id = org AND (_branch IS NULL OR rm.branch_id = _branch)
     AND rm.occupancy_status = 'occupied'
     AND NOT EXISTS (SELECT 1 FROM public.stays s WHERE s.room_id = rm.id AND s.checked_out_at IS NULL)

  UNION ALL
  -- Guest history did not record the arrival.
  SELECT 'timeline_missing', 'info', s.reservation_id,
         coalesce(r.reservation_number, s.reservation_id::text), rm.room_number,
         'The arrival is not present in the guest history timeline, so downstream guest statistics under-report it.',
         'Re-run the check-in reconciliation after confirming guest history writes are enabled.',
         '/crm/guests'
    FROM public.stays s
    LEFT JOIN public.reservations r ON r.id = s.reservation_id
    LEFT JOIN public.rooms rm ON rm.id = s.room_id
   WHERE s.organization_id = org AND (_branch IS NULL OR s.branch_id = _branch)
     AND s.checked_out_at IS NULL
     AND s.customer_id IS NOT NULL
     AND NOT EXISTS (
       SELECT 1 FROM public.customer_timeline_events e
        WHERE e.source_record_id = s.reservation_id::text
          AND e.event_type = 'stay' AND e.source_module = 'front-office')
  LIMIT 300;
END $fn$;

REVOKE EXECUTE ON FUNCTION public.neo_checkin_reconciliation(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.neo_checkin_reconciliation(uuid) TO authenticated;

INSERT INTO public.role_feature_templates (role_key, module, feature, action) VALUES
  ('front-office-manager','pms','checkin','revert'),
  ('duty-manager','pms','checkin','revert'),
  ('general-manager','pms','checkin','revert'),
  ('operations-manager','pms','checkin','revert')
ON CONFLICT (role_key, module, feature, action) DO NOTHING;