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
  IF _dupe IS NULL OR _canonical IS NULL OR _dupe = _canonical THEN
    RAISE EXCEPTION 'neo_merge_branch requires two distinct property ids';
  END IF;

  SELECT organization_id INTO _org FROM public.branches WHERE id = _canonical;
  IF _org IS NULL THEN
    RAISE EXCEPTION 'Canonical property % does not exist', _canonical;
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

REVOKE ALL ON FUNCTION public.neo_merge_branch(uuid, uuid, text) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.neo_merge_branch(uuid, uuid, text) TO authenticated, service_role;

DO $$
DECLARE
  _row record;
BEGIN
  FOR _row IN
    WITH ranked AS (
      SELECT b.id, b.organization_id, lower(btrim(b.name)) AS nm,
             row_number() OVER (
               PARTITION BY b.organization_id, lower(btrim(b.name))
               ORDER BY (SELECT count(*) FROM public.departments d WHERE d.branch_id = b.id) DESC,
                        b.created_at ASC) AS rn
        FROM public.branches b
       WHERE b.active
    )
    SELECT d.id AS dupe,
           (SELECT k.id FROM ranked k
             WHERE k.organization_id = d.organization_id AND k.nm = d.nm AND k.rn = 1) AS canonical
      FROM ranked d
     WHERE d.rn > 1
  LOOP
    PERFORM public.neo_merge_branch(_row.dupe, _row.canonical, 'duplicate property record with identical name');
  END LOOP;
END;
$$;

CREATE UNIQUE INDEX IF NOT EXISTS branches_org_name_active_uniq
  ON public.branches (organization_id, lower(btrim(name))) WHERE active;

CREATE UNIQUE INDEX IF NOT EXISTS branches_org_single_main_uniq
  ON public.branches (organization_id) WHERE is_main AND active;

CREATE UNIQUE INDEX IF NOT EXISTS departments_org_branch_name_active_uniq
  ON public.departments (organization_id, coalesce(branch_id, '00000000-0000-0000-0000-000000000000'::uuid), lower(btrim(name)))
  WHERE department_status = 'active';

CREATE UNIQUE INDEX IF NOT EXISTS roles_org_key_active_uniq
  ON public.roles (organization_id, normalized_role_key)
  WHERE normalized_role_key IS NOT NULL AND coalesce(role_status, 'active') = 'active';

CREATE UNIQUE INDEX IF NOT EXISTS profiles_org_staff_id_uniq
  ON public.profiles (organization_id, upper(btrim(staff_id)))
  WHERE coalesce(btrim(staff_id), '') <> '';

CREATE OR REPLACE FUNCTION public.neo_structure_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _rec jsonb := to_jsonb(NEW);
  _branch_org uuid;
  _dept_org uuid;
  _dept_branch uuid;
  _station_org uuid;
  _station_branch uuid;
BEGIN
  IF (_rec ? 'branch_id') AND NEW.branch_id IS NOT NULL THEN
    SELECT organization_id INTO _branch_org FROM public.branches WHERE id = NEW.branch_id;
    IF _branch_org IS NULL THEN
      RAISE EXCEPTION 'Property % does not exist', NEW.branch_id USING ERRCODE = '23503';
    END IF;
    IF _branch_org <> NEW.organization_id THEN
      RAISE EXCEPTION 'Property % belongs to a different organisation', NEW.branch_id USING ERRCODE = '23514';
    END IF;
  END IF;

  IF (_rec ? 'department_id') AND NEW.department_id IS NOT NULL THEN
    SELECT organization_id, branch_id INTO _dept_org, _dept_branch
      FROM public.departments WHERE id = NEW.department_id;
    IF _dept_org IS NULL THEN
      RAISE EXCEPTION 'Department % does not exist', NEW.department_id USING ERRCODE = '23503';
    END IF;
    IF _dept_org <> NEW.organization_id THEN
      RAISE EXCEPTION 'Department % belongs to a different organisation', NEW.department_id USING ERRCODE = '23514';
    END IF;
    IF (_rec ? 'branch_id') AND NEW.branch_id IS NOT NULL
       AND _dept_branch IS NOT NULL AND _dept_branch <> NEW.branch_id THEN
      RAISE EXCEPTION 'Department % belongs to another property', NEW.department_id USING ERRCODE = '23514';
    END IF;
  END IF;

  IF (_rec ? 'station_id') AND NEW.station_id IS NOT NULL THEN
    SELECT organization_id, branch_id INTO _station_org, _station_branch
      FROM public.operational_stations WHERE id = NEW.station_id;
    IF _station_org IS NOT NULL THEN
      IF _station_org <> NEW.organization_id THEN
        RAISE EXCEPTION 'Station % belongs to a different organisation', NEW.station_id USING ERRCODE = '23514';
      END IF;
      IF (_rec ? 'branch_id') AND NEW.branch_id IS NOT NULL
         AND _station_branch IS NOT NULL AND _station_branch <> NEW.branch_id THEN
        RAISE EXCEPTION 'Station % belongs to another property', NEW.station_id USING ERRCODE = '23514';
      END IF;
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

DO $$
DECLARE
  _t text;
BEGIN
  FOREACH _t IN ARRAY ARRAY['departments','roles','profiles','employees','operational_stations','user_stations','stock_locations']
  LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS trg_neo_structure_guard ON public.%I', _t);
    EXECUTE format(
      'CREATE TRIGGER trg_neo_structure_guard BEFORE INSERT OR UPDATE ON public.%I
         FOR EACH ROW EXECUTE FUNCTION public.neo_structure_guard()', _t);
  END LOOP;
END;
$$;

UPDATE public.profiles p
   SET department_id = (
         SELECT d2.id FROM public.departments d2
          WHERE d2.organization_id = p.organization_id
            AND d2.branch_id = p.branch_id
            AND lower(btrim(d2.name)) = lower(btrim(d.name))
            AND d2.department_status = 'active'
          LIMIT 1),
       assignment_review_required = true,
       assignment_review_reason = 'Department reassigned during structural repair (department belonged to another property)',
       updated_at = now()
  FROM public.departments d
 WHERE d.id = p.department_id
   AND p.branch_id IS NOT NULL
   AND d.branch_id IS NOT NULL
   AND d.branch_id <> p.branch_id;

UPDATE public.employees e
   SET department_id = (
         SELECT d2.id FROM public.departments d2
          WHERE d2.organization_id = e.organization_id
            AND d2.branch_id = e.branch_id
            AND lower(btrim(d2.name)) = lower(btrim(d.name))
            AND d2.department_status = 'active'
          LIMIT 1),
       updated_at = now()
  FROM public.departments d
 WHERE d.id = e.department_id
   AND e.branch_id IS NOT NULL
   AND d.branch_id IS NOT NULL
   AND d.branch_id <> e.branch_id;

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

REVOKE ALL ON FUNCTION public.neo_structure_scan(uuid, text) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.neo_structure_scan(uuid, text) TO authenticated, service_role;