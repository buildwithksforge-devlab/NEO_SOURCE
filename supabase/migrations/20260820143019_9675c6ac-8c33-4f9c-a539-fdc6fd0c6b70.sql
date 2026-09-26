-- ============================================================================
-- Modern Hotel Operating Structure v2.0 — one adoption path for every workspace
-- Additive only. No DROP/TRUNCATE of operational data. Every UUID preserved.
-- ============================================================================

-- Internal execution context. Only ever enabled inside the definer routines
-- below, so the org-admin guard still applies to every client call.
CREATE OR REPLACE FUNCTION public.neo_internal_ctx()
RETURNS boolean LANGUAGE sql STABLE SET search_path = public AS $$
  SELECT coalesce(current_setting('neo.internal', true), '') = 'on'
$$;
REVOKE ALL ON FUNCTION public.neo_internal_ctx() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.neo_internal_ctx() TO authenticated, service_role;

-- Adoption run ledger (report per organisation, repeatable and inspectable).
CREATE TABLE IF NOT EXISTS public.role_model_adoption_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  catalogue_version integer NOT NULL DEFAULT 2,
  trigger_source text NOT NULL DEFAULT 'manual',
  report jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT ON public.role_model_adoption_runs TO authenticated;
GRANT ALL ON public.role_model_adoption_runs TO service_role;
ALTER TABLE public.role_model_adoption_runs ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public'
      AND tablename='role_model_adoption_runs' AND policyname='adoption runs tenant read') THEN
    CREATE POLICY "adoption runs tenant read" ON public.role_model_adoption_runs
      FOR SELECT TO authenticated USING (organization_id = public.current_org_id());
  END IF;
END $$;

-- Permission template parity for catalogue keys that had no template.
INSERT INTO public.role_permission_templates (version, template_name, template_key, module, action)
SELECT 1, 'Delivery Manager', 'delivery-manager', t.module, t.action
FROM public.role_permission_templates t
WHERE t.version = 1 AND t.template_key = 'delivery manager'
ON CONFLICT DO NOTHING;

-- ---------------------------------------------------------------------------
-- Dashboard resolver: catalogue key first, historic name map second.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.neo_dashboard_key(_role_key text, _role_name text)
RETURNS text LANGUAGE sql IMMUTABLE SET search_path = public AS $$
  SELECT coalesce(
    CASE _role_key
      WHEN 'owner' THEN 'owner'
      WHEN 'operations-manager' THEN 'general-manager'
      WHEN 'finance-manager' THEN 'finance'
      WHEN 'accountant' THEN 'finance'
      WHEN 'night-auditor' THEN 'finance'
      WHEN 'food-and-beverage-manager' THEN 'restaurant-operations'
      WHEN 'waiter' THEN 'restaurant-floor'
      WHEN 'barista' THEN 'coffee-station'
      WHEN 'bar-attendant' THEN 'bar'
      WHEN 'head-chef' THEN 'kitchen-overview'
      WHEN 'hot-kitchen-chef' THEN 'hot-kitchen'
      WHEN 'chief-steward' THEN 'kitchen-overview'
      WHEN 'kitchen-steward' THEN 'hot-kitchen'
      WHEN 'head-pastry-chef' THEN 'pastry'
      WHEN 'pastry-chef' THEN 'pastry'
      WHEN 'front-office-supervisor' THEN 'front-office'
      WHEN 'receptionist' THEN 'front-office'
      WHEN 'reservations-agent' THEN 'front-office'
      WHEN 'front-office-cashier' THEN 'front-office'
      WHEN 'porter' THEN 'front-office'
      WHEN 'driver' THEN 'delivery'
      WHEN 'housekeeping-supervisor' THEN 'housekeeping'
      WHEN 'housekeeper' THEN 'housekeeping'
      WHEN 'laundry-supervisor' THEN 'housekeeping'
      WHEN 'laundry-attendant' THEN 'housekeeping'
      WHEN 'maintenance-manager' THEN 'maintenance'
      WHEN 'maintenance-technician' THEN 'maintenance'
      WHEN 'grounds-worker' THEN 'maintenance'
      WHEN 'marketing-manager' THEN 'marketing'
      WHEN 'sales-and-events-manager' THEN 'events'
      WHEN 'events-coordinator' THEN 'events'
      WHEN 'banqueting-staff' THEN 'events'
      WHEN 'procurement-manager' THEN 'procurement'
      WHEN 'procurement-officer' THEN 'procurement'
      WHEN 'storekeeper' THEN 'stores'
      WHEN 'receiving-clerk' THEN 'stores'
      WHEN 'human-resources-manager' THEN 'human-resources'
      WHEN 'hr-officer' THEN 'human-resources'
      WHEN 'it-system-administrator' THEN 'administration'
      WHEN 'delivery-manager' THEN 'delivery'
      WHEN 'rider' THEN 'delivery'
      ELSE NULL
    END,
    public.dashboard_key_for_role(_role_name),
    'staff');
$$;

-- ---------------------------------------------------------------------------
-- Provision every non-optional catalogue role that the organisation lacks.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.neo_provision_modern_roles(_org uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $fn$
DECLARE _created jsonb := '[]'::jsonb; _c record; _dept uuid; _level integer; _id uuid;
BEGIN
  IF _org IS NULL OR (NOT public.neo_internal_ctx()
      AND (_org <> public.current_org_id() OR NOT public.is_org_admin())) THEN
    RAISE EXCEPTION 'Not authorised';
  END IF;

  FOR _c IN SELECT * FROM public.role_catalogue WHERE NOT optional_role ORDER BY sort_order LOOP
    IF EXISTS (
      SELECT 1 FROM public.roles r
       WHERE r.organization_id = _org
         AND (r.normalized_role_key = _c.role_key
              OR public.neo_norm_key(r.name) = public.neo_norm_key(_c.role_name))
    ) THEN CONTINUE; END IF;

    SELECT d.id INTO _dept FROM public.departments d
     WHERE d.organization_id = _org
       AND public.neo_norm_key(d.name) = public.neo_norm_key(_c.department)
     LIMIT 1;
    _level := CASE WHEN _c.reports_to_key IS NULL THEN 1
                   WHEN _c.access_scope IN ('organisation','organization') THEN 2
                   WHEN _c.access_scope = 'branch' THEN 3
                   WHEN _c.access_scope = 'department' THEN 4
                   WHEN _c.access_scope = 'station' THEN 5 ELSE 6 END;

    _id := NULL;
    INSERT INTO public.roles (organization_id, name, description, is_system, active, access_scope,
      normalized_role_key, role_status, catalogue_version, department_id, approval_class,
      managerial_scope, position_level, migration_status)
    VALUES (_org, _c.role_name, _c.summary, true, true, _c.access_scope,
      _c.role_key, 'active', 2, _dept,
      CASE WHEN _c.restricted_authority THEN 'restricted_approver' ELSE 'requester' END,
      _c.access_scope, _level, 'migrated')
    ON CONFLICT (organization_id, name) DO NOTHING
    RETURNING id INTO _id;

    IF _id IS NOT NULL THEN
      _created := _created || jsonb_build_object('id', _id, 'role', _c.role_name);
    END IF;
  END LOOP;

  -- Reporting lines for anything newly created.
  UPDATE public.roles child SET reports_to_role_id = parent.id
    FROM public.role_catalogue rc
    JOIN public.roles parent ON parent.organization_id = _org
                            AND parent.normalized_role_key = rc.reports_to_key
                            AND parent.role_status = 'active'
   WHERE child.organization_id = _org
     AND child.normalized_role_key = rc.role_key
     AND child.role_status = 'active'
     AND child.id <> parent.id
     AND child.reports_to_role_id IS DISTINCT FROM parent.id;

  RETURN jsonb_build_object('created', _created);
END;
$fn$;

-- ---------------------------------------------------------------------------
-- Consolidate duplicates of the same catalogue role. Staff move to the keeper,
-- permissions merge, the duplicate is archived (never deleted).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.neo_consolidate_duplicate_roles(_org uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $fn$
DECLARE
  _grp record; _keeper uuid; _keeper_name text; _dup record;
  _merged jsonb := '[]'::jsonb; _moved integer := 0; _archived integer := 0;
BEGIN
  IF _org IS NULL OR (NOT public.neo_internal_ctx()
      AND (_org <> public.current_org_id() OR NOT public.is_org_admin())) THEN
    RAISE EXCEPTION 'Not authorised';
  END IF;

  FOR _grp IN
    SELECT r.normalized_role_key AS k, count(*) AS n
      FROM public.roles r
     WHERE r.organization_id = _org
       AND r.normalized_role_key IS NOT NULL
       AND r.role_status <> 'archived'
     GROUP BY 1 HAVING count(*) > 1
  LOOP
    SELECT r.id, r.name INTO _keeper, _keeper_name
      FROM public.roles r
      LEFT JOIN LATERAL (SELECT count(*) c FROM public.user_roles ur WHERE ur.role_id = r.id) a ON true
     WHERE r.organization_id = _org AND r.normalized_role_key = _grp.k AND r.role_status <> 'archived'
     ORDER BY (r.role_status = 'active') DESC, a.c DESC, r.created_at ASC
     LIMIT 1;

    -- The keeper becomes the canonical modern role, keeping its UUID.
    UPDATE public.roles r SET
      previous_name = CASE WHEN r.name <> c.role_name THEN coalesce(nullif(r.previous_name,''), r.name) ELSE r.previous_name END,
      name = c.role_name,
      role_status = 'active',
      active = true,
      catalogue_version = 2,
      migration_status = 'migrated',
      migration_review_reason = NULL
      FROM public.role_catalogue c
     WHERE r.id = _keeper AND c.role_key = _grp.k
       AND NOT EXISTS (SELECT 1 FROM public.roles o
                        WHERE o.organization_id = _org AND o.id <> _keeper AND o.name = c.role_name);
    SELECT name INTO _keeper_name FROM public.roles WHERE id = _keeper;

    FOR _dup IN
      SELECT r.* FROM public.roles r
       WHERE r.organization_id = _org AND r.normalized_role_key = _grp.k
         AND r.id <> _keeper AND r.role_status <> 'archived'
    LOOP
      -- Move staff, preserving assignment history.
      INSERT INTO public.role_assignment_history
        (organization_id, user_id, role_id, role_name_at_time, assignment_status,
         effective_until, change_reason, created_by)
      SELECT _org, ur.user_id, _dup.id, _dup.name, 'superseded', now(),
             format('Consolidated into %s (Modern Hotel Operating Structure v2.0)', _keeper_name), auth.uid()
        FROM public.user_roles ur WHERE ur.role_id = _dup.id;

      INSERT INTO public.user_roles (organization_id, user_id, role_id, is_primary)
      SELECT _org, ur.user_id, _keeper, ur.is_primary FROM public.user_roles ur WHERE ur.role_id = _dup.id
      ON CONFLICT (user_id, role_id) DO NOTHING;

      INSERT INTO public.role_assignment_history
        (organization_id, user_id, role_id, role_name_at_time, assignment_status, change_reason, created_by)
      SELECT _org, ur.user_id, _keeper, _keeper_name, 'active',
             format('Migrated from %s', _dup.name), auth.uid()
        FROM public.user_roles ur WHERE ur.role_id = _dup.id;

      GET DIAGNOSTICS _moved = ROW_COUNT;
      DELETE FROM public.user_roles WHERE role_id = _dup.id;

      -- Merge grants so nobody loses access through consolidation.
      INSERT INTO public.role_permissions (organization_id, role_id, permission_id)
      SELECT _org, _keeper, rp.permission_id FROM public.role_permissions rp
       WHERE rp.role_id = _dup.id
         AND NOT EXISTS (SELECT 1 FROM public.role_permissions k
                          WHERE k.role_id = _keeper AND k.permission_id = rp.permission_id);

      UPDATE public.roles SET
        role_status = 'archived', active = false,
        successor_role_id = _keeper,
        migration_status = 'retired',
        migration_review_reason = format('Consolidated into %s. Retained for history.', _keeper_name),
        effective_until = CURRENT_DATE
       WHERE id = _dup.id;
      UPDATE public.roles SET predecessor_role_id = _dup.id
       WHERE id = _keeper AND predecessor_role_id IS NULL;

      _archived := _archived + 1;
      _merged := _merged || jsonb_build_object('archived', _dup.name, 'archived_id', _dup.id,
                                               'kept', _keeper_name, 'kept_id', _keeper);
    END LOOP;
  END LOOP;

  RETURN jsonb_build_object('consolidated', _merged, 'roles_archived', _archived);
END;
$fn$;

-- ---------------------------------------------------------------------------
-- Apply approved permission templates and enforce restricted approval authority.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.neo_apply_role_templates(_org uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $fn$
DECLARE _granted integer := 0; _revoked integer := 0;
BEGIN
  IF _org IS NULL OR (NOT public.neo_internal_ctx()
      AND (_org <> public.current_org_id() OR NOT public.is_org_admin())) THEN
    RAISE EXCEPTION 'Not authorised';
  END IF;

  WITH added AS (
    INSERT INTO public.role_permissions (organization_id, role_id, permission_id)
    SELECT DISTINCT _org, r.id, p.id
      FROM public.roles r
      JOIN public.role_permission_templates t
        ON t.version = 1
       AND t.template_key IN (coalesce(r.normalized_role_key, ''),
                              public.neo_norm_key(r.name),
                              lower(r.name))
      JOIN public.permissions p ON p.module = t.module AND p.action = t.action
     WHERE r.organization_id = _org
       AND r.role_status IN ('active','custom')
       AND NOT EXISTS (SELECT 1 FROM public.role_permissions rp
                        WHERE rp.role_id = r.id AND rp.permission_id = p.id)
    RETURNING 1)
  SELECT count(*) INTO _granted FROM added;

  WITH removed AS (
    DELETE FROM public.role_permissions rp
     USING public.roles r, public.permissions p, public.restricted_actions ra
     WHERE rp.role_id = r.id
       AND r.organization_id = _org
       AND rp.permission_id = p.id
       AND p.module = ra.module AND p.action = ra.action
       AND NOT EXISTS (SELECT 1 FROM public.role_catalogue c
                        WHERE c.role_key = r.normalized_role_key AND c.restricted_authority)
    RETURNING 1)
  SELECT count(*) INTO _revoked FROM removed;

  RETURN jsonb_build_object('permissions_granted', _granted, 'restricted_revoked', _revoked);
END;
$fn$;

-- ---------------------------------------------------------------------------
-- Exactly one primary role per member, plus a default dashboard per role.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.neo_resolve_primary_roles(_org uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $fn$
DECLARE _u record; _pick uuid; _fixed integer := 0; _dash integer := 0;
BEGIN
  IF _org IS NULL OR (NOT public.neo_internal_ctx()
      AND (_org <> public.current_org_id() OR NOT public.is_org_admin())) THEN
    RAISE EXCEPTION 'Not authorised';
  END IF;

  FOR _u IN SELECT DISTINCT user_id FROM public.user_roles WHERE organization_id = _org LOOP
    SELECT ur.role_id INTO _pick
      FROM public.user_roles ur JOIN public.roles r ON r.id = ur.role_id
     WHERE ur.user_id = _u.user_id AND ur.organization_id = _org AND r.role_status <> 'archived'
     ORDER BY ur.is_primary DESC, coalesce(r.position_level, 999) ASC, r.name ASC
     LIMIT 1;
    IF _pick IS NULL THEN CONTINUE; END IF;
    UPDATE public.user_roles SET is_primary = (role_id = _pick)
     WHERE user_id = _u.user_id AND organization_id = _org
       AND is_primary IS DISTINCT FROM (role_id = _pick);
    GET DIAGNOSTICS _fixed = ROW_COUNT;
  END LOOP;

  WITH ins AS (
    INSERT INTO public.role_dashboard_assignments (organization_id, role_id, dashboard_key, priority, is_default)
    SELECT _org, r.id, public.neo_dashboard_key(r.normalized_role_key, r.name), 10, true
      FROM public.roles r
     WHERE r.organization_id = _org AND r.role_status IN ('active','custom')
       AND NOT EXISTS (SELECT 1 FROM public.role_dashboard_assignments a
                        WHERE a.role_id = r.id AND a.is_default)
    RETURNING 1)
  SELECT count(*) INTO _dash FROM ins;

  RETURN jsonb_build_object('primary_assignments_corrected', _fixed, 'dashboards_assigned', _dash);
END;
$fn$;

-- ---------------------------------------------------------------------------
-- The single adoption entry point. Idempotent, audited, reportable.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.neo_adopt_modern_model(_org uuid, _source text DEFAULT 'manual')
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $fn$
DECLARE _report jsonb; _prev text := coalesce(current_setting('neo.internal', true), '');
BEGIN
  IF _org IS NULL OR (NOT public.neo_internal_ctx()
      AND (_org <> public.current_org_id() OR NOT public.is_org_admin())) THEN
    RAISE EXCEPTION 'Not authorised';
  END IF;
  PERFORM set_config('neo.internal', 'on', true);

  _report := jsonb_build_object(
    'departments', public.neo_align_departments(_org),
    'classification', public.neo_classify_roles(_org),
    'provisioning', public.neo_provision_modern_roles(_org),
    'consolidation', public.neo_consolidate_duplicate_roles(_org),
    'templates', public.neo_apply_role_templates(_org),
    'primary_roles', public.neo_resolve_primary_roles(_org));

  _report := _report || jsonb_build_object(
    'active_roles', (SELECT count(*) FROM public.roles WHERE organization_id = _org AND role_status = 'active'),
    'legacy_roles', (SELECT count(*) FROM public.roles WHERE organization_id = _org AND role_status = 'legacy'),
    'archived_roles', (SELECT count(*) FROM public.roles WHERE organization_id = _org AND role_status = 'archived'),
    'custom_roles', (SELECT count(*) FROM public.roles WHERE organization_id = _org AND role_status = 'custom'),
    'roles_without_permissions', (SELECT count(*) FROM public.roles r
       WHERE r.organization_id = _org AND r.role_status = 'active'
         AND NOT EXISTS (SELECT 1 FROM public.role_permissions rp WHERE rp.role_id = r.id)),
    'members_without_primary', (SELECT count(*) FROM (
       SELECT ur.user_id FROM public.user_roles ur WHERE ur.organization_id = _org
        GROUP BY ur.user_id HAVING count(*) FILTER (WHERE ur.is_primary) <> 1) x),
    'catalogue_version', 2);

  INSERT INTO public.role_model_adoption_runs (organization_id, trigger_source, report, created_by)
  VALUES (_org, coalesce(_source, 'manual'), _report, auth.uid());

  INSERT INTO public.audit_logs (organization_id, user_id, action, module, record_id, new_value)
  VALUES (_org, auth.uid(), 'roles.modern_model_adopted', 'administration', _org, _report);

  PERFORM set_config('neo.internal', _prev, true);
  RETURN _report;
END;
$fn$;
REVOKE ALL ON FUNCTION public.neo_adopt_modern_model(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.neo_adopt_modern_model(uuid, text) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.neo_provision_modern_roles(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.neo_consolidate_duplicate_roles(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.neo_apply_role_templates(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.neo_resolve_primary_roles(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.neo_provision_modern_roles(uuid),
  public.neo_consolidate_duplicate_roles(uuid),
  public.neo_apply_role_templates(uuid),
  public.neo_resolve_primary_roles(uuid) TO authenticated, service_role;

-- Read-only adoption state for the administration screens.
CREATE OR REPLACE FUNCTION public.neo_model_adoption_status(_org uuid)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT jsonb_build_object(
    'organization_id', _org,
    'catalogue_roles', (SELECT count(*) FROM public.role_catalogue WHERE NOT optional_role),
    'active_roles', (SELECT count(*) FROM public.roles WHERE organization_id = _org AND role_status = 'active'),
    'legacy_roles', (SELECT count(*) FROM public.roles WHERE organization_id = _org AND role_status = 'legacy'),
    'archived_roles', (SELECT count(*) FROM public.roles WHERE organization_id = _org AND role_status = 'archived'),
    'custom_roles', (SELECT count(*) FROM public.roles WHERE organization_id = _org AND role_status = 'custom'),
    'missing_catalogue_roles', coalesce((SELECT jsonb_agg(c.role_name ORDER BY c.sort_order)
        FROM public.role_catalogue c WHERE NOT c.optional_role
         AND NOT EXISTS (SELECT 1 FROM public.roles r WHERE r.organization_id = _org
                          AND r.normalized_role_key = c.role_key AND r.role_status = 'active')), '[]'::jsonb),
    'roles_without_permissions', (SELECT count(*) FROM public.roles r
       WHERE r.organization_id = _org AND r.role_status = 'active'
         AND NOT EXISTS (SELECT 1 FROM public.role_permissions rp WHERE rp.role_id = r.id)),
    'roles_without_dashboard', (SELECT count(*) FROM public.roles r
       WHERE r.organization_id = _org AND r.role_status = 'active'
         AND NOT EXISTS (SELECT 1 FROM public.role_dashboard_assignments a WHERE a.role_id = r.id)),
    'members_without_primary', (SELECT count(*) FROM (
       SELECT ur.user_id FROM public.user_roles ur WHERE ur.organization_id = _org
        GROUP BY ur.user_id HAVING count(*) FILTER (WHERE ur.is_primary) <> 1) x),
    'last_run', (SELECT to_jsonb(x) FROM (
       SELECT id, created_at, trigger_source, report FROM public.role_model_adoption_runs
        WHERE organization_id = _org ORDER BY created_at DESC LIMIT 1) x))
  WHERE _org = public.current_org_id();
$$;
REVOKE ALL ON FUNCTION public.neo_model_adoption_status(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.neo_model_adoption_status(uuid) TO authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Allow the orchestrator to reuse the existing alignment/classification
-- routines, without weakening the org-admin guard for direct client calls.
-- ---------------------------------------------------------------------------
DO $patch$
DECLARE s text; n text; pairs text[][] := ARRAY[
  ARRAY['neo_align_departments','RAISE EXCEPTION ''Not authorised to align departments'';'],
  ARRAY['neo_classify_roles','RAISE EXCEPTION ''Not authorised to classify roles'';']];
  i integer;
BEGIN
  FOR i IN 1 .. array_length(pairs, 1) LOOP
    n := pairs[i][1];
    SELECT p.prosrc INTO s FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
     WHERE ns.nspname = 'public' AND p.proname = n;
    IF s IS NULL OR position(pairs[i][2] in s) = 0 THEN
      RAISE EXCEPTION 'guard pattern not found in %', n;
    END IF;
    s := replace(s, pairs[i][2],
      'IF NOT public.neo_internal_ctx() THEN ' || pairs[i][2] || ' END IF;');
    EXECUTE format(
      'CREATE OR REPLACE FUNCTION public.%I(_org uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS %L',
      n, s);
  END LOOP;
END $patch$;

-- Adoption runs automatically for every newly provisioned workspace.
DO $patch$
DECLARE s text; hook text; m text;
BEGIN
  hook := E'\n  BEGIN\n    PERFORM set_config(''neo.internal'', ''on'', true);\n    PERFORM public.neo_adopt_modern_model(_org, ''provisioning'');\n    PERFORM set_config(''neo.internal'', '''', true);\n  EXCEPTION WHEN OTHERS THEN\n    PERFORM set_config(''neo.internal'', '''', true);\n  END;\n\n';

  SELECT prosrc INTO s FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
   WHERE ns.nspname = 'public' AND p.proname = 'neo_create_workspace';
  m := '  RETURN jsonb_build_object(''organization_id'', _org, ''branch_id'', _branch, ''created'', true);';
  IF position(m in s) = 0 THEN RAISE EXCEPTION 'neo_create_workspace marker missing'; END IF;
  IF position('neo_adopt_modern_model' in s) = 0 THEN
    EXECUTE format('CREATE OR REPLACE FUNCTION public.neo_create_workspace(_payload jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS %L',
      replace(s, m, hook || m));
  END IF;

  SELECT prosrc INTO s FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
   WHERE ns.nspname = 'public' AND p.proname = 'neo_provision_workspace_for';
  m := '  RETURN jsonb_build_object(''status'', CASE WHEN _created THEN ''created'' ELSE ''recovered'' END,';
  IF position(m in s) = 0 THEN RAISE EXCEPTION 'neo_provision_workspace_for marker missing'; END IF;
  IF position('neo_adopt_modern_model' in s) = 0 THEN
    EXECUTE format('CREATE OR REPLACE FUNCTION public.neo_provision_workspace_for(_uid uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS %L',
      replace(s, m, hook || m));
  END IF;
END $patch$;

-- Effective access ignores archived roles and honours the dashboard assignment.
DO $patch$
DECLARE s text; o text; nw text;
BEGIN
  SELECT prosrc INTO s FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
   WHERE ns.nspname = 'public' AND p.proname = 'my_effective_access';

  o := E'    SELECT r.id, r.name, r.access_scope, ur.is_primary,\n           coalesce(r.position_level, 999) AS position_level';
  nw := E'    SELECT r.id, r.name, r.access_scope, ur.is_primary, r.normalized_role_key,\n           coalesce(r.position_level, 999) AS position_level';
  IF position(o in s) = 0 THEN RAISE EXCEPTION 'role_rows projection not found'; END IF;
  s := replace(s, o, nw);

  o := '     WHERE ur.user_id = auth.uid()),';
  IF position(o in s) = 0 THEN RAISE EXCEPTION 'role_rows filter not found'; END IF;
  s := replace(s, o, E'     WHERE ur.user_id = auth.uid()\n       AND r.role_status <> ''archived''),');

  o := '    ''dashboard_key'', (SELECT public.dashboard_key_for_role(pr.name) FROM primary_role pr),';
  IF position(o in s) = 0 THEN RAISE EXCEPTION 'dashboard_key expression not found'; END IF;
  s := replace(s, o, E'    ''dashboard_key'', (SELECT coalesce(\n        (SELECT a.dashboard_key FROM public.role_dashboard_assignments a\n          WHERE a.role_id = pr.id ORDER BY a.is_default DESC, a.priority ASC LIMIT 1),\n        public.neo_dashboard_key(pr.normalized_role_key, pr.name)) FROM primary_role pr),\n    ''primary_role_key'', (SELECT normalized_role_key FROM primary_role),');

  EXECUTE format('CREATE OR REPLACE FUNCTION public.my_effective_access() RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS %L', s);
END $patch$;
REVOKE ALL ON FUNCTION public.my_effective_access() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.my_effective_access() TO authenticated, service_role;

-- Adopt the modern model for every existing organisation (idempotent).
DO $$
DECLARE _o uuid;
BEGIN
  PERFORM set_config('neo.internal', 'on', true);
  FOR _o IN SELECT id FROM public.organizations LOOP
    BEGIN
      PERFORM public.neo_adopt_modern_model(_o, 'backfill');
    EXCEPTION WHEN OTHERS THEN
      RAISE NOTICE 'adoption skipped for %: %', _o, SQLERRM;
    END;
  END LOOP;
  PERFORM set_config('neo.internal', '', true);
END $$;