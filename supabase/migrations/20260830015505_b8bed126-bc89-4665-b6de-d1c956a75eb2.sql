-- Canonical workforce projection ------------------------------------------

CREATE OR REPLACE FUNCTION public.neo_workforce_active_count(_org uuid, _branch uuid DEFAULT NULL)
RETURNS integer LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
  SELECT count(*)::int FROM public.employees e
   WHERE e.organization_id = _org
     AND coalesce(e.employment_status, 'active') NOT IN ('exited', 'terminated')
     AND (_branch IS NULL OR e.branch_id = _branch);
$$;

CREATE OR REPLACE FUNCTION public.neo_workforce_summary(_branch uuid DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE org uuid := public.current_org_id(); _r jsonb;
BEGIN
  IF org IS NULL OR NOT public.is_active_staff() THEN
    RETURN jsonb_build_object('authorised', false);
  END IF;
  SELECT jsonb_build_object(
    'authorised', true,
    'branch_id', _branch,
    'employees_active', public.neo_workforce_active_count(org, _branch),
    'employees_total', (SELECT count(*) FROM public.employees e
                         WHERE e.organization_id = org
                           AND (_branch IS NULL OR e.branch_id = _branch)),
    'accounts_active', (SELECT count(*) FROM public.profiles p
                         WHERE p.organization_id = org
                           AND coalesce(p.account_status,'active') = 'active'),
    'employees_without_account', (SELECT count(*) FROM public.employees e
                         WHERE e.organization_id = org
                           AND (_branch IS NULL OR e.branch_id = _branch)
                           AND e.profile_id IS NULL),
    'accounts_without_employee', (SELECT count(*) FROM public.profiles p
                         WHERE p.organization_id = org
                           AND coalesce(p.account_status,'active') = 'active'
                           AND NOT EXISTS (SELECT 1 FROM public.employees e
                                            WHERE e.organization_id = org AND e.profile_id = p.id))
  ) INTO _r;
  RETURN _r;
END $$;

CREATE OR REPLACE FUNCTION public.neo_workforce_people(_branch uuid DEFAULT NULL, _department uuid DEFAULT NULL)
RETURNS TABLE (
  employee_id uuid,
  profile_id uuid,
  full_name text,
  job_title text,
  branch_id uuid,
  branch_name text,
  department_id uuid,
  department_name text,
  station_id uuid,
  employment_status text,
  has_account boolean
) LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
  SELECT e.id, e.profile_id, e.full_name, e.job_title, e.branch_id, b.name,
         e.department_id, d.name, e.station_id,
         coalesce(e.employment_status, 'active'), e.profile_id IS NOT NULL
    FROM public.employees e
    LEFT JOIN public.branches b ON b.id = e.branch_id
    LEFT JOIN public.departments d ON d.id = e.department_id
   WHERE public.is_active_staff()
     AND e.organization_id = public.current_org_id()
     AND coalesce(e.employment_status, 'active') NOT IN ('exited', 'terminated')
     AND (_branch IS NULL OR e.branch_id = _branch)
     AND (_department IS NULL OR e.department_id = _department)
   ORDER BY e.full_name;
$$;

REVOKE ALL ON FUNCTION public.neo_workforce_active_count(uuid, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.neo_workforce_summary(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.neo_workforce_people(uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.neo_workforce_summary(uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.neo_workforce_people(uuid, uuid) TO authenticated, service_role;

-- Dashboards read the same projection ---------------------------------------

DO $mig$
DECLARE _def text; _patched text;
BEGIN
  SELECT pg_get_functiondef(oid) INTO _def FROM pg_proc
   WHERE pronamespace = 'public'::regnamespace AND proname = 'neo_facts';

  _patched := regexp_replace(
    _def,
    'SELECT\s+count\(\*\)\s+INTO\s+staff_active[^;]*;',
    'staff_active := public.neo_workforce_active_count(org, _branch);'
  );

  IF _patched = _def THEN
    RAISE EXCEPTION 'neo_facts staff block not found — aborting rather than guessing';
  END IF;

  EXECUTE _patched;
END $mig$;