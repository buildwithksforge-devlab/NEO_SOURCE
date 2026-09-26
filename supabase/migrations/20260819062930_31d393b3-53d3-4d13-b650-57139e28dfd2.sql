-- 1. Deduplicate role_permissions (same role + permission stored many times)
DELETE FROM public.role_permissions rp
USING public.role_permissions keep
WHERE rp.role_id = keep.role_id
  AND rp.permission_id = keep.permission_id
  AND rp.organization_id IS NOT DISTINCT FROM keep.organization_id
  AND rp.ctid > keep.ctid;

CREATE UNIQUE INDEX IF NOT EXISTS role_permissions_unique_grant
  ON public.role_permissions (role_id, permission_id);

-- 2. Prevent duplicate role assignments
DELETE FROM public.user_roles ur
USING public.user_roles keep
WHERE ur.user_id = keep.user_id
  AND ur.role_id = keep.role_id
  AND ur.ctid > keep.ctid;

CREATE UNIQUE INDEX IF NOT EXISTS user_roles_unique_assignment
  ON public.user_roles (user_id, role_id);

-- 3. Cheap access-version fingerprint so live sessions can detect permission changes
CREATE OR REPLACE FUNCTION public.my_permission_version()
RETURNS text
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  SELECT md5(
    coalesce((SELECT p.account_status || coalesce(p.organization_id::text,'') FROM public.profiles p WHERE p.id = auth.uid()), 'none')
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
      SELECT count(*)::text FROM public.user_permissions up WHERE up.user_id = auth.uid()
    ), '0')
  );
$function$;

REVOKE ALL ON FUNCTION public.my_permission_version() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.my_permission_version() TO authenticated, service_role;