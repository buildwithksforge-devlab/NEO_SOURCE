-- Wave 1 repair derived from local source 9d18edc. No historical rows are changed.
-- Compare the deployment and reproduce in isolated UAT before applying.
BEGIN;
DO $neo_guard$
BEGIN
  IF replace((SELECT prosrc FROM pg_proc WHERE oid = 'public.hk_raise_cleaning_task(uuid,text,text,text,timestamptz,uuid,text,uuid,text,uuid,text,uuid)'::regprocedure), E'\r\n', E'\n')
     IS DISTINCT FROM replace($neo_expected$
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
END $neo_expected$, E'\r\n', E'\n') THEN
    RAISE EXCEPTION 'Function differs from reviewed local source; inspect deployment before applying this repair';
  END IF;
END
$neo_guard$;
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
    inspection_status='pending', sellable=false, updated_at=now() WHERE id=_room;
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
COMMIT;
