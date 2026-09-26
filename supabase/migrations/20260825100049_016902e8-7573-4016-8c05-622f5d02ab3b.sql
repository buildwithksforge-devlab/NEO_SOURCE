-- 1. Capability -------------------------------------------------------------
INSERT INTO public.permissions(module, feature, action, label)
SELECT 'human-resources','staff-photos','manage','Manage official staff photos'
WHERE NOT EXISTS (
  SELECT 1 FROM public.permissions
   WHERE module='human-resources' AND feature='staff-photos' AND action='manage'
);

INSERT INTO public.role_feature_templates(role_key, module, feature, action)
SELECT k, 'human-resources','staff-photos','manage'
  FROM unnest(ARRAY['owner','human-resources-manager','human resources','hr-officer','it-system-administrator','system administrator']) AS k
 WHERE NOT EXISTS (
   SELECT 1 FROM public.role_feature_templates t
    WHERE t.role_key = k AND t.module='human-resources' AND t.feature='staff-photos' AND t.action='manage'
 );

INSERT INTO public.role_permissions(organization_id, role_id, permission_id, source)
SELECT r.organization_id, r.id, p.id, 'catalogue'
  FROM public.roles r
  CROSS JOIN LATERAL (
    SELECT id FROM public.permissions
     WHERE module='human-resources' AND feature='staff-photos' AND action='manage' LIMIT 1
  ) p
 WHERE r.active
   AND lower(coalesce(r.normalized_role_key, r.name)) IN
       ('owner','human-resources-manager','human resources','hr-officer','it-system-administrator','system administrator','human-resources','system-administrator')
   AND NOT EXISTS (
     SELECT 1 FROM public.role_permissions rp
      WHERE rp.role_id = r.id AND rp.permission_id = p.id
   );

CREATE OR REPLACE FUNCTION public.can_manage_staff_photos()
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT public.has_exact_permission('human-resources','staff-photos','manage')
      OR public.is_org_admin();
$$;
REVOKE ALL ON FUNCTION public.can_manage_staff_photos() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.can_manage_staff_photos() TO authenticated;

-- 2. Self-service may no longer replace an official staff photo --------------
CREATE OR REPLACE FUNCTION public.enforce_profile_self_update()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NEW.id = auth.uid() AND NOT public.is_org_admin() THEN
    NEW.organization_id     := OLD.organization_id;
    NEW.account_type        := OLD.account_type;
    NEW.account_status      := OLD.account_status;
    NEW.employment_status   := OLD.employment_status;
    NEW.invitation_status   := OLD.invitation_status;
    NEW.branch_id           := OLD.branch_id;
    NEW.department_id       := OLD.department_id;
    NEW.job_title           := OLD.job_title;
    NEW.staff_id            := OLD.staff_id;
    NEW.created_by          := OLD.created_by;
    NEW.invited_by          := OLD.invited_by;
    NEW.invited_at          := OLD.invited_at;
    NEW.email               := OLD.email;
    NEW.locked_until        := OLD.locked_until;
    NEW.failed_login_count  := OLD.failed_login_count;
    -- The official staff photo belongs to the HR record, not to the account
    -- holder: only an authorised photo manager may change or remove it.
    IF coalesce(OLD.account_type,'staff') = 'staff' AND NOT public.can_manage_staff_photos() THEN
      NEW.avatar_url := OLD.avatar_url;
    END IF;
  END IF;
  RETURN NEW;
END; $$;

CREATE OR REPLACE FUNCTION public.guard_staff_photo_change()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NEW.avatar_url IS DISTINCT FROM OLD.avatar_url THEN
    IF NEW.id <> coalesce(auth.uid(), NEW.id)
       AND coalesce(NEW.account_type,'staff') = 'staff'
       AND NOT public.can_manage_staff_photos() THEN
      RAISE EXCEPTION 'Changing another staff member''s official photo requires the HR staff-photo permission';
    END IF;
    INSERT INTO public.audit_logs(organization_id, branch_id, user_id, action, module, record_id,
                                  previous_value, new_value)
    VALUES (NEW.organization_id, NEW.branch_id, auth.uid(),
            'hr.staff_photo.changed', 'human-resources', NEW.id,
            jsonb_build_object('avatar_url', OLD.avatar_url),
            jsonb_build_object('avatar_url', NEW.avatar_url, 'target_staff', NEW.id,
                               'account_type', NEW.account_type));
    -- The HR record mirrors the canonical profile photo; it is never a second
    -- source of truth.
    UPDATE public.employees e
       SET avatar_url = NEW.avatar_url, updated_at = now()
     WHERE e.profile_id = NEW.id AND e.avatar_url IS DISTINCT FROM NEW.avatar_url;
  END IF;
  RETURN NEW;
END; $$;

DROP TRIGGER IF EXISTS trg_guard_staff_photo_change ON public.profiles;
CREATE TRIGGER trg_guard_staff_photo_change
BEFORE UPDATE OF avatar_url ON public.profiles
FOR EACH ROW EXECUTE FUNCTION public.guard_staff_photo_change();

-- 3. Authorised managed upload -----------------------------------------------
CREATE OR REPLACE FUNCTION public.neo_hr_set_staff_photo(
  _profile uuid DEFAULT NULL,
  _employee uuid DEFAULT NULL,
  _path text DEFAULT NULL
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  _org uuid := public.current_org_id();
  _target uuid := _profile;
  _emp public.employees;
  _previous text;
BEGIN
  IF NOT public.can_manage_staff_photos() THEN
    RAISE EXCEPTION 'You are not permitted to manage official staff photos';
  END IF;

  IF _employee IS NOT NULL THEN
    SELECT * INTO _emp FROM public.employees WHERE id = _employee AND organization_id = _org;
    IF _emp.id IS NULL THEN RAISE EXCEPTION 'Employee record not found'; END IF;
    _target := coalesce(_target, _emp.profile_id);
  END IF;

  IF _target IS NULL AND _emp.id IS NULL THEN
    RAISE EXCEPTION 'Select the staff member whose photo is being changed';
  END IF;

  IF _target IS NOT NULL THEN
    SELECT avatar_url INTO _previous FROM public.profiles
     WHERE id = _target AND organization_id = _org;
    IF NOT FOUND THEN RAISE EXCEPTION 'That staff account is not in your organisation'; END IF;
    UPDATE public.profiles SET avatar_url = nullif(btrim(coalesce(_path,'')),''), updated_at = now()
     WHERE id = _target AND organization_id = _org;
  END IF;

  IF _emp.id IS NOT NULL THEN
    _previous := coalesce(_previous, _emp.avatar_url);
    UPDATE public.employees
       SET avatar_url = nullif(btrim(coalesce(_path,'')),''), updated_at = now()
     WHERE id = _emp.id;
    IF _target IS NULL THEN
      INSERT INTO public.audit_logs(organization_id, branch_id, user_id, action, module, record_id,
                                    previous_value, new_value)
      VALUES (_org, _emp.branch_id, auth.uid(), 'hr.staff_photo.changed', 'human-resources', _emp.id,
              jsonb_build_object('avatar_url', _previous),
              jsonb_build_object('avatar_url', _path, 'target_employee', _emp.id));
    END IF;
  END IF;

  RETURN jsonb_build_object('ok', true, 'profile_id', _target, 'employee_id', _emp.id,
                            'previous_path', _previous, 'avatar_url', _path);
END; $$;
REVOKE ALL ON FUNCTION public.neo_hr_set_staff_photo(uuid, uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.neo_hr_set_staff_photo(uuid, uuid, text) TO authenticated;

-- 4. Storage: an authorised manager may write into another staff folder ------
DROP POLICY IF EXISTS "Avatars: managed staff uploads" ON storage.objects;
CREATE POLICY "Avatars: managed staff uploads"
ON storage.objects FOR ALL TO authenticated
USING (
  bucket_id = 'avatars'
  AND public.can_manage_staff_photos()
  AND EXISTS (
    SELECT 1 FROM public.profiles p
     WHERE p.id::text = (storage.foldername(name))[1]
       AND p.organization_id = public.current_org_id()
  )
)
WITH CHECK (
  bucket_id = 'avatars'
  AND public.can_manage_staff_photos()
  AND EXISTS (
    SELECT 1 FROM public.profiles p
     WHERE p.id::text = (storage.foldername(name))[1]
       AND p.organization_id = public.current_org_id()
  )
);