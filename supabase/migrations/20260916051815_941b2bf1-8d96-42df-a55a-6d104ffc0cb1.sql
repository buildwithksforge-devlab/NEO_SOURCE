CREATE OR REPLACE FUNCTION public.neo_finalize_creator_workspace(_uid uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $fn$
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
  access_result jsonb;
BEGIN
  IF _uid IS NULL THEN RAISE EXCEPTION 'Authentication is required' USING ERRCODE = '42501'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(_uid::text, 0));

  SELECT lower(u.email) INTO email_address FROM auth.users u WHERE u.id = _uid;
  IF email_address IS NULL THEN RAISE EXCEPTION 'Authentication account not found' USING ERRCODE = '42501'; END IF;

  SELECT x.* INTO a
    FROM public.workspace_provisioning_attempts x
   WHERE x.user_id = _uid
   ORDER BY (x.status IN ('completed','complete')) ASC, x.created_at DESC
   LIMIT 1 FOR UPDATE;
  IF a.id IS NULL THEN
    RAISE EXCEPTION 'No creator-bound workspace attempt exists for this account' USING ERRCODE = '42501';
  END IF;

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
       AND ur.organization_id <> coalesce(profile_org, a.organization_id)
  ) THEN
    RAISE EXCEPTION 'Existing role assignments belong to another workspace' USING ERRCODE = '42501';
  END IF;

  org := coalesce(profile_org, a.organization_id);
  workspace_name := nullif(trim(payload->>'business_name'), '');
  full_name := coalesce(nullif(trim(payload->>'admin_full_name'), ''), split_part(email_address, '@', 1));

  IF org IS NULL THEN
    IF workspace_name IS NULL THEN RAISE EXCEPTION 'The creator-bound attempt has no workspace name'; END IF;
    org := public.bootstrap_tenant_for(_uid, workspace_name, full_name);
    was_created := true;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.organizations o WHERE o.id = org) THEN
    RAISE EXCEPTION 'The recorded workspace no longer exists';
  END IF;

  SELECT b.id INTO branch FROM public.branches b
   WHERE b.organization_id = org ORDER BY b.is_main DESC, b.created_at LIMIT 1;
  IF branch IS NULL THEN
    INSERT INTO public.branches (organization_id, name, code, is_main)
    VALUES (org, coalesce(nullif(trim(payload->>'property_name'), ''), 'Main Property'),
            coalesce(nullif(upper(trim(payload->>'property_code')), ''), 'MAIN'), true)
    RETURNING id INTO branch;
  END IF;

  SELECT d.id INTO department FROM public.departments d
   WHERE d.organization_id = org AND d.name = 'Administration' ORDER BY d.created_at LIMIT 1;
  IF department IS NULL THEN
    INSERT INTO public.departments (organization_id, branch_id, name, code)
    VALUES (org, branch, 'Administration', 'ADMI') RETURNING id INTO department;
  END IF;

  INSERT INTO public.profiles
    (id, organization_id, account_type, account_status, full_name, email, branch_id,
     department_id, job_title, invitation_status, created_by)
  VALUES (_uid, org, 'staff', 'active', full_name, email_address, branch,
          department, 'Owner / Director', 'active', _uid)
  ON CONFLICT (id) DO UPDATE SET
    organization_id = excluded.organization_id,
    account_type = 'staff', account_status = 'active',
    full_name = coalesce(nullif(public.profiles.full_name, ''), excluded.full_name),
    email = coalesce(nullif(public.profiles.email, ''), excluded.email),
    branch_id = coalesce(public.profiles.branch_id, excluded.branch_id),
    department_id = coalesce(public.profiles.department_id, excluded.department_id),
    job_title = coalesce(nullif(public.profiles.job_title, ''), excluded.job_title),
    invitation_status = 'active', updated_at = now();

  PERFORM set_config('neo.internal', 'on', true);
  PERFORM public.neo_adopt_modern_model(org, 'workspace-finalisation');

  SELECT r.id INTO owner_role FROM public.roles r
   WHERE r.organization_id = org AND r.active AND r.role_status <> 'archived'
     AND (r.normalized_role_key = 'owner' OR r.name = 'Owner')
   ORDER BY (r.normalized_role_key = 'owner') DESC, r.created_at LIMIT 1;
  IF owner_role IS NULL THEN RAISE EXCEPTION 'Owner role catalogue could not be provisioned'; END IF;

  INSERT INTO public.user_roles (organization_id, user_id, role_id, is_primary)
  VALUES (org, _uid, owner_role, true)
  ON CONFLICT (user_id, role_id) DO UPDATE SET organization_id = excluded.organization_id, is_primary = true;
  INSERT INTO public.user_branches (organization_id, user_id, branch_id)
  VALUES (org, _uid, branch)
  ON CONFLICT (user_id, branch_id) DO UPDATE SET organization_id = excluded.organization_id;
  INSERT INTO public.user_departments (organization_id, user_id, department_id)
  VALUES (org, _uid, department)
  ON CONFLICT (user_id, department_id) DO UPDATE SET organization_id = excluded.organization_id;

  INSERT INTO public.system_settings (organization_id, settings)
  VALUES (org, jsonb_strip_nulls(jsonb_build_object(
    'country', payload->>'country', 'currency', payload->>'currency',
    'timezone', payload->>'timezone', 'language', payload->>'language',
    'business_phone', payload->>'business_phone', 'business_email', payload->>'business_email',
    'property_count', payload->>'property_count', 'property_city', payload->>'property_city',
    'property_country', payload->>'property_country')))
  ON CONFLICT (organization_id) DO UPDATE SET
    settings = public.system_settings.settings || excluded.settings, updated_at = now();

  INSERT INTO public.number_sequences (organization_id, doc_type, prefix)
  SELECT org, s.doc_type, s.prefix FROM (VALUES
    ('invoice','INV'),('receipt','RCT'),('booking','BOOK'),('order','ORD'),
    ('purchase-order','PO'),('goods-received-note','GRN'),('quotation','QUO'),
    ('credit-note','CRN'),('task','TSK'),('approval-request','APR')) AS s(doc_type, prefix)
  WHERE NOT EXISTS (SELECT 1 FROM public.number_sequences n WHERE n.organization_id = org AND n.doc_type = s.doc_type);

  PERFORM public.fin_seed_finance_defaults();

  UPDATE public.workspace_provisioning_attempts
     SET organization_id = org, branch_id = branch, status = 'completed',
         current_step = 'effective_access', failure_reason = NULL,
         attempts = attempts + 1, completed_at = coalesce(completed_at, now()), updated_at = now()
   WHERE id = a.id AND user_id = _uid;

  DELETE FROM public.user_access_snapshots WHERE user_id = _uid;
  PERFORM set_config('neo.internal', '', true);
  access_result := public.neo_build_effective_access();
  IF coalesce(access_result->>'state', '') <> 'ready'
     OR coalesce((access_result->>'is_org_admin')::boolean, false) IS NOT TRUE THEN
    RAISE EXCEPTION 'Workspace finalisation did not produce ready Owner access';
  END IF;

  INSERT INTO public.audit_logs
    (organization_id, branch_id, user_id, user_name, action, module, record_id, new_value)
  VALUES (org, branch, _uid, full_name,
          CASE WHEN was_created THEN 'workspace.provisioned' ELSE 'workspace.recovered' END,
          'administration', org,
          jsonb_build_object('attempt_id', a.id, 'creator_verified', true, 'role', 'Owner'));

  RETURN jsonb_build_object('status', CASE WHEN was_created THEN 'created' ELSE 'recovered' END,
    'organization_id', org, 'branch_id', branch, 'department_id', department,
    'role', 'Owner', 'user_id', _uid, 'access', access_result);
END;
$fn$;

REVOKE ALL ON FUNCTION public.neo_finalize_creator_workspace(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.neo_finalize_creator_workspace(uuid) TO service_role;

CREATE OR REPLACE FUNCTION public.neo_reconcile_workspace()
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $fn$
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Authentication is required' USING ERRCODE = '42501'; END IF;
  RETURN public.neo_finalize_creator_workspace(auth.uid());
END;
$fn$;
REVOKE ALL ON FUNCTION public.neo_reconcile_workspace() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.neo_reconcile_workspace() TO authenticated;

CREATE OR REPLACE FUNCTION public.neo_recover_my_workspace()
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $fn$
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Authentication is required' USING ERRCODE = '42501'; END IF;
  RETURN public.neo_finalize_creator_workspace(auth.uid());
END;
$fn$;
REVOKE ALL ON FUNCTION public.neo_recover_my_workspace() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.neo_recover_my_workspace() TO authenticated;

CREATE OR REPLACE FUNCTION public.neo_workspace_link_status()
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $fn$
  SELECT jsonb_build_object(
    'user_id', auth.uid(),
    'has_profile', EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = auth.uid()),
    'attempt_recorded', EXISTS (SELECT 1 FROM public.workspace_provisioning_attempts a WHERE a.user_id = auth.uid()),
    'recoverable', EXISTS (SELECT 1 FROM public.workspace_provisioning_attempts a WHERE a.user_id = auth.uid()
      AND coalesce(a.payload->>'admin_role_key', 'owner') = 'owner'),
    'candidate_workspaces', (SELECT count(*) FROM public.workspace_provisioning_attempts a WHERE a.user_id = auth.uid()));
$fn$;
REVOKE ALL ON FUNCTION public.neo_workspace_link_status() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.neo_workspace_link_status() TO authenticated;

CREATE OR REPLACE FUNCTION public.neo_creator_workspace_recoverable()
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $fn$
  SELECT auth.uid() IS NOT NULL AND EXISTS (
    SELECT 1 FROM public.workspace_provisioning_attempts a
     WHERE a.user_id = auth.uid() AND coalesce(a.payload->>'admin_role_key', 'owner') = 'owner');
$fn$;
REVOKE ALL ON FUNCTION public.neo_creator_workspace_recoverable() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.neo_creator_workspace_recoverable() TO authenticated, service_role;

DO $patch$
DECLARE body text;
BEGIN
  SELECT p.prosrc INTO body FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'neo_build_effective_access' AND p.pronargs = 0;
  IF body IS NULL THEN RAISE EXCEPTION 'neo_build_effective_access not found'; END IF;
  body := regexp_replace(body,
    '''recoverable'', \(\(SELECT id FROM me\) IS NULL AND EXISTS \([\s\S]*?\)\),[[:space:]]*''access_version''',
    '''recoverable'', public.neo_creator_workspace_recoverable(), ''access_version''');
  IF body NOT LIKE '%''recoverable'', public.neo_creator_workspace_recoverable()%' THEN
    RAISE EXCEPTION 'effective-access recovery expression was not replaced';
  END IF;
  EXECUTE 'CREATE OR REPLACE FUNCTION public.neo_build_effective_access() RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS ' || quote_literal(body);
END;
$patch$;
REVOKE ALL ON FUNCTION public.neo_build_effective_access() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.neo_build_effective_access() TO authenticated, service_role;