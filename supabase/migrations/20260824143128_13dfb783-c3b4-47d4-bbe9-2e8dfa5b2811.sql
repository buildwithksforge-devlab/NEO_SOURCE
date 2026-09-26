-- 1) Retire Night Auditor from the active role model, without touching people.
ALTER TABLE public.role_catalogue ADD COLUMN IF NOT EXISTS retired boolean NOT NULL DEFAULT false;

UPDATE public.role_catalogue
   SET retired = true, updated_at = now()
 WHERE role_key = 'night-auditor';

UPDATE public.roles
   SET active = false,
       role_status = 'archived',
       migration_status = 'review_required',
       migration_review_reason = COALESCE(
         migration_review_reason,
         'Night Auditor retired from the NEO role model - reassign affected staff'
       ),
       updated_at = now()
 WHERE normalized_role_key = 'night-auditor'
    OR lower(name) = 'night auditor';

-- 2) Canonical department key for a role-catalogue department label.
CREATE OR REPLACE FUNCTION public.neo_department_catalogue_key(_label text)
RETURNS text
LANGUAGE sql
IMMUTABLE
SET search_path = public
AS $$
  WITH n AS (
    SELECT regexp_replace(
             regexp_replace(lower(coalesce(_label, '')), '[^a-z0-9]+', ' ', 'g'),
             '\s+(and|of|the)\s+', ' ', 'g') AS t
  )
  SELECT CASE trim(t)
           WHEN 'kitchen' THEN 'main-kitchen'
           WHEN 'main kitchen' THEN 'main-kitchen'
           WHEN 'executive' THEN 'executive-management'
           WHEN 'executive management' THEN 'executive-management'
           WHEN 'food beverage' THEN 'food-and-beverage'
           WHEN 'front office' THEN 'front-office'
           WHEN 'human resources' THEN 'human-resources'
           WHEN 'inventory stores' THEN 'inventory-and-stores'
           WHEN 'it systems' THEN 'it-and-systems'
           WHEN 'pastry bakery' THEN 'pastry-and-bakery'
           WHEN 'sales events banqueting' THEN 'sales-events-banqueting'
           WHEN 'housekeeping' THEN 'housekeeping'
           WHEN 'laundry' THEN 'laundry'
           WHEN 'maintenance' THEN 'maintenance'
           WHEN 'marketing' THEN 'marketing'
           WHEN 'operations' THEN 'operations'
           WHEN 'procurement' THEN 'procurement'
           WHEN 'security' THEN 'security'
           WHEN 'finance' THEN 'finance'
           WHEN 'delivery' THEN 'delivery'
           WHEN 'bar' THEN 'bar'
           WHEN 'administration' THEN 'administration'
           ELSE NULL          -- genuinely ambiguous: never guessed
         END
    FROM n;
$$;

REVOKE ALL ON FUNCTION public.neo_department_catalogue_key(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.neo_department_catalogue_key(text) TO authenticated, service_role;

-- 3) Server-side authority: a role must be valid for the department/property.
CREATE OR REPLACE FUNCTION public.neo_validate_role_assignment(
  _branch uuid,
  _department uuid,
  _role_ids uuid[]
) RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_org uuid := public.current_org_id();
  v_dept_key text;
  v_dept_branch uuid;
  v_dept_name text;
  r record;
  v_role_dept_key text;
  v_scope text;
BEGIN
  IF v_org IS NULL THEN
    RAISE EXCEPTION 'No organisation context';
  END IF;

  IF _department IS NOT NULL THEN
    SELECT d.catalogue_key, d.branch_id, d.name
      INTO v_dept_key, v_dept_branch, v_dept_name
      FROM public.departments d
     WHERE d.id = _department AND d.organization_id = v_org;
    IF v_dept_name IS NULL THEN
      RAISE EXCEPTION 'That department does not belong to your organisation';
    END IF;
    IF v_dept_branch IS NOT NULL AND _branch IS NOT NULL AND v_dept_branch <> _branch THEN
      RAISE EXCEPTION 'Department % belongs to another property', v_dept_name;
    END IF;
  END IF;

  FOR r IN
    SELECT ro.id, ro.name, ro.active, ro.role_status, ro.access_scope,
           ro.department_id, ro.normalized_role_key,
           rc.access_scope AS cat_scope, rc.department AS cat_dept, rc.retired AS cat_retired
      FROM public.roles ro
      LEFT JOIN public.role_catalogue rc ON rc.role_key = ro.normalized_role_key
     WHERE ro.id = ANY(coalesce(_role_ids, '{}'::uuid[]))
       AND ro.organization_id = v_org
  LOOP
    IF r.active IS NOT TRUE OR r.role_status = 'archived' OR coalesce(r.cat_retired, false) THEN
      RAISE EXCEPTION 'Role % is no longer part of the role model', r.name;
    END IF;

    v_scope := coalesce(r.access_scope, r.cat_scope);
    IF v_scope IN ('organisation', 'technical') THEN
      CONTINUE;  -- genuinely organisation-wide authority
    END IF;

    SELECT d.catalogue_key INTO v_role_dept_key
      FROM public.departments d
     WHERE d.id = r.department_id;

    IF v_role_dept_key IS NULL THEN
      v_role_dept_key := public.neo_department_catalogue_key(r.cat_dept);
    END IF;

    IF v_role_dept_key IS NULL THEN
      CONTINUE;  -- no canonical department relationship: cannot be proven invalid
    END IF;

    IF _department IS NULL THEN
      RAISE EXCEPTION 'Role % requires a department to be selected', r.name;
    END IF;

    IF v_dept_key IS DISTINCT FROM v_role_dept_key THEN
      RAISE EXCEPTION 'Role % does not belong to department %', r.name, v_dept_name;
    END IF;
  END LOOP;

  -- Every requested role must exist inside the caller's organisation.
  IF (SELECT count(*) FROM public.roles
       WHERE id = ANY(coalesce(_role_ids, '{}'::uuid[])) AND organization_id = v_org)
     <> coalesce(array_length(_role_ids, 1), 0) THEN
    RAISE EXCEPTION 'One of the selected roles does not belong to your organisation';
  END IF;

  RETURN jsonb_build_object('ok', true, 'department_key', v_dept_key,
                            'role_count', coalesce(array_length(_role_ids, 1), 0));
END;
$$;

REVOKE ALL ON FUNCTION public.neo_validate_role_assignment(uuid, uuid, uuid[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.neo_validate_role_assignment(uuid, uuid, uuid[]) TO authenticated, service_role;