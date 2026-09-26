CREATE OR REPLACE FUNCTION public.hk_complete_job(_job uuid, _notes text DEFAULT NULL, _correlation uuid DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_org uuid := public.current_org_id();
  v_job public.housekeeping_jobs;
  v_notification uuid;
  v_event uuid;
  v_audit uuid;
  v_inspector uuid;
BEGIN
  SELECT * INTO v_job
  FROM public.housekeeping_jobs
  WHERE id = _job AND organization_id = v_org
  FOR UPDATE;

  IF v_job.id IS NULL THEN
    RAISE EXCEPTION 'Unknown housekeeping task';
  END IF;

  IF NOT (v_job.assignee_id = auth.uid() OR public.has_permission('housekeeping', 'tasks', 'complete')) THEN
    RAISE EXCEPTION 'This task is not assigned to you';
  END IF;

  IF v_job.status = 'awaiting-inspection' THEN
    RETURN jsonb_build_object('ok', true, 'idempotent', true, 'job_id', _job);
  END IF;

  IF v_job.status <> 'in-progress' THEN
    RAISE EXCEPTION 'Task must be in progress before completion';
  END IF;

  UPDATE public.housekeeping_jobs
  SET status = CASE WHEN inspection_required THEN 'awaiting-inspection' ELSE 'completed' END,
      inspection_status = CASE WHEN inspection_required THEN 'pending' ELSE 'not-required' END,
      completed_at = now(),
      notes = coalesce(_notes, notes),
      updated_at = now()
  WHERE id = _job;

  UPDATE public.tasks
  SET status = CASE WHEN v_job.inspection_required THEN 'in-progress' ELSE 'completed' END,
      completed_at = CASE WHEN v_job.inspection_required THEN NULL ELSE now() END,
      updated_at = now()
  WHERE id = v_job.task_id;

  UPDATE public.rooms
  SET housekeeping_status = CASE WHEN v_job.inspection_required THEN 'awaiting-inspection' ELSE 'clean' END,
      inspection_status = CASE WHEN v_job.inspection_required THEN 'pending' ELSE 'not-required' END,
      last_cleaned_at = now(),
      sellable = false,
      updated_at = now()
  WHERE id = v_job.room_id;

  IF NOT v_job.inspection_required THEN
    PERFORM public.hk_recalculate_room(v_job.room_id);
  END IF;

  IF v_job.inspection_required THEN
    SELECT p.id INTO v_inspector
    FROM public.profiles p
    WHERE p.organization_id = v_org
      AND p.account_status = 'active'
      AND p.department_id = v_job.department_id
      AND (p.branch_id IS NULL OR p.branch_id = v_job.branch_id)
      AND EXISTS (
        SELECT 1
        FROM public.user_roles ur
        JOIN public.roles r
          ON r.id = ur.role_id
         AND r.organization_id = v_org
         AND r.active
        JOIN public.role_permissions rp
          ON rp.role_id = r.id
         AND rp.organization_id = v_org
        JOIN public.permissions perm ON perm.id = rp.permission_id
        CROSS JOIN LATERAL public.canonical_permission(perm.module, perm.feature, perm.action) held
        CROSS JOIN LATERAL public.canonical_permission('housekeeping', 'inspections', 'approve') wanted
        WHERE ur.user_id = p.id
          AND ur.organization_id = v_org
          AND held.module = wanted.module
          AND held.feature IN (wanted.feature, '*')
          AND (
            held.action = wanted.action
            OR public.permission_action_class(held.action) = public.permission_action_class(wanted.action)
          )
      )
      AND NOT EXISTS (
        SELECT 1
        FROM public.user_permissions up
        JOIN public.permissions perm ON perm.id = up.permission_id
        CROSS JOIN LATERAL public.canonical_permission(perm.module, perm.feature, perm.action) denied
        CROSS JOIN LATERAL public.canonical_permission('housekeeping', 'inspections', 'approve') wanted
        WHERE up.user_id = p.id
          AND up.organization_id = v_org
          AND up.effect = 'deny'
          AND denied.module = wanted.module
          AND denied.feature IN (wanted.feature, '*')
          AND (
            denied.action = wanted.action
            OR public.permission_action_class(denied.action) = public.permission_action_class(wanted.action)
          )
      )
    ORDER BY p.id
    LIMIT 1;

    IF v_inspector IS NOT NULL THEN
      INSERT INTO public.notifications (
        organization_id, branch_id, department_id, station_id, user_id, category,
        title, body, link, priority, idempotency_key, action_required,
        source_module, source_record_id, event_type
      )
      VALUES (
        v_org, v_job.branch_id, v_job.department_id, v_job.station_id, v_inspector,
        'approval', 'Room inspection required',
        'Cleaning is complete and awaits inspection.', '/housekeeping/inspections',
        'high', 'hk-inspect:' || _job::text, true, 'housekeeping', _job,
        'housekeeping.inspection.required'
      )
      RETURNING id INTO v_notification;
    END IF;
  END IF;

  v_event := public.emit_domain_event(
    v_org, v_job.branch_id, 'housekeeping.cleaning.completed', 'housekeeping', _job,
    jsonb_build_object(
      'room_id', v_job.room_id,
      'inspection_required', v_job.inspection_required,
      'inspector_id', v_inspector
    ),
    'hk-completed:' || _job::text,
    NULL
  );

  v_audit := public.log_audit_event(
    'housekeeping.task.completed', 'housekeeping', _job::text,
    jsonb_build_object('status', v_job.status),
    jsonb_build_object(
      'status', CASE WHEN v_job.inspection_required THEN 'awaiting-inspection' ELSE 'completed' END,
      'inspector_id', v_inspector
    ),
    _notes, 'housekeeping.tasks.complete', v_job.branch_id, v_job.department_id,
    v_job.station_id, coalesce(_correlation, gen_random_uuid())::text, NULL, NULL
  );

  RETURN jsonb_build_object(
    'ok', true,
    'idempotent', false,
    'job_id', _job,
    'inspection_required', v_job.inspection_required,
    'inspector_id', v_inspector,
    'notification_id', v_notification,
    'workflow_event_id', v_event,
    'audit_event_id', v_audit
  );
END
$$;

REVOKE ALL ON FUNCTION public.hk_complete_job(uuid, text, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.hk_complete_job(uuid, text, uuid) TO authenticated;