CREATE OR REPLACE FUNCTION public.neo_simulate_access(_user uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  org uuid := public.current_org_id();
  result jsonb;
BEGIN
  IF org IS NULL OR NOT (public.has_permission('administration', 'workspace', 'edit') OR public.has_permission('administration', 'users', 'view_access')) THEN
    RAISE EXCEPTION 'Not permitted to preview access';
  END IF;

  SELECT jsonb_build_object(
    'user_id', p.id,
    'full_name', p.full_name,
    'account_type', coalesce(p.account_type, 'staff'),
    'account_status', p.account_status,
    'organization_id', p.organization_id,
    -- Property assignments live on the employee record, not the login account:
    -- employee_branch_assignments is keyed by employee_id, so map through employees.
    'branch_ids', coalesce((
      SELECT jsonb_agg(DISTINCT b.branch_id)
        FROM public.employee_branch_assignments b
        JOIN public.employees e ON e.id = b.employee_id
       WHERE b.organization_id = org AND e.profile_id = p.id), '[]'::jsonb),
    'primary_branch_id', p.branch_id,
    'department_id', p.department_id,
    'roles', coalesce((
      SELECT jsonb_agg(jsonb_build_object('id', r.id, 'name', r.name,
                                          'key', r.normalized_role_key,
                                          'scope', r.access_scope,
                                          'is_primary', ur.is_primary)
                       ORDER BY ur.is_primary DESC, r.name)
        FROM public.user_roles ur JOIN public.roles r ON r.id = ur.role_id
       WHERE ur.user_id = p.id AND ur.organization_id = org), '[]'::jsonb),
    'capabilities', coalesce((
      SELECT jsonb_agg(DISTINCT (perm.module || '.' || coalesce(perm.feature, '*') || '.' || perm.action))
        FROM (
          SELECT pm.module, pm.feature, pm.action
            FROM public.user_roles ur
            JOIN public.roles r ON r.id = ur.role_id AND r.active
            JOIN public.role_permissions rp ON rp.role_id = r.id
            JOIN public.permissions pm ON pm.id = rp.permission_id
           WHERE ur.user_id = p.id AND ur.organization_id = org
          UNION
          SELECT pm.module, pm.feature, pm.action
            FROM public.user_permissions up
            JOIN public.permissions pm ON pm.id = up.permission_id
           WHERE up.user_id = p.id AND up.organization_id = org AND up.effect = 'grant'
        ) perm
       WHERE NOT EXISTS (
         SELECT 1 FROM public.user_permissions d
          JOIN public.permissions dp ON dp.id = d.permission_id
         WHERE d.user_id = p.id AND d.organization_id = org AND d.effect = 'deny'
           AND dp.module = perm.module AND dp.action = perm.action
           AND coalesce(dp.feature,'*') = coalesce(perm.feature,'*'))
      ), '[]'::jsonb)
  ) INTO result
  FROM public.profiles p
  WHERE p.id = _user AND p.organization_id = org;

  IF result IS NULL THEN
    RAISE EXCEPTION 'Staff member not found in this organisation';
  END IF;
  RETURN result;
END;
$function$;