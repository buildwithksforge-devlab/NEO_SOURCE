CREATE OR REPLACE FUNCTION public.neo_station_store_readiness(_branch uuid DEFAULT NULL::uuid)
 RETURNS TABLE(station_id uuid, station_name text, station_type text, department_name text, branch_id uuid, recipes_active bigint, direct_items bigint, location_id uuid, location_name text, mapped_explicitly boolean, ready boolean)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT s.id,
         s.name,
         coalesce(s.station_type, 'service'),
         d.name,
         s.branch_id,
         (SELECT count(*) FROM recipes r
           WHERE r.station_id = s.id
             AND r.organization_id = s.organization_id
             AND r.status = 'active'),
         (SELECT count(*) FROM menu_items mi
           WHERE mi.station_id = s.id
             AND mi.organization_id = s.organization_id),
         public.neo_station_consumption_location(s.organization_id, s.id, s.branch_id),
         (SELECT sl.name FROM stock_locations sl
           WHERE sl.id = public.neo_station_consumption_location(s.organization_id, s.id, s.branch_id)),
         EXISTS (SELECT 1 FROM station_consumption_stores m
                  WHERE m.station_id = s.id AND m.organization_id = s.organization_id),
         public.neo_station_consumption_location(s.organization_id, s.id, s.branch_id) IS NOT NULL
    FROM operational_stations s
    LEFT JOIN departments d ON d.id = s.department_id
   WHERE s.organization_id = public.current_org_id()
     AND s.active
     AND (_branch IS NULL OR s.branch_id = _branch OR s.branch_id IS NULL)
     AND public.neo_branch_in_scope(s.branch_id)
   ORDER BY (public.neo_station_consumption_location(s.organization_id, s.id, s.branch_id) IS NULL) DESC,
            d.name NULLS LAST, s.name;
$function$;

GRANT EXECUTE ON FUNCTION public.neo_station_store_readiness(uuid) TO authenticated, service_role;