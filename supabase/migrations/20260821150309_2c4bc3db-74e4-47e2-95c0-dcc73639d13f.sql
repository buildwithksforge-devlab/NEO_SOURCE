
DROP FUNCTION IF EXISTS public.pms_check_out(uuid, text);

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

  -- Settlement is judged on the ledger: every posted line of every folio on the
  -- stay. A cached folio total can be stale and must never release a room.
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

  INSERT INTO public.customer_timeline_events (organization_id, customer_id, event_type, title, description, created_by)
  SELECT _org, _stay.customer_id, 'stay', 'Checked out',
    'Room ' || COALESCE(_room.room_number,'') || ' · folio ' || COALESCE(_f.folio_number,'—'), auth.uid()
  WHERE _stay.customer_id IS NOT NULL;

  INSERT INTO public.audit_logs (organization_id, user_id, user_name, action, module, record_id, new_value, reason)
  VALUES (_org, auth.uid(), '', 'pms.checkout', 'front-office', _reservation::text,
    jsonb_build_object('stay_id',_stay.id,'folio_id',_f.id,'outstanding',_outstanding,'forced',_force AND round(_outstanding,2) > 0), _notes);

  RETURN jsonb_build_object('stay_id',_stay.id,'folio_id',_f.id,'outstanding',_outstanding,'idempotent',false);
END; $function$;

REVOKE EXECUTE ON FUNCTION public.pms_check_out(uuid, boolean, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.pms_check_out(uuid, boolean, text) TO authenticated;
