-- Repair the housekeeping Property → Department → Role → Active Worker assignment chain.

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
  WITH requested_department AS (
    SELECT d.id,
           coalesce(
             nullif(btrim(coalesce(d.catalogue_key,'')),''),
             public.neo_department_catalogue_key(d.name),
             lower(btrim(d.name))
           ) AS ident,
           d.branch_id
      FROM public.departments d
     WHERE _department IS NOT NULL
       AND d.id = _department
       AND d.organization_id = public.current_org_id()
       AND coalesce(d.active, true)
       AND coalesce(d.department_status, 'active') <> 'archived'
       AND (_branch IS NULL OR d.branch_id IS NULL OR d.branch_id = _branch)
  ), wanted AS (
    SELECT coalesce(
             nullif(btrim(_department_key), ''),
             (SELECT ident FROM requested_department LIMIT 1)
           ) AS ident
  ), active_staff AS (
    SELECT DISTINCT ON (p.id)
           p.id,
           p.full_name,
           p.staff_id,
           coalesce(nullif(p.job_title, ''), nullif(e.job_title, '')) AS job_title,
           coalesce(p.department_id, e.department_id) AS staff_department_id,
           coalesce(p.branch_id, e.branch_id) AS staff_branch_id
      FROM public.profiles p
      JOIN public.employees e
        ON e.profile_id = p.id
       AND e.organization_id = p.organization_id
       AND coalesce(e.employment_status, 'active') NOT IN ('terminated', 'exited', 'resigned')
       AND coalesce(e.system_access_status, 'active') NOT IN ('disabled', 'revoked', 'suspended')
     WHERE p.organization_id = public.current_org_id()
       AND coalesce(p.account_status, 'active') = 'active'
       AND coalesce(p.employment_status, 'active') NOT IN ('terminated', 'exited', 'resigned')
       AND (_branch IS NULL OR coalesce(p.branch_id, e.branch_id) = _branch)
       AND public.neo_branch_in_scope(coalesce(p.branch_id, e.branch_id))
       AND EXISTS (
         SELECT 1
           FROM public.user_roles ur
           JOIN public.roles r
             ON r.id = ur.role_id
            AND r.organization_id = p.organization_id
            AND coalesce(r.active, true)
            AND coalesce(r.role_status, 'active') = 'active'
           LEFT JOIN public.departments rd
             ON rd.id = r.department_id
          CROSS JOIN wanted w
          WHERE ur.user_id = p.id
            AND ur.organization_id = p.organization_id
            AND (
              w.ident IS NULL
              OR (
                rd.id IS NOT NULL
                AND coalesce(
                  nullif(btrim(coalesce(rd.catalogue_key,'')),''),
                  public.neo_department_catalogue_key(rd.name),
                  lower(btrim(rd.name))
                ) = w.ident
              )
            )
       )
       AND (
         (SELECT ident FROM wanted) IS NULL
         OR EXISTS (
           SELECT 1
             FROM public.departments sd
            WHERE sd.id IN (p.department_id, e.department_id)
              AND sd.organization_id = p.organization_id
              AND coalesce(sd.active, true)
              AND coalesce(sd.department_status, 'active') <> 'archived'
              AND (_branch IS NULL OR sd.branch_id IS NULL OR sd.branch_id = _branch)
              AND coalesce(
                nullif(btrim(coalesce(sd.catalogue_key,'')),''),
                public.neo_department_catalogue_key(sd.name),
                lower(btrim(sd.name))
              ) = (SELECT ident FROM wanted)
         )
       )
     ORDER BY p.id, (p.department_id IS NOT NULL) DESC, (p.branch_id IS NOT NULL) DESC
  )
  SELECT a.id,
         a.full_name,
         a.staff_id,
         a.job_title,
         a.staff_department_id,
         d.name,
         a.staff_branch_id,
         b.name
    FROM active_staff a
    LEFT JOIN public.departments d ON d.id = a.staff_department_id
    LEFT JOIN public.branches b ON b.id = a.staff_branch_id
   ORDER BY a.full_name, a.staff_id;
$function$;

CREATE OR REPLACE FUNCTION public.neo_assert_worker_scope(_worker uuid, _branch uuid, _department_key text DEFAULT NULL::text)
 RETURNS uuid
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_org uuid := public.current_org_id();
  p public.profiles;
  e public.employees;
  v_worker_branch uuid;
  v_department_ok boolean;
  v_role_ok boolean;
  v_key text := nullif(btrim(coalesce(_department_key, '')), '');
BEGIN
  IF _worker IS NULL THEN
    RAISE EXCEPTION 'Select the worker who will carry out this work';
  END IF;

  SELECT * INTO p
    FROM public.profiles
   WHERE id = _worker
     AND organization_id = v_org;

  IF p.id IS NULL THEN
    RAISE EXCEPTION 'That worker is not a staff account in this organisation';
  END IF;
  IF coalesce(p.account_status, 'active') <> 'active' OR coalesce(p.employment_status, 'active') IN ('terminated', 'exited', 'resigned') THEN
    RAISE EXCEPTION 'That worker''s account is not active';
  END IF;

  SELECT * INTO e
    FROM public.employees
   WHERE profile_id = p.id
     AND organization_id = v_org
   ORDER BY updated_at DESC
   LIMIT 1;

  IF e.id IS NULL THEN
    RAISE EXCEPTION 'That worker is not linked to an active HR employee record';
  END IF;
  IF coalesce(e.employment_status, 'active') IN ('terminated', 'exited', 'resigned')
     OR coalesce(e.system_access_status, 'active') IN ('disabled', 'revoked', 'suspended') THEN
    RAISE EXCEPTION 'That worker is not an active employee';
  END IF;

  v_worker_branch := coalesce(p.branch_id, e.branch_id);
  IF _branch IS NOT NULL AND v_worker_branch IS DISTINCT FROM _branch THEN
    RAISE EXCEPTION 'That worker belongs to another property';
  END IF;
  IF NOT public.neo_branch_in_scope(v_worker_branch) THEN
    RAISE EXCEPTION 'That worker is outside your authorized property scope';
  END IF;

  IF v_key IS NOT NULL THEN
    SELECT EXISTS (
      SELECT 1
        FROM public.departments d
       WHERE d.id IN (p.department_id, e.department_id)
         AND d.organization_id = v_org
         AND coalesce(d.active, true)
         AND coalesce(d.department_status, 'active') <> 'archived'
         AND (_branch IS NULL OR d.branch_id IS NULL OR d.branch_id = _branch)
         AND coalesce(
           nullif(btrim(coalesce(d.catalogue_key,'')),''),
           public.neo_department_catalogue_key(d.name),
           lower(btrim(d.name))
         ) = v_key
    ) INTO v_department_ok;

    IF NOT coalesce(v_department_ok, false) THEN
      RAISE EXCEPTION 'That worker is not assigned to the requested department for this property';
    END IF;

    SELECT EXISTS (
      SELECT 1
        FROM public.user_roles ur
        JOIN public.roles r
          ON r.id = ur.role_id
         AND r.organization_id = v_org
         AND coalesce(r.active, true)
         AND coalesce(r.role_status, 'active') = 'active'
        JOIN public.departments rd ON rd.id = r.department_id
       WHERE ur.user_id = p.id
         AND ur.organization_id = v_org
         AND coalesce(
           nullif(btrim(coalesce(rd.catalogue_key,'')),''),
           public.neo_department_catalogue_key(rd.name),
           lower(btrim(rd.name))
         ) = v_key
    ) INTO v_role_ok;

    IF NOT coalesce(v_role_ok, false) THEN
      RAISE EXCEPTION 'That worker does not hold an active role for the requested department';
    END IF;
  END IF;

  RETURN p.id;
END
$function$;

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
  v_assignee uuid;
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
  v_assignee := public.neo_assert_worker_scope(_assignee, v_job.branch_id, 'housekeeping');

  IF v_job.assignee_id = v_assignee THEN
    RETURN jsonb_build_object('ok', true, 'idempotent', true, 'job_id', _job, 'assignee_id', v_assignee);
  END IF;

  v_status := CASE WHEN v_job.status = 'pending' THEN 'assigned' ELSE v_job.status END;

  UPDATE public.housekeeping_jobs
  SET assignee_id = v_assignee, status = v_status, updated_at = now()
  WHERE id = _job;

  UPDATE public.tasks
  SET assignee_id = v_assignee,
      status = CASE WHEN status = 'open' THEN 'assigned' ELSE status END,
      updated_at = now()
  WHERE id = v_job.task_id;

  INSERT INTO public.notifications (
    organization_id, branch_id, department_id, station_id, user_id, category, title, body, link,
    priority, idempotency_key, action_required, source_module, source_record_id, event_type
  ) VALUES (
    v_org, v_job.branch_id, v_job.department_id, v_job.station_id, v_assignee, 'task',
    'Cleaning assigned — Room ' || coalesce(v_room.room_number, '—'),
    coalesce(v_reason, initcap(replace(v_job.job_type, '-', ' '))),
    '/housekeeping/tasks', coalesce(v_job.priority, 'normal'),
    'hk-assign:' || _job::text || ':' || v_assignee::text, true, 'housekeeping', _job,
    'housekeeping.task.assigned'
  )
  ON CONFLICT DO NOTHING
  RETURNING id INTO v_notification;

  v_event := public.emit_domain_event(
    v_org, v_job.branch_id, 'housekeeping.task.assigned', 'housekeeping', _job,
    jsonb_build_object('room_id', v_job.room_id, 'from_assignee', v_job.assignee_id, 'to_assignee', v_assignee),
    'hk-assigned:' || _job::text || ':' || v_assignee::text, NULL
  );

  v_audit := public.log_audit_event(
    'housekeeping.task.assigned', 'housekeeping', _job::text,
    jsonb_build_object('assignee_id', v_job.assignee_id, 'status', v_job.status),
    jsonb_build_object('assignee_id', v_assignee, 'status', v_status),
    v_reason, 'housekeeping.tasks.assign', v_job.branch_id, v_job.department_id, v_job.station_id,
    coalesce(_correlation, gen_random_uuid())::text, NULL, NULL
  );

  RETURN jsonb_build_object(
    'ok', true, 'idempotent', false, 'job_id', _job, 'task_id', v_job.task_id,
    'assignee_id', v_assignee, 'status', v_status,
    'notification_id', v_notification, 'workflow_event_id', v_event, 'audit_event_id', v_audit,
    'confirmed_assignee_id', (SELECT j.assignee_id FROM public.housekeeping_jobs j WHERE j.id = _job),
    'confirmed_task_assignee_id', (SELECT t.assignee_id FROM public.tasks t WHERE t.id = v_job.task_id)
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
  v_assignee uuid := NULL;
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
  SELECT id,requires_inspection INTO v_template,v_requires FROM public.housekeeping_checklist_templates
    WHERE organization_id=v_org AND active AND (branch_id IS NULL OR branch_id=v_room.branch_id)
    ORDER BY branch_id NULLS LAST LIMIT 1;
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
    room_id,room_type_id,job_type,reservation_id,template_id,assignee_id,assigned_team,priority,status,due_at,
    inspection_required,inspection_status,notes,idempotency_key,source,source_record_id,correlation_id,created_by)
  VALUES (v_org,v_room.branch_id,v_department,v_station,public.next_document_number('housekeeping-job'),v_task,
    _room,v_room.room_type_id,_job_type,_reservation,v_template,v_assignee,_assigned_team,_priority,v_status,_due_at,
    coalesce(v_requires,true),CASE WHEN coalesce(v_requires,true) THEN 'pending' ELSE 'not-required' END,v_reason,v_key,
    _source,_source_record,coalesce(_correlation,gen_random_uuid()),v_actor)
  RETURNING id INTO v_job;
  UPDATE public.rooms SET housekeeping_status=CASE WHEN _job_type='rework' THEN 'rework' ELSE 'dirty' END,
    inspection_status='pending', sellable=false, room_condition='vacant-dirty', updated_at=now() WHERE id=_room;
  IF v_assignee IS NOT NULL THEN
    INSERT INTO public.notifications (organization_id,branch_id,department_id,station_id,user_id,category,title,body,link,
      priority,idempotency_key,action_required,source_module,source_record_id,event_type)
    VALUES (v_org,v_room.branch_id,v_department,v_station,v_assignee,'task','Cleaning task — Room '||v_room.room_number,
      initcap(replace(_job_type,'-',' '))||coalesce(': '||v_reason,''),'/housekeeping/tasks',_priority,
      'hk-assigned:'||v_job::text,true,'housekeeping',v_job,'housekeeping.task.assigned') RETURNING id INTO v_notification;
  END IF;
  v_event := public.emit_domain_event(v_org,v_room.branch_id,'housekeeping.task.created','housekeeping',v_job,
    jsonb_build_object('room_id',_room,'task_id',v_task,'assignee_id',v_assignee,'job_type',_job_type,'source',_source,
      'source_record_id',_source_record,'correlation_id',coalesce(_correlation,gen_random_uuid())),
    'hk-created:'||v_key,NULL);
  v_audit := public.log_audit_event('housekeeping.task.created','housekeeping',v_job::text,to_jsonb(v_room),
    jsonb_build_object('job_id',v_job,'task_id',v_task,'room_id',_room,'assignee_id',v_assignee,'status',v_status),
    v_reason,'housekeeping.tasks.create',v_room.branch_id,v_department,v_station,
    coalesce(_correlation,gen_random_uuid())::text,NULL,NULL);
  RETURN jsonb_build_object('ok',true,'idempotent',false,'job_id',v_job,'task_id',v_task,
    'assignee_id',v_assignee,'notification_id',v_notification,'workflow_event_id',v_event,'audit_event_id',v_audit,
    'room_id',_room,'room_before',to_jsonb(v_room),
    'room_after',(SELECT to_jsonb(r) FROM public.rooms r WHERE r.id=_room),
    'confirmed_assignee_id',(SELECT j.assignee_id FROM public.housekeeping_jobs j WHERE j.id=v_job),
    'confirmed_task_assignee_id',(SELECT t.assignee_id FROM public.tasks t WHERE t.id=v_task));
END $function$;

REVOKE ALL ON FUNCTION public.neo_scoped_workers(uuid, uuid, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.neo_assert_worker_scope(uuid, uuid, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.hk_assign_job(uuid, uuid, text, uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.hk_raise_cleaning_task(uuid, text, text, text, timestamp with time zone, uuid, text, uuid, text, uuid, text, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.neo_scoped_workers(uuid, uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.neo_assert_worker_scope(uuid, uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.hk_assign_job(uuid, uuid, text, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.hk_raise_cleaning_task(uuid, text, text, text, timestamp with time zone, uuid, text, uuid, text, uuid, text, uuid) TO authenticated;