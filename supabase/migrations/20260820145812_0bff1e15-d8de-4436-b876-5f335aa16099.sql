-- Count reconciliation: report approved catalogue coverage separately from the
-- total number of active roles, so the screens can never show "43 / 34".
CREATE OR REPLACE FUNCTION public.neo_model_adoption_status(_org uuid)
RETURNS jsonb
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  SELECT jsonb_build_object(
    'organization_id', _org,
    'catalogue_roles', (SELECT count(*) FROM public.role_catalogue WHERE NOT optional_role),
    'catalogue_roles_present', (SELECT count(*) FROM public.role_catalogue c
       WHERE NOT c.optional_role
         AND EXISTS (SELECT 1 FROM public.roles r WHERE r.organization_id = _org
                      AND r.normalized_role_key = c.role_key AND r.role_status = 'active')),
    'active_roles', (SELECT count(*) FROM public.roles WHERE organization_id = _org AND role_status = 'active'),
    'active_recommended_roles', (SELECT count(*) FROM public.roles r
       WHERE r.organization_id = _org AND r.role_status = 'active'
         AND EXISTS (SELECT 1 FROM public.role_catalogue c WHERE c.role_key = r.normalized_role_key)),
    'legacy_roles', (SELECT count(*) FROM public.roles WHERE organization_id = _org AND role_status = 'legacy'),
    'archived_roles', (SELECT count(*) FROM public.roles WHERE organization_id = _org AND role_status = 'archived'),
    'custom_roles', (SELECT count(*) FROM public.roles WHERE organization_id = _org AND role_status = 'custom'),
    'total_historical_roles', (SELECT count(*) FROM public.roles WHERE organization_id = _org),
    'assignable_roles', (SELECT count(*) FROM public.roles
       WHERE organization_id = _org AND role_status IN ('active','custom')),
    'roles_with_permissions', (SELECT count(*) FROM public.roles r
       WHERE r.organization_id = _org AND r.role_status IN ('active','custom')
         AND EXISTS (SELECT 1 FROM public.role_permissions rp WHERE rp.role_id = r.id)),
    'roles_with_staff', (SELECT count(*) FROM public.roles r
       WHERE r.organization_id = _org AND r.role_status IN ('active','custom')
         AND EXISTS (SELECT 1 FROM public.user_roles ur WHERE ur.role_id = r.id)),
    'missing_catalogue_roles', coalesce((SELECT jsonb_agg(c.role_name ORDER BY c.sort_order)
        FROM public.role_catalogue c WHERE NOT c.optional_role
         AND NOT EXISTS (SELECT 1 FROM public.roles r WHERE r.organization_id = _org
                          AND r.normalized_role_key = c.role_key AND r.role_status = 'active')), '[]'::jsonb),
    'roles_without_permissions', (SELECT count(*) FROM public.roles r
       WHERE r.organization_id = _org AND r.role_status IN ('active','custom')
         AND NOT EXISTS (SELECT 1 FROM public.role_permissions rp WHERE rp.role_id = r.id)),
    'roles_without_dashboard', (SELECT count(*) FROM public.roles r
       WHERE r.organization_id = _org AND r.role_status = 'active'
         AND NOT EXISTS (SELECT 1 FROM public.role_dashboard_assignments a WHERE a.role_id = r.id)),
    'pending_role_decisions', (SELECT count(*) FROM public.neo_pending_role_decisions d
       WHERE d.organization_id = _org),
    'members_without_primary', (SELECT count(*) FROM (
       SELECT ur.user_id FROM public.user_roles ur WHERE ur.organization_id = _org
        GROUP BY ur.user_id HAVING count(*) FILTER (WHERE ur.is_primary) <> 1) x),
    'last_run', (SELECT to_jsonb(x) FROM (
       SELECT id, created_at, trigger_source, report FROM public.role_model_adoption_runs
        WHERE organization_id = _org ORDER BY created_at DESC LIMIT 1) x))
  WHERE _org = public.current_org_id();
$function$;