CREATE OR REPLACE FUNCTION public.branches_defaults()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW.organization_id := COALESCE(public.current_org_id(), NEW.organization_id);
    NEW.created_by := COALESCE(NEW.created_by, auth.uid());
  ELSE
    NEW.organization_id := OLD.organization_id;
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END;
$fn$;

CREATE OR REPLACE FUNCTION public.bootstrap_tenant_for(_uid uuid, _org_name text, _full_name text)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  _org uuid; _branch uuid; _owner_role uuid; _dept text; _role text; _rid uuid; _seq record; _st record;
BEGIN
  IF _uid IS NULL THEN RAISE EXCEPTION 'No user supplied'; END IF;
  SELECT organization_id INTO _org FROM public.profiles WHERE id = _uid;
  IF _org IS NOT NULL THEN RETURN _org; END IF;

  INSERT INTO public.organizations (name, legal_name)
  VALUES (COALESCE(NULLIF(_org_name,''), 'My Hospitality Group'), COALESCE(NULLIF(_org_name,''), 'My Hospitality Group'))
  RETURNING id INTO _org;

  INSERT INTO public.branches (organization_id, name, code, is_main)
  VALUES (_org, 'Main Property', 'MAIN', true) RETURNING id INTO _branch;

  FOREACH _dept IN ARRAY ARRAY['Front Office','Restaurant','Bar','Kitchen','Housekeeping','Laundry',
    'Procurement','Inventory & Stores','Finance','Marketing','Events','Maintenance','Delivery','Human Resources','Administration'] LOOP
    INSERT INTO public.departments (organization_id, branch_id, name, code)
    VALUES (_org, _branch, _dept, upper(left(regexp_replace(_dept,'[^a-zA-Z]','','g'),4)));
  END LOOP;

  FOREACH _role IN ARRAY ARRAY['Owner','System Administrator','General Manager','Operations Manager','Finance Manager','Accountant',
    'Front Office Manager','Receptionist','Restaurant Manager','Waiter / Waitress','Barista','Coffee Station Supervisor',
    'Bar Manager','Bar Attendant','Kitchen Manager','Hot Kitchen Supervisor','Chef','Pastry Supervisor','Pastry Chef',
    'Procurement Officer','Storekeeper','Housekeeping Supervisor','Housekeeper','Maintenance Officer',
    'Marketing Manager','Events Manager','Human Resources','Delivery Manager','Rider','Guest'] LOOP
    INSERT INTO public.roles (organization_id, name, description, is_system)
    VALUES (_org, _role, _role || ' role', true) RETURNING id INTO _rid;
    IF _role = 'Owner' THEN _owner_role := _rid; END IF;
  END LOOP;

  INSERT INTO public.role_permissions (organization_id, role_id, permission_id)
  SELECT _org, _owner_role, p.id FROM public.permissions p;

  FOR _st IN SELECT * FROM (VALUES
    ('restaurant-floor','Restaurant Floor','Restaurant','service','#0f766e',1),
    ('coffee-station','Coffee Station','Restaurant','beverage','#b45309',2),
    ('main-bar','Main Bar','Bar','beverage','#7c3aed',3),
    ('hot-kitchen','Hot Kitchen','Kitchen','production','#dc2626',4),
    ('pastry','Pastry','Kitchen','production','#db2777',5)
  ) AS s(code, name, dept, stype, color, sort) LOOP
    INSERT INTO public.operational_stations (organization_id, branch_id, department_id, code, name, description, station_type, color, sort_order, created_by)
    VALUES (_org, _branch, (SELECT id FROM public.departments WHERE organization_id = _org AND name = _st.dept LIMIT 1),
            _st.code, _st.name, _st.name || ' work area', _st.stype, _st.color, _st.sort, _uid);
  END LOOP;

  INSERT INTO public.profiles (id, organization_id, account_type, full_name, email, branch_id, department_id, job_title, invitation_status, created_by)
  VALUES (_uid, _org, 'staff', COALESCE(NULLIF(_full_name,''),'Owner'),
          COALESCE((SELECT email FROM auth.users WHERE id = _uid), ''), _branch,
          (SELECT id FROM public.departments WHERE organization_id = _org AND name = 'Administration' LIMIT 1),
          'Owner', 'active', _uid);

  INSERT INTO public.user_roles (organization_id, user_id, role_id) VALUES (_org, _uid, _owner_role) ON CONFLICT DO NOTHING;
  INSERT INTO public.user_branches (organization_id, user_id, branch_id) VALUES (_org, _uid, _branch) ON CONFLICT DO NOTHING;
  INSERT INTO public.user_departments (organization_id, user_id, department_id)
  VALUES (_org, _uid, (SELECT id FROM public.departments WHERE organization_id = _org AND name = 'Administration' LIMIT 1)) ON CONFLICT DO NOTHING;

  INSERT INTO public.approval_types (organization_id, key, name) VALUES
    (_org,'bill-void','Bill void request'),(_org,'refund','Refund approval'),(_org,'discount','Discount'),
    (_org,'complimentary-meal','Complimentary meal'),(_org,'complimentary-room','Complimentary room'),
    (_org,'credit-account','Credit account approval'),(_org,'purchase-request','Purchase request'),
    (_org,'stock-adjustment','Stock adjustment'),(_org,'expense','Expense approval'),
    (_org,'rate-override','Rate override'),(_org,'event-quotation','Event quotation'),
    (_org,'price-change','Manual price change');

  FOR _seq IN SELECT * FROM (VALUES
    ('invoice','INV'),('receipt','RCT'),('booking','BOOK'),('order','ORD'),('purchase-order','PO'),
    ('goods-received-note','GRN'),('quotation','QUO'),('credit-note','CRN'),('task','TSK'),('approval-request','APR')
  ) AS s(doc_type, prefix) LOOP
    INSERT INTO public.number_sequences (organization_id, doc_type, prefix) VALUES (_org, _seq.doc_type, _seq.prefix);
  END LOOP;

  INSERT INTO public.system_settings (organization_id, settings) VALUES (_org, jsonb_build_object(
    'operatingHours', jsonb_build_object('open','06:00','close','23:00'),
    'financialYearStart','01-01',
    'defaultPaymentMethods', jsonb_build_array('Cash','Card','Mobile Money','Bank Transfer'),
    'defaultRoomStatus','vacant-clean',
    'sessionTimeoutMinutes', 30,
    'passwordPolicy', jsonb_build_object('minLength',8,'requireUpper',true,'requireNumber',true,'requireSymbol',false,'expiryDays',90),
    'failedLoginLimit', 5,
    'lockoutMinutes', 15,
    'backupFrequency','daily',
    'notificationDefaults', jsonb_build_object('inApp',true,'email',true,'whatsapp',false,'sms',false,'push',false)
  )) ON CONFLICT (organization_id) DO NOTHING;

  INSERT INTO public.notifications (organization_id, user_id, category, title, body)
  VALUES (_org, _uid, 'system-alert', 'Welcome to your Hospitality OS',
          'Your organisation workspace is ready. Start by adding staff, roles and departments.');

  RETURN _org;
END;
$fn$;

REVOKE ALL ON FUNCTION public.bootstrap_tenant_for(uuid, text, text) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.bootstrap_tenant(_org_name text, _full_name text)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  RETURN public.bootstrap_tenant_for(auth.uid(), _org_name, _full_name);
END;
$fn$;

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
  _role_id uuid; _admin_role uuid;
  _created boolean := false;
BEGIN
  IF _uid IS NULL THEN RAISE EXCEPTION 'No user supplied'; END IF;

  SELECT email, COALESCE(raw_user_meta_data, '{}'::jsonb) INTO _email, _meta
    FROM auth.users WHERE id = _uid;
  IF _email IS NULL THEN
    RETURN jsonb_build_object('status','not_found','reason','No authentication user with that id.');
  END IF;

  SELECT * INTO _attempt FROM public.workspace_provisioning_attempts
   WHERE user_id = _uid OR lower(email) = lower(_email)
   ORDER BY created_at DESC LIMIT 1;

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

  _role_name := CASE
    WHEN _biz_role ILIKE '%system admin%' OR _biz_role ILIKE '%IT %' THEN 'System Administrator'
    WHEN _biz_role ILIKE '%general manager%' THEN 'General Manager'
    WHEN _biz_role ILIKE '%operations%' THEN 'Operations Manager'
    ELSE 'Owner' END;

  SELECT id INTO _role_id FROM public.roles WHERE organization_id = _org AND name = _role_name ORDER BY created_at LIMIT 1;
  IF _role_id IS NULL THEN
    INSERT INTO public.roles (organization_id, name, description, is_system)
    VALUES (_org, _role_name, _role_name || ' role', true) RETURNING id INTO _role_id;
  END IF;

  SELECT id INTO _admin_role FROM public.roles
   WHERE organization_id = _org AND name IN ('Owner','System Administrator')
   ORDER BY CASE WHEN name = 'Owner' THEN 0 ELSE 1 END, created_at LIMIT 1;
  IF _admin_role IS NULL THEN
    INSERT INTO public.roles (organization_id, name, description, is_system)
    VALUES (_org, 'Owner', 'Owner role', true) RETURNING id INTO _admin_role;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM public.role_permissions WHERE role_id = _admin_role) THEN
    INSERT INTO public.role_permissions (organization_id, role_id, permission_id)
    SELECT _org, _admin_role, p.id FROM public.permissions p ON CONFLICT DO NOTHING;
  END IF;

  IF _role_id <> _admin_role AND NOT EXISTS (SELECT 1 FROM public.role_permissions WHERE role_id = _role_id) THEN
    INSERT INTO public.role_permissions (organization_id, role_id, permission_id)
    SELECT _org, _role_id, p.id FROM public.permissions p ON CONFLICT DO NOTHING;
  END IF;

  INSERT INTO public.user_roles (organization_id, user_id, role_id) VALUES (_org, _uid, _admin_role) ON CONFLICT DO NOTHING;
  IF _role_id <> _admin_role THEN
    INSERT INTO public.user_roles (organization_id, user_id, role_id) VALUES (_org, _uid, _role_id) ON CONFLICT DO NOTHING;
  END IF;

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

  RETURN jsonb_build_object('status', CASE WHEN _created THEN 'created' ELSE 'recovered' END,
    'organization_id', _org, 'branch_id', _branch, 'department_id', _dept, 'role', _role_name, 'user_id', _uid);
END;
$fn$;

REVOKE ALL ON FUNCTION public.neo_provision_workspace_for(uuid) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.neo_reconcile_workspace()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  RETURN public.neo_provision_workspace_for(auth.uid());
END;
$fn$;

REVOKE ALL ON FUNCTION public.neo_reconcile_workspace() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.neo_reconcile_workspace() TO authenticated;

CREATE OR REPLACE FUNCTION public.neo_admin_recover_workspace(_user uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
BEGIN
  RETURN public.neo_provision_workspace_for(_user);
END;
$fn$;

REVOKE ALL ON FUNCTION public.neo_admin_recover_workspace(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.neo_admin_recover_workspace(uuid) TO service_role;

CREATE OR REPLACE FUNCTION public.my_effective_access()
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $fn$
  WITH me AS (SELECT p.* FROM public.profiles p WHERE p.id = auth.uid()),
  role_rows AS (
    SELECT r.id, r.name, r.access_scope FROM public.user_roles ur
    JOIN public.roles r ON r.id = ur.role_id WHERE ur.user_id = auth.uid()),
  perms AS (SELECT * FROM public.my_effective_permissions()),
  individual AS (
    SELECT up.effect, p.module, p.feature, p.action, up.valid_from, up.valid_until
    FROM public.user_permissions up JOIN public.permissions p ON p.id = up.permission_id
    WHERE up.user_id = auth.uid() AND up.organization_id = public.current_org_id())
  SELECT jsonb_build_object(
    'user_id', auth.uid(),
    'account_type', (SELECT coalesce(account_type,'staff') FROM me),
    'account_status', (SELECT account_status FROM me),
    'organization_id', public.current_org_id(),
    'profile_id', (SELECT id FROM me),
    'staff_id', (SELECT staff_id FROM me),
    'full_name', (SELECT full_name FROM me),
    'branch_ids', to_jsonb(coalesce(public.current_branch_ids(), '{}'::uuid[])),
    'active_branch_id', (SELECT branch_id FROM me),
    'department_ids', to_jsonb(coalesce(public.current_department_ids(), '{}'::uuid[])),
    'station_ids', to_jsonb(coalesce(public.current_station_ids(), '{}'::uuid[])),
    'access_scope', public.current_access_scope(),
    'is_org_admin', public.is_org_admin(),
    'role_ids', coalesce((SELECT jsonb_agg(DISTINCT id) FROM role_rows), '[]'::jsonb),
    'role_names', coalesce((SELECT jsonb_agg(DISTINCT name) FROM role_rows), '[]'::jsonb),
    'permissions', coalesce((SELECT jsonb_agg(jsonb_build_object('module', module, 'feature', feature, 'action', action)) FROM perms), '[]'::jsonb),
    'individual_grants', coalesce((SELECT jsonb_agg(jsonb_build_object('module', module, 'feature', feature, 'action', action, 'valid_from', valid_from, 'valid_until', valid_until)) FROM individual WHERE effect = 'grant'), '[]'::jsonb),
    'individual_denials', coalesce((SELECT jsonb_agg(jsonb_build_object('module', module, 'feature', feature, 'action', action, 'valid_from', valid_from, 'valid_until', valid_until)) FROM individual WHERE effect = 'deny'), '[]'::jsonb),
    'entitlements', coalesce((SELECT jsonb_object_agg(e.feature_key, e.enabled) FROM public.organization_entitlements e
      WHERE e.organization_id = public.current_org_id() AND (e.expires_at IS NULL OR e.expires_at >= current_date)), '{}'::jsonb),
    'dashboard_key', (SELECT public.dashboard_key_for_role(rr.name) FROM role_rows rr ORDER BY rr.name LIMIT 1),
    'setup_complete', (public.current_org_id() IS NOT NULL AND EXISTS (SELECT 1 FROM role_rows)
      AND array_length(public.current_branch_ids(), 1) IS NOT NULL),
    'state', CASE
      WHEN (SELECT id FROM me) IS NULL THEN 'no_account'
      WHEN coalesce((SELECT account_status FROM me), 'active') <> 'active' THEN 'suspended'
      WHEN public.current_org_id() IS NULL OR NOT EXISTS (SELECT 1 FROM role_rows)
        OR array_length(public.current_branch_ids(), 1) IS NULL THEN 'setup_incomplete'
      ELSE 'ready' END,
    'state_reason', CASE
      WHEN (SELECT id FROM me) IS NULL THEN
        CASE WHEN EXISTS (SELECT 1 FROM public.workspace_provisioning_attempts a
               WHERE a.user_id = auth.uid()
                  OR lower(a.email) = lower(coalesce((SELECT u.email FROM auth.users u WHERE u.id = auth.uid()), '')))
             THEN 'provisioning_incomplete' ELSE 'staff_record_missing' END
      WHEN coalesce((SELECT account_status FROM me), 'active') <> 'active' THEN 'account_suspended'
      WHEN (SELECT organization_id FROM me) IS NULL THEN 'membership_missing'
      WHEN public.current_org_id() IS NULL THEN 'membership_inactive'
      WHEN array_length(public.current_branch_ids(), 1) IS NULL THEN 'property_assignment_missing'
      WHEN NOT EXISTS (SELECT 1 FROM role_rows) THEN 'role_missing'
      WHEN array_length(public.current_department_ids(), 1) IS NULL THEN 'department_assignment_missing'
      ELSE 'ok' END,
    'recoverable', ((SELECT id FROM me) IS NULL AND EXISTS (
      SELECT 1 FROM public.workspace_provisioning_attempts a
       WHERE a.user_id = auth.uid()
          OR lower(a.email) = lower(coalesce((SELECT u.email FROM auth.users u WHERE u.id = auth.uid()), '')))),
    'access_version', public.my_permission_version(),
    'resolved_at', now());
$fn$;

REVOKE ALL ON FUNCTION public.my_effective_access() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.my_effective_access() TO authenticated;

DO $do$
DECLARE _u record; _res jsonb;
BEGIN
  FOR _u IN
    SELECT DISTINCT u.id, u.email FROM auth.users u
      JOIN public.workspace_provisioning_attempts a ON a.user_id = u.id OR lower(a.email) = lower(u.email)
     WHERE u.email_confirmed_at IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = u.id)
  LOOP
    BEGIN
      _res := public.neo_provision_workspace_for(_u.id);
      RAISE NOTICE 'recovered % -> %', _u.email, _res;
    EXCEPTION WHEN OTHERS THEN
      UPDATE public.workspace_provisioning_attempts
         SET status = 'failed', failure_reason = SQLERRM, updated_at = now()
       WHERE user_id = _u.id OR lower(email) = lower(_u.email);
      RAISE NOTICE 'recovery failed for %: %', _u.email, SQLERRM;
    END;
  END LOOP;
END;
$do$;