CREATE OR REPLACE FUNCTION public.neo_apply_reporting_rule()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _profile public.profiles;
  _roles uuid[];
  _manager uuid;
  _actor text;
BEGIN
  SELECT * INTO _profile FROM public.profiles WHERE id = NEW.user_id;
  IF _profile.id IS NULL OR _profile.account_type <> 'staff' THEN
    RETURN NEW;
  END IF;

  SELECT COALESCE(array_agg(ur.role_id), '{}') INTO _roles
    FROM public.user_roles ur WHERE ur.user_id = NEW.user_id;

  IF _profile.reporting_manager_id IS NOT NULL AND EXISTS (
       SELECT 1 FROM public.neo_reporting_candidate_rows(
         _profile.organization_id, NEW.user_id, _profile.branch_id, _roles) c
        WHERE c.profile_id = _profile.reporting_manager_id
     ) THEN
    RETURN NEW;
  END IF;

  SELECT c.profile_id INTO _manager
    FROM public.neo_reporting_candidate_rows(
      _profile.organization_id, NEW.user_id, _profile.branch_id, _roles) c
   ORDER BY CASE WHEN c.property_match = 'property' THEN 0 ELSE 1 END,
            c.management_level DESC,
            c.full_name
   LIMIT 1;

  IF _manager IS NULL OR _manager IS NOT DISTINCT FROM _profile.reporting_manager_id THEN
    RETURN NEW;
  END IF;

  UPDATE public.profiles
     SET reporting_manager_id = _manager, updated_at = now()
   WHERE id = NEW.user_id;

  SELECT COALESCE(full_name, 'System') INTO _actor FROM public.profiles WHERE id = auth.uid();

  INSERT INTO public.audit_logs (organization_id, branch_id, department_id, user_id, user_name,
    action, module, record_id, previous_value, new_value, reason)
  VALUES (_profile.organization_id, _profile.branch_id, _profile.department_id, auth.uid(),
    COALESCE(_actor, 'System'), 'users.reporting_line.auto_assign', 'administration',
    NEW.user_id::text,
    jsonb_build_object('reporting_manager_id', _profile.reporting_manager_id),
    jsonb_build_object('reporting_manager_id', _manager),
    'Applied the standing reporting rule for the granted role');

  RETURN NEW;
END;
$$;

DO $$
DECLARE
  r record;
  _roles uuid[];
  _manager uuid;
BEGIN
  FOR r IN
    SELECT p.id, p.organization_id, p.branch_id, p.department_id, p.reporting_manager_id
      FROM public.profiles p
     WHERE p.account_type = 'staff' AND p.account_status = 'active'
  LOOP
    SELECT COALESCE(array_agg(ur.role_id), '{}') INTO _roles
      FROM public.user_roles ur WHERE ur.user_id = r.id;

    IF r.reporting_manager_id IS NOT NULL AND EXISTS (
      SELECT 1 FROM public.neo_reporting_candidate_rows(r.organization_id, r.id, r.branch_id, _roles) c
       WHERE c.profile_id = r.reporting_manager_id
    ) THEN
      CONTINUE;
    END IF;

    SELECT c.profile_id INTO _manager
      FROM public.neo_reporting_candidate_rows(r.organization_id, r.id, r.branch_id, _roles) c
     ORDER BY CASE WHEN c.property_match = 'property' THEN 0 ELSE 1 END,
              c.management_level DESC, c.full_name
     LIMIT 1;

    IF _manager IS NULL OR _manager IS NOT DISTINCT FROM r.reporting_manager_id THEN
      CONTINUE;
    END IF;

    UPDATE public.profiles
       SET reporting_manager_id = _manager, updated_at = now()
     WHERE id = r.id;

    INSERT INTO public.audit_logs (organization_id, branch_id, department_id, user_name,
      action, module, record_id, previous_value, new_value, reason)
    VALUES (r.organization_id, r.branch_id, r.department_id, 'System',
      'users.reporting_line.auto_assign', 'administration', r.id::text,
      jsonb_build_object('reporting_manager_id', r.reporting_manager_id),
      jsonb_build_object('reporting_manager_id', _manager),
      'Backfilled by the standing reporting rule');
  END LOOP;
END $$;