CREATE OR REPLACE FUNCTION public.enforce_profile_self_update()
 RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
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
    -- A person may maintain their own photograph. The official mobile number
    -- still belongs to the HR record and only an authorised manager may set it.
    IF coalesce(OLD.account_type,'staff') = 'staff' AND NOT public.can_manage_staff_photos() THEN
      NEW.phone := OLD.phone;
    END IF;
  END IF;
  RETURN NEW;
END; $function$;
