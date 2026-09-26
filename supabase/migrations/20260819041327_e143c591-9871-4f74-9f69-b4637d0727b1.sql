-- Group 2 / Stages 4-8: access hardening (additive, non-destructive)

-- 1. Active-staff gate: suspended / inactive accounts and customer accounts
--    can never resolve a staff permission, regardless of role grants.
CREATE OR REPLACE FUNCTION public.is_active_staff()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  SELECT EXISTS (
    SELECT 1 FROM public.profiles p
    WHERE p.id = auth.uid()
      AND coalesce(p.account_type, 'staff') = 'staff'
      AND coalesce(p.account_status, 'active') = 'active'
      AND p.organization_id = public.current_org_id()
  );
$function$;

CREATE OR REPLACE FUNCTION public.is_org_admin()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  SELECT public.is_active_staff() AND EXISTS (
    SELECT 1 FROM public.user_roles ur
    JOIN public.roles r ON r.id = ur.role_id
    WHERE ur.user_id = auth.uid()
      AND r.name IN ('Owner', 'System Administrator')
      AND ur.organization_id = public.current_org_id()
      AND r.organization_id = public.current_org_id()
  );
$function$;

CREATE OR REPLACE FUNCTION public.has_permission(_module text, _feature text, _action text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  SELECT CASE
    WHEN NOT public.is_active_staff() THEN false
    WHEN EXISTS (
      SELECT 1 FROM public.user_permissions up
      JOIN public.permissions p ON p.id = up.permission_id
      WHERE up.user_id = auth.uid() AND up.effect = 'deny'
        AND p.module = _module AND p.action = _action
        AND p.feature IN (_feature, '*')
        AND up.organization_id = public.current_org_id()
    ) THEN false
    WHEN public.is_org_admin() THEN true
    ELSE EXISTS (
      SELECT 1 FROM public.user_roles ur
      JOIN public.roles r ON r.id = ur.role_id AND r.active
      JOIN public.role_permissions rp ON rp.role_id = r.id
      JOIN public.permissions p ON p.id = rp.permission_id
      WHERE ur.user_id = auth.uid()
        AND p.module = _module AND p.action = _action
        AND p.feature IN (_feature, '*')
        AND ur.organization_id = public.current_org_id()
        AND r.organization_id = public.current_org_id()
        AND rp.organization_id = public.current_org_id()
    ) OR EXISTS (
      SELECT 1 FROM public.user_permissions up
      JOIN public.permissions p ON p.id = up.permission_id
      WHERE up.user_id = auth.uid() AND up.effect = 'grant'
        AND p.module = _module AND p.action = _action
        AND p.feature IN (_feature, '*')
        AND up.organization_id = public.current_org_id()
    )
  END;
$function$;

CREATE OR REPLACE FUNCTION public.has_permission(_module text, _action text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$ SELECT public.has_permission(_module, '*', _action) $function$;

-- 2. Transactional, audited role permission save. Only the listed role is
--    touched, and only inside the caller's organization.
CREATE OR REPLACE FUNCTION public.set_role_permissions(_role uuid, _permission_ids uuid[])
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  _org uuid := public.current_org_id();
  _role_row public.roles;
  _added int := 0;
  _removed int := 0;
  _added_keys text[];
  _removed_keys text[];
BEGIN
  IF _org IS NULL OR NOT public.is_org_admin() THEN
    RAISE EXCEPTION 'Not authorised to change role permissions';
  END IF;

  SELECT * INTO _role_row FROM public.roles WHERE id = _role AND organization_id = _org;
  IF _role_row.id IS NULL THEN
    RAISE EXCEPTION 'Role not found in the active organization';
  END IF;

  -- Reject permission ids that do not exist (never silently drop a selection).
  IF EXISTS (
    SELECT 1 FROM unnest(coalesce(_permission_ids, '{}'::uuid[])) pid
    WHERE NOT EXISTS (SELECT 1 FROM public.permissions p WHERE p.id = pid)
  ) THEN
    RAISE EXCEPTION 'Unknown permission in selection';
  END IF;

  SELECT array_agg(p.module || '.' || p.feature || '.' || p.action)
    INTO _removed_keys
  FROM public.role_permissions rp
  JOIN public.permissions p ON p.id = rp.permission_id
  WHERE rp.role_id = _role AND rp.organization_id = _org
    AND NOT (rp.permission_id = ANY (coalesce(_permission_ids, '{}'::uuid[])));

  DELETE FROM public.role_permissions rp
  WHERE rp.role_id = _role AND rp.organization_id = _org
    AND NOT (rp.permission_id = ANY (coalesce(_permission_ids, '{}'::uuid[])));
  GET DIAGNOSTICS _removed = ROW_COUNT;

  SELECT array_agg(p.module || '.' || p.feature || '.' || p.action)
    INTO _added_keys
  FROM unnest(coalesce(_permission_ids, '{}'::uuid[])) pid
  JOIN public.permissions p ON p.id = pid
  WHERE NOT EXISTS (
    SELECT 1 FROM public.role_permissions rp
    WHERE rp.role_id = _role AND rp.permission_id = pid AND rp.organization_id = _org
  );

  INSERT INTO public.role_permissions (organization_id, role_id, permission_id)
  SELECT _org, _role, pid FROM unnest(coalesce(_permission_ids, '{}'::uuid[])) pid
  ON CONFLICT DO NOTHING;
  GET DIAGNOSTICS _added = ROW_COUNT;

  IF _added > 0 OR _removed > 0 THEN
    INSERT INTO public.audit_logs (organization_id, user_id, user_name, action, module, record_id, previous_value, new_value)
    SELECT _org, auth.uid(), coalesce(pr.full_name, ''), 'role.permissions.updated', 'administration',
           _role::text,
           jsonb_build_object('removed', coalesce(to_jsonb(_removed_keys), '[]'::jsonb)),
           jsonb_build_object('added', coalesce(to_jsonb(_added_keys), '[]'::jsonb), 'role', _role_row.name)
    FROM (SELECT full_name FROM public.profiles WHERE id = auth.uid()) pr;
  END IF;

  RETURN jsonb_build_object('added', _added, 'removed', _removed, 'role_id', _role);
END;
$function$;

-- 3. Safety net: audit every direct role_permissions change too.
CREATE OR REPLACE FUNCTION public.audit_role_permission_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE _row public.role_permissions := coalesce(NEW, OLD);
BEGIN
  INSERT INTO public.audit_logs (organization_id, user_id, user_name, action, module, record_id, new_value)
  VALUES (_row.organization_id, auth.uid(),
          coalesce((SELECT full_name FROM public.profiles WHERE id = auth.uid()), ''),
          CASE WHEN TG_OP = 'INSERT' THEN 'role.permission.granted' ELSE 'role.permission.revoked' END,
          'administration', _row.role_id::text,
          jsonb_build_object('permission_id', _row.permission_id));
  RETURN _row;
END;
$function$;

DROP TRIGGER IF EXISTS role_permissions_audit ON public.role_permissions;
CREATE TRIGGER role_permissions_audit
AFTER INSERT OR DELETE ON public.role_permissions
FOR EACH ROW EXECUTE FUNCTION public.audit_role_permission_change();

REVOKE ALL ON FUNCTION public.is_active_staff() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.set_role_permissions(uuid, uuid[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.is_active_staff() TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.set_role_permissions(uuid, uuid[]) TO authenticated, service_role;