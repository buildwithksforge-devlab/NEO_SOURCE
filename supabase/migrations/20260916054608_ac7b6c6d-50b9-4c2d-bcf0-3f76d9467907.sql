CREATE INDEX IF NOT EXISTS workspace_provisioning_attempts_user_created_idx
  ON public.workspace_provisioning_attempts (user_id, created_at DESC);

CREATE OR REPLACE FUNCTION public.neo_finalize_creator_workspace(_uid uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  a public.workspace_provisioning_attempts;
  payload jsonb;
  email_address text;
  org uuid;
  profile_org uuid;
  branch uuid;
  department uuid;
  owner_role uuid;
  workspace_name text;
  full_name text;
  was_created boolean := false;
  was_complete boolean := false;
  access_result jsonb;
BEGIN
  IF _uid IS NULL OR auth.uid() IS DISTINCT FROM _uid THEN
    RAISE EXCEPTION 'Authentication is required' USING ERRCODE = '42501';
  END IF;

  -- A second click must never wait behind a first provisioning transaction until
  -- statement_timeout. The first call owns the work; the second returns promptly.
  IF NOT pg_try_advisory_xact_lock(hashtextextended('neo-owner-bootstrap:' || _uid::text, 0)) THEN
    RAISE EXCEPTION 'Workspace setup is already in progress. Please try again shortly.' USING ERRCODE = '55P03';
  END IF;
  PERFORM set_config('lock_timeout', '2s', true);
  PERFORM set_config('neo.internal', 'on', true);

  SELECT lower(u.email) INTO email_address FROM auth.users u WHERE u.id = _uid;
  IF email_address IS NULL THEN
    RAISE EXCEPTION 'Authentication account not found' USING ERRCODE = '42501';
  END IF;

  SELECT x.* INTO a
    FROM public.workspace_provisioning_attempts x
   WHERE x.user_id = _uid
   ORDER BY (x.status IN ('completed','complete')) ASC, x.created_at DESC
   LIMIT 1
   FOR UPDATE;
  IF a.id IS NULL THEN
    RAISE EXCEPTION 'No creator-bound workspace attempt exists for this account' USING ERRCODE = '42501';
  END IF;
  was_complete := a.status IN ('completed','complete');

  payload := coalesce(a.payload, '{}'::jsonb);
  IF coalesce(payload->>'admin_role_key', 'owner') <> 'owner'
     AND coalesce(payload->>'business_role', 'Owner / Director') NOT ILIKE '%owner%'
     AND coalesce(payload->>'business_role', 'Owner / Director') NOT ILIKE '%director%' THEN
    RAISE EXCEPTION 'This recovery path is only for the recorded workspace Owner' USING ERRCODE = '42501';
  END IF;

  SELECT p.organization_id INTO profile_org FROM public.profiles p WHERE p.id = _uid;
  IF profile_org IS NOT NULL AND a.organization_id IS NOT NULL AND profile_org <> a.organization_id THEN
    RAISE EXCEPTION 'Workspace ownership evidence conflicts with the current membership' USING ERRCODE = '42501';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.user_roles ur
     WHERE ur.user_id = _uid
       AND (coalesce(profile_org, a.organization_id) IS NULL
            OR ur.organization_id <> coalesce(profile_org, a.organization_id))
  ) THEN
    RAISE EXCEPTION 'Existing role assignments belong to another workspace' USING ERRCODE = '42501';
  END IF;

  org := coalesce(profile_org, a.organization_id);
  workspace_name := nullif(trim(payload->>'business_name'), '');
  full_name := coalesce(nullif(trim(payload->>'admin_full_name'), ''), split_part(email_address, '@', 1));

  IF org IS NULL THEN
    IF workspace_name IS NULL THEN
      RAISE EXCEPTION 'The creator-bound attempt has no workspace name';
    END IF;
    INSERT INTO public.organizations (name, legal_name, business_type)
    VALUES (
      workspace_name,
      coalesce(nullif(trim(payload->>'legal_name'), ''), workspace_name),
      lower(coalesce(nullif(trim(payload->>'business_type'), ''), 'hotel'))
    )
    RETURNING id INTO org;
    was_created := true;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.organizations o WHERE o.id = org) THEN
    RAISE EXCEPTION 'The recorded workspace no longer exists';
  END IF;

  SELECT b.id INTO branch
    FROM public.branches b
   WHERE b.organization_id = org AND b.active
   ORDER BY b.is_main DESC, b.created_at
   LIMIT 1;
  IF branch IS NULL THEN
    INSERT INTO public.branches
      (organization_id, name, code, is_main, address, city, country, phone, email,
       timezone, currency, language, created_by)
    VALUES (
      org,
      coalesce(nullif(trim(payload->>'property_name'), ''), 'Main Property'),
      coalesce(nullif(upper(trim(payload->>'property_code')), ''), 'MAIN'),
      true,
      coalesce(payload->>'property_address', ''),
      coalesce(payload->>'property_city', ''),
      coalesce(payload->>'property_country', payload->>'country', ''),
      coalesce(payload->>'property_phone', ''),
      coalesce(payload->>'property_email', ''),
      nullif(payload->>'timezone', ''),
      nullif(payload->>'currency', ''),
      nullif(payload->>'language', ''),
      _uid
    )
    RETURNING id INTO branch;
  END IF;

  SELECT d.id INTO department
    FROM public.departments d
   WHERE d.organization_id = org
     AND d.department_status = 'active'
     AND (d.catalogue_key = 'administration' OR lower(trim(d.name)) = 'administration')
   ORDER BY (d.branch_id = branch) DESC, d.created_at
   LIMIT 1;
  IF department IS NULL THEN
    INSERT INTO public.departments
      (organization_id, branch_id, name, code, catalogue_key, department_status)
    VALUES (org, branch, 'Administration', 'ADMI', 'administration', 'active')
    RETURNING id INTO department;
  END IF;

  SELECT r.id INTO owner_role
    FROM public.roles r
   WHERE r.organization_id = org
     AND (r.normalized_role_key = 'owner' OR lower(trim(r.name)) IN ('owner','owner / director'))
   ORDER BY (r.normalized_role_key = 'owner') DESC, r.created_at
   LIMIT 1;
  IF owner_role IS NULL THEN
    INSERT INTO public.roles
      (organization_id, name, description, is_system, active, branch_scope,
       station_scope, access_scope, role_status, catalogue_version,
       normalized_role_key, position_level, managerial_scope, approval_class,
       management_level, reporting_manager_required)
    VALUES
      (org, 'Owner', 'Workspace Owner / Director', true, true, 'all', 'all',
       'organisation', 'active', 2, 'owner', 1, 'organisation', 'none', 100, false)
    RETURNING id INTO owner_role;
  ELSE
    UPDATE public.roles
       SET active = true,
           role_status = 'active',
           normalized_role_key = 'owner',
           access_scope = coalesce(access_scope, 'organisation'),
           managerial_scope = coalesce(managerial_scope, 'organisation'),
           updated_at = now()
     WHERE id = owner_role;
  END IF;

  INSERT INTO public.profiles
    (id, organization_id, account_type, account_status, full_name, email, branch_id,
     department_id, job_title, invitation_status, created_by)
  VALUES (_uid, org, 'staff', 'active', full_name, email_address, branch,
          department, 'Owner / Director', 'active', _uid)
  ON CONFLICT (id) DO UPDATE SET
    organization_id = excluded.organization_id,
    account_type = 'staff',
    account_status = 'active',
    full_name = coalesce(nullif(public.profiles.full_name, ''), excluded.full_name),
    email = coalesce(nullif(public.profiles.email, ''), excluded.email),
    branch_id = coalesce(public.profiles.branch_id, excluded.branch_id),
    department_id = coalesce(public.profiles.department_id, excluded.department_id),
    job_title = coalesce(nullif(public.profiles.job_title, ''), excluded.job_title),
    invitation_status = 'active',
    updated_at = now();

  INSERT INTO public.user_roles (organization_id, user_id, role_id, is_primary)
  VALUES (org, _uid, owner_role, true)
  ON CONFLICT (user_id, role_id) DO UPDATE
    SET organization_id = excluded.organization_id, is_primary = true;
  INSERT INTO public.user_branches (organization_id, user_id, branch_id)
  VALUES (org, _uid, branch)
  ON CONFLICT (user_id, branch_id) DO UPDATE
    SET organization_id = excluded.organization_id;
  INSERT INTO public.user_departments (organization_id, user_id, department_id)
  VALUES (org, _uid, department)
  ON CONFLICT (user_id, department_id) DO UPDATE
    SET organization_id = excluded.organization_id;

  INSERT INTO public.system_settings (organization_id, settings)
  VALUES (org, jsonb_strip_nulls(jsonb_build_object(
    'country', payload->>'country',
    'currency', payload->>'currency',
    'timezone', payload->>'timezone',
    'language', payload->>'language',
    'business_phone', payload->>'business_phone',
    'business_email', payload->>'business_email',
    'property_count', payload->>'property_count',
    'property_city', payload->>'property_city',
    'property_country', payload->>'property_country')))
  ON CONFLICT (organization_id) DO UPDATE SET
    settings = public.system_settings.settings || excluded.settings,
    updated_at = now();

  INSERT INTO public.number_sequences (organization_id, doc_type, prefix)
  SELECT org, s.doc_type, s.prefix
    FROM (VALUES
      ('invoice','INV'),('receipt','RCT'),('booking','BOOK'),('order','ORD'),
      ('purchase-order','PO'),('goods-received-note','GRN'),('quotation','QUO'),
      ('credit-note','CRN'),('task','TSK'),('approval-request','APR')) AS s(doc_type, prefix)
  ON CONFLICT (organization_id, doc_type, coalesce(branch_id, '00000000-0000-0000-0000-000000000000'::uuid))
  DO NOTHING;

  UPDATE public.workspace_provisioning_attempts
     SET organization_id = org,
         branch_id = branch,
         status = 'completed',
         current_step = 'effective_access',
         failure_reason = NULL,
         attempts = CASE WHEN was_complete THEN attempts ELSE attempts + 1 END,
         completed_at = coalesce(completed_at, now()),
         updated_at = now()
   WHERE id = a.id AND user_id = _uid;

  DELETE FROM public.user_access_snapshots WHERE user_id = _uid;
  PERFORM public.neo_bump_access_epoch(org);
  access_result := public.neo_build_effective_access();
  IF coalesce(access_result->>'state', '') <> 'ready'
     OR coalesce((access_result->>'is_org_admin')::boolean, false) IS NOT TRUE
     OR coalesce(access_result->>'primary_role_key', '') <> 'owner' THEN
    RAISE EXCEPTION 'Workspace finalisation did not produce ready Owner access';
  END IF;

  IF NOT was_complete THEN
    INSERT INTO public.audit_logs
      (organization_id, branch_id, user_id, user_name, action, module, record_id, new_value)
    VALUES (
      org, branch, _uid, full_name,
      CASE WHEN was_created THEN 'workspace.provisioned' ELSE 'workspace.recovered' END,
      'administration', org,
      jsonb_build_object('attempt_id', a.id, 'creator_verified', true, 'role', 'Owner'));
  END IF;

  PERFORM set_config('neo.internal', '', true);
  RETURN jsonb_build_object(
    'status', CASE WHEN was_created THEN 'created' ELSE 'recovered' END,
    'organization_id', org,
    'branch_id', branch,
    'department_id', department,
    'role', 'Owner',
    'user_id', _uid,
    'access', access_result);
EXCEPTION WHEN OTHERS THEN
  PERFORM set_config('neo.internal', '', true);
  RAISE;
END;
$function$;

REVOKE ALL ON FUNCTION public.neo_finalize_creator_workspace(uuid) FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.neo_reconcile_workspace()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Authentication is required' USING ERRCODE = '42501';
  END IF;
  PERFORM public.neo_assert_creator_workspace_recovery(auth.uid());
  RETURN public.neo_finalize_creator_workspace(auth.uid());
END;
$function$;
REVOKE ALL ON FUNCTION public.neo_reconcile_workspace() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.neo_reconcile_workspace() TO authenticated;

CREATE OR REPLACE FUNCTION public.neo_recover_my_workspace()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Authentication is required' USING ERRCODE = '42501';
  END IF;
  PERFORM public.neo_claim_signup_workspace();
  PERFORM public.neo_assert_creator_workspace_recovery(auth.uid());
  RETURN public.neo_finalize_creator_workspace(auth.uid());
END;
$function$;
REVOKE ALL ON FUNCTION public.neo_recover_my_workspace() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.neo_recover_my_workspace() TO authenticated;

-- Repair only the exact latest pending signup whose creator binding is already
-- immutable. This is the live failed attempt reported in this incident.
DO $repair$
DECLARE
  repair_uid uuid := '8e2c3346-195e-47a4-93ad-d4aa27371b89'::uuid;
  repair_attempt uuid := '8670e4f7-3a9c-422b-8a22-536081093a8f'::uuid;
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.workspace_provisioning_attempts a
     WHERE a.id = repair_attempt
       AND a.user_id = repair_uid
       AND a.status NOT IN ('complete','completed')
       AND coalesce(a.payload->>'admin_role_key','owner') = 'owner'
  ) THEN
    PERFORM set_config('request.jwt.claim.sub', repair_uid::text, true);
    PERFORM public.neo_assert_creator_workspace_recovery(repair_uid);
    PERFORM public.neo_finalize_creator_workspace(repair_uid);
  END IF;
END;
$repair$;