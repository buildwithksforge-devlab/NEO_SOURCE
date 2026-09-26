
-- 1. Canonical housekeeping vocabulary ---------------------------------------
CREATE OR REPLACE FUNCTION public.hk_canonical_condition(_value text)
RETURNS text LANGUAGE sql IMMUTABLE SET search_path TO 'public' AS $function$
  SELECT CASE lower(btrim(replace(replace(coalesce(_value,'dirty'),'_','-'),' ','-')))
    WHEN 'cleaning' THEN 'cleaning_in_progress'
    WHEN 'in-progress' THEN 'cleaning_in_progress'
    WHEN 'cleaning-in-progress' THEN 'cleaning_in_progress'
    WHEN 'being-cleaned' THEN 'cleaning_in_progress'
    WHEN 'cleaning-queued' THEN 'cleaning_queued'
    WHEN 'queued' THEN 'cleaning_queued'
    WHEN 'awaiting-inspection' THEN 'awaiting_inspection'
    WHEN 'ready-for-inspection' THEN 'awaiting_inspection'
    WHEN 'vacant-dirty' THEN 'dirty'
    WHEN 'soiled' THEN 'dirty'
    WHEN 'cleaned' THEN 'clean'
    WHEN 'vacant-clean' THEN 'clean'
    WHEN 'inspected' THEN 'inspected'
    WHEN 'rework' THEN 'rework'
    WHEN 'rework-required' THEN 'rework'
    WHEN 'failed' THEN 'rework'
    WHEN 'out-of-service' THEN 'out_of_service'
    WHEN 'clean' THEN 'clean'
    WHEN 'dirty' THEN 'dirty'
    ELSE lower(btrim(replace(replace(coalesce(_value,'dirty'),'-','_'),' ','_')))
  END;
$function$;

-- 2. Room derivation: sellability is derived, inspection state can never be
--    orphaned on a room that is not clean.
CREATE OR REPLACE FUNCTION public.rooms_derive_state()
RETURNS trigger LANGUAGE plpgsql SET search_path TO 'public' AS $function$
DECLARE hk text; mt text; oc text; insp text; cond text; cond_changed boolean := false;
BEGIN
  hk := lower(coalesce(NEW.housekeeping_status, 'dirty'));
  hk := CASE hk
          WHEN 'ready-for-inspection' THEN 'awaiting-inspection'
          WHEN 'cleaning' THEN 'in-progress'
          WHEN 'cleaning-in-progress' THEN 'in-progress'
          WHEN 'cleaning-queued' THEN 'cleaning-queued'
          WHEN 'queued' THEN 'cleaning-queued'
          WHEN 'rework-required' THEN 'rework'
          WHEN 'failed' THEN 'rework'
          WHEN 'vacant-dirty' THEN 'dirty'
          WHEN 'vacant-clean' THEN 'clean'
          WHEN 'occupied' THEN 'clean'
          ELSE hk END;
  IF hk NOT IN ('dirty','cleaning-queued','in-progress','awaiting-inspection','rework','clean','inspected')
    THEN hk := 'dirty'; END IF;

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
    IF cond = 'out-of-order' THEN mt := 'out-of-order';
    ELSIF cond IN ('out-of-service','blocked') THEN mt := 'out-of-service';
    ELSIF cond = 'maintenance' THEN mt := 'under-maintenance';
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

  -- Inspection is only meaningful once cleaning has produced a clean room.
  insp := lower(coalesce(NEW.inspection_status,'not-required'));
  IF hk IN ('dirty','cleaning-queued','in-progress') THEN insp := 'not-required'; END IF;
  IF hk = 'awaiting-inspection' THEN insp := 'pending'; END IF;
  IF hk = 'rework' THEN insp := 'failed'; END IF;
  IF hk = 'inspected' THEN insp := 'passed'; END IF;
  IF insp NOT IN ('not-required','pending','passed','failed') THEN insp := 'not-required'; END IF;

  IF mt = 'out-of-order' THEN cond := 'out-of-order';
  ELSIF mt = 'out-of-service' THEN cond := 'out-of-service';
  ELSIF mt = 'under-maintenance' THEN cond := 'maintenance';
  ELSIF oc IN ('occupied','house-use') THEN
    cond := CASE WHEN hk IN ('clean','inspected') THEN 'occupied-clean' ELSE 'occupied-dirty' END;
  ELSIF hk = 'inspected' THEN cond := 'inspected';
  ELSIF hk = 'clean' THEN cond := 'vacant-clean';
  ELSE cond := 'vacant-dirty';
  END IF;

  NEW.housekeeping_status := hk;
  NEW.maintenance_status := mt;
  NEW.occupancy_status := oc;
  NEW.inspection_status := insp;
  NEW.room_condition := cond;
  NEW.sellable := (coalesce(NEW.status,'active') = 'active'
                   AND mt = 'operational'
                   AND oc = 'vacant'
                   AND hk IN ('clean','inspected')
                   AND insp IN ('not-required','passed'));
  IF mt = 'operational' THEN
    NEW.out_of_order_reason := NULL;
    NEW.out_of_order_from := NULL;
    NEW.out_of_order_to := NULL;
  END IF;
  RETURN NEW;
END $function$;

-- 3. Failed inspection must leave the room in rework, not plain dirty.
CREATE OR REPLACE FUNCTION public.hk_record_inspection(_job uuid, _result text, _notes text DEFAULT NULL::text, _defects jsonb DEFAULT '[]'::jsonb, _inspection_type text DEFAULT 'standard'::text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $function$
DECLARE v_org uuid := current_org_id(); v_job record; v_insp uuid;
BEGIN
  IF NOT (has_permission('housekeeping','approve') OR is_org_admin()) THEN
    RAISE EXCEPTION 'Only a housekeeping supervisor may inspect and release rooms';
  END IF;
  SELECT * INTO v_job FROM housekeeping_jobs WHERE id = _job AND organization_id = v_org FOR UPDATE;
  IF v_job IS NULL THEN RAISE EXCEPTION 'Unknown job'; END IF;
  IF v_job.status NOT IN ('awaiting-inspection','rework') THEN
    RAISE EXCEPTION 'Job % is % — only cleaning awaiting inspection can be inspected', v_job.job_number, v_job.status;
  END IF;

  INSERT INTO room_inspections (organization_id, branch_id, room_id, job_id, inspection_type, inspector_id,
                                result, defects, notes, rework_required, released_at)
  VALUES (v_org, v_job.branch_id, v_job.room_id, _job, _inspection_type, auth.uid(), _result, _defects, _notes,
          _result IN ('failed','reinspection-required'),
          CASE WHEN _result IN ('passed','passed-with-notes') THEN now() ELSE NULL END)
  RETURNING id INTO v_insp;

  IF _result IN ('passed','passed-with-notes') THEN
    UPDATE housekeeping_jobs SET status='completed', inspection_status='passed' WHERE id=_job;
    UPDATE tasks SET status='completed', completed_at=now() WHERE id=v_job.task_id;
    IF v_job.room_id IS NOT NULL THEN
      PERFORM ops_set_room_status(v_job.room_id,'inspected',NULL,'Inspection passed','housekeeping',_job);
      INSERT INTO notifications (organization_id, branch_id, user_id, category, title, body, link, priority)
      SELECT v_org, v_job.branch_id, p.id, 'front-office', 'Room ready',
             'Room released by housekeeping inspection.', '/pms/rack', 'normal'
        FROM profiles p WHERE p.organization_id = v_org AND p.account_status='active'
          AND p.department_id IN (SELECT id FROM departments WHERE organization_id=v_org AND name ILIKE 'front office%');
    END IF;
  ELSE
    UPDATE housekeeping_jobs SET status='rework', inspection_status='failed', rework_count = rework_count + 1 WHERE id=_job;
    UPDATE tasks SET status='in-progress' WHERE id=v_job.task_id;
    IF v_job.room_id IS NOT NULL THEN
      PERFORM ops_set_room_status(v_job.room_id,'rework',NULL,'Inspection failed — rework required','housekeeping',_job);
    END IF;
    IF v_job.assignee_id IS NOT NULL THEN
      INSERT INTO notifications (organization_id, branch_id, user_id, category, title, body, link, priority)
      VALUES (v_org, v_job.branch_id, v_job.assignee_id, 'housekeeping', 'Rework required',
              'Inspection failed for '||coalesce(v_job.job_number,'a cleaning task')||'. Re-clean and resubmit.',
              '/housekeeping/tasks', 'high');
    END IF;
  END IF;
  RETURN jsonb_build_object('inspection_id', v_insp, 'result', _result);
END $function$;

-- 4. Recalculation helper aligned with the same derivation.
CREATE OR REPLACE FUNCTION public.hk_recalculate_room(_room uuid)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $function$
DECLARE v_room public.rooms; v_sellable boolean;
BEGIN
  SELECT * INTO v_room FROM public.rooms WHERE id=_room FOR UPDATE;
  IF v_room.id IS NULL THEN RAISE EXCEPTION 'Unknown room'; END IF;
  -- Re-running the derivation trigger keeps one single definition of truth.
  UPDATE public.rooms SET updated_at=now() WHERE id=_room;
  SELECT sellable INTO v_sellable FROM public.rooms WHERE id=_room;
  RETURN v_sellable;
END $function$;

-- 5. One canonical room-state read model -------------------------------------
DROP FUNCTION IF EXISTS public.ops_room_state(uuid);
CREATE FUNCTION public.ops_room_state(_branch uuid DEFAULT NULL::uuid)
RETURNS TABLE(
  room_id uuid, room_number text, room_type_id uuid, room_type_name text,
  organization_id uuid, property_id uuid, floor text, building text,
  inventory_status text, occupancy_status text, housekeeping_status text,
  housekeeping_state text, readiness_state text, room_condition text,
  inspection_status text, maintenance_status text, out_of_order_reason text,
  sellable boolean, sellable_now boolean, sellability_reason text, exclusion_reasons text[],
  current_reservation_id uuid, current_confirmation_number text,
  arrival_today boolean, departure_today boolean,
  current_job_id uuid, current_task_id uuid, current_job_status text,
  assignee_id uuid, assignee_name text,
  pending_inspection boolean,
  last_cleaned_at timestamptz, last_inspected_at timestamptz,
  last_status_change timestamptz, data_version timestamptz)
LANGUAGE sql STABLE SET search_path TO 'public' AS $function$
  WITH base AS (
    SELECT r.*, public.hk_canonical_condition(r.housekeeping_status) AS hk, rt.name AS rt_name
    FROM public.rooms r
    LEFT JOIN public.room_types rt ON rt.id = r.room_type_id
    WHERE (_branch IS NULL OR r.branch_id = _branch)
  ),
  stay AS (
    SELECT DISTINCT ON (res.room_id)
      res.room_id, res.id, res.confirmation_number, res.arrival_date, res.departure_date, res.status
    FROM public.reservations res
    WHERE res.room_id IS NOT NULL
      AND res.status IN ('confirmed','checked-in','in-house','on-hold','guaranteed')
      AND res.departure_date >= current_date
    ORDER BY res.room_id, res.arrival_date
  ),
  job AS (
    SELECT DISTINCT ON (j.room_id)
      j.room_id, j.id, j.task_id, j.status, j.assignee_id
    FROM public.housekeeping_jobs j
    WHERE j.room_id IS NOT NULL AND j.status NOT IN ('completed','cancelled')
    ORDER BY j.room_id, j.created_at DESC
  ),
  derived AS (
    SELECT b.*, s.id AS res_id, s.confirmation_number AS res_no,
      s.arrival_date, s.departure_date,
      job.id AS job_id, job.task_id, job.status AS job_status, job.assignee_id,
      coalesce(b.inspection_status,'not-required') AS insp,
      coalesce(b.maintenance_status,'operational') AS mt,
      coalesce(b.occupancy_status,'vacant') AS occ,
      coalesce(b.status,'active') AS inv,
      CASE
        WHEN b.hk = 'rework' OR coalesce(b.inspection_status,'not-required') = 'failed' THEN 'rework_required'
        WHEN b.hk = 'awaiting_inspection' OR (b.hk IN ('clean','inspected') AND coalesce(b.inspection_status,'not-required') = 'pending')
          THEN 'awaiting_inspection'
        WHEN b.hk = 'cleaning_in_progress' THEN 'cleaning_in_progress'
        WHEN b.hk = 'cleaning_queued' THEN 'cleaning_queued'
        WHEN b.hk = 'dirty' THEN 'dirty'
        WHEN b.hk IN ('clean','inspected') THEN 'ready'
        ELSE b.hk
      END AS hk_state,
      job.status IS NOT NULL AS has_open_job
    FROM base b
    LEFT JOIN stay s ON s.room_id = b.id
    LEFT JOIN job ON job.room_id = b.id
  )
  SELECT
    d.id, d.room_number, d.room_type_id, d.rt_name, d.organization_id, d.branch_id,
    d.floor, d.building,
    d.inv, d.occ, d.hk, d.hk_state,
    CASE WHEN d.hk_state='ready' AND d.mt='operational' AND d.occ='vacant' AND d.inv='active'
         THEN 'ready' ELSE 'not_ready' END,
    d.room_condition, d.insp, d.mt, d.out_of_order_reason,
    (d.inv='active' AND d.occ='vacant' AND d.mt='operational' AND d.hk_state='ready'),
    (d.inv='active' AND d.occ='vacant' AND d.mt='operational' AND d.hk_state='ready' AND d.res_id IS NULL),
    CASE
      WHEN d.inv <> 'active' THEN 'Room inventory is not active'
      WHEN d.mt = 'out-of-order' THEN coalesce('Out of order: '||d.out_of_order_reason,'Out of order')
      WHEN d.mt = 'out-of-service' THEN coalesce('Out of service: '||d.out_of_order_reason,'Out of service')
      WHEN d.mt = 'under-maintenance' THEN 'Maintenance block in place'
      WHEN d.occ = 'occupied' THEN 'Currently occupied'
      WHEN d.occ = 'house-use' THEN 'Reserved for house use'
      WHEN d.hk_state <> 'ready' THEN 'Housekeeping: '||replace(d.hk_state,'_',' ')
      WHEN d.res_id IS NOT NULL THEN 'Held by reservation '||coalesce(d.res_no,'')
      ELSE 'Sellable'
    END,
    (SELECT array_remove(ARRAY[
        CASE WHEN d.inv <> 'active' THEN 'inventory-inactive' END,
        CASE WHEN d.mt <> 'operational' THEN 'maintenance-'||d.mt END,
        CASE WHEN d.occ <> 'vacant' THEN 'occupancy-'||d.occ END,
        CASE WHEN d.hk_state <> 'ready' THEN 'housekeeping-'||d.hk_state END,
        CASE WHEN d.res_id IS NOT NULL THEN 'reservation-hold' END
      ], NULL)),
    d.res_id, d.res_no,
    (d.arrival_date = current_date), (d.departure_date = current_date),
    d.job_id, d.task_id, d.job_status, d.assignee_id, p.full_name,
    (d.insp = 'pending'),
    d.last_cleaned_at, d.last_inspected_at, d.updated_at, d.updated_at
  FROM derived d
  LEFT JOIN public.profiles p ON p.id = d.assignee_id
  ORDER BY d.room_number;
$function$;

REVOKE ALL ON FUNCTION public.ops_room_state(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.ops_room_state(uuid) TO authenticated, service_role;

-- 6. Date-range availability read model --------------------------------------
CREATE OR REPLACE FUNCTION public.ops_room_availability(_branch uuid, _from date, _to date)
RETURNS TABLE(
  room_id uuid, room_number text, room_type_id uuid, room_type_name text,
  housekeeping_state text, maintenance_status text, occupancy_status text,
  sellable_now boolean, available_for_requested_dates boolean,
  exclusion_reasons text[], data_version timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $function$
  WITH s AS (
    SELECT * FROM public.ops_room_state(_branch)
    WHERE organization_id = public.current_org_id()
  ), overlap AS (
    SELECT s.room_id,
      array_remove(ARRAY[
        CASE WHEN EXISTS (
          SELECT 1 FROM public.reservations r
          WHERE r.room_id = s.room_id
            AND r.status IN ('confirmed','guaranteed','checked-in','in-house')
            AND daterange(r.arrival_date, r.departure_date, '[)') && daterange(_from, _to, '[)')
        ) THEN 'reservation-overlap' END,
        CASE WHEN EXISTS (
          SELECT 1 FROM public.room_assignments a
          WHERE a.room_id = s.room_id AND a.status='active'
            AND daterange(a.start_date, a.end_date, '[)') && daterange(_from, _to, '[)')
        ) THEN 'assignment-overlap' END,
        CASE WHEN EXISTS (
          SELECT 1 FROM public.room_blocks b
          WHERE b.room_id = s.room_id AND b.status='active'
            AND daterange(b.start_date, b.end_date, '[]') && daterange(_from, _to, '[)')
        ) THEN 'room-block' END,
        CASE WHEN EXISTS (
          SELECT 1 FROM public.reservation_holds h
          WHERE h.room_id = s.room_id AND h.status='active' AND h.hold_expires_at > now()
            AND daterange(h.arrival_date, h.departure_date, '[)') && daterange(_from, _to, '[)')
        ) THEN 'active-hold' END
      ], NULL) AS reasons
    FROM s
  ), ooo AS (
    SELECT r.id AS room_id,
      (r.out_of_order_from IS NOT NULL
        AND daterange(r.out_of_order_from, coalesce(r.out_of_order_to, 'infinity'::date), '[]')
            && daterange(_from, _to, '[)')) AS blocked
    FROM public.rooms r
  )
  SELECT s.room_id, s.room_number, s.room_type_id, s.room_type_name,
    s.housekeeping_state, s.maintenance_status, s.occupancy_status,
    s.sellable_now,
    (s.maintenance_status = 'operational'
      AND s.inventory_status = 'active'
      AND coalesce(array_length(o.reasons,1),0) = 0
      AND NOT coalesce(x.blocked,false)
      AND (_from > current_date OR s.housekeeping_state = 'ready')),
    (o.reasons
      || CASE WHEN coalesce(x.blocked,false) THEN ARRAY['out-of-order-period'] ELSE ARRAY[]::text[] END
      || CASE WHEN s.maintenance_status <> 'operational' THEN ARRAY['maintenance-'||s.maintenance_status] ELSE ARRAY[]::text[] END
      || CASE WHEN _from <= current_date AND s.housekeeping_state <> 'ready'
              THEN ARRAY['housekeeping-'||s.housekeeping_state] ELSE ARRAY[]::text[] END),
    s.data_version
  FROM s
  JOIN overlap o ON o.room_id = s.room_id
  JOIN ooo x ON x.room_id = s.room_id
  ORDER BY s.room_number;
$function$;
REVOKE ALL ON FUNCTION public.ops_room_availability(uuid, date, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.ops_room_availability(uuid, date, date) TO authenticated, service_role;

-- 7. Availability search uses the same readiness contract ---------------------
CREATE OR REPLACE FUNCTION public.pms_available_rooms(_branch uuid, _arrival date, _departure date, _room_type uuid DEFAULT NULL::uuid, _adults integer DEFAULT 1, _children integer DEFAULT 0, _for_group uuid DEFAULT NULL::uuid)
RETURNS TABLE(room_id uuid, room_number text, room_type_id uuid, room_type_name text, floor text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $function$
  WITH candidates AS (
    SELECT r.id, r.room_number, r.room_type_id AS rt_id, rt.name AS rtname, r.floor,
           row_number() OVER (PARTITION BY r.room_type_id ORDER BY r.room_number DESC) AS rn
    FROM public.rooms r
    LEFT JOIN public.room_types rt ON rt.id = r.room_type_id
    WHERE r.organization_id = public.current_org_id()
      AND (_branch IS NULL OR r.branch_id = _branch)
      AND r.status = 'active'
      AND r.maintenance_status = 'operational'
      AND (_room_type IS NULL OR r.room_type_id = _room_type)
      AND (rt.id IS NULL OR rt.max_occupancy >= (_adults + _children))
      -- Same-day and in-progress stays must also be physically ready.
      AND (_arrival > current_date
           OR (public.hk_canonical_condition(r.housekeeping_status) IN ('clean','inspected')
               AND coalesce(r.inspection_status,'not-required') IN ('not-required','passed')
               AND coalesce(r.occupancy_status,'vacant') = 'vacant'))
      AND NOT (r.out_of_order_from IS NOT NULL
               AND daterange(r.out_of_order_from, coalesce(r.out_of_order_to,'infinity'::date), '[]')
                   && daterange(_arrival, _departure, '[)'))
      AND NOT EXISTS (
        SELECT 1 FROM public.reservations res
        WHERE res.room_id = r.id
          AND res.status IN ('confirmed','guaranteed','checked-in','in-house')
          AND daterange(res.arrival_date, res.departure_date, '[)') && daterange(_arrival, _departure, '[)'))
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
  ), held AS (
    SELECT gb.room_type_id AS rt_id,
           COALESCE(sum(GREATEST(gb.rooms_blocked - gb.rooms_picked_up - gb.rooms_released,0)),0)::int AS qty
    FROM public.group_room_blocks gb
    JOIN public.group_bookings g ON g.id = gb.group_booking_id
    WHERE gb.status = 'active' AND g.organization_id = public.current_org_id()
      AND g.status NOT IN ('cancelled','closed')
      AND (_branch IS NULL OR g.branch_id = _branch)
      AND (_for_group IS NULL OR gb.group_booking_id <> _for_group)
      AND daterange(gb.start_date, gb.end_date, '[]') && daterange(_arrival, _departure, '[)')
    GROUP BY gb.room_type_id
  )
  SELECT c.id, c.room_number, c.rt_id, c.rtname, c.floor
  FROM candidates c
  LEFT JOIN held h ON h.rt_id = c.rt_id
  WHERE c.rn > COALESCE(h.qty, 0)
  ORDER BY c.room_number;
$function$;

-- 8. Reconciliation report ----------------------------------------------------
CREATE OR REPLACE FUNCTION public.ops_room_state_reconciliation(_branch uuid DEFAULT NULL)
RETURNS TABLE(room_id uuid, room_number text, issue text, detail text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $function$
  WITH s AS (
    SELECT * FROM public.ops_room_state(_branch) WHERE organization_id = public.current_org_id()
  )
  SELECT s.room_id, s.room_number, 'cleaning-in-progress-without-task',
         'Room reports cleaning in progress but no open housekeeping task exists'
  FROM s WHERE s.housekeeping_state='cleaning_in_progress' AND s.current_job_id IS NULL
  UNION ALL
  SELECT s.room_id, s.room_number, 'awaiting-inspection-without-inspection',
         'Room awaits inspection but no cleaning job is awaiting inspection'
  FROM s WHERE s.housekeeping_state='awaiting_inspection'
    AND NOT EXISTS (SELECT 1 FROM public.housekeeping_jobs j
                    WHERE j.room_id=s.room_id AND j.status IN ('awaiting-inspection','rework'))
  UNION ALL
  SELECT s.room_id, s.room_number, 'sellable-with-maintenance-block',
         'Room is marked sellable while a maintenance block is in place'
  FROM s WHERE s.sellable_now AND s.maintenance_status <> 'operational'
  UNION ALL
  SELECT s.room_id, s.room_number, 'duplicate-open-cleaning-task',
         'More than one open cleaning task exists for this room'
  FROM s WHERE (SELECT count(*) FROM public.housekeeping_jobs j
                WHERE j.room_id=s.room_id AND j.status NOT IN ('completed','cancelled')) > 1
  UNION ALL
  SELECT s.room_id, s.room_number, 'dirty-without-cleaning-task',
         'Room is dirty or in rework but no open cleaning task exists'
  FROM s WHERE s.housekeeping_state IN ('dirty','rework_required') AND s.current_job_id IS NULL
  UNION ALL
  SELECT s.room_id, s.room_number, 'orphan-inspection-flag',
         'Inspection state is set on a room that is not clean'
  FROM s WHERE s.inspection_status <> 'not-required'
    AND s.housekeeping_state IN ('dirty','cleaning_queued','cleaning_in_progress');
$function$;
REVOKE ALL ON FUNCTION public.ops_room_state_reconciliation(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.ops_room_state_reconciliation(uuid) TO authenticated, service_role;

-- 9. Safe reconciliation of existing rows: re-run derivation only.
UPDATE public.rooms SET updated_at = now();
