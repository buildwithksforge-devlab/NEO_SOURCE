-- 1. Access epoch --------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.access_epochs (
  organization_id uuid PRIMARY KEY,
  epoch bigint NOT NULL DEFAULT 1,
  updated_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT ON public.access_epochs TO authenticated;
GRANT ALL ON public.access_epochs TO service_role;
ALTER TABLE public.access_epochs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "access_epochs read own org" ON public.access_epochs;
CREATE POLICY "access_epochs read own org" ON public.access_epochs
  FOR SELECT TO authenticated
  USING (organization_id = public.current_org_id());

CREATE OR REPLACE FUNCTION public.neo_bump_access_epoch(_org uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF _org IS NULL THEN RETURN; END IF;
  INSERT INTO public.access_epochs(organization_id, epoch, updated_at)
  VALUES (_org, 1, now())
  ON CONFLICT (organization_id) DO UPDATE
    SET epoch = public.access_epochs.epoch + 1, updated_at = now();
  DELETE FROM public.user_access_snapshots WHERE organization_id = _org;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.neo_bump_access_epoch(uuid) FROM PUBLIC, anon;

-- 2. Invalidation trigger -------------------------------------------------
CREATE OR REPLACE FUNCTION public.neo_invalidate_access()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  org uuid;
BEGIN
  IF TG_OP = 'DELETE' THEN
    org := (to_jsonb(OLD) ->> 'organization_id')::uuid;
  ELSE
    org := (to_jsonb(NEW) ->> 'organization_id')::uuid;
    IF org IS NULL AND TG_OP = 'UPDATE' THEN
      org := (to_jsonb(OLD) ->> 'organization_id')::uuid;
    END IF;
  END IF;
  PERFORM public.neo_bump_access_epoch(org);
  RETURN NULL;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.neo_invalidate_access() FROM PUBLIC, anon;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'roles','role_permissions','user_roles','user_permissions',
    'profiles','employee_branch_assignments','organization_entitlements'
  ] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS neo_invalidate_access_trg ON public.%I', t);
    EXECUTE format(
      'CREATE TRIGGER neo_invalidate_access_trg AFTER INSERT OR UPDATE OR DELETE ON public.%I
         FOR EACH ROW EXECUTE FUNCTION public.neo_invalidate_access()', t);
  END LOOP;
END;
$$;

-- 3. Fingerprint: exact role permission set + organisation epoch ----------
CREATE OR REPLACE FUNCTION public.my_permission_version()
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT md5(
    coalesce((SELECT p.account_status || coalesce(p.account_type,'') || coalesce(p.organization_id::text,'')
                || coalesce(p.branch_id::text,'') || coalesce(p.department_id::text,'')
              FROM public.profiles p WHERE p.id = auth.uid()), 'none')
    || coalesce((
      SELECT string_agg(x.k, ',' ORDER BY x.k) FROM (
        SELECT ur.role_id::text || ':' || coalesce(r.active::text,'f') || ':' ||
               coalesce((SELECT md5(string_agg(rp.permission_id::text, ',' ORDER BY rp.permission_id))
                           FROM public.role_permissions rp WHERE rp.role_id = ur.role_id), 'noperms') AS k
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
    || coalesce((SELECT ae.epoch::text FROM public.access_epochs ae
                  WHERE ae.organization_id = public.current_org_id()), 'noepoch')
  );
$$;

REVOKE EXECUTE ON FUNCTION public.my_permission_version() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.my_permission_version() TO authenticated;

-- 4. Administrator access preview (no operational data) -------------------
CREATE OR REPLACE FUNCTION public.neo_simulate_access(_user uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  org uuid := public.current_org_id();
  result jsonb;
BEGIN
  IF org IS NULL OR NOT public.has_permission('administration', 'workspace', 'edit') THEN
    RAISE EXCEPTION 'Not permitted to preview access';
  END IF;

  SELECT jsonb_build_object(
    'user_id', p.id,
    'full_name', p.full_name,
    'account_type', coalesce(p.account_type, 'staff'),
    'account_status', p.account_status,
    'organization_id', p.organization_id,
    'branch_ids', coalesce((
      SELECT jsonb_agg(DISTINCT b.branch_id) FROM public.employee_branch_assignments b
       WHERE b.organization_id = org AND b.profile_id = p.id), '[]'::jsonb),
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
$$;

REVOKE EXECUTE ON FUNCTION public.neo_simulate_access(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.neo_simulate_access(uuid) TO authenticated;

-- 5. Purge stale snapshots so every user rebuilds on next sign-in ---------
DELETE FROM public.user_access_snapshots;