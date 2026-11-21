-- Code-only Savannah room read models. No room, stay, task or reservation rows are updated.
-- Preserve existing function privileges and public return contracts. Do not run a historical backfill.
BEGIN;
SET LOCAL search_path=public;
DO $guard$ BEGIN
 IF to_regprocedure('public.ops_room_state(uuid)') IS NULL OR md5(pg_get_functiondef(to_regprocedure('public.ops_room_state(uuid)'))) IS DISTINCT FROM '2b90918a331868e431e51dc297ddfd34' THEN RAISE EXCEPTION 'Room readiness source differs: ops_room_state(uuid); inspect installed definitions before applying'; END IF;
 IF to_regprocedure('public.ops_room_availability(uuid,date,date)') IS NULL OR md5(pg_get_functiondef(to_regprocedure('public.ops_room_availability(uuid,date,date)'))) IS DISTINCT FROM '2a429e73d1bb74169bcc32ccdf56e6d4' THEN RAISE EXCEPTION 'Room readiness source differs: ops_room_availability(uuid,date,date); inspect installed definitions before applying'; END IF;
 IF to_regprocedure('public.pms_available_rooms(uuid,date,date,uuid,integer,integer,uuid)') IS NULL OR md5(pg_get_functiondef(to_regprocedure('public.pms_available_rooms(uuid,date,date,uuid,integer,integer,uuid)'))) IS DISTINCT FROM '6c7728b31765a22a36d4d1c69f76fc28' THEN RAISE EXCEPTION 'Room readiness source differs: pms_available_rooms(uuid,date,date,uuid,integer,integer,uuid); inspect installed definitions before applying'; END IF;
END $guard$;
CREATE OR REPLACE FUNCTION public.ops_room_state(_branch uuid DEFAULT NULL::uuid)
 RETURNS TABLE(room_id uuid, room_number text, room_type_id uuid, room_type_name text, organization_id uuid, property_id uuid, floor text, building text, inventory_status text, occupancy_status text, housekeeping_status text, housekeeping_state text, readiness_state text, room_condition text, inspection_status text, maintenance_status text, out_of_order_reason text, sellable boolean, sellable_now boolean, sellability_reason text, exclusion_reasons text[], current_reservation_id uuid, current_confirmation_number text, arrival_today boolean, departure_today boolean, current_job_id uuid, current_task_id uuid, current_job_status text, assignee_id uuid, assignee_name text, pending_inspection boolean, last_cleaned_at timestamp with time zone, last_inspected_at timestamp with time zone, last_status_change timestamp with time zone, data_version timestamp with time zone)
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $function$
  WITH base AS (
    SELECT r.*, public.hk_canonical_condition(r.housekeeping_status) AS hk, rt.name AS rt_name,
      CASE WHEN r.organization_id='aa17d427-f816-49bc-b02e-1a89e44806a2'::uuid THEN (now() AT TIME ZONE coalesce(nullif(br.timezone,''),'Africa/Nairobi'))::date ELSE current_date END AS room_today
    FROM public.rooms r
    LEFT JOIN public.room_types rt ON rt.id = r.room_type_id
    LEFT JOIN public.branches br ON br.id=r.branch_id AND br.organization_id=r.organization_id
    WHERE r.organization_id=public.current_org_id() AND public.neo_branch_in_scope(r.branch_id)
      AND (_branch IS NULL OR r.branch_id = _branch)
  ),
  stay AS (
    SELECT DISTINCT ON (res.organization_id,res.room_id)
      res.organization_id, res.room_id, res.id, res.confirmation_number, res.arrival_date, res.departure_date, res.status
    FROM public.reservations res JOIN base b ON b.id=res.room_id AND b.organization_id=res.organization_id AND b.branch_id IS NOT DISTINCT FROM res.branch_id
    WHERE res.room_id IS NOT NULL
      AND CASE WHEN res.organization_id='aa17d427-f816-49bc-b02e-1a89e44806a2'::uuid THEN
        res.status IN ('checked-in','in-house','checked_in','in_house') OR
        (res.status IN ('confirmed','on-hold','guaranteed') AND res.arrival_date<=b.room_today AND res.departure_date>=b.room_today)
      ELSE res.status IN ('confirmed','checked-in','in-house','on-hold','guaranteed') AND res.departure_date>=current_date END
    ORDER BY res.organization_id,res.room_id,
      CASE WHEN res.organization_id='aa17d427-f816-49bc-b02e-1a89e44806a2'::uuid AND res.status IN ('checked-in','in-house','checked_in','in_house') THEN 0 ELSE 1 END,
      res.arrival_date,res.id
  ),
  job AS (
    SELECT DISTINCT ON (j.organization_id,j.room_id)
      j.organization_id,j.room_id, j.id, j.task_id, j.status, j.assignee_id
    FROM public.housekeeping_jobs j JOIN base b ON b.id=j.room_id AND b.organization_id=j.organization_id AND b.branch_id IS NOT DISTINCT FROM j.branch_id
    WHERE j.room_id IS NOT NULL AND public.hk_job_is_open(j.status, j.superseded_by)
    ORDER BY j.organization_id,j.room_id, j.created_at DESC,j.id DESC
  ),
  derived AS (
    SELECT b.*, s.id AS res_id, s.confirmation_number AS res_no,
      s.arrival_date, s.departure_date,
      job.id AS job_id, job.task_id, job.status AS job_status, job.assignee_id,
      coalesce(b.inspection_status,'not-required') AS insp,
      coalesce(b.maintenance_status,'operational') AS mt,
      CASE WHEN b.organization_id='aa17d427-f816-49bc-b02e-1a89e44806a2'::uuid AND s.status IN ('checked-in','in-house','checked_in','in_house') THEN 'occupied' ELSE coalesce(b.occupancy_status,'vacant') END AS occ,
      coalesce(b.status,'active') AS inv,
      CASE
        WHEN b.organization_id='aa17d427-f816-49bc-b02e-1a89e44806a2'::uuid AND job.status='rework' THEN 'rework_required'
        WHEN b.organization_id='aa17d427-f816-49bc-b02e-1a89e44806a2'::uuid AND job.status='awaiting-inspection' THEN 'awaiting_inspection'
        WHEN b.organization_id='aa17d427-f816-49bc-b02e-1a89e44806a2'::uuid AND job.id IS NOT NULL THEN
          CASE WHEN job.status IN ('in-progress','in_progress','cleaning') THEN 'cleaning_in_progress' ELSE 'cleaning_queued' END
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
    LEFT JOIN stay s ON s.room_id = b.id AND s.organization_id=b.organization_id
    LEFT JOIN job ON job.room_id = b.id AND job.organization_id=b.organization_id
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
    (d.arrival_date = d.room_today), (d.departure_date = d.room_today),
    d.job_id, d.task_id, d.job_status, d.assignee_id, p.full_name,
    (d.insp = 'pending'),
    d.last_cleaned_at, d.last_inspected_at, d.updated_at, d.updated_at
  FROM derived d
  LEFT JOIN public.profiles p ON p.id = d.assignee_id
  ORDER BY d.room_number;
$function$;

CREATE OR REPLACE FUNCTION public.ops_room_availability(_branch uuid, _from date, _to date)
RETURNS TABLE(
  room_id uuid, room_number text, room_type_id uuid, room_type_name text,
  housekeeping_state text, maintenance_status text, occupancy_status text,
  sellable_now boolean, available_for_requested_dates boolean,
  exclusion_reasons text[], data_version timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $function$
  WITH s AS (
    SELECT rs.*,CASE WHEN rs.organization_id='aa17d427-f816-49bc-b02e-1a89e44806a2'::uuid THEN (now() AT TIME ZONE coalesce(nullif(br.timezone,''),'Africa/Nairobi'))::date ELSE current_date END AS room_today
    FROM public.ops_room_state(_branch) rs LEFT JOIN public.branches br ON br.id=rs.property_id AND br.organization_id=rs.organization_id
    WHERE rs.organization_id = public.current_org_id() AND public.neo_branch_in_scope(rs.property_id)
      AND _from IS NOT NULL AND _to IS NOT NULL AND _from<_to
  ), overlap AS (
    SELECT s.room_id,
      array_remove(ARRAY[
        CASE WHEN EXISTS (
          SELECT 1 FROM public.reservations r
          WHERE r.room_id = s.room_id
            AND r.organization_id=s.organization_id AND ((r.organization_id='aa17d427-f816-49bc-b02e-1a89e44806a2'::uuid AND r.status IN ('checked-in','in-house','checked_in','in_house') AND r.departure_date<s.room_today) OR
              ((r.status IN ('confirmed','guaranteed','checked-in','in-house') OR (r.organization_id='aa17d427-f816-49bc-b02e-1a89e44806a2'::uuid AND r.status IN ('checked_in','in_house')))
               AND daterange(r.arrival_date, r.departure_date, '[)') && daterange(_from, _to, '[)')))
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
      AND (_from > s.room_today OR (s.housekeeping_state = 'ready' AND (s.organization_id<>'aa17d427-f816-49bc-b02e-1a89e44806a2'::uuid OR s.occupancy_status='vacant')))),
    (o.reasons
      || CASE WHEN s.organization_id='aa17d427-f816-49bc-b02e-1a89e44806a2'::uuid AND _from<=s.room_today AND s.occupancy_status<>'vacant' THEN ARRAY['occupancy-'||s.occupancy_status] ELSE ARRAY[]::text[] END
      || CASE WHEN coalesce(x.blocked,false) THEN ARRAY['out-of-order-period'] ELSE ARRAY[]::text[] END
      || CASE WHEN s.maintenance_status <> 'operational' THEN ARRAY['maintenance-'||s.maintenance_status] ELSE ARRAY[]::text[] END
      || CASE WHEN _from <= s.room_today AND s.housekeeping_state <> 'ready'
              THEN ARRAY['housekeeping-'||s.housekeeping_state] ELSE ARRAY[]::text[] END),
    s.data_version
  FROM s
  JOIN overlap o ON o.room_id = s.room_id
  JOIN ooo x ON x.room_id = s.room_id
  ORDER BY s.room_number;
$function$;

CREATE OR REPLACE FUNCTION public.pms_available_rooms(
  _branch uuid,
  _arrival date,
  _departure date,
  _room_type uuid DEFAULT NULL::uuid,
  _adults integer DEFAULT 1,
  _children integer DEFAULT 0,
  _for_group uuid DEFAULT NULL::uuid
)
RETURNS TABLE(
  room_id uuid,
  room_number text,
  room_type_id uuid,
  room_type_name text,
  floor text,
  branch_id uuid,
  branch_name text,
  max_occupancy integer,
  readiness text,
  maintenance_status text,
  occupancy_status text,
  nights integer,
  qualification text
)
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  WITH bounds AS (
    SELECT _arrival AS a, _departure AS d,
           GREATEST(_departure - _arrival, 0)::int AS n
  ), candidates AS (
    SELECT r.id, r.room_number, r.room_type_id AS rt_id, rt.name AS rtname, r.floor,
           r.branch_id, b.name AS bname,
           COALESCE(rt.max_occupancy, 0)::int AS cap,
           CASE
             WHEN r.organization_id='aa17d427-f816-49bc-b02e-1a89e44806a2'::uuid THEN rs.housekeeping_state
             WHEN public.hk_canonical_condition(r.housekeeping_status) IN ('clean','inspected')
                  AND coalesce(r.inspection_status,'not-required') IN ('not-required','passed')
               THEN 'ready'
             ELSE public.hk_canonical_condition(r.housekeeping_status)
           END AS readiness,
           r.maintenance_status,
           CASE WHEN r.organization_id='aa17d427-f816-49bc-b02e-1a89e44806a2'::uuid THEN rs.occupancy_status ELSE coalesce(r.occupancy_status,'vacant') END AS occupancy_status,
           row_number() OVER (PARTITION BY r.room_type_id ORDER BY r.room_number DESC) AS rn
    FROM public.rooms r
    LEFT JOIN public.room_types rt ON rt.id = r.room_type_id
    LEFT JOIN public.branches b ON b.id = r.branch_id
    JOIN public.ops_room_state(_branch) rs ON rs.room_id=r.id AND rs.organization_id=r.organization_id
    CROSS JOIN bounds
    CROSS JOIN LATERAL (SELECT CASE WHEN r.organization_id='aa17d427-f816-49bc-b02e-1a89e44806a2'::uuid THEN (now() AT TIME ZONE coalesce(nullif(b.timezone,''),'Africa/Nairobi'))::date ELSE current_date END AS room_today) clock
    WHERE public.neo_branch_in_scope(r.branch_id) AND r.organization_id = public.current_org_id()
      AND (_branch IS NULL OR r.branch_id = _branch)
      AND r.status = 'active'
      AND r.maintenance_status = 'operational'
      AND (_room_type IS NULL OR r.room_type_id = _room_type)
      AND (rt.id IS NULL OR rt.max_occupancy >= (COALESCE(_adults,1) + COALESCE(_children,0)))
      AND bounds.n > 0 AND coalesce(_adults,1)>=1 AND coalesce(_children,0)>=0
      -- Same-day and in-progress stays must also be physically ready.
      AND (bounds.a > clock.room_today
           OR (r.organization_id='aa17d427-f816-49bc-b02e-1a89e44806a2'::uuid AND rs.sellable)
           OR (r.organization_id<>'aa17d427-f816-49bc-b02e-1a89e44806a2'::uuid AND public.hk_canonical_condition(r.housekeeping_status) IN ('clean','inspected')
               AND coalesce(r.inspection_status,'not-required') IN ('not-required','passed')
               AND coalesce(r.occupancy_status,'vacant') = 'vacant'))
      AND NOT (r.out_of_order_from IS NOT NULL
               AND daterange(r.out_of_order_from, coalesce(r.out_of_order_to,'infinity'::date), '[]')
                   && daterange(bounds.a, bounds.d, '[)'))
      AND NOT EXISTS (
        SELECT 1 FROM public.reservations res
        WHERE res.room_id = r.id
          AND res.organization_id=r.organization_id AND ((res.organization_id='aa17d427-f816-49bc-b02e-1a89e44806a2'::uuid AND res.status IN ('checked-in','in-house','checked_in','in_house') AND res.departure_date<clock.room_today) OR
            ((res.status IN ('confirmed','guaranteed','checked-in','in-house') OR (res.organization_id='aa17d427-f816-49bc-b02e-1a89e44806a2'::uuid AND res.status IN ('checked_in','in_house')))
             AND daterange(res.arrival_date, res.departure_date, '[)') && daterange(bounds.a, bounds.d, '[)'))))
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
  ), held AS (
    SELECT gb.room_type_id AS rt_id,
           COALESCE(sum(GREATEST(gb.rooms_blocked - gb.rooms_picked_up - gb.rooms_released,0)),0)::int AS qty
    FROM public.group_room_blocks gb
    JOIN public.group_bookings g ON g.id = gb.group_booking_id
    CROSS JOIN bounds
    WHERE gb.status = 'active' AND g.organization_id = public.current_org_id()
      AND g.status NOT IN ('cancelled','closed')
      AND (_branch IS NULL OR g.branch_id = _branch)
      AND (_for_group IS NULL OR gb.group_booking_id <> _for_group)
      AND daterange(gb.start_date, gb.end_date, '[]') && daterange(bounds.a, bounds.d, '[)')
    GROUP BY gb.room_type_id
  ), demand AS (
    -- Confirmed/guaranteed stays that have no room yet still consume inventory
    -- of their room type; otherwise the same room type is sold twice.
    SELECT res.room_type_id AS rt_id, count(*)::int AS qty
    FROM public.reservations res
    CROSS JOIN bounds
    WHERE res.organization_id = public.current_org_id()
      AND res.room_id IS NULL
      AND res.room_type_id IS NOT NULL
      AND res.status IN ('confirmed','guaranteed')
      AND (_branch IS NULL OR res.branch_id = _branch)
      AND (_for_group IS NULL OR res.group_booking_id IS DISTINCT FROM _for_group)
      AND daterange(res.arrival_date, res.departure_date, '[)') && daterange(bounds.a, bounds.d, '[)')
    GROUP BY res.room_type_id
  )
  SELECT c.id, c.room_number, c.rt_id, c.rtname, c.floor, c.branch_id, c.bname,
         c.cap, c.readiness, c.maintenance_status, c.occupancy_status,
         (SELECT n FROM bounds),
         'Sellable, no overlapping stay, assignment, block, hold or group inventory for '
           || to_char((SELECT a FROM bounds),'YYYY-MM-DD') || ' → '
           || to_char((SELECT d FROM bounds),'YYYY-MM-DD')
  FROM candidates c
  LEFT JOIN held h ON h.rt_id = c.rt_id
  LEFT JOIN demand dm ON dm.rt_id = c.rt_id
  WHERE c.rn > COALESCE(h.qty, 0) + COALESCE(dm.qty, 0)
  ORDER BY c.bname NULLS LAST, c.room_number;
$function$;

COMMIT;
