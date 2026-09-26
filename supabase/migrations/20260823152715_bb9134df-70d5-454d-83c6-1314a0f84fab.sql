-- Front Office dashboard cards were placeholders even though PMS is live.
-- One scoped, property-local-date routine now supplies every figure, read
-- through the same fact layer the rest of the dashboards use.
CREATE OR REPLACE FUNCTION public.neo_front_office_facts(_branch uuid DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE
  org uuid := public.current_org_id();
  tz text; today date;
  arrivals int := 0; arrivals_pending int := 0; departures int := 0;
  departures_pending int := 0; checkins int := 0; checkouts int := 0;
  in_house int := 0;
  rooms_total int := 0; rooms_available int := 0; rooms_occupied int := 0;
  rooms_ooo int := 0; rooms_dirty int := 0;
BEGIN
  IF org IS NULL THEN RETURN jsonb_build_object('authorised', false); END IF;

  SELECT coalesce(b.timezone, 'Africa/Nairobi') INTO tz FROM public.branches b
   WHERE b.organization_id = org AND (_branch IS NULL OR b.id = _branch)
   ORDER BY (b.id = _branch) DESC LIMIT 1;
  tz := coalesce(tz, 'Africa/Nairobi');
  today := (now() AT TIME ZONE tz)::date;

  SELECT
    count(*) FILTER (WHERE r.arrival_date = today AND r.status IN ('confirmed','guaranteed','tentative','pending-deposit','checked-in')),
    count(*) FILTER (WHERE r.arrival_date = today AND r.status IN ('confirmed','guaranteed','pending-deposit')),
    count(*) FILTER (WHERE r.departure_date = today AND r.status IN ('checked-in','checked-out')),
    count(*) FILTER (WHERE r.departure_date = today AND r.status = 'checked-in'),
    count(*) FILTER (WHERE r.arrival_date = today AND r.status IN ('checked-in','checked-out')),
    count(*) FILTER (WHERE r.departure_date = today AND r.status = 'checked-out'),
    count(*) FILTER (WHERE r.status = 'checked-in')
    INTO arrivals, arrivals_pending, departures, departures_pending, checkins, checkouts, in_house
    FROM public.reservations r
   WHERE r.organization_id = org AND (_branch IS NULL OR r.branch_id = _branch);

  SELECT count(*),
         count(*) FILTER (WHERE s.sellable_now),
         count(*) FILTER (WHERE s.occupancy_status = 'occupied'),
         count(*) FILTER (WHERE s.maintenance_status = 'out-of-order' OR s.inventory_status = 'out-of-order'),
         count(*) FILTER (WHERE s.room_condition = 'dirty')
    INTO rooms_total, rooms_available, rooms_occupied, rooms_ooo, rooms_dirty
    FROM public.ops_room_state(_branch) s;

  RETURN jsonb_build_object(
    'authorised', true,
    'local_date', today,
    'timezone', tz,
    'arrivals_today', arrivals,
    'arrivals_pending', arrivals_pending,
    'departures_today', departures,
    'departures_pending', departures_pending,
    'checkins_completed', checkins,
    'checkouts_completed', checkouts,
    'in_house', in_house,
    'rooms_total', rooms_total,
    'rooms_available', rooms_available,
    'rooms_occupied', rooms_occupied,
    'rooms_out_of_order', rooms_ooo,
    'rooms_dirty', rooms_dirty);
END;
$function$;

REVOKE ALL ON FUNCTION public.neo_front_office_facts(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.neo_front_office_facts(uuid) TO authenticated, service_role;