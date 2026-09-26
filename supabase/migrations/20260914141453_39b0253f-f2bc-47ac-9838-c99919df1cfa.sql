CREATE OR REPLACE FUNCTION public.neo_bar_station_ids(_branch uuid DEFAULT NULL::uuid)
RETURNS SETOF uuid
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $fn$
  SELECT s.id
    FROM public.operational_stations s
    JOIN public.departments d ON d.id = s.department_id
   WHERE s.organization_id = public.current_org_id()
     AND (_branch IS NULL OR s.branch_id = _branch)
     AND coalesce(s.active, true)
     AND (upper(coalesce(d.code,'')) = 'BAR' OR d.name ILIKE 'bar%' OR d.name ILIKE '% bar%');
$fn$;