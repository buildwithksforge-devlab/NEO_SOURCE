
CREATE OR REPLACE FUNCTION public.neo_create_workspace(_payload jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  _uid uuid := auth.uid();
  _org uuid;
  _branch uuid;
  _existing uuid;
  _run uuid;
  _name text := COALESCE(NULLIF(trim(_payload->>'business_name'), ''), 'My Hospitality Group');
  _full text := COALESCE(NULLIF(trim(_payload->>'admin_full_name'), ''), 'Workspace Administrator');
  _role text := COALESCE(NULLIF(trim(_payload->>'business_role'), ''), 'Owner/Director');
  _role_key text := NULLIF(trim(_payload->>'admin_role_key'), '');
  _cat public.role_catalogue;
  _role_id uuid;
  _dept_id uuid;
BEGIN
  IF _uid IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;

  SELECT organization_id INTO _existing FROM public.profiles WHERE id = _uid;
  IF _existing IS NOT NULL THEN
    RETURN jsonb_build_object('organization_id', _existing, 'created', false);
  END IF;

  INSERT INTO public.provisioning_runs (kind, idempotency_key, payload, created_by)
  VALUES ('workspace', 'workspace:' || _uid::text, _payload, _uid)
  ON CONFLICT (kind, idempotency_key) DO UPDATE
    SET attempts = public.provisioning_runs.attempts + 1, status = 'running',
        failure_reason = NULL, updated_at = now()
  RETURNING id INTO _run;

  _org := public.bootstrap_tenant(_name, _full);
  PERFORM public.neo_provisioning_step(_run, 'organization');

  UPDATE public.organizations
     SET legal_name = COALESCE(NULLIF(trim(_payload->>'legal_name'), ''), _name),
         name = COALESCE(NULLIF(trim(_payload->>'trading_name'), ''), _name),
         business_type = COALESCE(NULLIF(trim(_payload->>'business_type'), ''), business_type),
         updated_at = now()
   WHERE id = _org;

  SELECT id INTO _branch FROM public.branches
   WHERE organization_id = _org AND is_main ORDER BY created_at LIMIT 1;

  IF _branch IS NOT NULL THEN
    UPDATE public.branches
       SET name = COALESCE(NULLIF(trim(_payload->>'property_name'), ''), name),
           code = COALESCE(NULLIF(upper(trim(_payload->>'property_code')), ''), code),
           address = COALESCE(NULLIF(trim(_payload->>'property_address'), ''), address),
           phone = COALESCE(NULLIF(trim(_payload->>'property_phone'), ''), phone),
           email = COALESCE(NULLIF(trim(_payload->>'property_email'), ''), email),
           updated_at = now()
     WHERE id = _branch;
  END IF;
  PERFORM public.neo_provisioning_step(_run, 'property');

  UPDATE public.profiles
     SET full_name = _full,
         phone = COALESCE(NULLIF(trim(_payload->>'admin_phone'), ''), phone),
         job_title = _role,
         account_type = 'staff',
         updated_at = now()
   WHERE id = _uid;

  INSERT INTO public.system_settings (organization_id, settings)
  VALUES (_org, jsonb_build_object(
    'country', _payload->>'country',
    'currency', _payload->>'currency',
    'timezone', _payload->>'timezone',
    'language', _payload->>'language',
    'business_phone', _payload->>'business_phone',
    'business_email', _payload->>'business_email',
    'property_count', _payload->>'property_count',
    'property_city', _payload->>'property_city',
    'property_country', _payload->>'property_country'
  ))
  ON CONFLICT (organization_id) DO UPDATE
    SET settings = public.system_settings.settings || EXCLUDED.settings,
        updated_at = now();
  PERFORM public.neo_provisioning_step(_run, 'settings');

  BEGIN
    PERFORM set_config('neo.internal', 'on', true);
    PERFORM public.neo_adopt_modern_model(_org, 'provisioning');
    PERFORM set_config('neo.internal', '', true);
  EXCEPTION WHEN OTHERS THEN
    PERFORM set_config('neo.internal', '', true);
  END;
  PERFORM public.neo_provisioning_step(_run, 'catalogue');

  -- The creator receives exactly the administrative role they selected.
  -- Owner is never granted merely because somebody created the workspace.
  IF _role_key IS NULL THEN
    _role_key := CASE lower(_role)
      WHEN 'owner/director' THEN 'owner'
      WHEN 'general manager' THEN 'operations-manager'
      WHEN 'authorised system administrator' THEN 'it-system-administrator'
      ELSE public.neo_norm_key(_role)
    END;
  END IF;

  SELECT * INTO _cat FROM public.role_catalogue WHERE role_key = _role_key;

  SELECT id INTO _role_id FROM public.roles
   WHERE organization_id = _org
     AND COALESCE(role_status,'active') <> 'archived' AND active
     AND (normalized_role_key = _role_key OR public.neo_norm_key(name) = _role_key)
   ORDER BY created_at LIMIT 1;

  IF _role_id IS NOT NULL THEN
    DELETE FROM public.user_roles WHERE organization_id = _org AND user_id = _uid;
    INSERT INTO public.user_roles (organization_id, user_id, role_id, is_primary)
    VALUES (_org, _uid, _role_id, true) ON CONFLICT DO NOTHING;

    IF _cat.role_name IS NOT NULL THEN
      SELECT id INTO _dept_id FROM public.departments
       WHERE organization_id = _org
         AND (catalogue_key = public.neo_norm_key(_cat.department)
              OR public.neo_norm_key(name) = public.neo_norm_key(_cat.department))
       ORDER BY created_at LIMIT 1;

      UPDATE public.profiles SET job_title = _cat.role_name,
             department_id = COALESCE(_dept_id, department_id), updated_at = now()
       WHERE id = _uid;

      IF _dept_id IS NOT NULL THEN
        DELETE FROM public.user_departments WHERE organization_id = _org AND user_id = _uid;
        INSERT INTO public.user_departments (organization_id, user_id, department_id)
        VALUES (_org, _uid, _dept_id) ON CONFLICT DO NOTHING;
      END IF;
    END IF;
  END IF;
  PERFORM public.neo_provisioning_step(_run, 'administrator');

  INSERT INTO public.audit_logs (organization_id, branch_id, user_id, user_name, action, module, record_id, new_value)
  VALUES (_org, _branch, _uid, _full, 'workspace.created', 'administration', _org,
          jsonb_build_object('business_role', _role, 'admin_role_key', _role_key, 'business_name', _name));

  UPDATE public.provisioning_runs
     SET organization_id = _org, subject_id = _uid, status = 'ready', current_step = 'ready',
         completed_at = now(), updated_at = now(),
         steps = CASE WHEN steps ? 'ready' THEN steps ELSE steps || to_jsonb('ready'::text) END
   WHERE id = _run;

  RETURN jsonb_build_object('organization_id', _org, 'branch_id', _branch, 'created', true,
                            'admin_role_key', _role_key);
EXCEPTION WHEN OTHERS THEN
  IF _run IS NOT NULL THEN
    UPDATE public.provisioning_runs SET status='failed', failure_reason=SQLERRM, updated_at=now()
     WHERE id = _run;
  END IF;
  RAISE;
END;
$function$;
