
-- 1. Snapshot store -------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.user_access_snapshots (
  user_id uuid PRIMARY KEY,
  organization_id uuid,
  access_version text NOT NULL,
  payload jsonb NOT NULL,
  computed_at timestamptz NOT NULL DEFAULT now()
);
GRANT ALL ON public.user_access_snapshots TO service_role;
ALTER TABLE public.user_access_snapshots ENABLE ROW LEVEL SECURITY;
-- No policies and no grants for anon/authenticated: reachable only through
-- the security-definer resolver below.

-- 2. Supporting indexes ---------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_user_roles_user ON public.user_roles(user_id);
CREATE INDEX IF NOT EXISTS idx_role_permissions_role ON public.role_permissions(role_id);
CREATE INDEX IF NOT EXISTS idx_user_permissions_user ON public.user_permissions(user_id);
CREATE INDEX IF NOT EXISTS idx_user_branches_user ON public.user_branches(user_id);
CREATE INDEX IF NOT EXISTS idx_user_departments_user ON public.user_departments(user_id);
CREATE INDEX IF NOT EXISTS idx_user_stations_user ON public.user_stations(user_id);

-- 3. Full resolver, with every context helper evaluated exactly once ------
CREATE OR REPLACE FUNCTION public.neo_build_effective_access()
RETURNS jsonb
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  WITH ctx AS (
    SELECT auth.uid() AS uid,
           public.current_org_id() AS org,
           coalesce(public.current_branch_ids(), '{}'::uuid[]) AS branches,
           coalesce(public.current_department_ids(), '{}'::uuid[]) AS depts,
           coalesce(public.current_station_ids(), '{}'::uuid[]) AS stations,
           public.current_access_scope() AS scope,
           public.is_org_admin() AS admin
  ),
  me AS (SELECT p.* FROM public.profiles p, ctx WHERE p.id = ctx.uid),
  role_rows AS (
    SELECT r.id, r.name, r.access_scope, ur.is_primary, r.normalized_role_key,
           coalesce(r.position_level, 999) AS position_level
      FROM public.user_roles ur
      JOIN public.roles r ON r.id = ur.role_id
      CROSS JOIN ctx
     WHERE ur.user_id = ctx.uid
       AND r.role_status <> 'archived'),
  primary_role AS (
    SELECT * FROM role_rows
     ORDER BY is_primary DESC, position_level ASC, name ASC
     LIMIT 1),
  denied AS (
    SELECT p.id FROM public.user_permissions up
    JOIN public.permissions p ON p.id = up.permission_id
    CROSS JOIN ctx
    WHERE up.user_id = ctx.uid AND up.effect = 'deny'
      AND up.organization_id = ctx.org
      AND (up.valid_from IS NULL OR up.valid_from <= now())
      AND (up.valid_until IS NULL OR up.valid_until >= now())
  ),
  base AS (
    SELECT p.id, p.module, p.feature, p.action
      FROM public.permissions p, ctx
     WHERE ctx.admin
    UNION
    SELECT p.id, p.module, p.feature, p.action
      FROM public.user_roles ur
      JOIN public.roles r ON r.id = ur.role_id AND r.active
      JOIN public.role_permissions rp ON rp.role_id = r.id
      JOIN public.permissions p ON p.id = rp.permission_id
      CROSS JOIN ctx
     WHERE ur.user_id = ctx.uid
       AND ur.organization_id = ctx.org
       AND r.organization_id = ctx.org
       AND rp.organization_id = ctx.org
    UNION
    SELECT p.id, p.module, p.feature, p.action
      FROM public.user_permissions up
      JOIN public.permissions p ON p.id = up.permission_id
      CROSS JOIN ctx
     WHERE up.user_id = ctx.uid AND up.effect = 'grant'
       AND up.organization_id = ctx.org
       AND (up.valid_from IS NULL OR up.valid_from <= now())
       AND (up.valid_until IS NULL OR up.valid_until >= now())
  ),
  perms AS (
    SELECT b.module, b.feature, b.action
      FROM base b
     WHERE b.id NOT IN (SELECT id FROM denied)
       AND coalesce((SELECT account_status FROM me), 'active') = 'active'
  ),
  individual AS (
    SELECT up.effect, p.module, p.feature, p.action, up.valid_from, up.valid_until
      FROM public.user_permissions up
      JOIN public.permissions p ON p.id = up.permission_id
      CROSS JOIN ctx
     WHERE up.user_id = ctx.uid AND up.organization_id = ctx.org)
  SELECT jsonb_build_object(
    'user_id', ctx.uid,
    'account_type', (SELECT coalesce(account_type,'staff') FROM me),
    'account_status', (SELECT account_status FROM me),
    'organization_id', ctx.org,
    'profile_id', (SELECT id FROM me),
    'staff_id', (SELECT staff_id FROM me),
    'full_name', (SELECT full_name FROM me),
    'branch_ids', to_jsonb(ctx.branches),
    'active_branch_id', (SELECT branch_id FROM me),
    'department_ids', to_jsonb(ctx.depts),
    'station_ids', to_jsonb(ctx.stations),
    'access_scope', ctx.scope,
    'is_org_admin', ctx.admin,
    'role_ids', coalesce((SELECT jsonb_agg(DISTINCT id) FROM role_rows), '[]'::jsonb),
    'role_names', coalesce((SELECT jsonb_agg(DISTINCT name) FROM role_rows), '[]'::jsonb),
    'primary_role_id', (SELECT id FROM primary_role),
    'primary_role_name', (SELECT name FROM primary_role),
    'permissions', coalesce((SELECT jsonb_agg(jsonb_build_object('module', module, 'feature', feature, 'action', action)) FROM perms), '[]'::jsonb),
    'individual_grants', coalesce((SELECT jsonb_agg(jsonb_build_object('module', module, 'feature', feature, 'action', action, 'valid_from', valid_from, 'valid_until', valid_until)) FROM individual WHERE effect = 'grant'), '[]'::jsonb),
    'individual_denials', coalesce((SELECT jsonb_agg(jsonb_build_object('module', module, 'feature', feature, 'action', action, 'valid_from', valid_from, 'valid_until', valid_until)) FROM individual WHERE effect = 'deny'), '[]'::jsonb),
    'entitlements', coalesce((SELECT jsonb_object_agg(e.feature_key, e.enabled) FROM public.organization_entitlements e
      WHERE e.organization_id = ctx.org AND (e.expires_at IS NULL OR e.expires_at >= current_date)), '{}'::jsonb),
    'dashboard_key', (SELECT coalesce(
        (SELECT a.dashboard_key FROM public.role_dashboard_assignments a
          WHERE a.role_id = pr.id ORDER BY a.is_default DESC, a.priority ASC LIMIT 1),
        public.neo_dashboard_key(pr.normalized_role_key, pr.name)) FROM primary_role pr),
    'primary_role_key', (SELECT normalized_role_key FROM primary_role),
    'setup_complete', (ctx.org IS NOT NULL AND EXISTS (SELECT 1 FROM role_rows)
      AND array_length(ctx.branches, 1) IS NOT NULL),
    'state', CASE
      WHEN (SELECT id FROM me) IS NULL THEN 'no_account'
      WHEN coalesce((SELECT account_status FROM me), 'active') <> 'active' THEN 'suspended'
      WHEN ctx.org IS NULL OR NOT EXISTS (SELECT 1 FROM role_rows)
        OR array_length(ctx.branches, 1) IS NULL THEN 'setup_incomplete'
      ELSE 'ready' END,
    'state_reason', CASE
      WHEN (SELECT id FROM me) IS NULL THEN
        CASE WHEN EXISTS (SELECT 1 FROM public.workspace_provisioning_attempts a
               WHERE a.user_id = ctx.uid
                  OR lower(a.email) = lower(coalesce((SELECT u.email FROM auth.users u WHERE u.id = ctx.uid), '')))
             THEN 'provisioning_incomplete' ELSE 'staff_record_missing' END
      WHEN coalesce((SELECT account_status FROM me), 'active') <> 'active' THEN 'account_suspended'
      WHEN (SELECT organization_id FROM me) IS NULL THEN 'membership_missing'
      WHEN ctx.org IS NULL THEN 'membership_inactive'
      WHEN array_length(ctx.branches, 1) IS NULL THEN 'property_assignment_missing'
      WHEN NOT EXISTS (SELECT 1 FROM role_rows) THEN 'role_missing'
      WHEN array_length(ctx.depts, 1) IS NULL THEN 'department_assignment_missing'
      ELSE 'ok' END,
    'recoverable', ((SELECT id FROM me) IS NULL AND EXISTS (
      SELECT 1 FROM public.workspace_provisioning_attempts a
       WHERE a.user_id = ctx.uid
          OR lower(a.email) = lower(coalesce((SELECT u.email FROM auth.users u WHERE u.id = ctx.uid), '')))),
    'access_version', public.my_permission_version(),
    'resolved_at', now())
  FROM ctx;
$function$;
REVOKE EXECUTE ON FUNCTION public.neo_build_effective_access() FROM PUBLIC, anon;

-- 4. Incremental resolver: fingerprint first, full rebuild only on change -
CREATE OR REPLACE FUNCTION public.my_effective_access()
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  uid uuid := auth.uid();
  v text;
  cached jsonb;
  fresh jsonb;
BEGIN
  IF uid IS NULL THEN
    RETURN public.neo_build_effective_access();
  END IF;

  v := public.my_permission_version();

  SELECT s.payload INTO cached
    FROM public.user_access_snapshots s
   WHERE s.user_id = uid
     AND s.access_version = v
     AND s.computed_at > now() - interval '30 minutes';

  IF cached IS NOT NULL THEN
    RETURN jsonb_set(cached, '{resolved_at}', to_jsonb(now()));
  END IF;

  fresh := public.neo_build_effective_access();

  INSERT INTO public.user_access_snapshots(user_id, organization_id, access_version, payload, computed_at)
  VALUES (uid, nullif(fresh->>'organization_id','')::uuid, v, fresh, now())
  ON CONFLICT (user_id) DO UPDATE
    SET organization_id = excluded.organization_id,
        access_version = excluded.access_version,
        payload = excluded.payload,
        computed_at = excluded.computed_at;

  RETURN fresh;
END;
$function$;
REVOKE EXECUTE ON FUNCTION public.my_effective_access() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.my_effective_access() TO authenticated;
GRANT EXECUTE ON FUNCTION public.my_permission_version() TO authenticated;
