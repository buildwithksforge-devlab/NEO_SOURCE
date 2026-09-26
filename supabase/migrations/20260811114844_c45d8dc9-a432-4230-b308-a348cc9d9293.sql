
-- =========================================================
-- PHASE 2 — CORE PLATFORM FOUNDATION
-- =========================================================

CREATE OR REPLACE FUNCTION public.touch_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql SET search_path = public AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END; $$;

-- ---------- organizations ----------
CREATE TABLE public.organizations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  legal_name text NOT NULL DEFAULT '',
  business_type text NOT NULL DEFAULT 'hotel',
  description text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.branches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  name text NOT NULL,
  code text NOT NULL DEFAULT '',
  address text NOT NULL DEFAULT '',
  phone text NOT NULL DEFAULT '',
  email text NOT NULL DEFAULT '',
  is_main boolean NOT NULL DEFAULT false,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.departments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  branch_id uuid REFERENCES public.branches(id) ON DELETE SET NULL,
  name text NOT NULL,
  code text NOT NULL DEFAULT '',
  description text NOT NULL DEFAULT '',
  manager_id uuid,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.roles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  name text NOT NULL,
  description text NOT NULL DEFAULT '',
  branch_scope text NOT NULL DEFAULT 'all',
  department_id uuid REFERENCES public.departments(id) ON DELETE SET NULL,
  is_system boolean NOT NULL DEFAULT false,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, name)
);

CREATE TABLE public.permissions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  module text NOT NULL,
  action text NOT NULL,
  label text NOT NULL,
  UNIQUE (module, action)
);

CREATE TABLE public.role_permissions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  role_id uuid NOT NULL REFERENCES public.roles(id) ON DELETE CASCADE,
  permission_id uuid NOT NULL REFERENCES public.permissions(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (role_id, permission_id)
);

CREATE TABLE public.profiles (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  full_name text NOT NULL DEFAULT '',
  staff_id text NOT NULL DEFAULT '',
  email text NOT NULL DEFAULT '',
  phone text NOT NULL DEFAULT '',
  avatar_url text,
  branch_id uuid REFERENCES public.branches(id) ON DELETE SET NULL,
  department_id uuid REFERENCES public.departments(id) ON DELETE SET NULL,
  job_title text NOT NULL DEFAULT '',
  employment_status text NOT NULL DEFAULT 'full-time',
  account_status text NOT NULL DEFAULT 'active',
  must_change_password boolean NOT NULL DEFAULT false,
  last_login_at timestamptz,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.user_roles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  user_id uuid NOT NULL,
  role_id uuid NOT NULL REFERENCES public.roles(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, role_id)
);

CREATE TABLE public.user_branches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  user_id uuid NOT NULL,
  branch_id uuid NOT NULL REFERENCES public.branches(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, branch_id)
);

CREATE TABLE public.user_departments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  user_id uuid NOT NULL,
  department_id uuid NOT NULL REFERENCES public.departments(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, department_id)
);

CREATE TABLE public.approval_types (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  key text NOT NULL,
  name text NOT NULL,
  levels integer NOT NULL DEFAULT 1,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, key)
);

CREATE TABLE public.approval_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  branch_id uuid REFERENCES public.branches(id) ON DELETE SET NULL,
  department_id uuid REFERENCES public.departments(id) ON DELETE SET NULL,
  reference text NOT NULL DEFAULT '',
  approval_type text NOT NULL,
  requester_id uuid NOT NULL,
  approver_id uuid,
  reason text NOT NULL DEFAULT '',
  notes text NOT NULL DEFAULT '',
  attachment_url text,
  amount numeric,
  level integer NOT NULL DEFAULT 1,
  max_level integer NOT NULL DEFAULT 1,
  status text NOT NULL DEFAULT 'pending',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.approval_actions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  request_id uuid NOT NULL REFERENCES public.approval_requests(id) ON DELETE CASCADE,
  actor_id uuid NOT NULL,
  action text NOT NULL,
  comment text NOT NULL DEFAULT '',
  level integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.audit_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  branch_id uuid,
  department_id uuid,
  user_id uuid,
  user_name text NOT NULL DEFAULT '',
  action text NOT NULL,
  module text NOT NULL DEFAULT 'administration',
  record_id text,
  previous_value jsonb,
  new_value jsonb,
  reason text,
  device text,
  ip_address text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.notifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  user_id uuid,
  branch_id uuid,
  department_id uuid,
  category text NOT NULL DEFAULT 'system-alert',
  title text NOT NULL,
  body text NOT NULL DEFAULT '',
  link text,
  priority text NOT NULL DEFAULT 'normal',
  read_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.notification_preferences (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  user_id uuid NOT NULL UNIQUE,
  in_app boolean NOT NULL DEFAULT true,
  email boolean NOT NULL DEFAULT true,
  whatsapp boolean NOT NULL DEFAULT false,
  sms boolean NOT NULL DEFAULT false,
  push boolean NOT NULL DEFAULT false,
  categories jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.tasks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  branch_id uuid REFERENCES public.branches(id) ON DELETE SET NULL,
  department_id uuid REFERENCES public.departments(id) ON DELETE SET NULL,
  reference text NOT NULL DEFAULT '',
  title text NOT NULL,
  description text NOT NULL DEFAULT '',
  assignee_id uuid,
  created_by uuid,
  due_at timestamptz,
  priority text NOT NULL DEFAULT 'normal',
  status text NOT NULL DEFAULT 'new',
  progress integer NOT NULL DEFAULT 0,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.system_settings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL UNIQUE REFERENCES public.organizations(id) ON DELETE CASCADE,
  settings jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.number_sequences (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  doc_type text NOT NULL,
  prefix text NOT NULL,
  year integer NOT NULL DEFAULT date_part('year', now())::int,
  padding integer NOT NULL DEFAULT 6,
  next_number integer NOT NULL DEFAULT 1,
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, doc_type)
);

-- ---------- helper functions ----------
CREATE OR REPLACE FUNCTION public.current_org_id()
RETURNS uuid LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT organization_id FROM public.profiles WHERE id = auth.uid();
$$;

CREATE OR REPLACE FUNCTION public.is_org_admin()
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.user_roles ur
    JOIN public.roles r ON r.id = ur.role_id
    WHERE ur.user_id = auth.uid()
      AND r.name IN ('Owner', 'System Administrator')
  );
$$;

CREATE OR REPLACE FUNCTION public.has_permission(_module text, _action text)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT public.is_org_admin() OR EXISTS (
    SELECT 1 FROM public.user_roles ur
    JOIN public.roles r ON r.id = ur.role_id AND r.active
    JOIN public.role_permissions rp ON rp.role_id = r.id
    JOIN public.permissions p ON p.id = rp.permission_id
    WHERE ur.user_id = auth.uid() AND p.module = _module AND p.action = _action
  );
$$;

-- ---------- grants + RLS ----------
GRANT SELECT ON public.permissions TO authenticated;
GRANT ALL ON public.permissions TO service_role;
ALTER TABLE public.permissions ENABLE ROW LEVEL SECURITY;
CREATE POLICY "permissions readable" ON public.permissions FOR SELECT TO authenticated USING (true);

-- organizations
GRANT SELECT, INSERT, UPDATE, DELETE ON public.organizations TO authenticated;
GRANT ALL ON public.organizations TO service_role;
ALTER TABLE public.organizations ENABLE ROW LEVEL SECURITY;
CREATE POLICY "own org read" ON public.organizations FOR SELECT TO authenticated USING (id = public.current_org_id());
CREATE POLICY "own org update" ON public.organizations FOR UPDATE TO authenticated USING (id = public.current_org_id() AND public.is_org_admin());

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'branches','departments','roles','role_permissions','user_roles','user_branches',
    'user_departments','approval_types','system_settings','number_sequences'
  ] LOOP
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON public.%I TO authenticated;', t);
    EXECUTE format('GRANT ALL ON public.%I TO service_role;', t);
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY;', t);
    EXECUTE format('CREATE POLICY "%1$s tenant read" ON public.%1$I FOR SELECT TO authenticated USING (organization_id = public.current_org_id());', t);
    EXECUTE format('CREATE POLICY "%1$s admin write" ON public.%1$I FOR INSERT TO authenticated WITH CHECK (organization_id = public.current_org_id() AND public.is_org_admin());', t);
    EXECUTE format('CREATE POLICY "%1$s admin update" ON public.%1$I FOR UPDATE TO authenticated USING (organization_id = public.current_org_id() AND public.is_org_admin());', t);
    EXECUTE format('CREATE POLICY "%1$s admin delete" ON public.%1$I FOR DELETE TO authenticated USING (organization_id = public.current_org_id() AND public.is_org_admin());', t);
  END LOOP;
END $$;

-- profiles
GRANT SELECT, INSERT, UPDATE, DELETE ON public.profiles TO authenticated;
GRANT ALL ON public.profiles TO service_role;
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
CREATE POLICY "profiles tenant read" ON public.profiles FOR SELECT TO authenticated
  USING (id = auth.uid() OR organization_id = public.current_org_id());
CREATE POLICY "profiles self insert" ON public.profiles FOR INSERT TO authenticated WITH CHECK (id = auth.uid());
CREATE POLICY "profiles self update" ON public.profiles FOR UPDATE TO authenticated
  USING (id = auth.uid() OR (organization_id = public.current_org_id() AND public.is_org_admin()));
CREATE POLICY "profiles admin delete" ON public.profiles FOR DELETE TO authenticated
  USING (organization_id = public.current_org_id() AND public.is_org_admin());

-- approval requests
GRANT SELECT, INSERT, UPDATE, DELETE ON public.approval_requests TO authenticated;
GRANT ALL ON public.approval_requests TO service_role;
ALTER TABLE public.approval_requests ENABLE ROW LEVEL SECURITY;
CREATE POLICY "approvals tenant read" ON public.approval_requests FOR SELECT TO authenticated
  USING (organization_id = public.current_org_id());
CREATE POLICY "approvals insert" ON public.approval_requests FOR INSERT TO authenticated
  WITH CHECK (organization_id = public.current_org_id() AND requester_id = auth.uid());
CREATE POLICY "approvals update" ON public.approval_requests FOR UPDATE TO authenticated
  USING (organization_id = public.current_org_id()
    AND (requester_id = auth.uid() OR approver_id = auth.uid() OR public.is_org_admin()));

GRANT SELECT, INSERT ON public.approval_actions TO authenticated;
GRANT ALL ON public.approval_actions TO service_role;
ALTER TABLE public.approval_actions ENABLE ROW LEVEL SECURITY;
CREATE POLICY "approval actions read" ON public.approval_actions FOR SELECT TO authenticated
  USING (organization_id = public.current_org_id());
CREATE POLICY "approval actions insert" ON public.approval_actions FOR INSERT TO authenticated
  WITH CHECK (organization_id = public.current_org_id() AND actor_id = auth.uid());

-- audit logs: append-only, admin read
GRANT SELECT, INSERT ON public.audit_logs TO authenticated;
GRANT ALL ON public.audit_logs TO service_role;
ALTER TABLE public.audit_logs ENABLE ROW LEVEL SECURITY;
CREATE POLICY "audit admin read" ON public.audit_logs FOR SELECT TO authenticated
  USING (organization_id = public.current_org_id() AND (public.is_org_admin() OR user_id = auth.uid()));
CREATE POLICY "audit insert" ON public.audit_logs FOR INSERT TO authenticated
  WITH CHECK (organization_id = public.current_org_id() AND user_id = auth.uid());

-- notifications
GRANT SELECT, INSERT, UPDATE, DELETE ON public.notifications TO authenticated;
GRANT ALL ON public.notifications TO service_role;
ALTER TABLE public.notifications ENABLE ROW LEVEL SECURITY;
CREATE POLICY "notifications read" ON public.notifications FOR SELECT TO authenticated
  USING (organization_id = public.current_org_id() AND (user_id IS NULL OR user_id = auth.uid()));
CREATE POLICY "notifications insert" ON public.notifications FOR INSERT TO authenticated
  WITH CHECK (organization_id = public.current_org_id());
CREATE POLICY "notifications update" ON public.notifications FOR UPDATE TO authenticated
  USING (organization_id = public.current_org_id() AND (user_id IS NULL OR user_id = auth.uid()));
CREATE POLICY "notifications delete" ON public.notifications FOR DELETE TO authenticated
  USING (organization_id = public.current_org_id() AND user_id = auth.uid());

GRANT SELECT, INSERT, UPDATE ON public.notification_preferences TO authenticated;
GRANT ALL ON public.notification_preferences TO service_role;
ALTER TABLE public.notification_preferences ENABLE ROW LEVEL SECURITY;
CREATE POLICY "prefs read" ON public.notification_preferences FOR SELECT TO authenticated USING (user_id = auth.uid());
CREATE POLICY "prefs insert" ON public.notification_preferences FOR INSERT TO authenticated
  WITH CHECK (user_id = auth.uid() AND organization_id = public.current_org_id());
CREATE POLICY "prefs update" ON public.notification_preferences FOR UPDATE TO authenticated USING (user_id = auth.uid());

-- tasks
GRANT SELECT, INSERT, UPDATE, DELETE ON public.tasks TO authenticated;
GRANT ALL ON public.tasks TO service_role;
ALTER TABLE public.tasks ENABLE ROW LEVEL SECURITY;
CREATE POLICY "tasks tenant read" ON public.tasks FOR SELECT TO authenticated
  USING (organization_id = public.current_org_id());
CREATE POLICY "tasks insert" ON public.tasks FOR INSERT TO authenticated
  WITH CHECK (organization_id = public.current_org_id() AND created_by = auth.uid());
CREATE POLICY "tasks update" ON public.tasks FOR UPDATE TO authenticated
  USING (organization_id = public.current_org_id()
    AND (assignee_id = auth.uid() OR created_by = auth.uid() OR public.is_org_admin()));
CREATE POLICY "tasks delete" ON public.tasks FOR DELETE TO authenticated
  USING (organization_id = public.current_org_id() AND (created_by = auth.uid() OR public.is_org_admin()));

-- updated_at triggers
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['organizations','branches','departments','roles','profiles','approval_types',
    'approval_requests','tasks','system_settings','number_sequences','notification_preferences'] LOOP
    EXECUTE format('CREATE TRIGGER %1$s_touch BEFORE UPDATE ON public.%1$I FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();', t);
  END LOOP;
END $$;

-- ---------- permission catalogue ----------
INSERT INTO public.permissions (module, action, label)
SELECT m, a, initcap(replace(a,'-',' ')) || ' · ' || initcap(replace(m,'-',' '))
FROM unnest(ARRAY['front-office','restaurant','bar','kitchen','housekeeping','laundry','procurement',
  'stores','finance','marketing','events','maintenance','delivery','human-resources','administration','reports']) m
CROSS JOIN unnest(ARRAY['view','create','edit','delete','approve','reject','export','print','override','void','refund']) a
ON CONFLICT DO NOTHING;

-- ---------- tenant bootstrap ----------
CREATE OR REPLACE FUNCTION public.bootstrap_tenant(_org_name text, _full_name text)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  _uid uuid := auth.uid();
  _org uuid;
  _branch uuid;
  _owner_role uuid;
  _dept text;
  _role text;
  _rid uuid;
  _seq record;
BEGIN
  IF _uid IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  SELECT organization_id INTO _org FROM public.profiles WHERE id = _uid;
  IF _org IS NOT NULL THEN RETURN _org; END IF;

  INSERT INTO public.organizations (name, legal_name)
  VALUES (COALESCE(NULLIF(_org_name,''), 'My Hospitality Group'), COALESCE(NULLIF(_org_name,''), 'My Hospitality Group'))
  RETURNING id INTO _org;

  INSERT INTO public.branches (organization_id, name, code, is_main)
  VALUES (_org, 'Main Property', 'MAIN', true) RETURNING id INTO _branch;

  FOREACH _dept IN ARRAY ARRAY['Front Office','Restaurant','Bar','Kitchen','Housekeeping','Laundry',
    'Procurement','Stores','Finance','Marketing','Events','Maintenance','Delivery','Human Resources','Administration'] LOOP
    INSERT INTO public.departments (organization_id, branch_id, name, code)
    VALUES (_org, _branch, _dept, upper(left(regexp_replace(_dept,'[^a-zA-Z]','','g'),4)));
  END LOOP;

  FOREACH _role IN ARRAY ARRAY['Owner','System Administrator','General Manager','Finance Manager','Accountant',
    'Front Office Manager','Receptionist','Restaurant Manager','Waiter','Bar Attendant','Kitchen Manager','Chef',
    'Procurement Officer','Storekeeper','Housekeeping Supervisor','Housekeeper','Maintenance Officer',
    'Marketing Manager','Events Manager','Human Resources','Delivery Manager','Rider','Guest'] LOOP
    INSERT INTO public.roles (organization_id, name, description, is_system)
    VALUES (_org, _role, _role || ' role', true) RETURNING id INTO _rid;
    IF _role = 'Owner' THEN _owner_role := _rid; END IF;
  END LOOP;

  INSERT INTO public.role_permissions (organization_id, role_id, permission_id)
  SELECT _org, _owner_role, p.id FROM public.permissions p;

  INSERT INTO public.profiles (id, organization_id, full_name, email, branch_id, job_title, created_by)
  VALUES (_uid, _org, COALESCE(NULLIF(_full_name,''),'Owner'),
          COALESCE((SELECT email FROM auth.users WHERE id = _uid), ''), _branch, 'Owner', _uid);

  INSERT INTO public.user_roles (organization_id, user_id, role_id) VALUES (_org, _uid, _owner_role);
  INSERT INTO public.user_branches (organization_id, user_id, branch_id) VALUES (_org, _uid, _branch);

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
  ));

  INSERT INTO public.notifications (organization_id, user_id, category, title, body)
  VALUES (_org, _uid, 'system-alert', 'Welcome to your Hospitality OS',
          'Your organisation workspace is ready. Start by adding staff, roles and departments.');

  RETURN _org;
END; $$;

REVOKE ALL ON FUNCTION public.bootstrap_tenant(text, text) FROM public;
GRANT EXECUTE ON FUNCTION public.bootstrap_tenant(text, text) TO authenticated;

-- next document number generator
CREATE OR REPLACE FUNCTION public.next_document_number(_doc_type text)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE _org uuid := public.current_org_id(); _row public.number_sequences;
BEGIN
  UPDATE public.number_sequences SET next_number = next_number + 1, updated_at = now()
  WHERE organization_id = _org AND doc_type = _doc_type RETURNING * INTO _row;
  IF _row.id IS NULL THEN RETURN upper(left(_doc_type,3)) || '-' || to_char(now(),'YYYY') || '-000001'; END IF;
  RETURN _row.prefix || '-' || _row.year::text || '-' || lpad(_row.next_number::text, _row.padding, '0');
END; $$;
GRANT EXECUTE ON FUNCTION public.next_document_number(text) TO authenticated;
