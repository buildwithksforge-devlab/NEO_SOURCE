-- 1. Candidate rows for an explicit set of manager role keys.
CREATE OR REPLACE FUNCTION public.neo_reporting_candidate_rows_for(
  _org uuid, _profile uuid, _branch uuid, _keys text[], _min_level integer
)
RETURNS TABLE(profile_id uuid, full_name text, staff_id text, job_title text, role_key text,
              role_name text, branch_id uuid, department_id uuid, management_level integer,
              property_match text)
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  WITH candidate AS (
    SELECT DISTINCT ON (p.id)
           p.id, p.full_name, p.staff_id, p.job_title,
           ro.normalized_role_key AS rkey, ro.name AS rname,
           p.branch_id AS bid, p.department_id AS did,
           COALESCE(ro.management_level, c.management_level, 0) AS lvl,
           COALESCE(c.managerial_scope, 'self') AS mscope
      FROM public.profiles p
      JOIN public.user_roles ur ON ur.user_id = p.id
      JOIN public.roles ro ON ro.id = ur.role_id
      LEFT JOIN public.role_catalogue c ON c.role_key = ro.normalized_role_key
     WHERE p.organization_id = _org
       AND p.account_type = 'staff'
       AND p.account_status = 'active'
       AND p.invitation_status NOT IN ('suspended','deactivated')
       AND p.id <> COALESCE(_profile, '00000000-0000-0000-0000-000000000000'::uuid)
       AND ro.active
       AND ro.role_status <> 'archived'
       AND ro.normalized_role_key = ANY(COALESCE(_keys, '{}'::text[]))
     ORDER BY p.id, COALESCE(ro.management_level, c.management_level, 0) DESC
  )
  SELECT cd.id, cd.full_name, cd.staff_id, cd.job_title, cd.rkey, cd.rname,
         cd.bid, cd.did, cd.lvl,
         CASE
           WHEN _branch IS NULL OR cd.bid IS NULL THEN 'organisation'
           WHEN cd.bid = _branch THEN 'property'
           ELSE 'wider'
         END
    FROM candidate cd
   WHERE cd.lvl >= COALESCE(_min_level, 0)
     AND (
       _branch IS NULL OR cd.bid IS NULL OR cd.bid = _branch
       OR cd.mscope IN ('organisation','property')
     )
     AND NOT EXISTS (
       WITH RECURSIVE up(id, manager) AS (
         SELECT p2.id, p2.reporting_manager_id FROM public.profiles p2 WHERE p2.id = cd.id
         UNION ALL
         SELECT p3.id, p3.reporting_manager_id
           FROM public.profiles p3 JOIN up ON up.manager = p3.id
       )
       SELECT 1 FROM up WHERE up.id = _profile
     )
   ORDER BY cd.lvl DESC, cd.full_name;
$function$;

REVOKE ALL ON FUNCTION public.neo_reporting_candidate_rows_for(uuid, uuid, uuid, text[], integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.neo_reporting_candidate_rows_for(uuid, uuid, uuid, text[], integer) TO authenticated, service_role;

-- 2. Hierarchy walk with fallback: canonical superiors first, then the next
--    valid superior upward, then Operations Manager, then Owner.
CREATE OR REPLACE FUNCTION public.neo_reporting_candidate_rows(
  _org uuid, _profile uuid, _branch uuid, _role_ids uuid[]
)
RETURNS TABLE(profile_id uuid, full_name text, staff_id text, job_title text, role_key text,
              role_name text, branch_id uuid, department_id uuid, management_level integer,
              property_match text)
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  allowed text[];
  worker_lvl integer := 0;
  seen text[] := '{}';
  keys text[];
  next_keys text[];
  found integer := 0;
  hops integer := 0;
BEGIN
  SELECT m.allowed_manager_keys, COALESCE(m.worker_level, 0)
    INTO allowed, worker_lvl
    FROM public.neo_role_reporting_meta(_role_ids) m;

  keys := COALESCE(allowed, '{}'::text[]);

  -- Round 0: exactly what the canonical hierarchy names.
  IF array_length(keys, 1) IS NOT NULL THEN
    SELECT count(*) INTO found
      FROM public.neo_reporting_candidate_rows_for(_org, _profile, _branch, keys, 0);
    IF found > 0 THEN
      RETURN QUERY SELECT * FROM public.neo_reporting_candidate_rows_for(_org, _profile, _branch, keys, 0);
      RETURN;
    END IF;
  END IF;

  -- Rounds 1..5: climb to the superior of the superior, never downward.
  seen := keys;
  WHILE hops < 5 LOOP
    hops := hops + 1;
    SELECT COALESCE(array_agg(DISTINCT k), '{}')
      INTO next_keys
      FROM (
        SELECT unnest(c.reports_to_role_keys) AS k
          FROM public.role_catalogue c
         WHERE c.role_key = ANY(keys)
      ) u
      JOIN public.role_catalogue rc ON rc.role_key = u.k
     WHERE rc.retired = false
       AND NOT (u.k = ANY(seen));

    EXIT WHEN next_keys IS NULL OR array_length(next_keys, 1) IS NULL;
    keys := next_keys;
    seen := seen || next_keys;

    SELECT count(*) INTO found
      FROM public.neo_reporting_candidate_rows_for(_org, _profile, _branch, keys, worker_lvl + 1);
    IF found > 0 THEN
      RETURN QUERY SELECT * FROM public.neo_reporting_candidate_rows_for(_org, _profile, _branch, keys, worker_lvl + 1);
      RETURN;
    END IF;
  END LOOP;

  -- Operational fallback: the Operations Manager.
  IF NOT ('operations-manager' = ANY(seen)) THEN
    SELECT count(*) INTO found
      FROM public.neo_reporting_candidate_rows_for(_org, _profile, _branch, ARRAY['operations-manager'], worker_lvl + 1);
    IF found > 0 THEN
      RETURN QUERY SELECT * FROM public.neo_reporting_candidate_rows_for(_org, _profile, _branch, ARRAY['operations-manager'], worker_lvl + 1);
      RETURN;
    END IF;
  END IF;

  -- Final organisational fallback: the Owner / Director.
  IF NOT ('owner' = ANY(seen)) THEN
    RETURN QUERY SELECT * FROM public.neo_reporting_candidate_rows_for(_org, _profile, _branch, ARRAY['owner'], worker_lvl + 1);
  END IF;
END;
$function$;

-- 3. One canonical reporting relationship shared by Users and HR.
CREATE OR REPLACE FUNCTION public.neo_sync_reporting_line_to_employee()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  mgr_emp uuid;
BEGIN
  IF NEW.reporting_manager_id IS NOT NULL THEN
    SELECT e.id INTO mgr_emp
      FROM public.employees e
     WHERE e.profile_id = NEW.reporting_manager_id
       AND e.organization_id = NEW.organization_id
     LIMIT 1;
  END IF;

  UPDATE public.employees e
     SET reporting_manager_id = mgr_emp
   WHERE e.profile_id = NEW.id
     AND e.organization_id = NEW.organization_id
     AND e.reporting_manager_id IS DISTINCT FROM mgr_emp;

  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS neo_sync_reporting_line_to_employee_trg ON public.profiles;
CREATE TRIGGER neo_sync_reporting_line_to_employee_trg
AFTER INSERT OR UPDATE OF reporting_manager_id ON public.profiles
FOR EACH ROW EXECUTE FUNCTION public.neo_sync_reporting_line_to_employee();

CREATE OR REPLACE FUNCTION public.neo_sync_reporting_line_to_profile()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  mgr_profile uuid;
BEGIN
  IF NEW.profile_id IS NULL THEN
    RETURN NEW;
  END IF;

  IF NEW.reporting_manager_id IS NOT NULL THEN
    SELECT e.profile_id INTO mgr_profile
      FROM public.employees e
     WHERE e.id = NEW.reporting_manager_id
     LIMIT 1;
  END IF;

  UPDATE public.profiles p
     SET reporting_manager_id = mgr_profile
   WHERE p.id = NEW.profile_id
     AND p.organization_id = NEW.organization_id
     AND p.reporting_manager_id IS DISTINCT FROM mgr_profile
     AND (mgr_profile IS NULL OR mgr_profile <> p.id);

  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS neo_sync_reporting_line_to_profile_trg ON public.employees;
CREATE TRIGGER neo_sync_reporting_line_to_profile_trg
AFTER INSERT OR UPDATE OF reporting_manager_id ON public.employees
FOR EACH ROW EXECUTE FUNCTION public.neo_sync_reporting_line_to_profile();