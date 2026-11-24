CREATE TABLE IF NOT EXISTS public.neo_station_account_entry (
  organization_id uuid NOT NULL,
  user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  branch_id uuid NOT NULL,
  station_id uuid NOT NULL REFERENCES public.operational_stations(id) ON DELETE CASCADE,
  PRIMARY KEY (organization_id, user_id)
);
ALTER TABLE public.neo_station_account_entry ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.neo_station_account_entry FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.neo_station_login_admin(
  _branch uuid, _station uuid, _user uuid DEFAULT NULL, _remove boolean DEFAULT false
)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE org uuid := public.current_org_id();
BEGIN
  IF NOT coalesce(public.neo_device_admin_allowed(), false) OR org IS NULL OR _branch IS NULL
      OR NOT coalesce(public.neo_branch_in_scope(_branch), false) THEN
    RAISE EXCEPTION 'Owner or System Administrator access to this property is required.' USING ERRCODE = '42501';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.operational_stations s WHERE s.id = _station
      AND s.organization_id = org AND s.branch_id = _branch AND s.active
  ) THEN
    RAISE EXCEPTION 'Choose an active station at this property.' USING ERRCODE = '42501';
  END IF;

  IF _user IS NULL THEN
    RETURN coalesce((
      SELECT jsonb_agg(jsonb_build_object('id', p.id, 'name', p.full_name, 'email', p.email,
        'pin_set', coalesce(c.enabled, false), 'opens_station', coalesce(e.station_id = _station, false)) ORDER BY p.full_name, p.id)
      FROM public.profiles p
      LEFT JOIN public.neo_station_account_entry e ON e.user_id = p.id AND e.organization_id = org
      LEFT JOIN public.neo_production_staff_codes c ON c.user_id = p.id AND c.organization_id = org
      WHERE p.organization_id = org AND coalesce(p.account_type, 'staff') = 'staff'
        AND coalesce(p.account_status, 'active') = 'active' AND EXISTS (
          SELECT 1 FROM public.user_stations a WHERE a.organization_id = org AND a.user_id = p.id AND a.station_id = _station
        )
    ), '[]'::jsonb);
  END IF;

  IF _remove THEN
    DELETE FROM public.neo_station_account_entry WHERE organization_id = org AND user_id = _user
      AND branch_id = _branch AND station_id = _station;
  ELSE
    IF NOT EXISTS (
      SELECT 1 FROM public.user_stations a JOIN public.profiles p ON p.id = a.user_id
      WHERE a.organization_id = org AND a.user_id = _user AND a.station_id = _station
        AND p.organization_id = org AND coalesce(p.account_type, 'staff') = 'staff'
        AND coalesce(p.account_status, 'active') = 'active'
    ) THEN
      RAISE EXCEPTION 'Assign this active staff account to the station before configuring sign-in.' USING ERRCODE = '42501';
    END IF;
    INSERT INTO public.neo_station_account_entry AS e (organization_id, user_id, branch_id, station_id)
    VALUES (org, _user, _branch, _station)
    ON CONFLICT (organization_id, user_id) DO UPDATE
      SET branch_id = excluded.branch_id, station_id = excluded.station_id
      WHERE coalesce(public.neo_branch_in_scope(e.branch_id), false);
    IF NOT FOUND THEN
      RAISE EXCEPTION 'The account has a display at a property outside your access.' USING ERRCODE = '42501';
    END IF;
  END IF;
  RETURN jsonb_build_object('ok', true);
END;
$$;

CREATE OR REPLACE FUNCTION public.neo_station_login_destination(_branch uuid DEFAULT NULL)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT jsonb_build_object('id', s.id, 'branch_id', s.branch_id, 'name', s.name, 'code', s.code,
    'station_type', s.station_type, 'department_key', d.catalogue_key)
  FROM public.neo_station_account_entry e
  JOIN public.profiles p ON p.id = e.user_id AND p.organization_id = e.organization_id
  JOIN public.operational_stations s ON s.id = e.station_id AND s.organization_id = e.organization_id AND s.branch_id = e.branch_id
  LEFT JOIN public.departments d ON d.id = s.department_id AND d.organization_id = e.organization_id
  WHERE e.organization_id = public.current_org_id() AND e.user_id = auth.uid()
    AND coalesce(p.account_type, 'staff') = 'staff' AND coalesce(p.account_status, 'active') = 'active'
    AND s.active AND (_branch IS NULL OR e.branch_id = _branch)
    AND coalesce(public.neo_branch_in_scope(e.branch_id), false)
    AND s.id = ANY(public.neo_kitchen_visible_station_ids())
    AND EXISTS (SELECT 1 FROM public.user_stations a WHERE a.organization_id = e.organization_id
      AND a.user_id = e.user_id AND a.station_id = e.station_id);
$$;

REVOKE ALL ON FUNCTION public.neo_station_login_admin(uuid,uuid,uuid,boolean) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.neo_station_login_destination(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.neo_station_login_admin(uuid,uuid,uuid,boolean) TO authenticated;
GRANT EXECUTE ON FUNCTION public.neo_station_login_destination(uuid) TO authenticated;
