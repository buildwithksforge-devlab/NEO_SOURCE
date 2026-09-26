CREATE OR REPLACE FUNCTION public.neo_assert_worker_scope(_worker uuid, _branch uuid, _department_key text DEFAULT NULL::text)
 RETURNS uuid
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_org uuid := public.current_org_id();
  p public.profiles;
  e public.employees;
  v_worker_branch uuid;
  v_department_ok boolean;
  v_role_ok boolean;
  v_key text := nullif(btrim(coalesce(_department_key, '')), '');
BEGIN
  IF _worker IS NULL THEN
    RAISE EXCEPTION 'Select the worker who will carry out this work';
  END IF;

  SELECT * INTO p
    FROM public.profiles
   WHERE id = _worker
     AND organization_id = v_org;

  IF p.id IS NULL THEN
    RAISE EXCEPTION 'That worker is not a staff account in this organisation';
  END IF;
  IF coalesce(p.account_status, 'active') <> 'active' OR coalesce(p.employment_status, 'active') IN ('terminated', 'exited', 'resigned') THEN
    RAISE EXCEPTION 'That worker''s account is not active';
  END IF;

  SELECT * INTO e
    FROM public.employees
   WHERE profile_id = p.id
     AND organization_id = v_org
   ORDER BY updated_at DESC
   LIMIT 1;

  IF e.id IS NULL THEN
    RAISE EXCEPTION 'That worker is not linked to an active HR employee record';
  END IF;
  IF coalesce(e.employment_status, 'active') IN ('terminated', 'exited', 'resigned')
     OR coalesce(e.system_access_status, 'active') IN ('disabled', 'revoked', 'suspended') THEN
    RAISE EXCEPTION 'That worker is not an active employee';
  END IF;

  v_worker_branch := coalesce(p.branch_id, e.branch_id);
  IF _branch IS NOT NULL AND v_worker_branch IS DISTINCT FROM _branch THEN
    RAISE EXCEPTION 'That worker belongs to another property';
  END IF;
  IF NOT public.neo_branch_in_scope(v_worker_branch) THEN
    RAISE EXCEPTION 'That worker is outside your authorized property scope';
  END IF;

  IF v_key IS NOT NULL THEN
    SELECT EXISTS (
      SELECT 1
        FROM public.departments d
       WHERE d.id IN (p.department_id, e.department_id)
         AND d.organization_id = v_org
         AND coalesce(d.active, true)
         AND coalesce(d.department_status, 'active') <> 'archived'
         AND (_branch IS NULL OR d.branch_id IS NULL OR d.branch_id = _branch)
         AND coalesce(
           nullif(btrim(coalesce(d.catalogue_key,'')),''),
           public.neo_department_catalogue_key(d.name),
           lower(btrim(d.name))
         ) = v_key
    ) INTO v_department_ok;

    IF NOT coalesce(v_department_ok, false) THEN
      RAISE EXCEPTION 'That worker is not assigned to the requested department for this property';
    END IF;

    -- A custom role is a live role; only an archived one disqualifies a worker.
    SELECT EXISTS (
      SELECT 1
        FROM public.user_roles ur
        JOIN public.roles r
          ON r.id = ur.role_id
         AND r.organization_id = v_org
         AND coalesce(r.active, true)
         AND coalesce(r.role_status, 'active') <> 'archived'
        JOIN public.departments rd ON rd.id = r.department_id
       WHERE ur.user_id = p.id
         AND ur.organization_id = v_org
         AND coalesce(
           nullif(btrim(coalesce(rd.catalogue_key,'')),''),
           public.neo_department_catalogue_key(rd.name),
           lower(btrim(rd.name))
         ) = v_key
    ) INTO v_role_ok;

    IF NOT coalesce(v_role_ok, false) THEN
      RAISE EXCEPTION 'That worker does not hold an active role for the requested department';
    END IF;
  END IF;

  RETURN p.id;
END
$function$;