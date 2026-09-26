-- 1. Provisioning must never promote an existing member, and never fall back to Owner.
CREATE OR REPLACE FUNCTION public.neo_provision_workspace_for(_uid uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  _email text;
  _attempt public.workspace_provisioning_attempts;
  _payload jsonb := '{}'::jsonb;
  _meta jsonb := '{}'::jsonb;
  _org uuid; _branch uuid; _dept uuid;
  _name text; _full text; _biz_role text; _role_name text;
  _role_id uuid;
  _created boolean := false;
BEGIN
  IF _uid IS NULL THEN RAISE EXCEPTION 'No user supplied'; END IF;

  SELECT email, COALESCE(raw_user_meta_data, '{}'::jsonb) INTO _email, _meta
    FROM auth.users WHERE id = _uid;
  IF _email IS NULL THEN
    RETURN jsonb_build_object('status','not_found','reason','No authentication user with that id.');
  END IF;

  -- An account that already holds any role assignment is NEVER re-provisioned:
  -- signing in must only load confirmed assignments.
  IF EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = _uid) THEN
    SELECT organization_id INTO _org FROM public.profiles WHERE id = _uid;
    RETURN jsonb_build_object('status','existing','organization_id',_org,'user_id',_uid);
  END IF;

  SELECT * INTO _attempt FROM public.workspace_provisioning_attempts
   WHERE user_id = _uid OR lower(email) = lower(_email)
   ORDER BY created_at DESC LIMIT 1;

  -- Without an explicit workspace-creation attempt this account is simply a
  -- member awaiting assignment. No organisation, no role, no Owner fallback.
  IF _attempt.id IS NULL AND (_meta->>'org_name') IS NULL THEN
    RETURN jsonb_build_object('status','setup_incomplete',
      'reason','This account has no confirmed workspace assignment. An administrator must assign an organisation, property, department and role.',
      'user_id',_uid);
  END IF;

  _payload := COALESCE(_attempt.payload, '{}'::jsonb);
  _name := COALESCE(NULLIF(trim(_payload->>'business_name'),''), NULLIF(trim(_meta->>'org_name'),''), 'My Hospitality Group');
  _full := COALESCE(NULLIF(trim(_payload->>'admin_full_name'),''), NULLIF(trim(_meta->>'full_name'),''), split_part(_email,'@',1));
  _biz_role := COALESCE(NULLIF(trim(_payload->>'business_role'),''), 'Owner/Director');

  SELECT organization_id INTO _org FROM public.profiles WHERE id = _uid;
  IF _org IS NULL THEN _org := _attempt.organization_id; END IF;

  IF _org IS NULL THEN
    SELECT o.id INTO _org FROM public.organizations o
     WHERE lower(o.name) = lower(_name)
       AND NOT EXISTS (SELECT 1 FROM public.profiles p WHERE p.organization_id = o.id AND p.id <> _uid)
     ORDER BY o.created_at LIMIT 1;
  END IF;

  IF _org IS NULL AND EXISTS (SELECT 1 FROM public.organizations o WHERE lower(o.name) = lower(_name)) THEN
    RETURN jsonb_build_object('status','needs_admin_link',
      'reason','A workspace with this business name already has members. An administrator must link this sign-in to it instead of creating a duplicate.');
  END IF;

  IF _org IS NULL THEN
    _org := public.bootstrap_tenant_for(_uid, _name, _full);
    _created := true;
  END IF;

  -- Joining an organisation that already has members never grants a role here.
  IF NOT _created AND EXISTS (
      SELECT 1 FROM public.user_roles ur WHERE ur.organization_id = _org AND ur.user_id <> _uid) THEN
    RETURN jsonb_build_object('status','setup_incomplete',
      'reason','This workspace already has members. An administrator must assign this account a role.',
      'organization_id',_org,'user_id',_uid);
  END IF;

  SELECT id INTO _branch FROM public.branches WHERE organization_id = _org ORDER BY is_main DESC, created_at LIMIT 1;
  IF _branch IS NULL THEN
    INSERT INTO public.branches (organization_id, name, code, is_main)
    VALUES (_org, COALESCE(NULLIF(trim(_payload->>'property_name'),''),'Main Property'),
            COALESCE(NULLIF(upper(trim(_payload->>'property_code')),''),'MAIN'), true)
    RETURNING id INTO _branch;
  ELSIF _created THEN
    UPDATE public.branches
       SET name = COALESCE(NULLIF(trim(_payload->>'property_name'),''), name),
           code = COALESCE(NULLIF(upper(trim(_payload->>'property_code')),''), code),
           address = COALESCE(NULLIF(trim(_payload->>'property_address'),''), address),
           phone = COALESCE(NULLIF(trim(_payload->>'property_phone'),''), phone),
           email = COALESCE(NULLIF(trim(_payload->>'property_email'),''), email),
           updated_at = now()
     WHERE id = _branch;
  END IF;

  SELECT id INTO _dept FROM public.departments WHERE organization_id = _org AND name = 'Administration' ORDER BY created_at LIMIT 1;
  IF _dept IS NULL THEN
    INSERT INTO public.departments (organization_id, branch_id, name, code)
    VALUES (_org, _branch, 'Administration', 'ADMI') RETURNING id INTO _dept;
  END IF;

  INSERT INTO public.profiles (id, organization_id, account_type, full_name, email, branch_id, department_id, job_title, invitation_status, account_status, created_by)
  VALUES (_uid, _org, 'staff', _full, _email, _branch, _dept, _biz_role, 'active', 'active', _uid)
  ON CONFLICT (id) DO UPDATE SET
    organization_id = COALESCE(public.profiles.organization_id, EXCLUDED.organization_id),
    account_type = COALESCE(NULLIF(public.profiles.account_type,''), 'staff'),
    full_name = COALESCE(NULLIF(public.profiles.full_name,''), EXCLUDED.full_name),
    email = COALESCE(NULLIF(public.profiles.email,''), EXCLUDED.email),
    branch_id = COALESCE(public.profiles.branch_id, EXCLUDED.branch_id),
    department_id = COALESCE(public.profiles.department_id, EXCLUDED.department_id),
    job_title = COALESCE(NULLIF(public.profiles.job_title,''), EXCLUDED.job_title),
    account_status = COALESCE(NULLIF(public.profiles.account_status,''), 'active'),
    updated_at = now();

  -- Exactly one role: the administrative role the creator chose. No Owner fallback.
  _role_name := CASE
    WHEN _biz_role ILIKE '%system admin%' OR _biz_role ILIKE '%IT %' THEN 'System Administrator'
    WHEN _biz_role ILIKE '%general manager%' THEN 'General Manager'
    WHEN _biz_role ILIKE '%operations%' THEN 'Operations Manager'
    WHEN _biz_role ILIKE '%owner%' OR _biz_role ILIKE '%director%' THEN 'Owner'
    ELSE NULL END;

  IF _role_name IS NULL THEN
    RETURN jsonb_build_object('status','setup_incomplete',
      'reason','No administrative role was chosen for this workspace. An administrator must assign a role.',
      'organization_id',_org,'user_id',_uid);
  END IF;

  SELECT id INTO _role_id FROM public.roles WHERE organization_id = _org AND name = _role_name ORDER BY created_at LIMIT 1;
  IF _role_id IS NULL THEN
    INSERT INTO public.roles (organization_id, name, description, is_system)
    VALUES (_org, _role_name, _role_name || ' role', true) RETURNING id INTO _role_id;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM public.role_permissions WHERE role_id = _role_id) THEN
    INSERT INTO public.role_permissions (organization_id, role_id, permission_id)
    SELECT _org, _role_id, p.id FROM public.permissions p ON CONFLICT DO NOTHING;
  END IF;

  PERFORM set_config('neo.internal', 'on', true);
  INSERT INTO public.user_roles (organization_id, user_id, role_id) VALUES (_org, _uid, _role_id) ON CONFLICT DO NOTHING;
  PERFORM set_config('neo.internal', '', true);

  INSERT INTO public.user_branches (organization_id, user_id, branch_id) VALUES (_org, _uid, _branch) ON CONFLICT DO NOTHING;
  INSERT INTO public.user_departments (organization_id, user_id, department_id) VALUES (_org, _uid, _dept) ON CONFLICT DO NOTHING;

  INSERT INTO public.system_settings (organization_id, settings)
  VALUES (_org, jsonb_strip_nulls(jsonb_build_object(
    'country', _payload->>'country',
    'currency', _payload->>'currency',
    'timezone', _payload->>'timezone',
    'language', _payload->>'language',
    'business_phone', _payload->>'business_phone',
    'business_email', _payload->>'business_email',
    'property_count', _payload->>'property_count',
    'property_city', _payload->>'property_city',
    'property_country', _payload->>'property_country'
  )))
  ON CONFLICT (organization_id) DO UPDATE
    SET settings = public.system_settings.settings || EXCLUDED.settings, updated_at = now();

  INSERT INTO public.number_sequences (organization_id, doc_type, prefix)
  SELECT _org, s.doc_type, s.prefix FROM (VALUES
    ('invoice','INV'),('receipt','RCT'),('booking','BOOK'),('order','ORD'),('purchase-order','PO'),
    ('goods-received-note','GRN'),('quotation','QUO'),('credit-note','CRN'),('task','TSK'),('approval-request','APR')
  ) AS s(doc_type, prefix)
  WHERE NOT EXISTS (SELECT 1 FROM public.number_sequences n WHERE n.organization_id = _org AND n.doc_type = s.doc_type);

  UPDATE public.workspace_provisioning_attempts
     SET user_id = _uid, organization_id = _org, status = 'completed',
         current_step = 'provisioned', failure_reason = NULL, updated_at = now()
   WHERE id = _attempt.id;

  INSERT INTO public.audit_logs (organization_id, branch_id, user_id, user_name, action, module, record_id, new_value)
  VALUES (_org, _branch, _uid, _full,
          CASE WHEN _created THEN 'workspace.provisioned' ELSE 'workspace.recovered' END,
          'administration', _org,
          jsonb_build_object('business_name', _name, 'business_role', _biz_role, 'role', _role_name,
                             'branch_id', _branch, 'department_id', _dept));

  BEGIN
    PERFORM set_config('neo.internal', 'on', true);
    PERFORM public.neo_adopt_modern_model(_org, 'provisioning');
    PERFORM set_config('neo.internal', '', true);
  EXCEPTION WHEN OTHERS THEN
    PERFORM set_config('neo.internal', '', true);
  END;

  RETURN jsonb_build_object('status', CASE WHEN _created THEN 'created' ELSE 'recovered' END,
    'organization_id', _org, 'branch_id', _branch, 'department_id', _dept, 'role', _role_name, 'user_id', _uid);
END;
$fn$;

-- 2. Owner may only be granted by an authorised administrator, by internal
--    provisioning, or as the very first assignment of a brand-new workspace.
CREATE OR REPLACE FUNCTION public.neo_guard_owner_grant()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $g$
DECLARE _role text;
BEGIN
  SELECT name INTO _role FROM public.roles WHERE id = NEW.role_id;
  IF _role IS DISTINCT FROM 'Owner' THEN RETURN NEW; END IF;
  IF COALESCE(current_setting('neo.internal', true), '') = 'on' THEN RETURN NEW; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.user_roles ur WHERE ur.organization_id = NEW.organization_id) THEN
    RETURN NEW; -- first assignment in a brand-new workspace (its creator)
  END IF;
  IF auth.uid() IS NOT NULL AND public.is_org_admin() THEN RETURN NEW; END IF;
  RAISE EXCEPTION 'Owner can only be assigned by an authorised administrator.';
END;
$g$;

DROP TRIGGER IF EXISTS neo_guard_owner_grant ON public.user_roles;
CREATE TRIGGER neo_guard_owner_grant
BEFORE INSERT ON public.user_roles
FOR EACH ROW EXECUTE FUNCTION public.neo_guard_owner_grant();

-- 3. Remove the one demonstrably unauthorised Owner grant, with an audit record.
INSERT INTO public.audit_logs (organization_id, user_id, user_name, action, module, record_id, previous_value, reason)
SELECT ur.organization_id, ur.user_id, COALESCE(p.full_name, p.email), 'role.unauthorized_owner_revoked', 'security',
       ur.user_id::text, jsonb_build_object('role','Owner','granted_at',ur.created_at,'job_title',p.job_title),
       'Owner was granted automatically at sign-in by workspace reconciliation, not by an administrator.'
FROM public.user_roles ur
JOIN public.roles r ON r.id = ur.role_id
JOIN public.profiles p ON p.id = ur.user_id
WHERE r.name = 'Owner' AND ur.is_primary IS NOT TRUE
  AND EXISTS (SELECT 1 FROM public.user_roles u2 JOIN public.roles r2 ON r2.id = u2.role_id
              WHERE u2.user_id = ur.user_id AND r2.name <> 'Owner');

DELETE FROM public.user_roles ur
USING public.roles r
WHERE r.id = ur.role_id AND r.name = 'Owner' AND ur.is_primary IS NOT TRUE
  AND EXISTS (SELECT 1 FROM public.user_roles u2 JOIN public.roles r2 ON r2.id = u2.role_id
              WHERE u2.user_id = ur.user_id AND r2.name <> 'Owner');