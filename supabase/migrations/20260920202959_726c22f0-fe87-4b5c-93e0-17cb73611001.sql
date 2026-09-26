-- 1. Configurable standard: template metadata ---------------------------------
ALTER TABLE public.housekeeping_checklist_templates
  ADD COLUMN IF NOT EXISTS description text,
  ADD COLUMN IF NOT EXISTS version integer NOT NULL DEFAULT 1;

ALTER TABLE public.housekeeping_checklist_items
  ADD COLUMN IF NOT EXISTS instructions text,
  ADD COLUMN IF NOT EXISTS applies_to text NOT NULL DEFAULT 'cleaning';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'housekeeping_checklist_items_applies_to_check'
  ) THEN
    ALTER TABLE public.housekeeping_checklist_items
      ADD CONSTRAINT housekeeping_checklist_items_applies_to_check
      CHECK (applies_to IN ('cleaning', 'inspection', 'both'));
  END IF;
END $$;

-- Historical evidence must never be rewritten by a later template edit.
ALTER TABLE public.housekeeping_jobs
  ADD COLUMN IF NOT EXISTS checklist_snapshot jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS template_name text,
  ADD COLUMN IF NOT EXISTS template_version integer;

-- 2. Version bump whenever the standard changes -------------------------------
CREATE OR REPLACE FUNCTION public.hk_touch_template_version()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_template uuid := coalesce(NEW.template_id, OLD.template_id);
BEGIN
  IF v_template IS NOT NULL THEN
    UPDATE public.housekeeping_checklist_templates
      SET version = coalesce(version, 1) + 1, updated_at = now()
    WHERE id = v_template;
  END IF;
  RETURN coalesce(NEW, OLD);
END $$;

DROP TRIGGER IF EXISTS hk_checklist_items_version ON public.housekeeping_checklist_items;
CREATE TRIGGER hk_checklist_items_version
AFTER INSERT OR UPDATE OR DELETE ON public.housekeeping_checklist_items
FOR EACH ROW EXECUTE FUNCTION public.hk_touch_template_version();

-- 3. Which standard applies to a given clean ----------------------------------
CREATE OR REPLACE FUNCTION public.hk_resolve_checklist_template(
  _org uuid, _branch uuid, _job_type text, _room_type uuid)
RETURNS uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
  SELECT t.id
  FROM public.housekeeping_checklist_templates t
  WHERE t.organization_id = _org
    AND t.active
    AND (t.branch_id IS NULL OR t.branch_id = _branch)
    AND (t.room_type_id IS NULL OR t.room_type_id = _room_type)
    AND (
      t.cleaning_type IS NULL
      OR t.cleaning_type IN ('any', 'all')
      OR t.cleaning_type = _job_type
      OR t.cleaning_type = replace(_job_type, '-cleaning', '')
    )
  ORDER BY (t.cleaning_type = _job_type OR t.cleaning_type = replace(_job_type, '-cleaning', '')) DESC,
           (t.room_type_id = _room_type) DESC NULLS LAST,
           (t.branch_id = _branch) DESC NULLS LAST,
           t.created_at
  LIMIT 1;
$$;

GRANT EXECUTE ON FUNCTION public.hk_resolve_checklist_template(uuid, uuid, text, uuid) TO authenticated, service_role;

-- Frozen copy of the standard as it stood when the job was raised.
CREATE OR REPLACE FUNCTION public.hk_template_snapshot(_template uuid)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
  SELECT coalesce(jsonb_agg(jsonb_build_object(
    'item_id', i.id,
    'label', i.label,
    'instructions', i.instructions,
    'response_type', coalesce(i.response_type, 'check'),
    'applies_to', coalesce(i.applies_to, 'cleaning'),
    'mandatory', coalesce(i.mandatory, false),
    'requires_comment', coalesce(i.requires_comment, false),
    'requires_photo', coalesce(i.requires_photo, false),
    'allows_defect', coalesce(i.allows_defect, false),
    'sort_order', coalesce(i.sort_order, 0)
  ) ORDER BY coalesce(i.sort_order, 0), i.label), '[]'::jsonb)
  FROM public.housekeeping_checklist_items i
  WHERE i.template_id = _template;
$$;

GRANT EXECUTE ON FUNCTION public.hk_template_snapshot(uuid) TO authenticated, service_role;

-- 4. Job creation attaches the resolved standard ------------------------------
CREATE OR REPLACE FUNCTION public.hk_raise_cleaning_task(_room uuid, _job_type text, _reason text, _priority text DEFAULT 'normal'::text, _due_at timestamp with time zone DEFAULT NULL::timestamp with time zone, _assignee uuid DEFAULT NULL::uuid, _assigned_team text DEFAULT NULL::text, _reservation uuid DEFAULT NULL::uuid, _source text DEFAULT 'manual'::text, _source_record uuid DEFAULT NULL::uuid, _idempotency_key text DEFAULT NULL::text, _correlation uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_org uuid := public.current_org_id(); v_actor uuid := auth.uid(); v_room public.rooms;
  v_department uuid; v_station uuid; v_existing public.housekeeping_jobs; v_job uuid; v_task uuid;
  v_notification uuid; v_event uuid; v_audit uuid; v_key text; v_requires boolean := true;
  v_template uuid; v_status text; v_reason text := nullif(btrim(coalesce(_reason,'')),'');
  v_assignee uuid := NULL; v_snapshot jsonb := '[]'::jsonb; v_tname text; v_tversion integer;
BEGIN
  IF v_org IS NULL OR v_actor IS NULL THEN RAISE EXCEPTION 'Authenticated organization context required'; END IF;
  IF NOT public.has_permission('housekeeping','tasks','create') THEN RAISE EXCEPTION 'Missing permission: housekeeping.tasks.create'; END IF;
  IF _job_type NOT IN ('checkout-cleaning','stayover-cleaning','deep-cleaning','touch-up','rework','recovery','turndown') THEN
    RAISE EXCEPTION 'Unsupported cleaning task type: %', _job_type;
  END IF;
  IF _priority NOT IN ('low','normal','high','urgent') THEN RAISE EXCEPTION 'Invalid priority'; END IF;
  SELECT * INTO v_room FROM public.rooms WHERE id=_room AND organization_id=v_org FOR UPDATE;
  IF v_room.id IS NULL THEN RAISE EXCEPTION 'The selected room does not exist in your authorized organization'; END IF;
  IF NOT public.in_my_scope(v_room.organization_id,v_room.branch_id,NULL,NULL,NULL,v_actor) THEN
    RAISE EXCEPTION 'The selected room is outside your authorized property scope';
  END IF;
  IF v_room.occupancy_status='occupied' AND _job_type='checkout-cleaning' THEN
    RAISE EXCEPTION 'An occupied room cannot receive departure cleaning; choose stay-over cleaning';
  END IF;
  IF _source='manual' AND v_room.housekeeping_status='clean' AND v_reason IS NULL THEN
    RAISE EXCEPTION 'This room is already clean; provide an authorized manual-cleaning reason';
  END IF;
  v_department := public.neo_housekeeping_department(v_org, v_room.branch_id);
  IF _assignee IS NOT NULL THEN
    v_assignee := public.neo_assert_worker_scope(_assignee, v_room.branch_id, 'housekeeping');
  END IF;
  v_key := coalesce(nullif(_idempotency_key,''),
    _source || ':' || coalesce(_source_record::text,_reservation::text,_room::text || ':' || _job_type || ':' || current_date::text));
  SELECT * INTO v_existing FROM public.housekeeping_jobs WHERE organization_id=v_org AND idempotency_key=v_key;
  IF v_existing.id IS NOT NULL THEN
    RETURN jsonb_build_object('ok',true,'idempotent',true,'job_id',v_existing.id,'task_id',v_existing.task_id,
      'assignee_id', v_existing.assignee_id,
      'notification_id',(SELECT id FROM public.notifications WHERE organization_id=v_org AND source_record_id=v_existing.id ORDER BY created_at LIMIT 1),
      'workflow_event_id',(SELECT id FROM public.domain_events WHERE organization_id=v_org AND source_record_id=v_existing.id ORDER BY created_at LIMIT 1),
      'audit_event_id',(SELECT id FROM public.audit_logs WHERE organization_id=v_org AND record_id=v_existing.id::text ORDER BY created_at LIMIT 1));
  END IF;

  -- The applicable configured standard: cleaning type first, then room type,
  -- then property. A hotel with nothing configured still raises the job.
  v_template := public.hk_resolve_checklist_template(v_org, v_room.branch_id, _job_type, v_room.room_type_id);
  IF v_template IS NOT NULL THEN
    SELECT t.requires_inspection, t.name, t.version INTO v_requires, v_tname, v_tversion
      FROM public.housekeeping_checklist_templates t WHERE t.id = v_template;
    v_snapshot := public.hk_template_snapshot(v_template);
  END IF;

  IF v_assignee IS NOT NULL THEN
    SELECT r.station_id INTO v_station
      FROM public.roles r
      JOIN public.user_roles ur ON ur.role_id=r.id AND ur.organization_id=v_org
      LEFT JOIN public.operational_stations s ON s.id = r.station_id
     WHERE ur.user_id=v_assignee
       AND r.organization_id=v_org
       AND coalesce(r.active, true)
       AND coalesce(r.role_status, 'active') = 'active'
       AND r.station_id IS NOT NULL
       AND (s.id IS NULL OR s.organization_id = v_org)
       AND (s.branch_id IS NULL OR s.branch_id = v_room.branch_id)
       AND (s.department_id IS NULL OR s.department_id = v_department)
     LIMIT 1;
  END IF;
  v_status := CASE WHEN v_assignee IS NULL THEN 'pending' ELSE 'assigned' END;
  INSERT INTO public.tasks (organization_id,branch_id,department_id,station_id,reference,title,description,
    assignee_id,created_by,due_at,priority,status)
  VALUES (v_org,v_room.branch_id,v_department,v_station,'HK-'||left(v_key,24),
    initcap(replace(_job_type,'-',' '))||' — Room '||v_room.room_number,coalesce(v_reason,''),
    v_assignee,v_actor,_due_at,_priority,CASE WHEN v_assignee IS NULL THEN 'open' ELSE 'assigned' END)
  RETURNING id INTO v_task;
  INSERT INTO public.housekeeping_jobs (organization_id,branch_id,department_id,station_id,job_number,task_id,
    room_id,room_type_id,job_type,reservation_id,template_id,template_name,template_version,checklist_snapshot,
    assignee_id,assigned_team,priority,status,due_at,
    inspection_required,inspection_status,notes,idempotency_key,source,source_record_id,correlation_id,created_by)
  VALUES (v_org,v_room.branch_id,v_department,v_station,public.next_document_number('housekeeping-job'),v_task,
    _room,v_room.room_type_id,_job_type,_reservation,v_template,v_tname,v_tversion,v_snapshot,
    v_assignee,_assigned_team,_priority,v_status,_due_at,
    coalesce(v_requires,true),CASE WHEN coalesce(v_requires,true) THEN 'pending' ELSE 'not-required' END,v_reason,v_key,
    _source,_source_record,coalesce(_correlation,gen_random_uuid()),v_actor)
  RETURNING id INTO v_job;
  UPDATE public.rooms SET housekeeping_status=CASE WHEN _job_type='rework' THEN 'rework' ELSE 'dirty' END,
    inspection_status='pending', sellable=false, room_condition='vacant-dirty', updated_at=now() WHERE id=_room;
  IF v_assignee IS NOT NULL THEN
    INSERT INTO public.notifications (organization_id,branch_id,department_id,station_id,user_id,category,title,body,link,
      priority,idempotency_key,action_required,source_module,source_record_id,event_type)
    VALUES (v_org,v_room.branch_id,v_department,v_station,v_assignee,'task','Cleaning task — Room '||v_room.room_number,
      initcap(replace(_job_type,'-',' '))||coalesce(': '||v_reason,''),'/housekeeping/my-work',_priority,
      'hk-assigned:'||v_job::text,true,'housekeeping',v_job,'housekeeping.task.assigned') RETURNING id INTO v_notification;
  END IF;
  v_event := public.emit_domain_event(v_org,v_room.branch_id,'housekeeping.task.created','housekeeping',v_job,
    jsonb_build_object('room_id',_room,'task_id',v_task,'assignee_id',v_assignee,'job_type',_job_type,'source',_source,
      'source_record_id',_source_record,'template_id',v_template,'correlation_id',coalesce(_correlation,gen_random_uuid())),
    'hk-created:'||v_key,NULL);
  v_audit := public.log_audit_event('housekeeping.task.created','housekeeping',v_job::text,to_jsonb(v_room),
    jsonb_build_object('job_id',v_job,'task_id',v_task,'room_id',_room,'assignee_id',v_assignee,'status',v_status,
      'template_id',v_template,'template_version',v_tversion),
    v_reason,'housekeeping.tasks.create',v_room.branch_id,v_department,v_station,
    coalesce(_correlation,gen_random_uuid())::text,NULL,NULL);
  RETURN jsonb_build_object('ok',true,'idempotent',false,'job_id',v_job,'task_id',v_task,
    'assignee_id',v_assignee,'notification_id',v_notification,'workflow_event_id',v_event,'audit_event_id',v_audit,
    'template_id',v_template,'checklist_items',jsonb_array_length(v_snapshot),
    'room_id',_room,'room_before',to_jsonb(v_room),
    'room_after',(SELECT to_jsonb(r) FROM public.rooms r WHERE r.id=_room),
    'confirmed_assignee_id',(SELECT j.assignee_id FROM public.housekeeping_jobs j WHERE j.id=v_job),
    'confirmed_task_assignee_id',(SELECT t.assignee_id FROM public.tasks t WHERE t.id=v_task));
END $function$;

-- 5. Completion enforces the configured standard ------------------------------
CREATE OR REPLACE FUNCTION public.hk_complete_job(_job uuid, _notes text DEFAULT NULL::text, _correlation uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_org uuid := public.current_org_id();
  v_job public.housekeeping_jobs;
  v_notification uuid;
  v_event uuid;
  v_audit uuid;
  v_inspector uuid;
  v_attempt text;
  v_key text;
  v_missing text;
BEGIN
  SELECT * INTO v_job FROM public.housekeeping_jobs WHERE id = _job AND organization_id = v_org FOR UPDATE;
  IF v_job.id IS NULL THEN RAISE EXCEPTION 'Unknown housekeeping task'; END IF;
  IF NOT (v_job.assignee_id = auth.uid() OR public.has_permission('housekeeping', 'tasks', 'complete')) THEN
    RAISE EXCEPTION 'This task is not assigned to you';
  END IF;
  IF v_job.status = 'awaiting-inspection' THEN
    RETURN jsonb_build_object('ok', true, 'idempotent', true, 'job_id', _job,
      'workflow_event_id',(SELECT id FROM public.domain_events WHERE organization_id=v_org AND source_record_id=_job AND event_type='housekeeping.cleaning.completed' ORDER BY created_at DESC LIMIT 1),
      'audit_event_id',(SELECT id FROM public.audit_logs WHERE organization_id=v_org AND record_id=_job::text ORDER BY created_at DESC LIMIT 1));
  END IF;
  IF v_job.status <> 'in-progress' THEN RAISE EXCEPTION 'Task must be in progress before completion'; END IF;

  -- Required cleaning steps must actually be recorded. A job raised before a
  -- standard existed carries an empty snapshot and is unaffected.
  SELECT string_agg(s.label, ', ' ORDER BY s.label) INTO v_missing
  FROM jsonb_to_recordset(coalesce(v_job.checklist_snapshot, '[]'::jsonb))
    AS s(label text, mandatory boolean, requires_comment boolean, applies_to text)
  LEFT JOIN public.housekeeping_job_results r
    ON r.job_id = _job AND r.label = s.label
  WHERE coalesce(s.mandatory, false)
    AND coalesce(s.applies_to, 'cleaning') IN ('cleaning', 'both')
    AND (
      r.id IS NULL
      OR nullif(btrim(coalesce(r.result, '')), '') IS NULL
      OR (r.result IN ('not-applicable', 'failed', 'issue')
          AND nullif(btrim(coalesce(r.comment, '')), '') IS NULL)
      OR (coalesce(s.requires_comment, false)
          AND nullif(btrim(coalesce(r.comment, '')), '') IS NULL)
    );

  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'Required cleaning steps are incomplete: %', v_missing;
  END IF;

  v_attempt := coalesce(v_job.rework_count,0)::text;

  UPDATE public.housekeeping_jobs
  SET status = CASE WHEN inspection_required THEN 'awaiting-inspection' ELSE 'completed' END,
      inspection_status = CASE WHEN inspection_required THEN 'pending' ELSE 'not-required' END,
      completed_at = now(), notes = coalesce(_notes, notes), updated_at = now()
  WHERE id = _job;

  UPDATE public.tasks
  SET status = CASE WHEN v_job.inspection_required THEN 'in-progress' ELSE 'completed' END,
      completed_at = CASE WHEN v_job.inspection_required THEN NULL ELSE now() END,
      updated_at = now()
  WHERE id = v_job.task_id;

  UPDATE public.rooms
  SET housekeeping_status = CASE WHEN v_job.inspection_required THEN 'awaiting-inspection' ELSE 'clean' END,
      inspection_status = CASE WHEN v_job.inspection_required THEN 'pending' ELSE 'not-required' END,
      last_cleaned_at = now(), updated_at = now()
  WHERE id = v_job.room_id;

  IF v_job.inspection_required THEN
    SELECT p.id INTO v_inspector
    FROM public.profiles p
    WHERE p.organization_id = v_org
      AND p.account_status = 'active'
      AND p.department_id = v_job.department_id
      AND (p.branch_id IS NULL OR p.branch_id = v_job.branch_id)
      AND p.id <> auth.uid()
      AND EXISTS (
        SELECT 1 FROM public.user_roles ur
        JOIN public.roles r ON r.id = ur.role_id AND r.organization_id = v_org AND r.active
        JOIN public.role_permissions rp ON rp.role_id = r.id AND rp.organization_id = v_org
        JOIN public.permissions perm ON perm.id = rp.permission_id
        CROSS JOIN LATERAL public.canonical_permission(perm.module, perm.feature, perm.action) held
        CROSS JOIN LATERAL public.canonical_permission('housekeeping', 'inspections', 'approve') wanted
        WHERE ur.user_id = p.id AND ur.organization_id = v_org
          AND held.module = wanted.module
          AND held.feature IN (wanted.feature, '*')
          AND (held.action = wanted.action
               OR public.permission_action_class(held.action) = public.permission_action_class(wanted.action))
      )
    ORDER BY p.id LIMIT 1;

    IF v_inspector IS NOT NULL THEN
      v_key := 'hk-inspect:' || _job::text || ':' || v_attempt;
      SELECT id INTO v_notification FROM public.notifications
      WHERE organization_id = v_org AND user_id = v_inspector AND idempotency_key = v_key;
      IF v_notification IS NULL THEN
        INSERT INTO public.notifications (
          organization_id, branch_id, department_id, station_id, user_id, category,
          title, body, link, priority, idempotency_key, action_required,
          source_module, source_record_id, event_type)
        VALUES (
          v_org, v_job.branch_id, v_job.department_id, v_job.station_id, v_inspector,
          'approval', 'Room inspection required',
          'Cleaning is complete and awaits inspection.', '/housekeeping/inspections',
          'high', v_key, true, 'housekeeping', _job,
          'housekeeping.inspection.required')
        RETURNING id INTO v_notification;
      END IF;
    END IF;
  END IF;

  v_event := public.emit_domain_event(
    v_org, v_job.branch_id, 'housekeeping.cleaning.completed', 'housekeeping', _job,
    jsonb_build_object('room_id', v_job.room_id, 'inspection_required', v_job.inspection_required,
      'inspector_id', v_inspector, 'attempt', v_attempt),
    'hk-completed:' || _job::text || ':' || v_attempt, NULL);

  v_audit := public.log_audit_event(
    'housekeeping.task.completed', 'housekeeping', _job::text,
    jsonb_build_object('status', v_job.status),
    jsonb_build_object('status', CASE WHEN v_job.inspection_required THEN 'awaiting-inspection' ELSE 'completed' END,
      'inspector_id', v_inspector),
    _notes, 'housekeeping.tasks.complete', v_job.branch_id, v_job.department_id,
    v_job.station_id, coalesce(_correlation, gen_random_uuid())::text, NULL, NULL);

  RETURN jsonb_build_object('ok', true, 'idempotent', false, 'job_id', _job,
    'inspection_required', v_job.inspection_required, 'inspector_id', v_inspector,
    'notification_id', v_notification, 'workflow_event_id', v_event, 'audit_event_id', v_audit);
END
$function$;

-- 6. Access rights for maintaining the standards ------------------------------
INSERT INTO public.permissions (module, feature, action, label)
SELECT 'housekeeping', 'checklists', a, 'Cleaning standards — ' || initcap(a)
FROM unnest(ARRAY['view','create','edit','delete','approve','export','print']) AS a
ON CONFLICT DO NOTHING;
