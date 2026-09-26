-- Authority must never depend on a display name.
CREATE OR REPLACE FUNCTION public.is_org_admin()
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT public.is_active_staff() AND EXISTS (
    SELECT 1 FROM public.user_roles ur
    JOIN public.roles r ON r.id = ur.role_id
    WHERE ur.user_id = auth.uid()
      AND ur.organization_id = public.current_org_id()
      AND r.organization_id = public.current_org_id()
      AND r.role_status <> 'archived'
      AND (
        r.normalized_role_key IN ('owner','it-system-administrator')
        OR r.name IN ('Owner','System Administrator','IT/System Administrator','Owner / Director / Super User')
      )
  );
$$;

CREATE OR REPLACE FUNCTION public.can_approve_restricted()
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.user_roles ur
    JOIN public.roles r ON r.id = ur.role_id
    LEFT JOIN public.role_catalogue c ON c.role_key = r.normalized_role_key
    WHERE ur.user_id = auth.uid()
      AND ur.organization_id = public.current_org_id()
      AND r.role_status <> 'archived'
      AND (r.approval_class = 'restricted_approver' OR coalesce(c.restricted_authority, false))
  );
$$;

-- Template lookup that accepts either the catalogue key or the display name.
CREATE OR REPLACE FUNCTION public.neo_template_permissions(_role_key text, _role_name text)
RETURNS TABLE(module text, action text)
LANGUAGE sql STABLE SET search_path = public AS $$
  SELECT DISTINCT t.module, t.action
  FROM public.role_permission_templates t
  WHERE t.version = 1
    AND t.template_key IN (coalesce(_role_key,''), public.neo_norm_key(_role_name));
$$;

-- ---------------------------------------------------------------------------
-- Preflight
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.neo_role_migration_preflight(_org uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE _out jsonb;
BEGIN
  IF _org IS NULL OR _org <> public.current_org_id() OR NOT public.is_org_admin() THEN
    RAISE EXCEPTION 'Not authorised';
  END IF;

  SELECT jsonb_build_object(
    'roles_total', (SELECT count(*) FROM roles WHERE organization_id = _org),
    'roles_active', (SELECT count(*) FROM roles WHERE organization_id = _org AND role_status = 'active'),
    'roles_legacy', (SELECT count(*) FROM roles WHERE organization_id = _org AND role_status = 'legacy'),
    'roles_archived', (SELECT count(*) FROM roles WHERE organization_id = _org AND role_status = 'archived'),
    'roles_custom', (SELECT count(*) FROM roles WHERE organization_id = _org AND role_status = 'custom'),
    'departments_total', (SELECT count(*) FROM departments WHERE organization_id = _org),
    'stations_total', (SELECT count(*) FROM operational_stations WHERE organization_id = _org),
    'staff_total', (SELECT count(*) FROM profiles WHERE organization_id = _org AND coalesce(account_type,'staff') <> 'customer'),
    'duplicate_role_keys', (
      SELECT coalesce(jsonb_agg(jsonb_build_object('key', k, 'roles', names)), '[]'::jsonb) FROM (
        SELECT public.neo_norm_key(name) k, jsonb_agg(name) names
        FROM roles WHERE organization_id = _org GROUP BY 1 HAVING count(*) > 1) d),
    'duplicate_departments', (
      SELECT coalesce(jsonb_agg(jsonb_build_object('name', k, 'count', c)), '[]'::jsonb) FROM (
        SELECT public.neo_norm_key(name) k, count(*) c
        FROM departments WHERE organization_id = _org GROUP BY 1 HAVING count(*) > 1) d),
    'users_on_predecessor_roles', (
      SELECT coalesce(jsonb_agg(jsonb_build_object('user', p.full_name, 'role', r.name)), '[]'::jsonb)
      FROM user_roles ur JOIN roles r ON r.id = ur.role_id JOIN profiles p ON p.id = ur.user_id
      WHERE ur.organization_id = _org AND r.role_status = 'legacy'),
    'users_multiple_roles', (
      SELECT coalesce(jsonb_agg(jsonb_build_object('user', full_name, 'roles', roles)), '[]'::jsonb) FROM (
        SELECT p.full_name, jsonb_agg(r.name ORDER BY r.name) roles
        FROM user_roles ur JOIN roles r ON r.id = ur.role_id JOIN profiles p ON p.id = ur.user_id
        WHERE ur.organization_id = _org GROUP BY p.id, p.full_name HAVING count(*) > 1) m),
    'users_without_roles', (
      SELECT coalesce(jsonb_agg(p.full_name), '[]'::jsonb) FROM profiles p
      WHERE p.organization_id = _org AND coalesce(p.account_type,'staff') <> 'customer'
        AND NOT EXISTS (SELECT 1 FROM user_roles ur WHERE ur.user_id = p.id)),
    'users_without_property', (
      SELECT coalesce(jsonb_agg(p.full_name), '[]'::jsonb) FROM profiles p
      WHERE p.organization_id = _org AND coalesce(p.account_type,'staff') <> 'customer' AND p.branch_id IS NULL),
    'users_without_department', (
      SELECT coalesce(jsonb_agg(p.full_name), '[]'::jsonb) FROM profiles p
      WHERE p.organization_id = _org AND coalesce(p.account_type,'staff') <> 'customer' AND p.department_id IS NULL),
    'users_without_station', (
      SELECT coalesce(jsonb_agg(p.full_name), '[]'::jsonb) FROM profiles p
      WHERE p.organization_id = _org AND coalesce(p.account_type,'staff') <> 'customer'
        AND NOT EXISTS (SELECT 1 FROM user_stations us WHERE us.user_id = p.id)),
    'departments_without_manager', (
      SELECT coalesce(jsonb_agg(d.name ORDER BY d.name), '[]'::jsonb) FROM departments d
      WHERE d.organization_id = _org AND d.department_status = 'active' AND d.manager_id IS NULL),
    'roles_with_custom_grants', (
      SELECT coalesce(jsonb_agg(jsonb_build_object('role', r.name, 'grants', g.c)), '[]'::jsonb)
      FROM roles r JOIN (SELECT role_id, count(*) c FROM role_permissions GROUP BY 1) g ON g.role_id = r.id
      WHERE r.organization_id = _org AND r.role_status IN ('legacy','custom')),
    'individual_grants', (SELECT count(*) FROM user_permissions up
      JOIN profiles p ON p.id = up.user_id WHERE p.organization_id = _org),
    'workflow_role_references', jsonb_build_object(
      'approval_rules', (SELECT count(*) FROM approval_rules ar JOIN roles r ON r.id = ar.approver_role_id WHERE r.organization_id = _org),
      'task_rules', (SELECT count(*) FROM task_assignment_rules tr JOIN roles r ON r.id = tr.assignee_role_id WHERE r.organization_id = _org),
      'notification_rules', (SELECT count(*) FROM notification_rules nr JOIN roles r ON r.id = nr.recipient_role_id WHERE r.organization_id = _org),
      'dashboard_assignments', (SELECT count(*) FROM role_dashboard_assignments da JOIN roles r ON r.id = da.role_id WHERE r.organization_id = _org)),
    'review_required_roles', (
      SELECT coalesce(jsonb_agg(jsonb_build_object('role', name, 'reason', migration_review_reason)), '[]'::jsonb)
      FROM roles WHERE organization_id = _org AND migration_status = 'review_required')
  ) INTO _out;

  RETURN _out;
END;
$$;
REVOKE EXECUTE ON FUNCTION public.neo_role_migration_preflight(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.neo_role_migration_preflight(uuid) TO authenticated;

-- ---------------------------------------------------------------------------
-- Planning: builds a draft run. Changes nothing operational.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.neo_plan_role_migration(_org uuid, _idempotency_key text)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  _run uuid;
  _r record;
  _alias record;
  _cat record;
  _target uuid;
  _dept uuid;
  _gained jsonb; _retained jsonb; _removed jsonb;
  _cur_key text; _new_key text;
  _restricted text;
BEGIN
  IF _org IS NULL OR _org <> public.current_org_id() OR NOT public.is_org_admin() THEN
    RAISE EXCEPTION 'Not authorised';
  END IF;

  SELECT id INTO _run FROM role_migration_runs
   WHERE organization_id = _org AND idempotency_key = _idempotency_key;
  IF _run IS NOT NULL THEN
    IF (SELECT status FROM role_migration_runs WHERE id = _run) IN ('completed','executing') THEN
      RETURN _run;
    END IF;
    DELETE FROM role_migration_items WHERE run_id = _run;
  ELSE
    INSERT INTO role_migration_runs (organization_id, idempotency_key, created_by)
    VALUES (_org, _idempotency_key, auth.uid()) RETURNING id INTO _run;
  END IF;

  FOR _r IN
    SELECT ur.user_id, p.full_name, p.job_title, r.id AS role_id, r.name AS role_name,
           r.normalized_role_key, r.role_status
      FROM user_roles ur
      JOIN roles r ON r.id = ur.role_id
      JOIN profiles p ON p.id = ur.user_id
     WHERE ur.organization_id = _org AND coalesce(p.account_type,'staff') <> 'customer'
     ORDER BY p.full_name, r.name
  LOOP
    SELECT * INTO _alias FROM role_catalogue_aliases WHERE alias_key = public.neo_norm_key(_r.role_name);

    IF _alias IS NULL THEN
      INSERT INTO role_migration_items (run_id, organization_id, item_kind, subject_user_id, subject_label,
        current_role_id, ambiguous, migration_reason)
      VALUES (_run, _org, 'user_role_review', _r.user_id, _r.full_name, _r.role_id, true,
        format('%s has no approved catalogue equivalent. An authorised administrator must decide.', _r.role_name));
      CONTINUE;
    END IF;

    SELECT * INTO _cat FROM role_catalogue WHERE role_key = _alias.role_key;

    SELECT id INTO _target FROM roles
      WHERE organization_id = _org
        AND (normalized_role_key = _cat.role_key OR public.neo_norm_key(name) = public.neo_norm_key(_cat.role_name))
        AND role_status <> 'archived'
      ORDER BY (role_status = 'active') DESC LIMIT 1;

    SELECT id INTO _dept FROM departments
      WHERE organization_id = _org AND public.neo_norm_key(name) = public.neo_norm_key(_cat.department) LIMIT 1;

    _cur_key := coalesce(_r.normalized_role_key, public.neo_norm_key(_r.role_name));
    _new_key := _cat.role_key;

    SELECT coalesce(jsonb_agg(module || '.' || action ORDER BY module, action), '[]'::jsonb) INTO _gained
      FROM public.neo_template_permissions(_new_key, _cat.role_name) n
     WHERE NOT EXISTS (SELECT 1 FROM public.neo_template_permissions(_cur_key, _r.role_name) c
                        WHERE c.module = n.module AND c.action = n.action);
    SELECT coalesce(jsonb_agg(module || '.' || action ORDER BY module, action), '[]'::jsonb) INTO _retained
      FROM public.neo_template_permissions(_new_key, _cat.role_name) n
     WHERE EXISTS (SELECT 1 FROM public.neo_template_permissions(_cur_key, _r.role_name) c
                        WHERE c.module = n.module AND c.action = n.action);
    SELECT coalesce(jsonb_agg(module || '.' || action ORDER BY module, action), '[]'::jsonb) INTO _removed
      FROM public.neo_template_permissions(_cur_key, _r.role_name) c
     WHERE NOT EXISTS (SELECT 1 FROM public.neo_template_permissions(_new_key, _cat.role_name) n
                        WHERE c.module = n.module AND c.action = n.action);

    _restricted := CASE
      WHEN _cat.restricted_authority THEN 'retained'
      WHEN EXISTS (SELECT 1 FROM role_catalogue c2
                    WHERE c2.role_key = _cur_key AND c2.restricted_authority) THEN 'removed'
      ELSE 'none' END;

    INSERT INTO role_migration_items (run_id, organization_id, item_kind, subject_user_id, subject_label,
      current_role_id, proposed_role_id, proposed_role_key, target_department_id, target_station_id,
      manager_candidate, ambiguous, options, permissions_gained, permissions_retained, permissions_removed,
      restricted_authority_change, migration_reason, decision)
    VALUES (_run, _org,
      CASE WHEN _alias.ambiguous THEN 'user_role_review'
           WHEN _target = _r.role_id THEN 'user_role_retained'
           ELSE 'user_role_migrate' END,
      _r.user_id, _r.full_name, _r.role_id, _target, _cat.role_key, _dept,
      (SELECT us.station_id FROM user_stations us WHERE us.user_id = _r.user_id ORDER BY us.is_primary DESC LIMIT 1),
      (_cat.multiplicity = 'single' AND _cat.access_scope IN ('department','branch','organisation')),
      _alias.ambiguous,
      CASE WHEN _alias.ambiguous THEN jsonb_build_array(
             jsonb_build_object('role_key', _cat.role_key, 'label', _cat.role_name),
             jsonb_build_object('role_key', 'retain-custom', 'label', 'Retain as a custom role'))
           ELSE '[]'::jsonb END,
      _gained, _retained, _removed, _restricted,
      CASE WHEN _alias.ambiguous THEN _alias.review_reason
           WHEN _target = _r.role_id THEN format('%s already matches the approved catalogue.', _r.role_name)
           ELSE format('%s maps to %s in the approved catalogue.', _r.role_name, _cat.role_name) END,
      CASE WHEN _alias.ambiguous THEN 'pending'
           WHEN _target = _r.role_id THEN 'skipped' ELSE 'pending' END);
  END LOOP;

  UPDATE role_migration_runs
     SET status = 'previewed', preflight = public.neo_role_migration_preflight(_org), updated_at = now()
   WHERE id = _run;

  RETURN _run;
END;
$$;
REVOKE EXECUTE ON FUNCTION public.neo_plan_role_migration(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.neo_plan_role_migration(uuid, text) TO authenticated;
