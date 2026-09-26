-- Kitchen queue visibility: resolve production stations a user may watch.
CREATE OR REPLACE FUNCTION public.neo_kitchen_visible_station_ids()
RETURNS uuid[]
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
  WITH me AS (
    SELECT public.current_org_id()          AS org,
           public.current_access_scope()    AS scope,
           public.current_branch_ids()      AS branches,
           public.current_department_ids()  AS depts,
           public.current_station_ids()     AS stations
  )
  SELECT COALESCE(array_agg(DISTINCT s.id), '{}'::uuid[])
  FROM public.operational_stations s, me
  WHERE me.org IS NOT NULL
    AND s.organization_id = me.org
    -- Property boundary stays hard for everyone below organisation reach.
    AND (
      public.scope_rank(me.scope) >= 5
      OR s.branch_id IS NULL
      OR s.branch_id = ANY (me.branches)
    )
    AND (
      public.scope_rank(me.scope) >= 5
      -- Broad production oversight is a configured capability, never a role name.
      OR public.has_permission('kitchen', 'all_stations', 'view')
      -- Explicitly assigned production station(s).
      OR s.id = ANY (me.stations)
      -- Otherwise the stations that belong to the user's own department(s).
      OR (s.department_id IS NOT NULL AND s.department_id = ANY (me.depts))
    );
$$;

GRANT EXECUTE ON FUNCTION public.neo_kitchen_visible_station_ids() TO authenticated;

DROP POLICY IF EXISTS "station_tickets_production_read" ON public.station_tickets;
CREATE POLICY "station_tickets_production_read"
  ON public.station_tickets FOR SELECT
  TO authenticated
  USING (
    organization_id = public.current_org_id()
    AND public.has_permission('kitchen', 'queue', 'view')
    AND station_id = ANY (public.neo_kitchen_visible_station_ids())
  );
