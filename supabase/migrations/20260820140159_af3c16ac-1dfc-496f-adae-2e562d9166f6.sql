ALTER TABLE public.user_roles ADD COLUMN IF NOT EXISTS is_primary boolean NOT NULL DEFAULT false;

CREATE OR REPLACE FUNCTION public.my_effective_access()
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $fn$
  WITH me AS (SELECT p.* FROM public.profiles p WHERE p.id = auth.uid()),
  role_rows AS (
    SELECT r.id, r.name, r.access_scope, ur.is_primary,
           coalesce(r.position_level, 999) AS position_level
      FROM public.user_roles ur
      JOIN public.roles r ON r.id = ur.role_id
     WHERE ur.user_id = auth.uid()),
  primary_role AS (
    SELECT * FROM role_rows
     ORDER BY is_primary DESC, position_level ASC, name ASC
     LIMIT 1),
  perms AS (SELECT * FROM public.my_effective_permissions()),
  individual AS (
    SELECT up.effect, p.module, p.feature, p.action, up.valid_from, up.valid_until
    FROM public.user_permissions up JOIN public.permissions p ON p.id = up.permission_id
    WHERE up.user_id = auth.uid() AND up.organization_id = public.current_org_id())
  SELECT jsonb_build_object(
    'user_id', auth.uid(),
    'account_type', (SELECT coalesce(account_type,'staff') FROM me),
    'account_status', (SELECT account_status FROM me),
    'organization_id', public.current_org_id(),
    'profile_id', (SELECT id FROM me),
    'staff_id', (SELECT staff_id FROM me),
    'full_name', (SELECT full_name FROM me),
    'branch_ids', to_jsonb(coalesce(public.current_branch_ids(), '{}'::uuid[])),
    'active_branch_id', (SELECT branch_id FROM me),
    'department_ids', to_jsonb(coalesce(public.current_department_ids(), '{}'::uuid[])),
    'station_ids', to_jsonb(coalesce(public.current_station_ids(), '{}'::uuid[])),
    'access_scope', public.current_access_scope(),
    'is_org_admin', public.is_org_admin(),
    'role_ids', coalesce((SELECT jsonb_agg(DISTINCT id) FROM role_rows), '[]'::jsonb),
    'role_names', coalesce((SELECT jsonb_agg(DISTINCT name) FROM role_rows), '[]'::jsonb),
    'primary_role_id', (SELECT id FROM primary_role),
    'primary_role_name', (SELECT name FROM primary_role),
    'permissions', coalesce((SELECT jsonb_agg(jsonb_build_object('module', module, 'feature', feature, 'action', action)) FROM perms), '[]'::jsonb),
    'individual_grants', coalesce((SELECT jsonb_agg(jsonb_build_object('module', module, 'feature', feature, 'action', action, 'valid_from', valid_from, 'valid_until', valid_until)) FROM individual WHERE effect = 'grant'), '[]'::jsonb),
    'individual_denials', coalesce((SELECT jsonb_agg(jsonb_build_object('module', module, 'feature', feature, 'action', action, 'valid_from', valid_from, 'valid_until', valid_until)) FROM individual WHERE effect = 'deny'), '[]'::jsonb),
    'entitlements', coalesce((SELECT jsonb_object_agg(e.feature_key, e.enabled) FROM public.organization_entitlements e
      WHERE e.organization_id = public.current_org_id() AND (e.expires_at IS NULL OR e.expires_at >= current_date)), '{}'::jsonb),
    'dashboard_key', (SELECT public.dashboard_key_for_role(pr.name) FROM primary_role pr),
    'setup_complete', (public.current_org_id() IS NOT NULL AND EXISTS (SELECT 1 FROM role_rows)
      AND array_length(public.current_branch_ids(), 1) IS NOT NULL),
    'state', CASE
      WHEN (SELECT id FROM me) IS NULL THEN 'no_account'
      WHEN coalesce((SELECT account_status FROM me), 'active') <> 'active' THEN 'suspended'
      WHEN public.current_org_id() IS NULL OR NOT EXISTS (SELECT 1 FROM role_rows)
        OR array_length(public.current_branch_ids(), 1) IS NULL THEN 'setup_incomplete'
      ELSE 'ready' END,
    'state_reason', CASE
      WHEN (SELECT id FROM me) IS NULL THEN
        CASE WHEN EXISTS (SELECT 1 FROM public.workspace_provisioning_attempts a
               WHERE a.user_id = auth.uid()
                  OR lower(a.email) = lower(coalesce((SELECT u.email FROM auth.users u WHERE u.id = auth.uid()), '')))
             THEN 'provisioning_incomplete' ELSE 'staff_record_missing' END
      WHEN coalesce((SELECT account_status FROM me), 'active') <> 'active' THEN 'account_suspended'
      WHEN (SELECT organization_id FROM me) IS NULL THEN 'membership_missing'
      WHEN public.current_org_id() IS NULL THEN 'membership_inactive'
      WHEN array_length(public.current_branch_ids(), 1) IS NULL THEN 'property_assignment_missing'
      WHEN NOT EXISTS (SELECT 1 FROM role_rows) THEN 'role_missing'
      WHEN array_length(public.current_department_ids(), 1) IS NULL THEN 'department_assignment_missing'
      ELSE 'ok' END,
    'recoverable', ((SELECT id FROM me) IS NULL AND EXISTS (
      SELECT 1 FROM public.workspace_provisioning_attempts a
       WHERE a.user_id = auth.uid()
          OR lower(a.email) = lower(coalesce((SELECT u.email FROM auth.users u WHERE u.id = auth.uid()), '')))),
    'access_version', public.my_permission_version(),
    'resolved_at', now());
$fn$;

REVOKE EXECUTE ON FUNCTION public.my_effective_access() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.my_effective_access() TO authenticated;