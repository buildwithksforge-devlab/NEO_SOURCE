CREATE OR REPLACE FUNCTION public.neo_station_store_console(_branch uuid DEFAULT NULL)
RETURNS TABLE(
  station_id uuid, station_name text, station_code text, station_type text,
  department_id uuid, department_name text, branch_id uuid,
  location_id uuid, location_name text, location_active boolean, location_branch_id uuid,
  mapped_explicitly boolean, recipes_active bigint, direct_items bigint, routed_items bigint,
  changed_at timestamptz, changed_by_name text, state text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $fn$
  WITH base AS (
    SELECT s.id, s.name, s.code, coalesce(s.station_type,'service') AS station_type,
           s.department_id, d.name AS department_name, s.branch_id, s.organization_id,
           m.location_id AS mapped_location,
           m.updated_at AS changed_at,
           coalesce(
             p.full_name,
             (SELECT a.user_name FROM audit_logs a
               WHERE a.organization_id = s.organization_id
                 AND a.record_id = s.id::text
                 AND a.action IN ('station_store_assigned','station_store_changed')
                 AND a.created_at >= now() - interval '400 days'
                 AND a.user_name IS NOT NULL
               ORDER BY a.created_at DESC LIMIT 1)
           ) AS changed_by_name,
           public.neo_station_consumption_location(s.organization_id, s.id, s.branch_id) AS resolved
      FROM operational_stations s
      LEFT JOIN departments d ON d.id = s.department_id
      LEFT JOIN station_consumption_stores m
             ON m.station_id = s.id AND m.organization_id = s.organization_id
      LEFT JOIN profiles p ON p.id = m.created_by
     WHERE s.organization_id = public.current_org_id()
       AND s.active
       AND (_branch IS NULL OR s.branch_id = _branch OR s.branch_id IS NULL)
       AND public.neo_branch_in_scope(s.branch_id)
  ), counted AS (
    SELECT b.*,
      (SELECT count(*) FROM recipes r
        WHERE r.station_id = b.id AND r.organization_id = b.organization_id AND r.status = 'active') AS recipes_active,
      (SELECT count(*) FROM menu_items mi
        WHERE mi.station_id = b.id AND mi.organization_id = b.organization_id) AS direct_items,
      (SELECT count(*) FROM menu_items mi
         JOIN station_routing_rules rr ON rr.category_id = mi.category_id
        WHERE rr.station_id = b.id AND rr.organization_id = b.organization_id
          AND mi.organization_id = b.organization_id AND mi.station_id IS NULL) AS routed_items,
      sl.id AS store_id, sl.name AS store_name, sl.active AS store_active, sl.branch_id AS store_branch
      FROM base b
      LEFT JOIN stock_locations sl ON sl.id = coalesce(b.mapped_location, b.resolved)
  )
  SELECT c.id, c.name, c.code, c.station_type, c.department_id, c.department_name, c.branch_id,
         c.store_id, c.store_name, c.store_active, c.store_branch,
         c.mapped_location IS NOT NULL,
         c.recipes_active, c.direct_items, c.routed_items,
         c.changed_at, c.changed_by_name,
         CASE
           WHEN c.store_id IS NULL THEN 'needs_setup'
           WHEN c.store_active IS NOT TRUE THEN 'store_inactive'
           WHEN c.store_branch IS NOT NULL AND c.branch_id IS NOT NULL
                AND c.store_branch <> c.branch_id THEN 'cross_property'
           ELSE 'ready'
         END
    FROM counted c
   WHERE c.station_type IN ('production','bar','beverage','pastry','kitchen')
      OR c.recipes_active > 0 OR c.direct_items > 0 OR c.routed_items > 0
   ORDER BY (c.store_id IS NULL) DESC, c.department_name NULLS LAST, c.name;
$fn$;

GRANT EXECUTE ON FUNCTION public.neo_station_store_console(uuid) TO authenticated;