-- HR owns the official staff identity: photo AND mobile number.
-- The account holder may not change either on a staff account; an authorised
-- manager may, and every change is audited and mirrored to the HR record.

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
    -- The official staff photo and mobile number belong to the HR record, not
    -- to the account holder: only an authorised manager may change them.
    IF coalesce(OLD.account_type,'staff') = 'staff' AND NOT public.can_manage_staff_photos() THEN
      NEW.avatar_url := OLD.avatar_url;
      NEW.phone      := OLD.phone;
    END IF;
  END IF;
  RETURN NEW;
END; $$;

CREATE OR REPLACE FUNCTION public.guard_staff_photo_change()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  _photo_changed boolean := NEW.avatar_url IS DISTINCT FROM OLD.avatar_url;
  _phone_changed boolean := NEW.phone IS DISTINCT FROM OLD.phone;
BEGIN
  IF NOT (_photo_changed OR _phone_changed) THEN
    RETURN NEW;
  END IF;

  IF coalesce(NEW.account_type,'staff') = 'staff'
     AND NEW.id <> coalesce(auth.uid(), NEW.id)
     AND NOT public.can_manage_staff_photos() THEN
    RAISE EXCEPTION 'Changing another staff member''s official photo or mobile number requires the HR staff-identity permission';
  END IF;

  INSERT INTO public.audit_logs(organization_id, branch_id, user_id, action, module, record_id,
                                previous_value, new_value)
  VALUES (NEW.organization_id, NEW.branch_id, auth.uid(),
          CASE WHEN _photo_changed AND _phone_changed THEN 'hr.staff_identity.changed'
               WHEN _photo_changed THEN 'hr.staff_photo.changed'
               ELSE 'hr.staff_phone.changed' END,
          'human-resources', NEW.id,
          jsonb_build_object('avatar_url', OLD.avatar_url, 'phone', OLD.phone),
          jsonb_build_object('avatar_url', NEW.avatar_url, 'phone', NEW.phone,
                             'target_staff', NEW.id, 'account_type', NEW.account_type));

  -- The HR record mirrors the canonical profile identity; it is never a second
  -- source of truth.
  UPDATE public.employees e
     SET avatar_url = NEW.avatar_url,
         phone      = coalesce(NEW.phone, e.phone),
         updated_at = now()
   WHERE e.profile_id = NEW.id
     AND (e.avatar_url IS DISTINCT FROM NEW.avatar_url OR e.phone IS DISTINCT FROM NEW.phone);

  RETURN NEW;
END; $$;

DROP TRIGGER IF EXISTS trg_guard_staff_photo_change ON public.profiles;
CREATE TRIGGER trg_guard_staff_photo_change
BEFORE UPDATE OF avatar_url, phone ON public.profiles
FOR EACH ROW EXECUTE FUNCTION public.guard_staff_photo_change();

-- HR-side edits flow back to the canonical account so Users, avatars and
-- directories show the same number without a second entry point.
CREATE OR REPLACE FUNCTION public.neo_employee_identity_mirror()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NEW.profile_id IS NOT NULL
     AND (NEW.phone IS DISTINCT FROM OLD.phone OR NEW.avatar_url IS DISTINCT FROM OLD.avatar_url) THEN
    UPDATE public.profiles p
       SET phone      = coalesce(NEW.phone, p.phone),
           avatar_url = coalesce(NEW.avatar_url, p.avatar_url),
           updated_at = now()
     WHERE p.id = NEW.profile_id
       AND (p.phone IS DISTINCT FROM coalesce(NEW.phone, p.phone)
            OR p.avatar_url IS DISTINCT FROM coalesce(NEW.avatar_url, p.avatar_url));
  END IF;
  RETURN NEW;
END; $$;

DROP TRIGGER IF EXISTS trg_employee_identity_mirror ON public.employees;
CREATE TRIGGER trg_employee_identity_mirror
AFTER UPDATE OF phone, avatar_url ON public.employees
FOR EACH ROW EXECUTE FUNCTION public.neo_employee_identity_mirror();

-- One HR action for the official photo and mobile number together.
CREATE OR REPLACE FUNCTION public.neo_hr_set_staff_identity(
  _profile uuid DEFAULT NULL,
  _employee uuid DEFAULT NULL,
  _path text DEFAULT NULL,
  _phone text DEFAULT NULL,
  _set_photo boolean DEFAULT true,
  _set_phone boolean DEFAULT true
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  _org uuid := public.current_org_id();
  _target uuid := _profile;
  _emp public.employees;
  _prev_photo text;
  _prev_phone text;
  _photo text := nullif(btrim(coalesce(_path,'')),'');
  _tel text := nullif(btrim(coalesce(_phone,'')),'');
BEGIN
  IF NOT public.can_manage_staff_photos() THEN
    RAISE EXCEPTION 'You are not permitted to manage official staff identity details';
  END IF;

  IF _employee IS NOT NULL THEN
    SELECT * INTO _emp FROM public.employees WHERE id = _employee AND organization_id = _org;
    IF _emp.id IS NULL THEN RAISE EXCEPTION 'Employee record not found'; END IF;
    _target := coalesce(_target, _emp.profile_id);
  END IF;

  IF _target IS NULL AND _emp.id IS NULL THEN
    RAISE EXCEPTION 'Select the staff member whose details are being changed';
  END IF;

  IF _target IS NOT NULL THEN
    SELECT avatar_url, phone INTO _prev_photo, _prev_phone
      FROM public.profiles WHERE id = _target AND organization_id = _org;
    IF NOT FOUND THEN RAISE EXCEPTION 'That staff account is not in your organisation'; END IF;
    UPDATE public.profiles
       SET avatar_url = CASE WHEN _set_photo THEN _photo ELSE avatar_url END,
           phone      = CASE WHEN _set_phone THEN coalesce(_tel, phone) ELSE phone END,
           updated_at = now()
     WHERE id = _target AND organization_id = _org;
  END IF;

  IF _emp.id IS NOT NULL THEN
    _prev_photo := coalesce(_prev_photo, _emp.avatar_url);
    _prev_phone := coalesce(_prev_phone, _emp.phone);
    UPDATE public.employees
       SET avatar_url = CASE WHEN _set_photo THEN _photo ELSE avatar_url END,
           phone      = CASE WHEN _set_phone THEN coalesce(_tel, phone) ELSE phone END,
           updated_at = now()
     WHERE id = _emp.id;
    IF _target IS NULL THEN
      INSERT INTO public.audit_logs(organization_id, branch_id, user_id, action, module, record_id,
                                    previous_value, new_value)
      VALUES (_org, _emp.branch_id, auth.uid(), 'hr.staff_identity.changed', 'human-resources', _emp.id,
              jsonb_build_object('avatar_url', _prev_photo, 'phone', _prev_phone),
              jsonb_build_object('avatar_url', _photo, 'phone', _tel, 'target_employee', _emp.id));
    END IF;
  END IF;

  RETURN jsonb_build_object('ok', true, 'profile_id', _target, 'employee_id', _emp.id,
                            'previous_path', _prev_photo, 'previous_phone', _prev_phone,
                            'avatar_url', _photo, 'phone', _tel);
END; $$;

REVOKE ALL ON FUNCTION public.neo_hr_set_staff_identity(uuid,uuid,text,text,boolean,boolean) FROM anon, PUBLIC;
GRANT EXECUTE ON FUNCTION public.neo_hr_set_staff_identity(uuid,uuid,text,text,boolean,boolean) TO authenticated;
REVOKE ALL ON FUNCTION public.neo_employee_identity_mirror() FROM anon, PUBLIC;
REVOKE ALL ON FUNCTION public.guard_staff_photo_change() FROM anon, PUBLIC;
REVOKE ALL ON FUNCTION public.enforce_profile_self_update() FROM anon, PUBLIC;