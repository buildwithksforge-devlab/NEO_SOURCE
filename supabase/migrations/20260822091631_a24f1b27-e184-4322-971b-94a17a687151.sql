-- 1. Canonical capability -------------------------------------------------
INSERT INTO public.permissions (module, feature, action, label)
SELECT 'administration', 'users', 'assign_owner', 'Assign the hotel Owner role'
WHERE NOT EXISTS (
  SELECT 1 FROM public.permissions
   WHERE module='administration' AND feature='users' AND action='assign_owner');

-- Granted to the Owner and the IT/System Administrator in every organisation.
INSERT INTO public.role_permissions (organization_id, role_id, permission_id, source)
SELECT r.organization_id, r.id, p.id, 'catalogue'
  FROM public.roles r
  CROSS JOIN public.permissions p
 WHERE p.module='administration' AND p.feature='users' AND p.action='assign_owner'
   AND r.active
   AND COALESCE(r.role_status,'active') <> 'archived'
   AND r.normalized_role_key IN ('owner','it-system-administrator')
   AND NOT EXISTS (SELECT 1 FROM public.role_permissions rp
                    WHERE rp.role_id = r.id AND rp.permission_id = p.id);

-- 2. Capability-based Owner guard (no role-name authorisation) --------------
CREATE OR REPLACE FUNCTION public.neo_guard_owner_grant()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE _key text;
BEGIN
  SELECT COALESCE(r.normalized_role_key, public.neo_norm_key(r.name))
    INTO _key FROM public.roles r WHERE r.id = NEW.role_id;
  IF _key IS DISTINCT FROM 'owner' THEN RETURN NEW; END IF;
  IF COALESCE(current_setting('neo.internal', true), '') = 'on' THEN RETURN NEW; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.user_roles ur WHERE ur.organization_id = NEW.organization_id) THEN
    RETURN NEW; -- first assignment in a brand-new workspace (its creator)
  END IF;
  IF auth.uid() IS NOT NULL
     AND public.has_permission('administration','users','assign_owner') THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'Assigning the Owner role requires the Assign Owner permission.';
END;
$function$;

-- 3. Organisation-scoped staff identifier allocator -------------------------
CREATE OR REPLACE FUNCTION public.neo_allocate_staff_id(_org uuid)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE _n integer; _candidate text;
BEGIN
  LOOP
    SELECT COALESCE(MAX((regexp_replace(staff_id, '^STF-A-', ''))::int), 0) + 1
      INTO _n
      FROM public.profiles
     WHERE organization_id = _org
       AND staff_id ~ '^STF-A-[0-9]+$';
    _candidate := 'STF-A-' || lpad(_n::text, 3, '0');
    EXIT WHEN NOT EXISTS (
      SELECT 1 FROM public.profiles
       WHERE organization_id = _org AND staff_id = _candidate);
  END LOOP;
  RETURN _candidate;
END;
$function$;

-- 4. Deliberate Owner assignment -------------------------------------------
CREATE OR REPLACE FUNCTION public.neo_assign_owner_role(_target uuid, _reason text, _idempotency_key text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  _caller uuid := auth.uid();
  _org uuid := public.current_org_id();
  _t public.profiles;
  _owner_role uuid;
  _before jsonb;
  _after jsonb;
  _staff text;
  _idem text := NULLIF(trim(COALESCE(_idempotency_key,'')), '');
BEGIN
  IF _caller IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  IF NOT public.has_permission('administration','users','assign_owner') THEN
    RAISE EXCEPTION 'You do not hold the Assign Owner permission.';
  END IF;
  IF COALESCE(trim(_reason),'') = '' THEN
    RAISE EXCEPTION 'A reason is required to assign the Owner role.';
  END IF;

  SELECT * INTO _t FROM public.profiles WHERE id = _target;
  IF _t.id IS NULL THEN RAISE EXCEPTION 'That account does not exist.'; END IF;
  IF _t.organization_id IS DISTINCT FROM _org THEN
    RAISE EXCEPTION 'That account belongs to another organisation.';
  END IF;
  IF _t.account_type = 'platform_admin' THEN
    RAISE EXCEPTION 'A platform administrator is not part of the hotel employee catalogue.';
  END IF;

  SELECT r.id INTO _owner_role
    FROM public.roles r
   WHERE r.organization_id = _org
     AND COALESCE(r.normalized_role_key, public.neo_norm_key(r.name)) = 'owner'
     AND r.active AND COALESCE(r.role_status,'active') <> 'archived'
   ORDER BY r.created_at
   LIMIT 1;
  IF _owner_role IS NULL THEN
    RAISE EXCEPTION 'This organisation has no canonical Owner role to assign.';
  END IF;

  -- Idempotent: a repeated confirmation is a no-op, never a duplicate role.
  IF EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = _target AND role_id = _owner_role) THEN
    RETURN jsonb_build_object('ok', true, 'changed', false, 'role_id', _owner_role,
                              'staff_id', _t.staff_id);
  END IF;

  _before := jsonb_build_object(
    'staff_id', _t.staff_id,
    'job_title', _t.job_title,
    'roles', (SELECT COALESCE(jsonb_agg(r.name ORDER BY r.name), '[]'::jsonb)
                FROM public.user_roles ur JOIN public.roles r ON r.id = ur.role_id
               WHERE ur.user_id = _target));

  PERFORM set_config('neo.internal', 'on', true);
  INSERT INTO public.user_roles (organization_id, user_id, role_id, is_primary)
  VALUES (_org, _target, _owner_role, true)
  ON CONFLICT DO NOTHING;
  -- Owner is the senior assignment; other roles stay, but stop being primary.
  UPDATE public.user_roles SET is_primary = false
   WHERE user_id = _target AND role_id <> _owner_role;
  PERFORM set_config('neo.internal', 'off', true);

  _staff := _t.staff_id;
  IF COALESCE(trim(_staff),'') = '' THEN
    _staff := public.neo_allocate_staff_id(_org);
    UPDATE public.profiles SET staff_id = _staff WHERE id = _target;
  END IF;

  _after := jsonb_build_object(
    'staff_id', _staff,
    'job_title', _t.job_title,
    'roles', (SELECT COALESCE(jsonb_agg(r.name ORDER BY r.name), '[]'::jsonb)
                FROM public.user_roles ur JOIN public.roles r ON r.id = ur.role_id
               WHERE ur.user_id = _target));

  INSERT INTO public.audit_logs (organization_id, user_id, action, module, record_id,
                                 previous_value, new_value, reason)
  VALUES (_org, _caller, 'user.assign_owner', 'administration', _target::text,
          _before, _after, COALESCE(_idem || ' — ', '') || _reason);

  PERFORM public.neo_bump_access_epoch(_org);
  RETURN jsonb_build_object('ok', true, 'changed', true, 'role_id', _owner_role, 'staff_id', _staff);
END;
$function$;

-- 5. Guarded Owner removal --------------------------------------------------
CREATE OR REPLACE FUNCTION public.neo_remove_owner_role(_target uuid, _reason text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  _caller uuid := auth.uid();
  _org uuid := public.current_org_id();
  _owner_role uuid;
  _remaining int;
BEGIN
  IF _caller IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  IF NOT public.has_permission('administration','users','assign_owner') THEN
    RAISE EXCEPTION 'You do not hold the Assign Owner permission.';
  END IF;
  IF COALESCE(trim(_reason),'') = '' THEN
    RAISE EXCEPTION 'A reason is required to remove the Owner role.';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.profiles WHERE id = _target AND organization_id = _org) THEN
    RAISE EXCEPTION 'That account belongs to another organisation.';
  END IF;

  SELECT r.id INTO _owner_role
    FROM public.roles r
   WHERE r.organization_id = _org
     AND COALESCE(r.normalized_role_key, public.neo_norm_key(r.name)) = 'owner'
   ORDER BY r.created_at LIMIT 1;
  IF _owner_role IS NULL THEN RETURN jsonb_build_object('ok', true, 'changed', false); END IF;

  SELECT count(*) INTO _remaining
    FROM public.user_roles ur
    JOIN public.profiles p ON p.id = ur.user_id
   WHERE ur.role_id = _owner_role AND ur.user_id <> _target
     AND p.account_status = 'active';
  IF _remaining = 0 THEN
    RAISE EXCEPTION 'The last active Owner cannot be removed without a confirmed replacement.';
  END IF;

  DELETE FROM public.user_roles WHERE user_id = _target AND role_id = _owner_role;

  INSERT INTO public.audit_logs (organization_id, user_id, action, module, record_id,
                                 previous_value, new_value, reason)
  VALUES (_org, _caller, 'user.remove_owner', 'administration', _target::text,
          jsonb_build_object('owner', true), jsonb_build_object('owner', false), _reason);

  PERFORM public.neo_bump_access_epoch(_org);
  RETURN jsonb_build_object('ok', true, 'changed', true);
END;
$function$;

REVOKE ALL ON FUNCTION public.neo_allocate_staff_id(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.neo_assign_owner_role(uuid, text, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.neo_remove_owner_role(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.neo_allocate_staff_id(uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.neo_assign_owner_role(uuid, text, text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.neo_remove_owner_role(uuid, text) TO authenticated, service_role;