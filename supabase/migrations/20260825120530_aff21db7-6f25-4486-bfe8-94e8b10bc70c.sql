CREATE OR REPLACE FUNCTION public.neo_merge_branch(_dupe uuid, _canonical uuid, _reason text DEFAULT 'duplicate property merge')
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _rel record;
  _moved jsonb := '{}'::jsonb;
  _n integer;
  _skipped integer := 0;
  _org uuid;
BEGIN
  IF auth.uid() IS NOT NULL AND NOT public.is_org_admin() THEN
    RAISE EXCEPTION 'Only an organisation administrator may merge properties' USING ERRCODE = '42501';
  END IF;
  IF _dupe IS NULL OR _canonical IS NULL OR _dupe = _canonical THEN
    RAISE EXCEPTION 'neo_merge_branch requires two distinct property ids';
  END IF;

  SELECT organization_id INTO _org FROM public.branches WHERE id = _canonical;
  IF _org IS NULL THEN
    RAISE EXCEPTION 'Canonical property % does not exist', _canonical;
  END IF;
  IF auth.uid() IS NOT NULL AND _org <> public.current_org_id() THEN
    RAISE EXCEPTION 'Property belongs to another organisation' USING ERRCODE = '42501';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.branches WHERE id = _dupe AND organization_id = _org) THEN
    RAISE EXCEPTION 'Properties belong to different organisations and cannot be merged';
  END IF;

  FOR _rel IN
    SELECT c.table_name
      FROM information_schema.columns c
      JOIN information_schema.tables t
        ON t.table_schema = c.table_schema AND t.table_name = c.table_name
     WHERE c.table_schema = 'public'
       AND c.column_name = 'branch_id'
       AND t.table_type = 'BASE TABLE'
       AND c.table_name <> 'branches'
     ORDER BY c.table_name
  LOOP
    BEGIN
      EXECUTE format('UPDATE public.%I SET branch_id = $1 WHERE branch_id = $2', _rel.table_name)
        USING _canonical, _dupe;
      GET DIAGNOSTICS _n = ROW_COUNT;
      IF _n > 0 THEN
        _moved := _moved || jsonb_build_object(_rel.table_name, _n);
      END IF;
    EXCEPTION WHEN unique_violation OR foreign_key_violation THEN
      _skipped := _skipped + 1;
    END;
  END LOOP;

  UPDATE public.branches
     SET is_main = false,
         active = false,
         description = coalesce(nullif(btrim(description), ''), '')
                       || CASE WHEN coalesce(btrim(description), '') = '' THEN '' ELSE ' ' END
                       || format('[Merged into property %s on %s: %s]', _canonical, to_char(now(), 'YYYY-MM-DD'), _reason),
         updated_at = now()
   WHERE id = _dupe;

  RETURN jsonb_build_object(
    'merged', _dupe, 'into', _canonical, 'organization_id', _org,
    'moved', _moved, 'skipped_tables', _skipped, 'reason', _reason);
END;
$$;

CREATE OR REPLACE FUNCTION public.neo_structure_scan(_org uuid DEFAULT NULL, _trigger text DEFAULT 'manual')
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _target uuid;
  _findings jsonb;
  _count integer;
  _out jsonb := '[]'::jsonb;
BEGIN
  IF auth.uid() IS NOT NULL THEN
    IF NOT public.is_org_admin() THEN
      RAISE EXCEPTION 'Only an organisation administrator may run the structure scan' USING ERRCODE = '42501';
    END IF;
    _org := public.current_org_id();
  END IF;

  FOR _target IN
    SELECT o.id FROM public.organizations o WHERE (_org IS NULL OR o.id = _org)
  LOOP
    WITH f AS (
      SELECT 'duplicate_property' AS key, 'Properties sharing a name' AS label,
             jsonb_build_object('organization_id', b.organization_id, 'name', b.name, 'count', count(*)) AS detail
        FROM public.branches b
       WHERE b.organization_id = _target AND b.active
       GROUP BY b.organization_id, lower(btrim(b.name)), b.name
      HAVING count(*) > 1
      UNION ALL
      SELECT 'department_wrong_property', 'Departments attached to another organisation''s property',
             jsonb_build_object('department_id', d.id, 'name', d.name)
        FROM public.departments d
        LEFT JOIN public.branches b ON b.id = d.branch_id
       WHERE d.organization_id = _target AND d.branch_id IS NOT NULL
         AND (b.id IS NULL OR b.organization_id <> d.organization_id)
      UNION ALL
      SELECT 'role_wrong_department', 'Roles pointing at a department outside their organisation',
             jsonb_build_object('role_id', r.id, 'name', r.name)
        FROM public.roles r
        LEFT JOIN public.departments d ON d.id = r.department_id
       WHERE r.organization_id = _target AND r.department_id IS NOT NULL
         AND (d.id IS NULL OR d.organization_id <> r.organization_id)
      UNION ALL
      SELECT 'duplicate_active_role', 'Active roles sharing the same catalogue key',
             jsonb_build_object('role_key', r.normalized_role_key, 'count', count(*))
        FROM public.roles r
       WHERE r.organization_id = _target AND r.normalized_role_key IS NOT NULL
         AND coalesce(r.role_status, 'active') = 'active'
       GROUP BY r.normalized_role_key
      HAVING count(*) > 1
      UNION ALL
      SELECT 'user_role_orphan', 'Role assignments without a valid role',
             jsonb_build_object('assignment_id', ur.id, 'user_id', ur.user_id)
        FROM public.user_roles ur
        LEFT JOIN public.roles r ON r.id = ur.role_id
       WHERE ur.organization_id = _target
         AND (r.id IS NULL OR r.organization_id <> ur.organization_id)
      UNION ALL
      SELECT 'worker_wrong_property', 'Workers whose department sits in another property',
             jsonb_build_object('profile_id', p.id, 'name', p.full_name)
        FROM public.profiles p
        JOIN public.departments d ON d.id = p.department_id
       WHERE p.organization_id = _target AND p.branch_id IS NOT NULL
         AND d.branch_id IS NOT NULL AND d.branch_id <> p.branch_id
      UNION ALL
      SELECT 'employee_wrong_property', 'Employee records linked across properties',
             jsonb_build_object('employee_id', e.id, 'name', e.full_name)
        FROM public.employees e
        LEFT JOIN public.departments d ON d.id = e.department_id
        LEFT JOIN public.operational_stations s ON s.id = e.station_id
       WHERE e.organization_id = _target AND e.branch_id IS NOT NULL
         AND ((d.branch_id IS NOT NULL AND d.branch_id <> e.branch_id)
           OR (s.branch_id IS NOT NULL AND s.branch_id <> e.branch_id))
      UNION ALL
      SELECT 'station_wrong_property', 'Stations attached to a department in another property',
             jsonb_build_object('station_id', s.id, 'name', s.name)
        FROM public.operational_stations s
        JOIN public.departments d ON d.id = s.department_id
       WHERE s.organization_id = _target AND s.branch_id IS NOT NULL
         AND d.branch_id IS NOT NULL AND d.branch_id <> s.branch_id
      UNION ALL
      SELECT 'station_assignment_mismatch', 'Worker station assignments outside the worker''s property',
             jsonb_build_object('assignment_id', us.id, 'user_id', us.user_id)
        FROM public.user_stations us
        JOIN public.operational_stations s ON s.id = us.station_id
       WHERE us.organization_id = _target AND us.branch_id IS NOT NULL
         AND s.branch_id IS NOT NULL AND s.branch_id <> us.branch_id
      UNION ALL
      SELECT 'store_wrong_property', 'Stores attached to a department in another property',
             jsonb_build_object('location_id', l.id, 'name', l.name)
        FROM public.stock_locations l
        JOIN public.departments d ON d.id = l.department_id
       WHERE l.organization_id = _target AND l.branch_id IS NOT NULL
         AND d.branch_id IS NOT NULL AND d.branch_id <> l.branch_id
    )
    SELECT coalesce(jsonb_agg(jsonb_build_object('key', key, 'label', label, 'detail', detail)), '[]'::jsonb)
      INTO _findings FROM f;

    _count := jsonb_array_length(_findings);

    INSERT INTO public.integrity_check_runs
      (organization_id, check_key, check_label, status, anomaly_count, details, triggered_by)
    VALUES
      (_target, 'structure_relationships',
       'Organisation to property, department, role, worker and station relationships',
       CASE WHEN _count = 0 THEN 'clean' ELSE 'anomaly' END,
       _count, _findings, coalesce(_trigger, 'manual'));

    _out := _out || jsonb_build_array(jsonb_build_object(
      'organization_id', _target, 'anomaly_count', _count, 'findings', _findings));
  END LOOP;

  RETURN _out;
END;
$$;

REVOKE ALL ON FUNCTION public.neo_merge_branch(uuid, uuid, text) FROM public, anon;
REVOKE ALL ON FUNCTION public.neo_structure_scan(uuid, text) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.neo_merge_branch(uuid, uuid, text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.neo_structure_scan(uuid, text) TO authenticated, service_role;