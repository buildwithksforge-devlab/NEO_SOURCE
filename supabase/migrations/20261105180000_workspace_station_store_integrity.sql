-- Generic station-to-departmental-store integrity.
--
-- This migration contains no workspace-specific identifiers.
--
-- Every workspace supplies its own physical stores and production stations.
-- NEØ validates the relationship, blocks unsafe mappings and deducts stock
-- only from the explicitly chosen departmental store.
--
-- Main Store remains the procurement/requisition source. It can never be a
-- POS production-consumption destination.

CREATE OR REPLACE FUNCTION public.neo_station_consumption_location(
  _org uuid,
  _station uuid,
  _branch uuid
)
RETURNS uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
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
$function$;

COMMENT ON FUNCTION public.neo_station_consumption_location(uuid,uuid,uuid)
IS
  'Resolves only an explicit, active, non-main, same-workspace and same-property departmental consumption store.';

CREATE OR REPLACE FUNCTION public.neo_station_store_integrity_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_station record;
  v_location record;
BEGIN
  SELECT
    s.id,
    s.organization_id,
    s.branch_id,
    s.active
  INTO v_station
  FROM public.operational_stations s
  WHERE s.id = NEW.station_id;

  IF v_station.id IS NULL THEN
    RAISE EXCEPTION
      'station_store_invalid: production station does not exist'
      USING ERRCODE = '23503';
  END IF;

  IF NOT v_station.active THEN
    RAISE EXCEPTION
      'station_store_invalid: production station is inactive'
      USING ERRCODE = '23514';
  END IF;

  IF v_station.branch_id IS NULL THEN
    RAISE EXCEPTION
      'station_store_invalid: production station has no property'
      USING ERRCODE = '23514';
  END IF;

  SELECT
    sl.id,
    sl.organization_id,
    sl.branch_id,
    sl.active,
    COALESCE(sl.is_main, false) AS is_main
  INTO v_location
  FROM public.stock_locations sl
  WHERE sl.id = NEW.location_id;

  IF v_location.id IS NULL THEN
    RAISE EXCEPTION
      'station_store_invalid: stock location does not exist'
      USING ERRCODE = '23503';
  END IF;

  IF v_location.organization_id IS DISTINCT FROM
     v_station.organization_id THEN
    RAISE EXCEPTION
      'station_store_invalid: station and store belong to different workspaces'
      USING ERRCODE = '23514';
  END IF;

  IF v_location.branch_id IS DISTINCT FROM
     v_station.branch_id THEN
    RAISE EXCEPTION
      'station_store_invalid: station and store belong to different properties'
      USING ERRCODE = '23514';
  END IF;

  IF NOT v_location.active THEN
    RAISE EXCEPTION
      'station_store_invalid: consumption store is inactive'
      USING ERRCODE = '23514';
  END IF;

  IF v_location.is_main THEN
    RAISE EXCEPTION
      'station_store_invalid: Main Store supplies departments through requisitions and cannot be used for POS consumption'
      USING ERRCODE = '23514';
  END IF;

  IF NEW.organization_id IS NOT NULL
     AND NEW.organization_id IS DISTINCT FROM
         v_station.organization_id THEN
    RAISE EXCEPTION
      'station_store_invalid: mapping workspace does not match its station'
      USING ERRCODE = '23514';
  END IF;

  IF NEW.branch_id IS NOT NULL
     AND NEW.branch_id IS DISTINCT FROM
         v_station.branch_id THEN
    RAISE EXCEPTION
      'station_store_invalid: mapping property does not match its station'
      USING ERRCODE = '23514';
  END IF;

  NEW.organization_id := v_station.organization_id;
  NEW.branch_id := v_station.branch_id;

  IF TG_OP = 'INSERT' THEN
    NEW.created_by := COALESCE(NEW.created_by, auth.uid());
  END IF;

  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS
  station_consumption_stores_integrity
ON public.station_consumption_stores;

CREATE TRIGGER station_consumption_stores_integrity
BEFORE INSERT OR UPDATE OF
  organization_id,
  branch_id,
  station_id,
  location_id
ON public.station_consumption_stores
FOR EACH ROW
EXECUTE FUNCTION public.neo_station_store_integrity_guard();

REVOKE ALL
ON FUNCTION public.neo_station_store_integrity_guard()
FROM PUBLIC, anon, authenticated;

/*
 * Browser clients may read the projection but cannot bypass the validated,
 * audited mapping routines with direct writes.
 */
REVOKE INSERT, UPDATE, DELETE
ON TABLE public.station_consumption_stores
FROM authenticated;

GRANT SELECT
ON TABLE public.station_consumption_stores
TO authenticated;

CREATE OR REPLACE FUNCTION public.neo_station_store_set(
  _station uuid,
  _location uuid,
  _reason text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_org uuid := public.current_org_id();
  v_station public.operational_stations;
  v_location public.stock_locations;
  v_previous uuid;
  v_previous_name text;
BEGIN
  IF v_org IS NULL THEN
    RAISE EXCEPTION
      'No workspace in context.'
      USING ERRCODE = '42501';
  END IF;

  IF NOT (
    public.has_permission(
      'inventory',
      'settings.manage'
    )
    OR public.has_permission(
      'kitchen',
      'settings',
      'edit'
    )
    OR public.is_org_admin_for(v_org)
  ) THEN
    RAISE EXCEPTION
      'You do not have permission to change station supply stores.'
      USING ERRCODE = '42501';
  END IF;

  IF _location IS NULL THEN
    RAISE EXCEPTION
      'Choose a departmental store — nothing is selected automatically.';
  END IF;

  SELECT *
  INTO v_station
  FROM public.operational_stations s
  WHERE s.id = _station
    AND s.organization_id = v_org;

  IF v_station.id IS NULL THEN
    RAISE EXCEPTION
      'That station does not belong to this workspace.';
  END IF;

  IF NOT v_station.active THEN
    RAISE EXCEPTION
      'That production station is inactive.';
  END IF;

  IF v_station.branch_id IS NULL THEN
    RAISE EXCEPTION
      'Assign the production station to a property first.';
  END IF;

  IF NOT public.neo_branch_in_scope(
    v_station.branch_id
  ) THEN
    RAISE EXCEPTION
      'That station is outside the properties you may configure.';
  END IF;

  SELECT *
  INTO v_location
  FROM public.stock_locations sl
  WHERE sl.id = _location
    AND sl.organization_id = v_org;

  IF v_location.id IS NULL THEN
    RAISE EXCEPTION
      'That store does not belong to this workspace.';
  END IF;

  IF NOT v_location.active THEN
    RAISE EXCEPTION
      'That store is not active. Reactivate it or choose another.';
  END IF;

  IF COALESCE(v_location.is_main, false) THEN
    RAISE EXCEPTION
      'Main Store supplies departments through requisitions. Choose the departmental store that physically serves this station.';
  END IF;

  IF v_location.branch_id IS DISTINCT FROM
     v_station.branch_id THEN
    RAISE EXCEPTION
      'That store belongs to a different property than the station.';
  END IF;

  SELECT m.location_id
  INTO v_previous
  FROM public.station_consumption_stores m
  WHERE m.station_id = _station
    AND m.organization_id = v_org;

  SELECT sl.name
  INTO v_previous_name
  FROM public.stock_locations sl
  WHERE sl.id = v_previous;

  INSERT INTO public.station_consumption_stores (
    organization_id,
    branch_id,
    station_id,
    location_id,
    created_by
  )
  VALUES (
    v_org,
    v_station.branch_id,
    _station,
    _location,
    auth.uid()
  )
  ON CONFLICT (station_id)
  DO UPDATE
  SET location_id = EXCLUDED.location_id,
      branch_id = EXCLUDED.branch_id,
      organization_id = EXCLUDED.organization_id,
      created_by = auth.uid();

  PERFORM public.log_audit_event(
    CASE
      WHEN v_previous IS NULL
        THEN 'station_store_assigned'
      ELSE 'station_store_changed'
    END,
    'kitchen',
    _station::text,
    jsonb_build_object(
      'location_id',
      v_previous,
      'location_name',
      v_previous_name
    ),
    jsonb_build_object(
      'location_id',
      _location,
      'location_name',
      v_location.name,
      'recipes_active',
      (
        SELECT count(*)
        FROM public.recipes r
        WHERE r.station_id = _station
          AND r.organization_id = v_org
          AND r.status = 'active'
      ),
      'menu_items',
      (
        SELECT count(*)
        FROM public.menu_items mi
        WHERE mi.station_id = _station
          AND mi.organization_id = v_org
      )
    ),
    _reason,
    'kitchen.settings.edit',
    v_station.branch_id,
    v_station.department_id,
    _station,
    NULL,
    NULL,
    NULL
  );

  RETURN jsonb_build_object(
    'ok',
    true,
    'station_id',
    _station,
    'location_id',
    _location,
    'location_name',
    v_location.name,
    'previous_location_id',
    v_previous
  );
END;
$function$;

REVOKE ALL
ON FUNCTION public.neo_station_store_set(uuid,uuid,text)
FROM PUBLIC, anon;

GRANT EXECUTE
ON FUNCTION public.neo_station_store_set(uuid,uuid,text)
TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.neo_station_store_readiness(
  _branch uuid DEFAULT NULL
)
RETURNS TABLE(
  station_id uuid,
  station_name text,
  station_type text,
  department_name text,
  branch_id uuid,
  recipes_active bigint,
  direct_items bigint,
  location_id uuid,
  location_name text,
  mapped_explicitly boolean,
  ready boolean
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
  SELECT
    s.id,
    s.name,
    COALESCE(s.station_type, 'service'),
    d.name,
    s.branch_id,

    (
      SELECT count(*)
      FROM public.recipes r
      WHERE r.station_id = s.id
        AND r.organization_id = s.organization_id
        AND r.status = 'active'
    ),

    (
      SELECT count(*)
      FROM public.menu_items mi
      WHERE mi.station_id = s.id
        AND mi.organization_id = s.organization_id
    ),

    resolved.location_id,

    sl.name,

    mapping.mapped_explicitly,

    resolved.location_id IS NOT NULL

  FROM public.operational_stations s

  LEFT JOIN public.departments d
    ON d.id = s.department_id

  LEFT JOIN LATERAL (
    SELECT
      m.location_id,
      true AS mapped_explicitly
    FROM public.station_consumption_stores m
    WHERE m.station_id = s.id
      AND m.organization_id = s.organization_id
    LIMIT 1
  ) mapping
    ON true

  LEFT JOIN LATERAL (
    SELECT public.neo_station_consumption_location(
      s.organization_id,
      s.id,
      s.branch_id
    ) AS location_id
  ) resolved
    ON true

  LEFT JOIN public.stock_locations sl
    ON sl.id = resolved.location_id

  WHERE s.organization_id = public.current_org_id()
    AND s.active
    AND (
      _branch IS NULL
      OR s.branch_id = _branch
    )
    AND public.neo_branch_in_scope(
      s.branch_id
    )

  ORDER BY
    (resolved.location_id IS NULL) DESC,
    d.name NULLS LAST,
    s.name;
$function$;

REVOKE ALL
ON FUNCTION public.neo_station_store_readiness(uuid)
FROM PUBLIC, anon;

GRANT EXECUTE
ON FUNCTION public.neo_station_store_readiness(uuid)
TO authenticated, service_role;

/*
 * No existing mapping is silently rewritten here.
 *
 * Existing invalid, cross-property, inactive or Main Store mappings simply
 * stop resolving and appear as not ready. The workspace administrator must
 * deliberately choose the physical departmental store in Kitchen Settings.
 */
