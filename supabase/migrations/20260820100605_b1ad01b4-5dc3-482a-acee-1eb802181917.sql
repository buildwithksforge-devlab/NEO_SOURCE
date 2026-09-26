
ALTER TABLE public.user_permissions
  ADD COLUMN IF NOT EXISTS valid_from timestamptz,
  ADD COLUMN IF NOT EXISTS valid_until timestamptz,
  ADD COLUMN IF NOT EXISTS reason text;

CREATE OR REPLACE FUNCTION public.my_effective_permissions()
RETURNS TABLE(module text, feature text, action text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$
  WITH org AS (SELECT public.current_org_id() AS id),
  denied AS (
    SELECT p.id FROM public.user_permissions up
    JOIN public.permissions p ON p.id = up.permission_id
    WHERE up.user_id = auth.uid() AND up.effect = 'deny'
      AND up.organization_id = (SELECT id FROM org)
      AND (up.valid_from IS NULL OR up.valid_from <= now())
      AND (up.valid_until IS NULL OR up.valid_until >= now())
  ),
  base AS (
    SELECT p.id, p.module, p.feature, p.action
    FROM public.permissions p
    WHERE public.is_org_admin()
    UNION
    SELECT p.id, p.module, p.feature, p.action
    FROM public.user_roles ur
    JOIN public.roles r ON r.id = ur.role_id AND r.active
    JOIN public.role_permissions rp ON rp.role_id = r.id
    JOIN public.permissions p ON p.id = rp.permission_id
    WHERE ur.user_id = auth.uid()
      AND ur.organization_id = (SELECT id FROM org)
      AND r.organization_id = (SELECT id FROM org)
      AND rp.organization_id = (SELECT id FROM org)
    UNION
    SELECT p.id, p.module, p.feature, p.action
    FROM public.user_permissions up
    JOIN public.permissions p ON p.id = up.permission_id
    WHERE up.user_id = auth.uid() AND up.effect = 'grant'
      AND up.organization_id = (SELECT id FROM org)
      AND (up.valid_from IS NULL OR up.valid_from <= now())
      AND (up.valid_until IS NULL OR up.valid_until >= now())
  )
  SELECT b.module, b.feature, b.action
  FROM base b
  WHERE b.id NOT IN (SELECT id FROM denied)
    AND COALESCE((SELECT pr.account_status FROM public.profiles pr WHERE pr.id = auth.uid()), 'active') = 'active';
$function$;

CREATE OR REPLACE FUNCTION public.my_permission_version()
RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$
  SELECT md5(
    coalesce((SELECT p.account_status || coalesce(p.account_type,'') || coalesce(p.organization_id::text,'')
                || coalesce(p.branch_id::text,'') || coalesce(p.department_id::text,'')
              FROM public.profiles p WHERE p.id = auth.uid()), 'none')
    || coalesce((
      SELECT string_agg(x.k, ',' ORDER BY x.k) FROM (
        SELECT ur.role_id::text || ':' || coalesce(r.active::text,'f') || ':' ||
               coalesce((SELECT count(*)::text FROM public.role_permissions rp WHERE rp.role_id = ur.role_id), '0') AS k
        FROM public.user_roles ur
        LEFT JOIN public.roles r ON r.id = ur.role_id
        WHERE ur.user_id = auth.uid()
      ) x
    ), 'noroles')
    || coalesce((
      SELECT string_agg(up.permission_id::text || up.effect
               || coalesce(up.valid_from::text,'') || coalesce(up.valid_until::text,''), ','
               ORDER BY up.permission_id::text)
      FROM public.user_permissions up WHERE up.user_id = auth.uid()
    ), 'noindividual')
    || coalesce(array_to_string(public.current_branch_ids(), ','), 'nobranch')
    || coalesce(array_to_string(public.current_department_ids(), ','), 'nodept')
    || coalesce(array_to_string(public.current_station_ids(), ','), 'nostation')
    || coalesce((
      SELECT string_agg(e.feature_key || e.enabled::text, ',' ORDER BY e.feature_key)
      FROM public.organization_entitlements e
      WHERE e.organization_id = public.current_org_id()
    ), 'noentitlements')
  );
$function$;

CREATE OR REPLACE FUNCTION public.my_effective_access()
RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$
  WITH me AS (
    SELECT p.* FROM public.profiles p WHERE p.id = auth.uid()
  ),
  role_rows AS (
    SELECT r.id, r.name, r.access_scope
    FROM public.user_roles ur
    JOIN public.roles r ON r.id = ur.role_id
    WHERE ur.user_id = auth.uid()
  ),
  perms AS (SELECT * FROM public.my_effective_permissions()),
  individual AS (
    SELECT up.effect, p.module, p.feature, p.action, up.valid_from, up.valid_until
    FROM public.user_permissions up
    JOIN public.permissions p ON p.id = up.permission_id
    WHERE up.user_id = auth.uid()
      AND up.organization_id = public.current_org_id()
  )
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
    'permissions', coalesce((
      SELECT jsonb_agg(jsonb_build_object('module', module, 'feature', feature, 'action', action))
      FROM perms), '[]'::jsonb),
    'individual_grants', coalesce((
      SELECT jsonb_agg(jsonb_build_object('module', module, 'feature', feature, 'action', action,
                                          'valid_from', valid_from, 'valid_until', valid_until))
      FROM individual WHERE effect = 'grant'), '[]'::jsonb),
    'individual_denials', coalesce((
      SELECT jsonb_agg(jsonb_build_object('module', module, 'feature', feature, 'action', action,
                                          'valid_from', valid_from, 'valid_until', valid_until))
      FROM individual WHERE effect = 'deny'), '[]'::jsonb),
    'entitlements', coalesce((
      SELECT jsonb_object_agg(e.feature_key, e.enabled)
      FROM public.organization_entitlements e
      WHERE e.organization_id = public.current_org_id()
        AND (e.expires_at IS NULL OR e.expires_at >= current_date)), '{}'::jsonb),
    'dashboard_key', (
      SELECT public.dashboard_key_for_role(rr.name) FROM role_rows rr ORDER BY rr.name LIMIT 1),
    'setup_complete', (
      public.current_org_id() IS NOT NULL
      AND EXISTS (SELECT 1 FROM role_rows)
      AND array_length(public.current_branch_ids(), 1) IS NOT NULL
    ),
    'state', CASE
      WHEN (SELECT id FROM me) IS NULL THEN 'no_account'
      WHEN coalesce((SELECT account_status FROM me), 'active') <> 'active' THEN 'suspended'
      WHEN public.current_org_id() IS NULL
        OR NOT EXISTS (SELECT 1 FROM role_rows)
        OR array_length(public.current_branch_ids(), 1) IS NULL THEN 'setup_incomplete'
      ELSE 'ready' END,
    'access_version', public.my_permission_version(),
    'resolved_at', now()
  );
$function$;

REVOKE EXECUTE ON FUNCTION public.my_effective_access() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.my_effective_access() TO authenticated;
REVOKE EXECUTE ON FUNCTION public.my_permission_version() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.my_permission_version() TO authenticated;
REVOKE EXECUTE ON FUNCTION public.my_effective_permissions() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.my_effective_permissions() TO authenticated;
