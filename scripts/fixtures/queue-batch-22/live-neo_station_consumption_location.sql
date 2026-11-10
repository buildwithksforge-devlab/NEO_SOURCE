CREATE OR REPLACE FUNCTION public.neo_station_consumption_location(_org uuid, _station uuid, _branch uuid)
 RETURNS uuid
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT sl.id
  FROM public.station_consumption_stores m
  JOIN public.operational_stations s
    ON s.id = m.station_id
   AND s.organization_id = _org
   AND s.active
  JOIN public.stock_locations sl
    ON sl.id = m.location_id
   AND sl.organization_id = _org
   AND sl.active
   AND NOT COALESCE(sl.is_main, false)
  WHERE m.organization_id = _org
    AND m.station_id = _station
    AND _station IS NOT NULL
    AND s.branch_id IS NOT NULL
    AND s.branch_id IS NOT DISTINCT FROM _branch
    AND m.branch_id IS NOT DISTINCT FROM s.branch_id
    AND sl.branch_id IS NOT DISTINCT FROM s.branch_id
  LIMIT 1;
$function$
