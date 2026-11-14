CREATE OR REPLACE FUNCTION public.ops_room_availability(_branch uuid, _from date, _to date)
 RETURNS TABLE(room_id uuid, room_number text, room_type_id uuid, room_type_name text, housekeeping_state text, maintenance_status text, occupancy_status text, sellable_now boolean, available_for_requested_dates boolean, exclusion_reasons text[], data_version timestamp with time zone)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  WITH s AS (
    SELECT rs.*,(now() AT TIME ZONE coalesce(nullif(br.timezone,''),'UTC'))::date AS room_today
    FROM public.ops_room_state(_branch) rs LEFT JOIN public.branches br ON br.id=rs.property_id AND br.organization_id=rs.organization_id
    WHERE rs.organization_id = public.current_org_id() AND public.neo_branch_in_scope(rs.property_id)
      AND _from IS NOT NULL AND _to IS NOT NULL AND _from<_to
  ), overlap AS (
    SELECT s.room_id,
      array_remove(ARRAY[
        CASE WHEN EXISTS (
          SELECT 1 FROM public.reservations r
          WHERE r.room_id = s.room_id
            AND r.organization_id=s.organization_id AND ((r.status IN ('checked-in','in-house','checked_in','in_house') AND r.departure_date<s.room_today) OR
              (r.status IN ('confirmed','guaranteed','checked-in','in-house','checked_in','in_house')
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
      AND (_from > s.room_today OR (s.housekeeping_state = 'ready' AND s.occupancy_status='vacant'))),
    (o.reasons
      || CASE WHEN _from<=s.room_today AND s.occupancy_status<>'vacant' THEN ARRAY['occupancy-'||s.occupancy_status] ELSE ARRAY[]::text[] END
      || CASE WHEN coalesce(x.blocked,false) THEN ARRAY['out-of-order-period'] ELSE ARRAY[]::text[] END
      || CASE WHEN s.maintenance_status <> 'operational' THEN ARRAY['maintenance-'||s.maintenance_status] ELSE ARRAY[]::text[] END
      || CASE WHEN _from <= s.room_today AND s.housekeeping_state <> 'ready'
              THEN ARRAY['housekeeping-'||s.housekeeping_state] ELSE ARRAY[]::text[] END),
    s.data_version
  FROM s
  JOIN overlap o ON o.room_id = s.room_id
  JOIN ooo x ON x.room_id = s.room_id
  ORDER BY s.room_number;
$function$
