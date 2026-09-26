INSERT INTO public.workspace_provisioning_attempts (idempotency_key, email, user_id, payload, status, current_step)
SELECT 'recovered::' || u.id::text,
       lower(u.email),
       u.id,
       jsonb_build_object(
         'business_name', coalesce(NULLIF(trim(u.raw_user_meta_data->>'org_name'), ''), 'Workspace'),
         'legal_name', coalesce(NULLIF(trim(u.raw_user_meta_data->>'org_name'), ''), 'Workspace'),
         'trading_name', coalesce(NULLIF(trim(u.raw_user_meta_data->>'org_name'), ''), 'Workspace'),
         'admin_full_name', coalesce(NULLIF(trim(u.raw_user_meta_data->>'full_name'), ''), split_part(u.email, '@', 1)),
         'business_email', lower(u.email)
       ),
       'pending',
       'recovered_from_signup'
FROM auth.users u
LEFT JOIN public.profiles p ON p.id = u.id
WHERE p.id IS NULL AND u.email IS NOT NULL
ON CONFLICT (idempotency_key) DO NOTHING;

CREATE OR REPLACE FUNCTION public.neo_reconcile_workspace()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  _uid uuid := auth.uid();
  _email text;
  _attempt public.workspace_provisioning_attempts;
  _candidates jsonb;
  _candidate_count integer;
  _org uuid;
  _existing_org uuid;
  _branch uuid;
  _dept uuid;
  _role uuid;
  _payload jsonb;
  _full text;
  _name text;
  _recovered jsonb := '[]'::jsonb;
BEGIN
  IF _uid IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  SELECT lower(u.email) INTO _email FROM auth.users u WHERE u.id = _uid;

  SELECT * INTO _attempt
  FROM public.workspace_provisioning_attempts a
  WHERE a.user_id = _uid
  ORDER BY a.created_at DESC LIMIT 1;

  IF _attempt.id IS NULL AND _email IS NOT NULL THEN
    SELECT count(*) INTO _candidate_count
    FROM public.workspace_provisioning_attempts a
    WHERE a.user_id IS NULL AND lower(a.email) = _email AND a.status <> 'complete';

    IF _candidate_count > 1 THEN
      SELECT jsonb_agg(jsonb_build_object('attempt_id', a.id, 'created_at', a.created_at,
                                          'business_name', a.payload->>'business_name',
                                          'organization_id', a.organization_id))
        INTO _candidates
      FROM public.workspace_provisioning_attempts a
      WHERE a.user_id IS NULL AND lower(a.email) = _email AND a.status <> 'complete';
      RETURN jsonb_build_object('status', 'ambiguous', 'reason',
        'More than one workspace-creation attempt exists for this email.',
        'candidates', _candidates);
    END IF;

    UPDATE public.workspace_provisioning_attempts a
       SET user_id = _uid, updated_at = now()
     WHERE a.user_id IS NULL AND lower(a.email) = _email AND a.status <> 'complete'
     RETURNING * INTO _attempt;
  END IF;

  SELECT p.organization_id INTO _org FROM public.profiles p WHERE p.id = _uid;
  IF _org IS NULL THEN _org := _attempt.organization_id; END IF;

  IF _org IS NULL THEN
    SELECT count(DISTINCT l.organization_id) INTO _candidate_count
    FROM public.audit_logs l
    WHERE l.user_id = _uid AND l.action IN ('workspace.created', 'workspace.reconciled')
      AND l.organization_id IS NOT NULL;

    IF _candidate_count > 1 THEN
      SELECT jsonb_agg(DISTINCT jsonb_build_object('organization_id', l.organization_id)) INTO _candidates
      FROM public.audit_logs l
      WHERE l.user_id = _uid AND l.action IN ('workspace.created', 'workspace.reconciled')
        AND l.organization_id IS NOT NULL;
      RETURN jsonb_build_object('status', 'ambiguous', 'reason',
        'This sign-in created more than one organisation; an administrator must choose.',
        'candidates', _candidates);
    END IF;

    SELECT l.organization_id INTO _org
    FROM public.audit_logs l
    WHERE l.user_id = _uid AND l.action IN ('workspace.created', 'workspace.reconciled')
      AND l.organization_id IS NOT NULL
    ORDER BY l.created_at LIMIT 1;
  END IF;

  _payload := coalesce(_attempt.payload, '{}'::jsonb);
  _name := NULLIF(trim(_payload->>'business_name'), '');
  _full := coalesce(NULLIF(trim(_payload->>'admin_full_name'), ''),
                    (SELECT p.full_name FROM public.profiles p WHERE p.id = _uid),
                    split_part(coalesce(_email, 'owner'), '@', 1));

  IF _org IS NULL THEN
    IF _attempt.id IS NULL THEN
      RETURN jsonb_build_object('status', 'no_attempt', 'reason',
        'No workspace-creation attempt is linked to this sign-in.');
    END IF;

    -- Never create a second organisation for a business that already exists.
    IF _name IS NOT NULL THEN
      SELECT o.id INTO _existing_org FROM public.organizations o
       WHERE lower(trim(o.name)) = lower(_name) ORDER BY o.created_at LIMIT 1;
    END IF;

    IF _existing_org IS NOT NULL THEN
      UPDATE public.workspace_provisioning_attempts
         SET status = 'needs_admin_link', current_step = 'organization',
             failure_reason = 'An organisation with this business name already exists.',
             organization_id = _existing_org, updated_at = now()
       WHERE id = _attempt.id;
      RETURN jsonb_build_object('status', 'needs_admin_link', 'reason',
        'A workspace for this business already exists. An administrator of that workspace must add this person, so no duplicate organisation is created.',
        'candidates', jsonb_build_array(jsonb_build_object('organization_id', _existing_org, 'name', _name)));
    END IF;

    UPDATE public.workspace_provisioning_attempts
       SET status = 'in_progress', current_step = 'organization',
           attempts = attempts + 1, updated_at = now()
     WHERE id = _attempt.id;
    _org := (public.neo_create_workspace(_payload)->>'organization_id')::uuid;
    _recovered := _recovered || to_jsonb(ARRAY['organization']);
  END IF;

  IF _org IS NULL THEN
    RETURN jsonb_build_object('status', 'failed', 'reason', 'Organisation could not be resolved.');
  END IF;

  SELECT b.id INTO _branch FROM public.branches b
   WHERE b.organization_id = _org ORDER BY b.is_main DESC, b.created_at LIMIT 1;

  IF _branch IS NULL THEN
    INSERT INTO public.branches (organization_id, name, code, is_main)
    VALUES (_org,
            coalesce(NULLIF(trim(_payload->>'property_name'), ''), 'Main Property'),
            coalesce(NULLIF(upper(trim(_payload->>'property_code')), ''), 'MAIN'), true)
    RETURNING id INTO _branch;
    _recovered := _recovered || to_jsonb(ARRAY['branch']);
  END IF;

  SELECT d.id INTO _dept FROM public.departments d
   WHERE d.organization_id = _org AND d.name IN ('Administration', 'Executive Management')
   ORDER BY (d.name = 'Administration') DESC LIMIT 1;

  IF _dept IS NULL THEN
    INSERT INTO public.departments (organization_id, branch_id, name, code)
    VALUES (_org, _branch, 'Administration', 'ADMI')
    RETURNING id INTO _dept;
    _recovered := _recovered || to_jsonb(ARRAY['department']);
  END IF;

  IF EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = _uid) THEN
    UPDATE public.profiles p
       SET organization_id = coalesce(p.organization_id, _org),
           account_type = CASE WHEN p.account_type = 'platform_admin' THEN p.account_type ELSE 'staff' END,
           branch_id = coalesce(p.branch_id, _branch),
           department_id = coalesce(p.department_id, _dept),
           full_name = coalesce(NULLIF(trim(p.full_name), ''), _full),
           email = coalesce(NULLIF(trim(p.email), ''), _email),
           job_title = coalesce(NULLIF(trim(p.job_title), ''), NULLIF(trim(_payload->>'business_role'), ''), 'Owner/Director'),
           updated_at = now()
     WHERE p.id = _uid;
    _recovered := _recovered || to_jsonb(ARRAY['profile.repaired']);
  ELSE
    INSERT INTO public.profiles (id, organization_id, account_type, account_status, full_name, email,
                                 branch_id, department_id, job_title, invitation_status, created_by)
    VALUES (_uid, _org, 'staff', 'active', _full, _email, _branch, _dept,
            coalesce(NULLIF(trim(_payload->>'business_role'), ''), 'Owner/Director'), 'active', _uid);
    _recovered := _recovered || to_jsonb(ARRAY['profile.created']);
  END IF;

  SELECT r.id INTO _role FROM public.roles r
   WHERE r.organization_id = _org AND r.name = 'Owner' LIMIT 1;
  IF _role IS NULL THEN
    INSERT INTO public.roles (organization_id, name, description, is_system)
    VALUES (_org, 'Owner', 'Organisation owner', true) RETURNING id INTO _role;
    INSERT INTO public.role_permissions (organization_id, role_id, permission_id)
    SELECT _org, _role, p.id FROM public.permissions p
    ON CONFLICT DO NOTHING;
    _recovered := _recovered || to_jsonb(ARRAY['role.owner']);
  END IF;

  INSERT INTO public.user_roles (organization_id, user_id, role_id)
  VALUES (_org, _uid, _role) ON CONFLICT (user_id, role_id) DO NOTHING;

  INSERT INTO public.user_branches (organization_id, user_id, branch_id)
  VALUES (_org, _uid, _branch) ON CONFLICT (user_id, branch_id) DO NOTHING;

  INSERT INTO public.user_departments (organization_id, user_id, department_id)
  VALUES (_org, _uid, _dept) ON CONFLICT (user_id, department_id) DO NOTHING;

  _recovered := _recovered || to_jsonb(ARRAY['assignments']);

  IF _attempt.id IS NOT NULL THEN
    UPDATE public.workspace_provisioning_attempts
       SET user_id = _uid, organization_id = _org, branch_id = _branch,
           status = 'complete', current_step = 'effective_access', failure_reason = NULL,
           recovered_relationships = _recovered, completed_at = now(), updated_at = now()
     WHERE id = _attempt.id;
  END IF;

  INSERT INTO public.audit_logs (organization_id, branch_id, user_id, user_name, action, module, record_id, new_value)
  VALUES (_org, _branch, _uid, _full, 'workspace.reconciled', 'administration', _org,
          jsonb_build_object('recovered', _recovered, 'attempt_id', _attempt.id));

  RETURN jsonb_build_object('status', 'ok', 'organization_id', _org, 'branch_id', _branch,
                            'recovered', _recovered, 'access', public.my_effective_access());
END;
$$;

REVOKE ALL ON FUNCTION public.neo_reconcile_workspace() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.neo_reconcile_workspace() TO authenticated;