CREATE OR REPLACE FUNCTION public.log_audit_event(_action text, _module text DEFAULT 'administration'::text, _record_id text DEFAULT NULL::text, _previous jsonb DEFAULT NULL::jsonb, _new jsonb DEFAULT NULL::jsonb, _reason text DEFAULT NULL::text, _permission_used text DEFAULT NULL::text, _branch uuid DEFAULT NULL::uuid, _department uuid DEFAULT NULL::uuid, _station uuid DEFAULT NULL::uuid, _correlation text DEFAULT NULL::text, _delegation jsonb DEFAULT NULL::jsonb, _device text DEFAULT NULL::text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_org uuid := public.current_org_id();
  v_actor uuid := auth.uid();
  v_name text;
  v_roles text[];
  v_id uuid;
BEGIN
  IF v_actor IS NULL OR v_org IS NULL THEN RAISE EXCEPTION 'Authenticated organization context required'; END IF;
  SELECT p.full_name, coalesce(_branch, p.branch_id), coalesce(_department, p.department_id)
    INTO v_name, _branch, _department FROM public.profiles p WHERE p.id = v_actor;
  -- Roles are scoped to the active workspace: a multi-group user must never
  -- have roles from another workspace recorded against this entry.
  SELECT array_agg(DISTINCT r.name) INTO v_roles
    FROM public.user_roles ur JOIN public.roles r ON r.id = ur.role_id
   WHERE ur.user_id = v_actor AND ur.organization_id = v_org;
  INSERT INTO public.audit_logs (
    organization_id, branch_id, department_id, station_id, user_id, user_name,
    action, module, record_id, previous_value, new_value, reason, device,
    role_names, permission_used, correlation_id, delegation_context
  ) VALUES (
    v_org, _branch, _department, _station, v_actor, coalesce(v_name,''),
    _action, coalesce(_module,'administration'), _record_id, _previous, _new, _reason, _device,
    v_roles, _permission_used, coalesce(nullif(_correlation,''),gen_random_uuid()::text), _delegation
  ) RETURNING id INTO v_id;
  RETURN v_id;
END $function$;

CREATE OR REPLACE FUNCTION public.hr_leave_year_of(_org uuid, _on date)
 RETURNS integer
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT CASE
    WHEN EXTRACT(month FROM _on)::int < COALESCE((
      SELECT s.leave_year_start_month FROM public.hr_settings s
       WHERE s.organization_id = public.neo_assert_tenant_context(_org) LIMIT 1), 1)
      THEN EXTRACT(year FROM _on)::int - 1
    ELSE EXTRACT(year FROM _on)::int
  END;
$function$;

CREATE OR REPLACE FUNCTION public.provision_catalogue_roles(_org uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  _created integer := 0;
  _linked  integer := 0;
BEGIN
  IF _org IS NULL THEN
    RAISE EXCEPTION 'Workspace is required' USING ERRCODE = '22023';
  END IF;
  IF auth.uid() IS NOT NULL AND NOT public.is_org_admin_for(_org) THEN
    RAISE EXCEPTION 'Not permitted for this workspace' USING ERRCODE = '42501';
  END IF;

  WITH ins AS (
    INSERT INTO public.roles (organization_id, name, description, is_system, active, access_scope, template_key, follows_template)
    SELECT _org, c.role_name, c.summary, true, true, c.access_scope, c.role_key,
           EXISTS (SELECT 1 FROM public.role_feature_templates t WHERE t.role_key = c.role_key)
    FROM public.role_catalogue c
    ON CONFLICT (organization_id, name) DO UPDATE
      SET description  = EXCLUDED.description,
          access_scope = EXCLUDED.access_scope,
          is_system    = true,
          template_key = COALESCE(public.roles.template_key, EXCLUDED.template_key),
          updated_at   = now()
    RETURNING (xmax = 0) AS inserted
  )
  SELECT count(*) FILTER (WHERE inserted) INTO _created FROM ins;

  UPDATE public.roles r
     SET follows_template = true, updated_at = now()
   WHERE r.organization_id = _org
     AND r.is_system
     AND NOT r.follows_template
     AND EXISTS (SELECT 1 FROM public.role_feature_templates t WHERE t.role_key = r.template_key);
  GET DIAGNOSTICS _linked = ROW_COUNT;

  RETURN jsonb_build_object(
    'organization_id', _org,
    'roles_created', _created,
    'roles_linked_to_template', _linked,
    'permission_rows_materialised', 0
  );
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.provision_catalogue_roles(uuid) FROM authenticated, anon;

CREATE OR REPLACE FUNCTION public.bootstrap_tenant_for(_uid uuid, _org_name text, _full_name text)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $fn$
DECLARE
  _org uuid;
  _branch uuid;
  _owner_role uuid;
  _dept text;
  _idem text;
  _run uuid;
BEGIN
  IF _uid IS NULL THEN RAISE EXCEPTION 'No user supplied'; END IF;
  IF auth.uid() IS NOT NULL AND _uid <> auth.uid() THEN
    RAISE EXCEPTION 'Not permitted' USING ERRCODE = '42501';
  END IF;

  SELECT p.organization_id INTO _org FROM public.profiles p WHERE p.id = _uid;
  IF _org IS NOT NULL THEN
    RETURN _org;
  END IF;

  _idem := 'bootstrap:' || _uid::text;
  SELECT r.organization_id INTO _org FROM public.provisioning_runs r
   WHERE r.idempotency_key = _idem AND r.status = 'completed';
  IF _org IS NOT NULL THEN
    RETURN _org;
  END IF;

  INSERT INTO public.provisioning_runs (kind, subject_id, idempotency_key, status, current_step, created_by, payload)
  VALUES ('tenant', _uid, _idem, 'running', 'organization', _uid,
          jsonb_build_object('organization_name', _org_name))
  ON CONFLICT (idempotency_key) DO UPDATE
     SET attempts = public.provisioning_runs.attempts + 1,
         status = 'running',
         updated_at = now()
  RETURNING id INTO _run;

  INSERT INTO public.organizations (name, legal_name)
  VALUES (COALESCE(NULLIF(_org_name, ''), 'My Hospitality Group'),
          COALESCE(NULLIF(_org_name, ''), 'My Hospitality Group'))
  RETURNING id INTO _org;

  UPDATE public.provisioning_runs SET organization_id = _org, current_step = 'property', updated_at = now() WHERE id = _run;

  INSERT INTO public.branches (organization_id, name, code, is_main)
  VALUES (_org, 'Main Property', 'MAIN', true) RETURNING id INTO _branch;

  FOREACH _dept IN ARRAY ARRAY['Front Office','Restaurant','Bar','Kitchen','Housekeeping','Laundry',
    'Procurement','Inventory & Stores','Finance','Marketing','Events','Maintenance','Delivery','Human Resources','Administration'] LOOP
    INSERT INTO public.departments (organization_id, branch_id, name, code)
    VALUES (_org, _branch, _dept, upper(left(regexp_replace(_dept, '[^a-zA-Z]', '', 'g'), 4)))
    ON CONFLICT DO NOTHING;
  END LOOP;

  UPDATE public.provisioning_runs SET current_step = 'roles', updated_at = now() WHERE id = _run;

  INSERT INTO public.roles (organization_id, name, description, is_system, active, access_scope, template_key, follows_template)
  SELECT _org, c.role_name, c.summary, true, true, c.access_scope, c.role_key,
         EXISTS (SELECT 1 FROM public.role_feature_templates t WHERE t.role_key = c.role_key)
  FROM public.role_catalogue c
  ON CONFLICT (organization_id, name) DO NOTHING;

  SELECT r.id INTO _owner_role FROM public.roles r
   WHERE r.organization_id = _org AND r.name ILIKE 'Owner%'
   ORDER BY r.name LIMIT 1;
  IF _owner_role IS NULL THEN
    INSERT INTO public.roles (organization_id, name, description, is_system, active)
    VALUES (_org, 'Owner', 'Owner role', true, true) RETURNING id INTO _owner_role;
  END IF;

  UPDATE public.provisioning_runs SET current_step = 'identity', updated_at = now() WHERE id = _run;

  INSERT INTO public.profiles (id, organization_id, active_organization_id, account_type, full_name, email,
                               branch_id, department_id, job_title, invitation_status, created_by)
  VALUES (_uid, _org, _org, 'staff', COALESCE(NULLIF(_full_name, ''), 'Owner'),
          COALESCE((SELECT email FROM auth.users WHERE id = _uid), ''), _branch,
          (SELECT id FROM public.departments WHERE organization_id = _org AND name = 'Administration' LIMIT 1),
          'Owner', 'active', _uid)
  ON CONFLICT (id) DO UPDATE
     SET organization_id = COALESCE(public.profiles.organization_id, EXCLUDED.organization_id),
         active_organization_id = COALESCE(public.profiles.active_organization_id, EXCLUDED.active_organization_id);

  INSERT INTO public.organization_memberships (user_id, organization_id, membership_type, status, note)
  VALUES (_uid, _org, 'staff', 'active', 'Workspace owner created during provisioning')
  ON CONFLICT (user_id, organization_id) DO UPDATE SET status = 'active', updated_at = now();

  INSERT INTO public.user_roles (organization_id, user_id, role_id) VALUES (_org, _uid, _owner_role) ON CONFLICT DO NOTHING;
  INSERT INTO public.user_branches (organization_id, user_id, branch_id) VALUES (_org, _uid, _branch) ON CONFLICT DO NOTHING;
  INSERT INTO public.user_departments (organization_id, user_id, department_id)
  VALUES (_org, _uid, (SELECT id FROM public.departments WHERE organization_id = _org AND name = 'Administration' LIMIT 1))
  ON CONFLICT DO NOTHING;

  UPDATE public.provisioning_runs SET current_step = 'lifecycle', updated_at = now() WHERE id = _run;

  INSERT INTO public.tenant_lifecycle_states (organization_id, state, reason)
  VALUES (_org, 'active', 'Provisioned')
  ON CONFLICT (organization_id) DO NOTHING;

  INSERT INTO public.audit_logs (organization_id, action, module, record_id, new_value, reason, user_id)
  VALUES (_org, 'workspace.provisioned', 'platform', _org::text,
          jsonb_build_object('provisioning_run', _run, 'property', _branch), 'Workspace provisioning', _uid);

  UPDATE public.provisioning_runs
     SET status = 'completed', current_step = 'done', completed_at = now(), updated_at = now()
   WHERE id = _run;

  RETURN _org;
END;
$fn$;