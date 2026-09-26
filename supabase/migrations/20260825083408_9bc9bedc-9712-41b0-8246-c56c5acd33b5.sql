-- Shared scoping contract: departments, stations and workers, always property first.

CREATE OR REPLACE FUNCTION public.neo_scoped_departments(_branch uuid DEFAULT NULL::uuid)
 RETURNS TABLE(id uuid, name text, catalogue_key text, branch_id uuid, branch_name text, branch_specific boolean)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  WITH scoped AS (
    SELECT d.id, d.name, d.catalogue_key, d.branch_id,
           coalesce(
             nullif(btrim(coalesce(d.catalogue_key,'')),''),
             public.neo_department_catalogue_key(d.name),
             lower(btrim(d.name))
           ) AS ident
      FROM public.departments d
     WHERE d.organization_id = public.current_org_id()
       AND coalesce(d.active, true)
       AND coalesce(d.department_status, 'active') <> 'archived'
       AND (_branch IS NULL OR d.branch_id = _branch OR d.branch_id IS NULL)
       AND public.neo_branch_in_scope(d.branch_id)
  ), ranked AS (
    SELECT s.*, row_number() OVER (
             PARTITION BY s.ident, CASE WHEN _branch IS NULL THEN s.branch_id END
             ORDER BY (s.branch_id IS NOT NULL) DESC, s.name, s.id
           ) AS rn
      FROM scoped s
  )
  SELECT r.id, r.name, r.catalogue_key, r.branch_id,
         (SELECT b.name FROM public.branches b WHERE b.id = r.branch_id),
         r.branch_id IS NOT NULL
    FROM ranked r
   WHERE r.rn = 1
   ORDER BY r.name;
$function$;

CREATE OR REPLACE FUNCTION public.neo_scoped_stations(_branch uuid DEFAULT NULL::uuid, _department uuid DEFAULT NULL::uuid)
 RETURNS TABLE(id uuid, name text, code text, station_type text, department_id uuid, branch_id uuid, branch_name text)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  WITH scoped AS (
    SELECT s.id, s.name, s.code, s.station_type, s.department_id, s.branch_id,
           lower(btrim(s.name)) AS ident
      FROM public.operational_stations s
     WHERE s.organization_id = public.current_org_id()
       AND coalesce(s.active, true)
       AND coalesce(s.status, 'active') NOT IN ('retired','archived')
       AND (_branch IS NULL OR s.branch_id = _branch OR s.branch_id IS NULL)
       AND (_department IS NULL OR s.department_id IS NULL OR s.department_id = _department)
       AND public.neo_branch_in_scope(s.branch_id)
  ), ranked AS (
    SELECT s.*, row_number() OVER (
             PARTITION BY s.ident, CASE WHEN _branch IS NULL THEN s.branch_id END
             ORDER BY (s.branch_id IS NOT NULL) DESC, (s.department_id IS NOT NULL) DESC, s.name, s.id
           ) AS rn
      FROM scoped s
  )
  SELECT r.id, r.name, r.code, r.station_type, r.department_id, r.branch_id,
         (SELECT b.name FROM public.branches b WHERE b.id = r.branch_id)
    FROM ranked r
   WHERE r.rn = 1
   ORDER BY r.name;
$function$;

-- Canonical worker catalogue. The value a form submits is always profiles.id.
CREATE OR REPLACE FUNCTION public.neo_scoped_workers(
  _branch uuid DEFAULT NULL::uuid,
  _department uuid DEFAULT NULL::uuid,
  _department_key text DEFAULT NULL::text
)
 RETURNS TABLE(id uuid, full_name text, staff_id text, job_title text,
               department_id uuid, department_name text, branch_id uuid, branch_name text)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT p.id, p.full_name, p.staff_id, p.job_title,
         p.department_id, d.name, p.branch_id, b.name
    FROM public.profiles p
    LEFT JOIN public.departments d ON d.id = p.department_id
    LEFT JOIN public.branches b ON b.id = p.branch_id
   WHERE p.organization_id = public.current_org_id()
     AND coalesce(p.account_status, 'active') = 'active'
     AND (_branch IS NULL OR p.branch_id = _branch OR p.branch_id IS NULL)
     AND public.neo_branch_in_scope(p.branch_id)
     AND (_department IS NULL OR p.department_id = _department
          OR (_department_key IS NOT NULL AND d.id IS NOT NULL
              AND coalesce(nullif(btrim(coalesce(d.catalogue_key,'')),''),
                           public.neo_department_catalogue_key(d.name),
                           lower(btrim(d.name))) = _department_key))
     AND (_department_key IS NULL OR d.id IS NULL
          OR coalesce(nullif(btrim(coalesce(d.catalogue_key,'')),''),
                      public.neo_department_catalogue_key(d.name),
                      lower(btrim(d.name))) = _department_key)
   ORDER BY p.full_name;
$function$;

-- One chain guard for every module (the menu guard keeps its own name).
CREATE OR REPLACE FUNCTION public.neo_assert_scope_chain(_branch uuid, _department uuid, _station uuid)
 RETURNS void
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  _org uuid := public.current_org_id();
  _dept public.departments;
  _st   public.operational_stations;
BEGIN
  IF _branch IS NULL THEN
    RAISE EXCEPTION 'Select a property before a department or station';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.branches WHERE id = _branch AND organization_id = _org) THEN
    RAISE EXCEPTION 'That property does not belong to this organisation';
  END IF;
  IF NOT public.neo_branch_in_scope(_branch) THEN
    RAISE EXCEPTION 'That property is outside your access';
  END IF;

  IF _department IS NOT NULL THEN
    SELECT * INTO _dept FROM public.departments WHERE id = _department AND organization_id = _org;
    IF _dept.id IS NULL THEN RAISE EXCEPTION 'That department does not exist'; END IF;
    IF _dept.branch_id IS NOT NULL AND _dept.branch_id <> _branch THEN
      RAISE EXCEPTION 'That department belongs to another property';
    END IF;
    IF NOT coalesce(_dept.active, true) OR coalesce(_dept.department_status,'active') = 'archived' THEN
      RAISE EXCEPTION 'That department is no longer active';
    END IF;
  END IF;

  IF _station IS NOT NULL THEN
    SELECT * INTO _st FROM public.operational_stations WHERE id = _station AND organization_id = _org;
    IF _st.id IS NULL THEN RAISE EXCEPTION 'That station does not exist'; END IF;
    IF _st.branch_id IS NOT NULL AND _st.branch_id <> _branch THEN
      RAISE EXCEPTION 'That station belongs to another property';
    END IF;
    IF NOT coalesce(_st.active, true) OR coalesce(_st.status,'active') IN ('retired','archived') THEN
      RAISE EXCEPTION 'That station is no longer active';
    END IF;
    IF _department IS NOT NULL AND _st.department_id IS NOT NULL AND _st.department_id <> _department THEN
      RAISE EXCEPTION 'That station belongs to another department';
    END IF;
  END IF;
END $function$;

-- Canonical worker guard: the caller may only ever submit profiles.id.
CREATE OR REPLACE FUNCTION public.neo_assert_worker_scope(_worker uuid, _branch uuid, _department_key text DEFAULT NULL::text)
 RETURNS uuid
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_org uuid := public.current_org_id();
  p public.profiles;
BEGIN
  IF _worker IS NULL THEN RAISE EXCEPTION 'Select the worker who will carry out this work'; END IF;
  SELECT * INTO p FROM public.profiles WHERE id = _worker AND organization_id = v_org;
  IF p.id IS NULL THEN
    RAISE EXCEPTION 'That worker is not a staff account in this organisation';
  END IF;
  IF coalesce(p.account_status,'active') <> 'active' THEN
    RAISE EXCEPTION 'That worker''s account is not active';
  END IF;
  IF _branch IS NOT NULL AND p.branch_id IS NOT NULL AND p.branch_id <> _branch THEN
    RAISE EXCEPTION 'That worker belongs to another property';
  END IF;
  IF _department_key IS NOT NULL AND p.department_id IS NOT NULL THEN
    IF NOT EXISTS (
      SELECT 1 FROM public.departments d
       WHERE d.id = p.department_id
         AND coalesce(nullif(btrim(coalesce(d.catalogue_key,'')),''),
                      public.neo_department_catalogue_key(d.name),
                      lower(btrim(d.name))) = _department_key
         AND (d.branch_id IS NULL OR _branch IS NULL OR d.branch_id = _branch)
    ) THEN
      RAISE EXCEPTION 'That worker is not in the % department for this property', _department_key;
    END IF;
  END IF;
  RETURN p.id;
END $function$;

REVOKE ALL ON FUNCTION public.neo_scoped_departments(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.neo_scoped_stations(uuid, uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.neo_scoped_workers(uuid, uuid, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.neo_assert_scope_chain(uuid, uuid, uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.neo_assert_worker_scope(uuid, uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.neo_scoped_departments(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.neo_scoped_stations(uuid, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.neo_scoped_workers(uuid, uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.neo_assert_scope_chain(uuid, uuid, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.neo_assert_worker_scope(uuid, uuid, text) TO authenticated;

-- Housekeeping now consumes the shared worker guard.
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

  PERFORM public.neo_assert_worker_scope(_assignee, v_job.branch_id, 'housekeeping');

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
BEGIN
  IF v_org IS NULL OR v_actor IS NULL THEN RAISE EXCEPTION 'Authenticated organization context required'; END IF;
  IF NOT public.has_permission('housekeeping','tasks','create') THEN RAISE EXCEPTION 'Missing permission: housekeeping.tasks.create'; END IF;
  IF _job_type NOT IN ('checkout-cleaning','stayover-cleaning','deep-cleaning','touch-up','rework','recovery') THEN
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
    PERFORM public.neo_assert_worker_scope(_assignee, v_room.branch_id, 'housekeeping');
  END IF;
  v_key := coalesce(nullif(_idempotency_key,''),
    _source || ':' || coalesce(_source_record::text,_reservation::text,_room::text || ':' || _job_type || ':' || current_date::text));
  SELECT * INTO v_existing FROM public.housekeeping_jobs WHERE organization_id=v_org AND idempotency_key=v_key;
  IF v_existing.id IS NOT NULL THEN
    RETURN jsonb_build_object('ok',true,'idempotent',true,'job_id',v_existing.id,'task_id',v_existing.task_id,
      'notification_id',(SELECT id FROM public.notifications WHERE organization_id=v_org AND source_record_id=v_existing.id ORDER BY created_at LIMIT 1),
      'workflow_event_id',(SELECT id FROM public.domain_events WHERE organization_id=v_org AND source_record_id=v_existing.id ORDER BY created_at LIMIT 1),
      'audit_event_id',(SELECT id FROM public.audit_logs WHERE organization_id=v_org AND record_id=v_existing.id::text ORDER BY created_at LIMIT 1));
  END IF;
  SELECT id,requires_inspection INTO v_template,v_requires FROM public.housekeeping_checklist_templates
    WHERE organization_id=v_org AND active AND (branch_id IS NULL OR branch_id=v_room.branch_id)
    ORDER BY branch_id NULLS LAST LIMIT 1;
  SELECT station_id INTO v_station FROM public.roles r JOIN public.user_roles ur ON ur.role_id=r.id
    WHERE ur.user_id=_assignee AND r.organization_id=v_org AND r.station_id IS NOT NULL LIMIT 1;
  v_status := CASE WHEN _assignee IS NULL THEN 'pending' ELSE 'assigned' END;
  INSERT INTO public.tasks (organization_id,branch_id,department_id,station_id,reference,title,description,
    assignee_id,created_by,due_at,priority,status)
  VALUES (v_org,v_room.branch_id,v_department,v_station,'HK-'||left(v_key,24),
    initcap(replace(_job_type,'-',' '))||' — Room '||v_room.room_number,coalesce(v_reason,''),
    _assignee,v_actor,_due_at,_priority,CASE WHEN _assignee IS NULL THEN 'open' ELSE 'assigned' END)
  RETURNING id INTO v_task;
  INSERT INTO public.housekeeping_jobs (organization_id,branch_id,department_id,station_id,job_number,task_id,
    room_id,room_type_id,job_type,reservation_id,template_id,assignee_id,assigned_team,priority,status,due_at,
    inspection_required,inspection_status,notes,idempotency_key,source,source_record_id,correlation_id,created_by)
  VALUES (v_org,v_room.branch_id,v_department,v_station,public.next_document_number('housekeeping-job'),v_task,
    _room,v_room.room_type_id,_job_type,_reservation,v_template,_assignee,_assigned_team,_priority,v_status,_due_at,
    coalesce(v_requires,true),CASE WHEN coalesce(v_requires,true) THEN 'pending' ELSE 'not-required' END,v_reason,v_key,
    _source,_source_record,coalesce(_correlation,gen_random_uuid()),v_actor)
  RETURNING id INTO v_job;
  UPDATE public.rooms SET housekeeping_status=CASE WHEN _job_type='rework' THEN 'rework' ELSE 'dirty' END,
    inspection_status='pending', sellable=false, room_condition='vacant-dirty', updated_at=now() WHERE id=_room;
  IF _assignee IS NOT NULL THEN
    INSERT INTO public.notifications (organization_id,branch_id,department_id,station_id,user_id,category,title,body,link,
      priority,idempotency_key,action_required,source_module,source_record_id,event_type)
    VALUES (v_org,v_room.branch_id,v_department,v_station,_assignee,'task','Cleaning task — Room '||v_room.room_number,
      initcap(replace(_job_type,'-',' '))||coalesce(': '||v_reason,''),'/housekeeping/tasks',_priority,
      'hk-assigned:'||v_job::text,true,'housekeeping',v_job,'housekeeping.task.assigned') RETURNING id INTO v_notification;
  END IF;
  v_event := public.emit_domain_event(v_org,v_room.branch_id,'housekeeping.task.created','housekeeping',v_job,
    jsonb_build_object('room_id',_room,'task_id',v_task,'assignee_id',_assignee,'job_type',_job_type,'source',_source,
      'source_record_id',_source_record,'correlation_id',coalesce(_correlation,gen_random_uuid())),
    'hk-created:'||v_key,NULL);
  v_audit := public.log_audit_event('housekeeping.task.created','housekeeping',v_job::text,to_jsonb(v_room),
    jsonb_build_object('job_id',v_job,'task_id',v_task,'room_id',_room,'assignee_id',_assignee,'status',v_status),
    v_reason,'housekeeping.tasks.create',v_room.branch_id,v_department,v_station,
    coalesce(_correlation,gen_random_uuid())::text,NULL,NULL);
  RETURN jsonb_build_object('ok',true,'idempotent',false,'job_id',v_job,'task_id',v_task,
    'notification_id',v_notification,'workflow_event_id',v_event,'audit_event_id',v_audit,
    'room_id',_room,'room_before',to_jsonb(v_room),
    'room_after',(SELECT to_jsonb(r) FROM public.rooms r WHERE r.id=_room));
END $function$;