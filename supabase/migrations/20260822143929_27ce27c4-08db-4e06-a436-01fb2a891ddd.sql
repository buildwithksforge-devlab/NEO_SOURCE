
DROP FUNCTION IF EXISTS public.pms_available_rooms(uuid, date, date, uuid, integer, integer);
DROP FUNCTION IF EXISTS public.pms_available_rooms(uuid, date, date, uuid, integer, integer, uuid);

CREATE FUNCTION public.pms_available_rooms(
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
             WHEN public.hk_canonical_condition(r.housekeeping_status) IN ('clean','inspected')
                  AND coalesce(r.inspection_status,'not-required') IN ('not-required','passed')
               THEN 'ready'
             ELSE public.hk_canonical_condition(r.housekeeping_status)
           END AS readiness,
           r.maintenance_status,
           coalesce(r.occupancy_status,'vacant') AS occupancy_status,
           row_number() OVER (PARTITION BY r.room_type_id ORDER BY r.room_number DESC) AS rn
    FROM public.rooms r
    LEFT JOIN public.room_types rt ON rt.id = r.room_type_id
    LEFT JOIN public.branches b ON b.id = r.branch_id
    CROSS JOIN bounds
    WHERE r.organization_id = public.current_org_id()
      AND (_branch IS NULL OR r.branch_id = _branch)
      AND r.status = 'active'
      AND r.maintenance_status = 'operational'
      AND (_room_type IS NULL OR r.room_type_id = _room_type)
      AND (rt.id IS NULL OR rt.max_occupancy >= (COALESCE(_adults,1) + COALESCE(_children,0)))
      AND bounds.n > 0
      -- Same-day and in-progress stays must also be physically ready.
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

REVOKE ALL ON FUNCTION public.pms_available_rooms(uuid, date, date, uuid, integer, integer, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.pms_available_rooms(uuid, date, date, uuid, integer, integer, uuid) TO authenticated;
