-- Decide a single reviewed item.
CREATE OR REPLACE FUNCTION public.neo_decide_migration_item(
  _item uuid, _decision text, _override_role_id uuid DEFAULT NULL, _reason text DEFAULT ''
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE _org uuid;
BEGIN
  SELECT organization_id INTO _org FROM role_migration_items WHERE id = _item;
  IF _org IS NULL OR _org <> public.current_org_id() OR NOT public.is_org_admin() THEN
    RAISE EXCEPTION 'Not authorised';
  END IF;
  IF _decision NOT IN ('approved','rejected','pending') THEN
    RAISE EXCEPTION 'Unsupported decision %', _decision;
  END IF;
  UPDATE role_migration_items
     SET decision = _decision,
         proposed_role_id = COALESCE(_override_role_id, proposed_role_id),
         migration_reason = CASE WHEN coalesce(_reason,'') = '' THEN migration_reason ELSE _reason END,
         decided_by = auth.uid(), decided_at = now()
   WHERE id = _item AND decision NOT IN ('applied');
  RETURN jsonb_build_object('ok', FOUND);
END;
$$;
REVOKE EXECUTE ON FUNCTION public.neo_decide_migration_item(uuid, text, uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.neo_decide_migration_item(uuid, text, uuid, text) TO authenticated;

CREATE OR REPLACE FUNCTION public.neo_approve_role_migration(_run uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE _org uuid; _pending integer;
BEGIN
  SELECT organization_id INTO _org FROM role_migration_runs WHERE id = _run;
  IF _org IS NULL OR _org <> public.current_org_id() OR NOT public.is_org_admin() THEN
    RAISE EXCEPTION 'Not authorised';
  END IF;
  SELECT count(*) INTO _pending FROM role_migration_items
   WHERE run_id = _run AND ambiguous AND decision = 'pending';
  IF _pending > 0 THEN
    RAISE EXCEPTION 'Resolve the % ambiguous assignment(s) awaiting human review first', _pending;
  END IF;
  UPDATE role_migration_runs SET status = 'approved', approved_by = auth.uid(), approved_at = now(), updated_at = now()
   WHERE id = _run AND status IN ('draft','previewed','approved');
  RETURN jsonb_build_object('ok', FOUND);
END;
$$;
REVOKE EXECUTE ON FUNCTION public.neo_approve_role_migration(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.neo_approve_role_migration(uuid) TO authenticated;

-- Restricted authority: derived from approval class, never from a role name.
CREATE OR REPLACE FUNCTION public.neo_apply_restricted_authority(_org uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE _granted integer := 0; _revoked integer := 0;
BEGIN
  IF _org IS NULL OR _org <> public.current_org_id() OR NOT public.is_org_admin() THEN
    RAISE EXCEPTION 'Not authorised';
  END IF;

  CREATE TEMP TABLE _restricted ON COMMIT DROP AS
  SELECT p.id, p.module, p.action,
         CASE WHEN p.action LIKE '%.request' THEN 'request' ELSE 'approve_execute' END AS tier
  FROM permissions p
  WHERE (p.module, p.action) IN (
      ('pos','void.request'),('pos','void.approve'),('pos','void.execute'),
      ('pos','discount.request'),('pos','discount.approve'),('pos','discount.execute'),
      ('pos','complimentary.request'),('pos','complimentary.approve'),('pos','complimentary.execute'),
      ('finance','refunds.request'),('finance','refunds.approve'),('finance','refunds.execute'),
      ('finance','payments.reverse.request'),('finance','payments.reverse.approve'),('finance','payments.reverse.execute'),
      ('pms','folios.reopen.request'),('pms','folios.reopen.approve'),('pms','folios.reopen.execute'),
      ('pms','charges.reverse.request'),('pms','charges.reverse.approve'),('pms','charges.reverse.execute'),
      ('pricing','override.request'),('pricing','override.approve'),('pricing','override.execute'),
      ('pos','voids.approve'),('pos','discounts.approve'),('pos','complimentary.approve'),
      ('pos','refunds.approve'),('pos','bills.reopen'),('pos','pricing.manage'),
      ('pms','rate_override.approve'),('pms','refunds.approve'),('pms','complimentary.approve'),
      ('pms','folios.reopen'),('pms','folios.adjust')
  );

  -- Approvers receive the full request/approve/execute set.
  INSERT INTO role_permissions (organization_id, role_id, permission_id)
  SELECT _org, r.id, x.id
    FROM roles r CROSS JOIN _restricted x
   WHERE r.organization_id = _org AND r.approval_class = 'restricted_approver' AND r.role_status = 'active'
     AND NOT EXISTS (SELECT 1 FROM role_permissions rp WHERE rp.role_id = r.id AND rp.permission_id = x.id);
  GET DIAGNOSTICS _granted = ROW_COUNT;

  -- Everyone else loses approve/execute and keeps only the request permission.
  DELETE FROM role_permissions rp
   USING roles r, _restricted x
   WHERE rp.role_id = r.id AND rp.permission_id = x.id
     AND r.organization_id = _org
     AND r.approval_class IS DISTINCT FROM 'restricted_approver'
     AND x.tier = 'approve_execute';
  GET DIAGNOSTICS _revoked = ROW_COUNT;

  -- Operational roles that already work in a module may request a correction there.
  INSERT INTO role_permissions (organization_id, role_id, permission_id)
  SELECT DISTINCT _org, r.id, x.id
    FROM roles r
    JOIN role_permissions rp ON rp.role_id = r.id
    JOIN permissions p ON p.id = rp.permission_id
    JOIN _restricted x ON x.module = p.module AND x.tier = 'request'
   WHERE r.organization_id = _org AND r.role_status = 'active'
     AND NOT EXISTS (SELECT 1 FROM role_permissions rp2 WHERE rp2.role_id = r.id AND rp2.permission_id = x.id);

  RETURN jsonb_build_object('granted', _granted, 'revoked', _revoked);
END;
$$;
REVOKE EXECUTE ON FUNCTION public.neo_apply_restricted_authority(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.neo_apply_restricted_authority(uuid) TO authenticated;

-- Execute an approved run. Idempotent: a completed run returns its report.
CREATE OR REPLACE FUNCTION public.neo_execute_role_migration(_run uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  _org uuid; _status text; _it record; _report jsonb; _dept_report jsonb; _role_report jsonb;
  _applied integer := 0; _managers integer := 0; _copied integer := 0; _restricted jsonb;
BEGIN
  SELECT organization_id, status INTO _org, _status FROM role_migration_runs WHERE id = _run;
  IF _org IS NULL OR _org <> public.current_org_id() OR NOT public.is_org_admin() THEN
    RAISE EXCEPTION 'Not authorised';
  END IF;
  IF _status = 'completed' THEN
    RETURN (SELECT report FROM role_migration_runs WHERE id = _run);
  END IF;
  IF _status <> 'approved' THEN
    RAISE EXCEPTION 'The migration must be approved before it can run';
  END IF;

  UPDATE role_migration_runs SET status = 'executing', updated_at = now() WHERE id = _run;

  _dept_report := public.neo_align_departments(_org);
  _role_report := public.neo_classify_roles(_org);

  FOR _it IN
    SELECT * FROM role_migration_items
     WHERE run_id = _run AND decision = 'approved' AND proposed_role_id IS NOT NULL
       AND subject_user_id IS NOT NULL
  LOOP
    IF _it.proposed_role_id = _it.current_role_id THEN
      UPDATE role_migration_items SET decision = 'applied', applied_at = now(),
             apply_result = jsonb_build_object('note','Role already canonical; assignment untouched.')
       WHERE id = _it.id;
      CONTINUE;
    END IF;

    -- End-date the former assignment without overwriting anything.
    UPDATE role_assignment_history
       SET effective_until = now(), assignment_status = 'ended'
     WHERE user_id = _it.subject_user_id AND role_id = _it.current_role_id AND effective_until IS NULL;
    IF NOT FOUND THEN
      INSERT INTO role_assignment_history (organization_id, user_id, role_id, role_name_at_time,
        branch_id, department_id, department_name_at_time, assignment_status, effective_until,
        change_reason, migration_item_id, created_by)
      SELECT _org, _it.subject_user_id, _it.current_role_id, r.name, p.branch_id, p.department_id,
             coalesce(d.name,''), 'ended', now(),
             'Recorded at migration time from the live assignment.', _it.id, auth.uid()
        FROM roles r LEFT JOIN profiles p ON p.id = _it.subject_user_id
        LEFT JOIN departments d ON d.id = p.department_id
       WHERE r.id = _it.current_role_id;
    END IF;

    INSERT INTO user_roles (organization_id, user_id, role_id)
    VALUES (_org, _it.subject_user_id, _it.proposed_role_id)
    ON CONFLICT (user_id, role_id) DO NOTHING;

    DELETE FROM user_roles WHERE user_id = _it.subject_user_id AND role_id = _it.current_role_id;

    UPDATE user_stations SET role_id = _it.proposed_role_id
     WHERE user_id = _it.subject_user_id AND role_id = _it.current_role_id;

    IF _it.target_department_id IS NOT NULL THEN
      UPDATE profiles SET department_id = _it.target_department_id WHERE id = _it.subject_user_id;
    END IF;

    INSERT INTO role_assignment_history (organization_id, user_id, role_id, role_name_at_time, branch_id,
      department_id, department_name_at_time, station_id, assignment_type, assignment_status,
      change_reason, migration_item_id, created_by)
    SELECT _org, _it.subject_user_id, _it.proposed_role_id, r.name, p.branch_id,
           coalesce(_it.target_department_id, p.department_id), coalesce(d.name,''), _it.target_station_id,
           'primary', 'active', _it.migration_reason, _it.id, auth.uid()
      FROM roles r LEFT JOIN profiles p ON p.id = _it.subject_user_id
      LEFT JOIN departments d ON d.id = coalesce(_it.target_department_id, p.department_id)
     WHERE r.id = _it.proposed_role_id;

    INSERT INTO audit_logs (organization_id, user_id, user_name, action, module, record_id, previous_value, new_value, reason)
    SELECT _org, auth.uid(), coalesce((SELECT full_name FROM profiles WHERE id = auth.uid()),''),
           'role.migration.assignment_moved', 'administration', _it.subject_user_id,
           jsonb_build_object('role_id', _it.current_role_id, 'role', (SELECT name FROM roles WHERE id = _it.current_role_id)),
           jsonb_build_object('role_id', _it.proposed_role_id, 'role', (SELECT name FROM roles WHERE id = _it.proposed_role_id),
                              'department_id', _it.target_department_id),
           _it.migration_reason;

    UPDATE role_migration_items SET decision = 'applied', applied_at = now(),
           apply_result = jsonb_build_object('moved', true) WHERE id = _it.id;
    _applied := _applied + 1;

    -- Vacant department manager positions may be filled; occupied ones are never overwritten.
    IF _it.manager_candidate AND _it.target_department_id IS NOT NULL THEN
      UPDATE departments SET manager_id = _it.subject_user_id
       WHERE id = _it.target_department_id AND manager_id IS NULL;
      IF FOUND THEN _managers := _managers + 1; END IF;
    END IF;
  END LOOP;

  -- Copy valid custom grants from a predecessor onto its successor (never restricted authority).
  INSERT INTO role_permissions (organization_id, role_id, permission_id)
  SELECT DISTINCT _org, r.successor_role_id, rp.permission_id
    FROM roles r
    JOIN role_permissions rp ON rp.role_id = r.id
    JOIN permissions p ON p.id = rp.permission_id
   WHERE r.organization_id = _org AND r.role_status = 'legacy' AND r.successor_role_id IS NOT NULL
     AND p.action NOT LIKE '%approve%' AND p.action NOT LIKE '%execute%'
     AND p.action NOT IN ('override','void','refund','delete')
     AND NOT EXISTS (SELECT 1 FROM role_permissions rp2
                      WHERE rp2.role_id = r.successor_role_id AND rp2.permission_id = rp.permission_id);
  GET DIAGNOSTICS _copied = ROW_COUNT;

  -- Modern roles receive their recommended template (existing grants are kept).
  INSERT INTO role_permissions (organization_id, role_id, permission_id)
  SELECT DISTINCT _org, r.id, p.id
    FROM roles r
    JOIN role_catalogue c ON c.role_key = r.normalized_role_key
    JOIN public.neo_template_permissions(c.role_key, c.role_name) t ON true
    JOIN permissions p ON p.module = t.module AND p.action = t.action
   WHERE r.organization_id = _org AND r.role_status = 'active'
     AND NOT EXISTS (SELECT 1 FROM role_permissions rp WHERE rp.role_id = r.id AND rp.permission_id = p.id);

  _restricted := public.neo_apply_restricted_authority(_org);

  _report := jsonb_build_object(
    'departments', _dept_report,
    'roles', _role_report,
    'assignments_migrated', _applied,
    'department_managers_assigned', _managers,
    'custom_grants_copied', _copied,
    'restricted_authority', _restricted,
    'reconciliation', public.neo_role_migration_preflight(_org),
    'executed_at', now()
  );

  UPDATE role_migration_runs
     SET status = 'completed', executed_at = now(), report = _report, updated_at = now()
   WHERE id = _run;

  INSERT INTO audit_logs (organization_id, user_id, user_name, action, module, record_id, new_value)
  VALUES (_org, auth.uid(), coalesce((SELECT full_name FROM profiles WHERE id = auth.uid()),''),
          'role.migration.executed', 'administration', _run, _report);

  RETURN _report;
END;
$$;
REVOKE EXECUTE ON FUNCTION public.neo_execute_role_migration(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.neo_execute_role_migration(uuid) TO authenticated;

-- Dependencies that block retiring a predecessor role.
CREATE OR REPLACE FUNCTION public.neo_role_dependencies(_role uuid)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT jsonb_build_object(
    'active_users', (SELECT count(*) FROM user_roles WHERE role_id = _role),
    'approval_rules', (SELECT count(*) FROM approval_rules WHERE approver_role_id = _role),
    'task_rules', (SELECT count(*) FROM task_assignment_rules WHERE assignee_role_id = _role),
    'notification_rules', (SELECT count(*) FROM notification_rules WHERE recipient_role_id = _role),
    'dashboard_assignments', (SELECT count(*) FROM role_dashboard_assignments WHERE role_id = _role),
    'station_assignments', (SELECT count(*) FROM user_stations WHERE role_id = _role),
    'permission_grants', (SELECT count(*) FROM role_permissions WHERE role_id = _role)
  )
  WHERE EXISTS (SELECT 1 FROM roles r WHERE r.id = _role AND r.organization_id = public.current_org_id());
$$;
REVOKE EXECUTE ON FUNCTION public.neo_role_dependencies(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.neo_role_dependencies(uuid) TO authenticated;

CREATE OR REPLACE FUNCTION public.neo_archive_legacy_role(_role uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE _org uuid; _dep jsonb; _blockers text[] := '{}';
BEGIN
  SELECT organization_id INTO _org FROM roles WHERE id = _role;
  IF _org IS NULL OR _org <> public.current_org_id() OR NOT public.is_org_admin() THEN
    RAISE EXCEPTION 'Not authorised';
  END IF;
  _dep := public.neo_role_dependencies(_role);
  IF (_dep->>'active_users')::int > 0 THEN _blockers := _blockers || format('%s active user(s) still hold this role', _dep->>'active_users'); END IF;
  IF (_dep->>'approval_rules')::int > 0 THEN _blockers := _blockers || 'approval rules still route to this role'; END IF;
  IF (_dep->>'task_rules')::int > 0 THEN _blockers := _blockers || 'task assignment rules still route to this role'; END IF;
  IF (_dep->>'notification_rules')::int > 0 THEN _blockers := _blockers || 'notification rules still route to this role'; END IF;
  IF (_dep->>'station_assignments')::int > 0 THEN _blockers := _blockers || 'station assignments still reference this role'; END IF;

  IF array_length(_blockers, 1) > 0 THEN
    UPDATE roles SET migration_status = 'blocked', migration_review_reason = array_to_string(_blockers, '; ') WHERE id = _role;
    RETURN jsonb_build_object('archived', false, 'blockers', to_jsonb(_blockers), 'dependencies', _dep);
  END IF;

  UPDATE roles SET role_status = 'archived', active = false, migration_status = 'retired',
                   effective_until = current_date, migration_review_reason = NULL
   WHERE id = _role;

  INSERT INTO audit_logs (organization_id, user_id, user_name, action, module, record_id, new_value)
  VALUES (_org, auth.uid(), coalesce((SELECT full_name FROM profiles WHERE id = auth.uid()),''),
          'role.migration.archived', 'administration', _role,
          jsonb_build_object('role', (SELECT name FROM roles WHERE id = _role), 'dependencies', _dep));

  RETURN jsonb_build_object('archived', true, 'dependencies', _dep);
END;
$$;
REVOKE EXECUTE ON FUNCTION public.neo_archive_legacy_role(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.neo_archive_legacy_role(uuid) TO authenticated;

CREATE OR REPLACE FUNCTION public.neo_reactivate_role(_role uuid, _reason text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE _org uuid;
BEGIN
  SELECT organization_id INTO _org FROM roles WHERE id = _role;
  IF _org IS NULL OR _org <> public.current_org_id() OR NOT public.is_org_admin() THEN
    RAISE EXCEPTION 'Not authorised';
  END IF;
  UPDATE roles SET role_status = 'legacy', active = true, effective_until = NULL,
                   migration_status = 'planned',
                   migration_review_reason = coalesce(nullif(_reason,''), 'Reactivated by an authorised administrator.')
   WHERE id = _role AND role_status = 'archived';
  INSERT INTO audit_logs (organization_id, user_id, user_name, action, module, record_id, new_value, reason)
  VALUES (_org, auth.uid(), coalesce((SELECT full_name FROM profiles WHERE id = auth.uid()),''),
          'role.migration.reactivated', 'administration', _role,
          jsonb_build_object('role', (SELECT name FROM roles WHERE id = _role)), _reason);
  RETURN jsonb_build_object('ok', true);
END;
$$;
REVOKE EXECUTE ON FUNCTION public.neo_reactivate_role(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.neo_reactivate_role(uuid, text) TO authenticated;

CREATE OR REPLACE FUNCTION public.neo_role_reconciliation(_org uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF _org IS NULL OR _org <> public.current_org_id() OR NOT public.is_org_admin() THEN
    RAISE EXCEPTION 'Not authorised';
  END IF;
  RETURN jsonb_build_object(
    'active_roles', (SELECT coalesce(jsonb_agg(jsonb_build_object('id', id, 'name', name,
        'users', (SELECT count(*) FROM user_roles ur WHERE ur.role_id = roles.id)) ORDER BY name), '[]'::jsonb)
      FROM roles WHERE organization_id = _org AND role_status = 'active'),
    'legacy_roles', (SELECT coalesce(jsonb_agg(jsonb_build_object('id', id, 'name', name,
        'successor', (SELECT name FROM roles s WHERE s.id = roles.successor_role_id),
        'users', (SELECT count(*) FROM user_roles ur WHERE ur.role_id = roles.id),
        'dependencies', public.neo_role_dependencies(id)) ORDER BY name), '[]'::jsonb)
      FROM roles WHERE organization_id = _org AND role_status = 'legacy'),
    'archived_roles', (SELECT coalesce(jsonb_agg(jsonb_build_object('id', id, 'name', name) ORDER BY name), '[]'::jsonb)
      FROM roles WHERE organization_id = _org AND role_status = 'archived'),
    'review_required', (SELECT coalesce(jsonb_agg(jsonb_build_object('id', id, 'name', name,
        'reason', migration_review_reason) ORDER BY name), '[]'::jsonb)
      FROM roles WHERE organization_id = _org AND migration_status = 'review_required'),
    'users_on_legacy', (SELECT coalesce(jsonb_agg(jsonb_build_object('user', p.full_name, 'role', r.name)), '[]'::jsonb)
      FROM user_roles ur JOIN roles r ON r.id = ur.role_id JOIN profiles p ON p.id = ur.user_id
      WHERE ur.organization_id = _org AND r.role_status = 'legacy'),
    'restricted_approvers', (SELECT coalesce(jsonb_agg(name ORDER BY name), '[]'::jsonb)
      FROM roles WHERE organization_id = _org AND approval_class = 'restricted_approver' AND role_status = 'active'),
    'history_records', (SELECT count(*) FROM role_assignment_history WHERE organization_id = _org),
    'audit_records', (SELECT count(*) FROM audit_logs WHERE organization_id = _org)
  );
END;
$$;
REVOKE EXECUTE ON FUNCTION public.neo_role_reconciliation(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.neo_role_reconciliation(uuid) TO authenticated;
