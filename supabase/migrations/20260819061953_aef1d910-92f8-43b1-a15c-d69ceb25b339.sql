-- 1. Authoritative room state derivation ------------------------------------
CREATE OR REPLACE FUNCTION public.rooms_derive_state()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $$
DECLARE hk text; mt text; oc text; cond text; cond_changed boolean := false;
BEGIN
  hk := lower(coalesce(NEW.housekeeping_status, 'dirty'));
  hk := CASE hk
          WHEN 'ready-for-inspection' THEN 'awaiting-inspection'
          WHEN 'cleaning' THEN 'in-progress'
          WHEN 'vacant-dirty' THEN 'dirty'
          WHEN 'vacant-clean' THEN 'clean'
          WHEN 'occupied' THEN 'clean'
          ELSE hk END;
  IF hk NOT IN ('dirty','in-progress','awaiting-inspection','clean','inspected') THEN hk := 'dirty'; END IF;

  mt := lower(coalesce(NEW.maintenance_status, 'operational'));
  mt := CASE mt
          WHEN 'in-repair' THEN 'under-maintenance'
          WHEN 'reported' THEN 'under-maintenance'
          WHEN 'maintenance' THEN 'under-maintenance'
          WHEN 'blocked' THEN 'out-of-service'
          WHEN 'ok' THEN 'operational'
          WHEN 'none' THEN 'operational'
          ELSE mt END;
  IF mt NOT IN ('operational','under-maintenance','out-of-service','out-of-order') THEN mt := 'operational'; END IF;

  oc := lower(coalesce(NEW.occupancy_status, 'vacant'));
  IF oc NOT IN ('vacant','occupied','house-use') THEN oc := 'vacant'; END IF;

  IF TG_OP = 'UPDATE' AND NEW.room_condition IS DISTINCT FROM OLD.room_condition THEN
    cond_changed := true;
  END IF;

  IF cond_changed THEN
    cond := lower(coalesce(NEW.room_condition, ''));
    IF cond = 'out-of-order' THEN
      mt := 'out-of-order';
    ELSIF cond IN ('out-of-service','blocked') THEN
      mt := 'out-of-service';
    ELSIF cond = 'maintenance' THEN
      mt := 'under-maintenance';
    ELSE
      mt := 'operational';
      IF cond = 'vacant-clean' THEN oc := 'vacant'; hk := 'clean';
      ELSIF cond = 'vacant-dirty' THEN oc := 'vacant'; hk := 'dirty';
      ELSIF cond = 'inspected' THEN oc := 'vacant'; hk := 'inspected';
      ELSIF cond = 'occupied-clean' THEN oc := 'occupied'; hk := 'clean';
      ELSIF cond = 'occupied-dirty' THEN oc := 'occupied'; hk := 'dirty';
      END IF;
    END IF;
  END IF;

  -- derived presentation condition
  IF mt = 'out-of-order' THEN cond := 'out-of-order';
  ELSIF mt = 'out-of-service' THEN cond := 'out-of-service';
  ELSIF mt = 'under-maintenance' THEN cond := 'maintenance';
  ELSIF oc IN ('occupied','house-use') THEN
    cond := CASE WHEN hk IN ('dirty','in-progress','awaiting-inspection') THEN 'occupied-dirty' ELSE 'occupied-clean' END;
  ELSIF hk = 'inspected' THEN cond := 'inspected';
  ELSIF hk = 'clean' THEN cond := 'vacant-clean';
  ELSE cond := 'vacant-dirty';
  END IF;

  NEW.housekeeping_status := hk;
  NEW.maintenance_status := mt;
  NEW.occupancy_status := oc;
  NEW.room_condition := cond;
  NEW.sellable := (coalesce(NEW.status,'active') = 'active' AND mt = 'operational');
  IF mt = 'operational' THEN
    NEW.out_of_order_reason := NULL;
    NEW.out_of_order_from := NULL;
    NEW.out_of_order_to := NULL;
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS rooms_derive_state ON public.rooms;
CREATE TRIGGER rooms_derive_state
BEFORE INSERT OR UPDATE ON public.rooms
FOR EACH ROW EXECUTE FUNCTION public.rooms_derive_state();

-- 2. Room status action understands occupancy and leaves derivation to the trigger
CREATE OR REPLACE FUNCTION public.ops_set_room_status(
  _room uuid,
  _housekeeping_status text DEFAULT NULL,
  _maintenance_status text DEFAULT NULL,
  _reason text DEFAULT NULL,
  _source_module text DEFAULT 'housekeeping',
  _reference uuid DEFAULT NULL,
  _occupancy_status text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE v_org uuid := current_org_id(); v_room record;
BEGIN
  IF v_org IS NULL THEN RAISE EXCEPTION 'No active organization'; END IF;
  SELECT * INTO v_room FROM rooms WHERE id = _room AND organization_id = v_org FOR UPDATE;
  IF v_room IS NULL THEN RAISE EXCEPTION 'Unknown room'; END IF;
  IF NOT (has_permission('housekeeping','edit') OR has_permission('maintenance','edit') OR has_permission('pms','rooms.manage') OR is_org_admin()) THEN
    RAISE EXCEPTION 'Not permitted to change room status';
  END IF;

  IF _housekeeping_status IS NOT NULL AND _housekeeping_status IS DISTINCT FROM v_room.housekeeping_status THEN
    INSERT INTO room_status_history (organization_id, branch_id, room_id, field, previous_value, new_value, reason, changed_by)
    VALUES (v_org, v_room.branch_id, _room, 'housekeeping_status', v_room.housekeeping_status, _housekeeping_status,
            COALESCE(_reason,'') || ' [' || _source_module || COALESCE(':'||_reference::text,'') || ']', auth.uid());
    UPDATE rooms SET housekeeping_status = _housekeeping_status,
      last_cleaned_at = CASE WHEN _housekeeping_status IN ('clean','inspected') THEN now() ELSE last_cleaned_at END,
      last_inspected_at = CASE WHEN _housekeeping_status = 'inspected' THEN now() ELSE last_inspected_at END,
      updated_at = now()
    WHERE id = _room;
  END IF;

  IF _maintenance_status IS NOT NULL AND _maintenance_status IS DISTINCT FROM v_room.maintenance_status THEN
    INSERT INTO room_status_history (organization_id, branch_id, room_id, field, previous_value, new_value, reason, changed_by)
    VALUES (v_org, v_room.branch_id, _room, 'maintenance_status', v_room.maintenance_status, _maintenance_status,
            COALESCE(_reason,'') || ' [' || _source_module || COALESCE(':'||_reference::text,'') || ']', auth.uid());
    UPDATE rooms SET maintenance_status = _maintenance_status,
      out_of_order_reason = CASE WHEN _maintenance_status IN ('out-of-order','out-of-service','under-maintenance') THEN _reason ELSE NULL END,
      updated_at = now()
    WHERE id = _room;
  END IF;

  IF _occupancy_status IS NOT NULL AND _occupancy_status IS DISTINCT FROM v_room.occupancy_status THEN
    INSERT INTO room_status_history (organization_id, branch_id, room_id, field, previous_value, new_value, reason, changed_by)
    VALUES (v_org, v_room.branch_id, _room, 'occupancy_status', v_room.occupancy_status, _occupancy_status,
            COALESCE(_reason,'') || ' [' || _source_module || COALESCE(':'||_reference::text,'') || ']', auth.uid());
    UPDATE rooms SET occupancy_status = _occupancy_status, updated_at = now() WHERE id = _room;
  END IF;

  SELECT * INTO v_room FROM rooms WHERE id = _room;
  RETURN jsonb_build_object('room_id', _room, 'ok', true,
    'housekeeping_status', v_room.housekeeping_status,
    'maintenance_status', v_room.maintenance_status,
    'occupancy_status', v_room.occupancy_status,
    'room_condition', v_room.room_condition,
    'sellable', v_room.sellable);
END $$;

REVOKE ALL ON FUNCTION public.ops_set_room_status(uuid,text,text,text,text,uuid,text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.ops_set_room_status(uuid,text,text,text,text,uuid,text) TO authenticated;

-- 3. Availability reads the authoritative axes
CREATE OR REPLACE FUNCTION public.pms_available_rooms(_branch uuid, _arrival date, _departure date, _room_type uuid DEFAULT NULL::uuid, _adults integer DEFAULT 1, _children integer DEFAULT 0)
 RETURNS TABLE(room_id uuid, room_number text, room_type_id uuid, room_type_name text, floor text)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT r.id, r.room_number, r.room_type_id, rt.name, r.floor
  FROM public.rooms r
  LEFT JOIN public.room_types rt ON rt.id = r.room_type_id
  WHERE r.organization_id = public.current_org_id()
    AND (_branch IS NULL OR r.branch_id = _branch)
    AND r.status = 'active'
    AND r.maintenance_status = 'operational'
    AND (_room_type IS NULL OR r.room_type_id = _room_type)
    AND (rt.id IS NULL OR rt.max_occupancy >= (_adults + _children))
    AND NOT EXISTS (
      SELECT 1 FROM public.room_assignments a
      WHERE a.room_id = r.id AND a.status = 'active'
        AND daterange(a.start_date, a.end_date, '[)') && daterange(_arrival, _departure, '[)'))
    AND NOT EXISTS (
      SELECT 1 FROM public.room_blocks b
      WHERE b.room_id = r.id AND b.status = 'active'
        AND daterange(b.start_date, b.end_date, '[]') && daterange(_arrival, _departure, '[)'))
    AND NOT EXISTS (
      SELECT 1 FROM public.reservation_holds h
      WHERE h.room_id = r.id AND h.status = 'active' AND h.hold_expires_at > now()
        AND daterange(h.arrival_date, h.departure_date, '[)') && daterange(_arrival, _departure, '[)'))
  ORDER BY r.room_number;
$function$;

-- 4. Front office metrics read the same axes
CREATE OR REPLACE FUNCTION public.pms_front_office_metrics(_branch uuid DEFAULT NULL::uuid, _on date DEFAULT CURRENT_DATE)
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT jsonb_build_object(
    'date', _on,
    'rooms', (SELECT jsonb_build_object(
        'total', count(*),
        'sellable', count(*) FILTER (WHERE status='active' AND maintenance_status='operational'),
        'vacant_clean', count(*) FILTER (WHERE occupancy_status='vacant' AND maintenance_status='operational' AND housekeeping_status IN ('clean','inspected')),
        'vacant_dirty', count(*) FILTER (WHERE occupancy_status='vacant' AND maintenance_status='operational' AND housekeeping_status IN ('dirty','in-progress','awaiting-inspection')),
        'occupied', count(*) FILTER (WHERE occupancy_status IN ('occupied','house-use')),
        'out_of_order', count(*) FILTER (WHERE maintenance_status IN ('out-of-order','out-of-service')),
        'maintenance', count(*) FILTER (WHERE maintenance_status='under-maintenance'))
      FROM public.rooms WHERE organization_id=public.current_org_id() AND (_branch IS NULL OR branch_id=_branch)),
    'reservations', (SELECT jsonb_build_object(
        'arrivals_today', count(*) FILTER (WHERE arrival_date=_on AND status IN ('confirmed','guaranteed','tentative','pending-deposit')),
        'departures_today', count(*) FILTER (WHERE departure_date=_on AND status='checked-in'),
        'in_house', count(*) FILTER (WHERE status='checked-in'),
        'unassigned', count(*) FILTER (WHERE room_id IS NULL AND status IN ('confirmed','guaranteed') AND departure_date>=_on),
        'vip_arrivals', count(*) FILTER (WHERE arrival_date=_on AND is_vip),
        'corporate_arrivals', count(*) FILTER (WHERE arrival_date=_on AND corporate_account_id IS NOT NULL),
        'group_arrivals', count(*) FILTER (WHERE arrival_date=_on AND group_booking_id IS NOT NULL),
        'no_shows', count(*) FILTER (WHERE status='no-show' AND arrival_date=_on),
        'cancelled', count(*) FILTER (WHERE status='cancelled' AND cancelled_at::date=_on))
      FROM public.reservations WHERE organization_id=public.current_org_id() AND (_branch IS NULL OR branch_id=_branch)),
    'folios', (SELECT jsonb_build_object(
        'open', count(*) FILTER (WHERE status='open'),
        'attention', count(*) FILTER (WHERE status='under-review'),
        'outstanding_balance', COALESCE(sum(balance) FILTER (WHERE status IN ('open','under-review')),0))
      FROM public.folios WHERE organization_id=public.current_org_id() AND (_branch IS NULL OR branch_id=_branch)),
    'requests', (SELECT jsonb_build_object(
        'open', count(*) FILTER (WHERE status NOT IN ('completed','cancelled')),
        'overdue', count(*) FILTER (WHERE due_at < now() AND status NOT IN ('completed','cancelled')))
      FROM public.guest_requests WHERE organization_id=public.current_org_id() AND (_branch IS NULL OR branch_id=_branch)),
    'waitlist', (SELECT count(*) FROM public.waitlist_entries
      WHERE organization_id=public.current_org_id() AND status='waiting' AND (_branch IS NULL OR branch_id=_branch))
  );
$function$;
