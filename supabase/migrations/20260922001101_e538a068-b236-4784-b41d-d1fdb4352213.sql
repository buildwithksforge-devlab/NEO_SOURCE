-- Rich console view of station → consumption store mapping for one property.
DROP FUNCTION IF EXISTS public.neo_station_store_console(uuid);
CREATE FUNCTION public.neo_station_store_console(_branch uuid DEFAULT NULL)
RETURNS TABLE(
  station_id uuid, station_name text, station_code text, station_type text,
  department_id uuid, department_name text, branch_id uuid,
  location_id uuid, location_name text, location_active boolean,
  location_branch_id uuid, mapped_explicitly boolean,
  recipes_active bigint, direct_items bigint, routed_items bigint,
  changed_at timestamptz, changed_by_name text, state text
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $fn$
  WITH base AS (
    SELECT s.id, s.name, s.code, coalesce(s.station_type,'service') AS station_type,
           s.department_id, d.name AS department_name, s.branch_id, s.organization_id,
           m.location_id AS mapped_location,
           m.updated_at AS changed_at,
           p.full_name AS changed_by_name,
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
           WHEN (c.recipes_active + c.direct_items + c.routed_items) = 0 THEN 'no_production'
           ELSE 'ready'
         END
    FROM counted c
   WHERE c.station_type IN ('production','bar','beverage','pastry','kitchen')
      OR c.recipes_active > 0 OR c.direct_items > 0 OR c.routed_items > 0
   ORDER BY (c.store_id IS NULL) DESC, c.department_name NULLS LAST, c.name;
$fn$;

REVOKE EXECUTE ON FUNCTION public.neo_station_store_console(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.neo_station_store_console(uuid) TO authenticated;

-- Which recipes and menu items depend on this station's store.
DROP FUNCTION IF EXISTS public.neo_station_store_impact(uuid);
CREATE FUNCTION public.neo_station_store_impact(_station uuid)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $fn$
DECLARE v_org uuid := public.current_org_id(); v_station operational_stations;
BEGIN
  SELECT * INTO v_station FROM operational_stations
   WHERE id = _station AND organization_id = v_org;
  IF v_station.id IS NULL OR NOT public.neo_branch_in_scope(v_station.branch_id) THEN
    RETURN jsonb_build_object('allowed', false, 'reason', 'Station not available in your scope.');
  END IF;
  RETURN jsonb_build_object(
    'allowed', true,
    'station_name', v_station.name,
    'recipes', coalesce((SELECT jsonb_agg(jsonb_build_object('id', r.id, 'name', r.name) ORDER BY r.name)
                           FROM recipes r
                          WHERE r.station_id = _station AND r.organization_id = v_org
                            AND r.status = 'active'), '[]'::jsonb),
    'menu_items', coalesce((SELECT jsonb_agg(jsonb_build_object('id', mi.id, 'name', mi.name) ORDER BY mi.name)
                              FROM menu_items mi
                             WHERE mi.organization_id = v_org
                               AND (mi.station_id = _station
                                    OR (mi.station_id IS NULL AND EXISTS (
                                          SELECT 1 FROM station_routing_rules rr
                                           WHERE rr.station_id = _station
                                             AND rr.organization_id = v_org
                                             AND rr.category_id = mi.category_id)))), '[]'::jsonb)
  );
END; $fn$;

REVOKE EXECUTE ON FUNCTION public.neo_station_store_impact(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.neo_station_store_impact(uuid) TO authenticated;

-- Assign or change the consumption store for one station, with validation + audit.
DROP FUNCTION IF EXISTS public.neo_station_store_set(uuid, uuid, text);
CREATE FUNCTION public.neo_station_store_set(_station uuid, _location uuid, _reason text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $fn$
DECLARE
  v_org uuid := public.current_org_id();
  v_station operational_stations;
  v_loc stock_locations;
  v_prev uuid;
  v_prev_name text;
BEGIN
  IF v_org IS NULL THEN RAISE EXCEPTION 'No workspace in context.'; END IF;
  IF NOT (public.has_permission('inventory','settings.manage')
          OR public.has_permission('kitchen','settings','edit')
          OR public.is_org_admin_for(v_org)) THEN
    RAISE EXCEPTION 'You do not have permission to change station supply stores.';
  END IF;
  IF _location IS NULL THEN RAISE EXCEPTION 'Choose a store — nothing is selected automatically.'; END IF;

  SELECT * INTO v_station FROM operational_stations WHERE id = _station AND organization_id = v_org;
  IF v_station.id IS NULL THEN RAISE EXCEPTION 'That station does not belong to this workspace.'; END IF;
  IF NOT public.neo_branch_in_scope(v_station.branch_id) THEN
    RAISE EXCEPTION 'That station is outside the properties you may configure.';
  END IF;

  SELECT * INTO v_loc FROM stock_locations WHERE id = _location AND organization_id = v_org;
  IF v_loc.id IS NULL THEN RAISE EXCEPTION 'That store does not belong to this workspace.'; END IF;
  IF NOT v_loc.active THEN RAISE EXCEPTION 'That store is not active. Reactivate it or choose another.'; END IF;
  IF v_loc.branch_id IS NOT NULL AND v_station.branch_id IS NOT NULL
     AND v_loc.branch_id <> v_station.branch_id THEN
    RAISE EXCEPTION 'That store belongs to a different property than the station.';
  END IF;

  SELECT m.location_id INTO v_prev FROM station_consumption_stores m
   WHERE m.station_id = _station AND m.organization_id = v_org;
  SELECT name INTO v_prev_name FROM stock_locations WHERE id = v_prev;

  INSERT INTO station_consumption_stores (organization_id, branch_id, station_id, location_id, created_by)
  VALUES (v_org, v_station.branch_id, _station, _location, auth.uid())
  ON CONFLICT (station_id) DO UPDATE
    SET location_id = EXCLUDED.location_id,
        branch_id = EXCLUDED.branch_id,
        created_by = auth.uid();

  PERFORM public.log_audit_event(
    CASE WHEN v_prev IS NULL THEN 'station_store_assigned' ELSE 'station_store_changed' END,
    'kitchen', _station::text,
    jsonb_build_object('location_id', v_prev, 'location_name', v_prev_name),
    jsonb_build_object('location_id', _location, 'location_name', v_loc.name,
                       'recipes_active', (SELECT count(*) FROM recipes r WHERE r.station_id = _station
                                            AND r.organization_id = v_org AND r.status = 'active'),
                       'menu_items', (SELECT count(*) FROM menu_items mi WHERE mi.station_id = _station
                                        AND mi.organization_id = v_org)),
    _reason, 'kitchen.settings.edit', v_station.branch_id, v_station.department_id, _station, NULL, NULL, NULL);

  RETURN jsonb_build_object('ok', true, 'station_id', _station, 'location_id', _location,
                            'location_name', v_loc.name, 'previous_location_id', v_prev);
END; $fn$;

REVOKE EXECUTE ON FUNCTION public.neo_station_store_set(uuid, uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.neo_station_store_set(uuid, uuid, text) TO authenticated;

-- Remove a mapping, refusing when live production would be left unable to post stock.
DROP FUNCTION IF EXISTS public.neo_station_store_clear(uuid, text);
CREATE FUNCTION public.neo_station_store_clear(_station uuid, _reason text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $fn$
DECLARE
  v_org uuid := public.current_org_id();
  v_station operational_stations;
  v_prev uuid; v_prev_name text; v_after uuid; v_deps bigint;
BEGIN
  IF v_org IS NULL THEN RAISE EXCEPTION 'No workspace in context.'; END IF;
  IF NOT (public.has_permission('inventory','settings.manage')
          OR public.has_permission('kitchen','settings','edit')
          OR public.is_org_admin_for(v_org)) THEN
    RAISE EXCEPTION 'You do not have permission to change station supply stores.';
  END IF;

  SELECT * INTO v_station FROM operational_stations WHERE id = _station AND organization_id = v_org;
  IF v_station.id IS NULL THEN RAISE EXCEPTION 'That station does not belong to this workspace.'; END IF;
  IF NOT public.neo_branch_in_scope(v_station.branch_id) THEN
    RAISE EXCEPTION 'That station is outside the properties you may configure.';
  END IF;

  SELECT m.location_id INTO v_prev FROM station_consumption_stores m
   WHERE m.station_id = _station AND m.organization_id = v_org;
  IF v_prev IS NULL THEN RAISE EXCEPTION 'This station has no mapping to remove.'; END IF;
  SELECT name INTO v_prev_name FROM stock_locations WHERE id = v_prev;

  SELECT (SELECT count(*) FROM recipes r WHERE r.station_id = _station
            AND r.organization_id = v_org AND r.status = 'active')
       + (SELECT count(*) FROM menu_items mi WHERE mi.station_id = _station
            AND mi.organization_id = v_org AND coalesce(mi.available, true))
    INTO v_deps;

  DELETE FROM station_consumption_stores
   WHERE station_id = _station AND organization_id = v_org;

  v_after := public.neo_station_consumption_location(v_org, _station, v_station.branch_id);

  IF v_after IS NULL AND v_deps > 0 THEN
    RAISE EXCEPTION 'Removing this store would leave % live recipe(s)/menu item(s) unable to deduct stock. Reroute or deactivate them first.', v_deps;
  END IF;

  PERFORM public.log_audit_event(
    'station_store_removed', 'kitchen', _station::text,
    jsonb_build_object('location_id', v_prev, 'location_name', v_prev_name),
    jsonb_build_object('location_id', v_after, 'dependents', v_deps),
    _reason, 'kitchen.settings.edit', v_station.branch_id, v_station.department_id, _station, NULL, NULL, NULL);

  RETURN jsonb_build_object('ok', true, 'station_id', _station, 'fallback_location_id', v_after);
END; $fn$;

REVOKE EXECUTE ON FUNCTION public.neo_station_store_clear(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.neo_station_store_clear(uuid, text) TO authenticated;