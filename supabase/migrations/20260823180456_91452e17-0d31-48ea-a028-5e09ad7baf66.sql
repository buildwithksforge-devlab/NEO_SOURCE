-- 1. Inspection authority: the supervisor's granted "inspect" key must resolve
--    to the canonical housekeeping.inspections.approve capability.
INSERT INTO public.permission_key_aliases (alias_module, alias_action, canonical_module, canonical_feature, canonical_action)
VALUES ('housekeeping', 'inspect', 'housekeeping', 'inspections', 'approve')
ON CONFLICT DO NOTHING;

-- 2. Remove legacy duplicate overloads that used coarse two-argument permission
--    checks (a cleaner could complete another cleaner's job through them).
DROP FUNCTION IF EXISTS public.hk_complete_job(uuid, text);
DROP FUNCTION IF EXISTS public.hk_record_inspection(uuid, text, text, jsonb, text);
DROP FUNCTION IF EXISTS public.hk_create_job(uuid, text, uuid, text, timestamptz, text, text);

-- 3. Task visibility: a task was readable by every member of the tenant.
DROP POLICY IF EXISTS "tasks tenant read" ON public.tasks;
CREATE POLICY "tasks scoped read" ON public.tasks
FOR SELECT TO authenticated
USING (public.in_my_scope(organization_id, branch_id, department_id, station_id, assignee_id, created_by));

-- 4. Approval visibility: approvals were readable by every member of the tenant.
DROP POLICY IF EXISTS "approvals tenant read" ON public.approval_requests;
CREATE POLICY "approvals scoped read" ON public.approval_requests
FOR SELECT TO authenticated
USING (
  organization_id = public.current_org_id()
  AND (
    requester_id = auth.uid()
    OR approver_id = auth.uid()
    OR public.in_my_scope(organization_id, branch_id, department_id, NULL::uuid, approver_id, requester_id)
    OR public.can_approve_restricted()
  )
);

-- 5. Authoritative assignment / reassignment primitive.
CREATE OR REPLACE FUNCTION public.hk_assign_job(_job uuid, _assignee uuid, _reason text DEFAULT NULL::text, _correlation uuid DEFAULT NULL::uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_org uuid := public.current_org_id();
  v_actor uuid := auth.uid();
  v_job public.housekeeping_jobs;
  v_room public.rooms;
  v_department uuid;
  v_status text;
  v_notification uuid;
  v_event uuid;
  v_audit uuid;
  v_reason text := nullif(btrim(coalesce(_reason, '')), '');
BEGIN
  IF v_org IS NULL OR v_actor IS NULL THEN
    RAISE EXCEPTION 'Authenticated organization context required';
  END IF;
  IF NOT public.has_permission('housekeeping', 'tasks', 'assign') THEN
    RAISE EXCEPTION 'Missing permission: housekeeping.tasks.assign';
  END IF;

  SELECT * INTO v_job FROM public.housekeeping_jobs
  WHERE id = _job AND organization_id = v_org FOR UPDATE;
  IF v_job.id IS NULL THEN
    RAISE EXCEPTION 'Unknown housekeeping task';
  END IF;
  IF NOT public.in_my_scope(v_job.organization_id, v_job.branch_id, v_job.department_id, v_job.station_id, v_job.assignee_id, v_job.created_by) THEN
    RAISE EXCEPTION 'This task is outside your authorized scope';
  END IF;
  IF v_job.status IN ('completed', 'cancelled') THEN
    RAISE EXCEPTION 'A % task can no longer be reassigned', v_job.status;
  END IF;

  SELECT * INTO v_room FROM public.rooms WHERE id = v_job.room_id;

  SELECT id INTO v_department FROM public.departments
  WHERE organization_id = v_org AND name ILIKE 'housekeeping%' ORDER BY name LIMIT 1;

  IF _assignee IS NULL THEN
    RAISE EXCEPTION 'Select the housekeeper who will carry out this cleaning';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.profiles p
    WHERE p.id = _assignee
      AND p.organization_id = v_org
      AND p.account_status = 'active'
      AND (v_department IS NULL OR p.department_id = v_department)
      AND (p.branch_id IS NULL OR v_job.branch_id IS NULL OR p.branch_id = v_job.branch_id)
  ) THEN
    RAISE EXCEPTION 'Selected assignee is not an active Housekeeping worker in this property scope';
  END IF;

  IF v_job.assignee_id = _assignee THEN
    RETURN jsonb_build_object('ok', true, 'idempotent', true, 'job_id', _job, 'assignee_id', _assignee);
  END IF;

  v_status := CASE WHEN v_job.status = 'pending' THEN 'assigned' ELSE v_job.status END;

  UPDATE public.housekeeping_jobs
  SET assignee_id = _assignee, status = v_status, updated_at = now()
  WHERE id = _job;

  UPDATE public.tasks
  SET assignee_id = _assignee,
      status = CASE WHEN status = 'open' THEN 'assigned' ELSE status END,
      updated_at = now()
  WHERE id = v_job.task_id;

  INSERT INTO public.notifications (
    organization_id, branch_id, department_id, station_id, user_id, category, title, body, link,
    priority, idempotency_key, action_required, source_module, source_record_id, event_type
  ) VALUES (
    v_org, v_job.branch_id, v_job.department_id, v_job.station_id, _assignee, 'task',
    'Cleaning assigned — Room ' || coalesce(v_room.room_number, '—'),
    coalesce(v_reason, initcap(replace(v_job.job_type, '-', ' '))),
    '/housekeeping/tasks', coalesce(v_job.priority, 'normal'),
    'hk-assign:' || _job::text || ':' || _assignee::text, true, 'housekeeping', _job,
    'housekeeping.task.assigned'
  )
  ON CONFLICT DO NOTHING
  RETURNING id INTO v_notification;

  v_event := public.emit_domain_event(
    v_org, v_job.branch_id, 'housekeeping.task.assigned', 'housekeeping', _job,
    jsonb_build_object('room_id', v_job.room_id, 'from_assignee', v_job.assignee_id, 'to_assignee', _assignee),
    'hk-assigned:' || _job::text || ':' || _assignee::text, NULL
  );

  v_audit := public.log_audit_event(
    'housekeeping.task.assigned', 'housekeeping', _job::text,
    jsonb_build_object('assignee_id', v_job.assignee_id, 'status', v_job.status),
    jsonb_build_object('assignee_id', _assignee, 'status', v_status),
    v_reason, 'housekeeping.tasks.assign', v_job.branch_id, v_job.department_id, v_job.station_id,
    coalesce(_correlation, gen_random_uuid())::text, NULL, NULL
  );

  RETURN jsonb_build_object(
    'ok', true, 'idempotent', false, 'job_id', _job, 'task_id', v_job.task_id,
    'assignee_id', _assignee, 'status', v_status,
    'notification_id', v_notification, 'workflow_event_id', v_event, 'audit_event_id', v_audit
  );
END
$function$;

REVOKE ALL ON FUNCTION public.hk_assign_job(uuid, uuid, text, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.hk_assign_job(uuid, uuid, text, uuid) TO authenticated, service_role;