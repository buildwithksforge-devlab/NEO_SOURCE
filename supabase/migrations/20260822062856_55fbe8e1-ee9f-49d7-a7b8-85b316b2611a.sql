ALTER TABLE public.audit_logs
  ALTER COLUMN correlation_id TYPE text USING correlation_id::text;

ALTER TABLE public.housekeeping_jobs
  ADD COLUMN IF NOT EXISTS room_type_id uuid REFERENCES public.room_types(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS station_id uuid REFERENCES public.operational_stations(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'manual',
  ADD COLUMN IF NOT EXISTS source_record_id uuid,
  ADD COLUMN IF NOT EXISTS correlation_id uuid NOT NULL DEFAULT gen_random_uuid(),
  ADD COLUMN IF NOT EXISTS assigned_team text;

ALTER TABLE public.rooms
  ADD COLUMN IF NOT EXISTS inspection_status text NOT NULL DEFAULT 'not-required';

ALTER TABLE public.menu_import_batches
  ADD COLUMN IF NOT EXISTS menu_id uuid REFERENCES public.menus(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS correlation_id uuid,
  ADD COLUMN IF NOT EXISTS parsed_rows integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS valid_rows integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS committed_rows integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS duplicate_rows integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS mapping_rows integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS rolled_back_rows integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS checksum text;

CREATE TABLE public.audit_repair_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  action text NOT NULL,
  module text NOT NULL,
  record_id text,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  correlation_id text NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  attempts integer NOT NULL DEFAULT 0,
  last_error text,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, correlation_id, action)
);
GRANT SELECT, INSERT, UPDATE ON public.audit_repair_jobs TO authenticated;
GRANT ALL ON public.audit_repair_jobs TO service_role;
ALTER TABLE public.audit_repair_jobs ENABLE ROW LEVEL SECURITY;
CREATE POLICY audit_repair_jobs_read ON public.audit_repair_jobs FOR SELECT TO authenticated
  USING (organization_id = public.current_org_id() AND public.has_permission('administration','audit-logs','view'));
CREATE POLICY audit_repair_jobs_insert ON public.audit_repair_jobs FOR INSERT TO authenticated
  WITH CHECK (organization_id = public.current_org_id() AND created_by = auth.uid());
CREATE POLICY audit_repair_jobs_update ON public.audit_repair_jobs FOR UPDATE TO authenticated
  USING (organization_id = public.current_org_id() AND public.has_permission('administration','audit-logs','edit'))
  WITH CHECK (organization_id = public.current_org_id());

DROP FUNCTION IF EXISTS public.log_audit_event(text,text,text,jsonb,jsonb,text,text,uuid,uuid,uuid,uuid,jsonb,text);
CREATE OR REPLACE FUNCTION public.log_audit_event(
  _action text,
  _module text DEFAULT 'administration',
  _record_id text DEFAULT NULL,
  _previous jsonb DEFAULT NULL,
  _new jsonb DEFAULT NULL,
  _reason text DEFAULT NULL,
  _permission_used text DEFAULT NULL,
  _branch uuid DEFAULT NULL,
  _department uuid DEFAULT NULL,
  _station uuid DEFAULT NULL,
  _correlation text DEFAULT NULL,
  _delegation jsonb DEFAULT NULL,
  _device text DEFAULT NULL
) RETURNS uuid
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path TO 'public'
AS $$
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
  SELECT array_agg(DISTINCT r.name) INTO v_roles
    FROM public.user_roles ur JOIN public.roles r ON r.id = ur.role_id WHERE ur.user_id = v_actor;
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
END $$;
REVOKE ALL ON FUNCTION public.log_audit_event(text,text,text,jsonb,jsonb,text,text,uuid,uuid,uuid,text,jsonb,text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.log_audit_event(text,text,text,jsonb,jsonb,text,text,uuid,uuid,uuid,text,jsonb,text) TO authenticated;

CREATE OR REPLACE FUNCTION public.hk_recalculate_room(_room uuid)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE v_room public.rooms; v_sellable boolean;
BEGIN
  SELECT * INTO v_room FROM public.rooms WHERE id=_room FOR UPDATE;
  IF v_room.id IS NULL THEN RAISE EXCEPTION 'Unknown room'; END IF;
  v_sellable := v_room.status='active'
    AND v_room.occupancy_status='vacant'
    AND v_room.housekeeping_status='clean'
    AND v_room.inspection_status IN ('passed','not-required')
    AND v_room.maintenance_status='operational';
  UPDATE public.rooms SET sellable=v_sellable,
    room_condition=CASE
      WHEN maintenance_status <> 'operational' THEN 'maintenance'
      WHEN occupancy_status='occupied' THEN 'occupied'
      WHEN housekeeping_status='clean' AND inspection_status IN ('passed','not-required') THEN 'vacant-clean'
      ELSE 'vacant-dirty' END,
    updated_at=now() WHERE id=_room;
  RETURN v_sellable;
END $$;
REVOKE ALL ON FUNCTION public.hk_recalculate_room(uuid) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.hk_raise_cleaning_task(
  _room uuid,
  _job_type text,
  _reason text,
  _priority text DEFAULT 'normal',
  _due_at timestamptz DEFAULT NULL,
  _assignee uuid DEFAULT NULL,
  _assigned_team text DEFAULT NULL,
  _reservation uuid DEFAULT NULL,
  _source text DEFAULT 'manual',
  _source_record uuid DEFAULT NULL,
  _idempotency_key text DEFAULT NULL,
  _correlation uuid DEFAULT NULL
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
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
  SELECT id INTO v_department FROM public.departments
    WHERE organization_id=v_org AND name ILIKE 'housekeeping%' ORDER BY name LIMIT 1;
  IF _assignee IS NOT NULL THEN
    IF NOT EXISTS (SELECT 1 FROM public.profiles p WHERE p.id=_assignee AND p.organization_id=v_org
      AND p.account_status='active' AND p.department_id=v_department
      AND (p.branch_id IS NULL OR p.branch_id=v_room.branch_id)) THEN
      RAISE EXCEPTION 'Selected assignee is not an active Housekeeping worker in this property scope';
    END IF;
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
END $$;
REVOKE ALL ON FUNCTION public.hk_raise_cleaning_task(uuid,text,text,text,timestamptz,uuid,text,uuid,text,uuid,text,uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.hk_raise_cleaning_task(uuid,text,text,text,timestamptz,uuid,text,uuid,text,uuid,text,uuid) TO authenticated;

CREATE OR REPLACE FUNCTION public.hk_start_job(_job uuid, _correlation uuid DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE v_org uuid:=public.current_org_id(); v_job public.housekeeping_jobs; v_audit uuid; v_event uuid;
BEGIN
  SELECT * INTO v_job FROM public.housekeeping_jobs WHERE id=_job AND organization_id=v_org FOR UPDATE;
  IF v_job.id IS NULL THEN RAISE EXCEPTION 'Unknown housekeeping task'; END IF;
  IF NOT (v_job.assignee_id=auth.uid() OR public.has_permission('housekeeping','tasks','assign')) THEN RAISE EXCEPTION 'This task is not assigned to you'; END IF;
  IF v_job.status='in-progress' THEN RETURN jsonb_build_object('ok',true,'idempotent',true,'job_id',_job); END IF;
  IF v_job.status NOT IN ('pending','assigned','rework') THEN RAISE EXCEPTION 'Task cannot be started from status %',v_job.status; END IF;
  UPDATE public.housekeeping_jobs SET status='in-progress',started_at=coalesce(started_at,now()),assignee_id=coalesce(assignee_id,auth.uid()),updated_at=now() WHERE id=_job;
  UPDATE public.tasks SET status='in-progress',assignee_id=coalesce(assignee_id,auth.uid()),updated_at=now() WHERE id=v_job.task_id;
  UPDATE public.rooms SET housekeeping_status='in-progress',inspection_status='pending',sellable=false,updated_at=now() WHERE id=v_job.room_id;
  v_event:=public.emit_domain_event(v_org,v_job.branch_id,'housekeeping.task.started','housekeeping',_job,jsonb_build_object('room_id',v_job.room_id),'hk-started:'||_job::text,NULL);
  v_audit:=public.log_audit_event('housekeeping.task.started','housekeeping',_job::text,jsonb_build_object('status',v_job.status),jsonb_build_object('status','in-progress'),NULL,'housekeeping.tasks.start',v_job.branch_id,v_job.department_id,v_job.station_id,coalesce(_correlation,gen_random_uuid())::text,NULL,NULL);
  RETURN jsonb_build_object('ok',true,'idempotent',false,'job_id',_job,'workflow_event_id',v_event,'audit_event_id',v_audit);
END $$;
REVOKE ALL ON FUNCTION public.hk_start_job(uuid,uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.hk_start_job(uuid,uuid) TO authenticated;

CREATE OR REPLACE FUNCTION public.hk_complete_job(_job uuid, _notes text DEFAULT NULL, _correlation uuid DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE v_org uuid:=public.current_org_id(); v_job public.housekeeping_jobs; v_notification uuid; v_event uuid; v_audit uuid; v_inspector uuid;
BEGIN
  SELECT * INTO v_job FROM public.housekeeping_jobs WHERE id=_job AND organization_id=v_org FOR UPDATE;
  IF v_job.id IS NULL THEN RAISE EXCEPTION 'Unknown housekeeping task'; END IF;
  IF NOT (v_job.assignee_id=auth.uid() OR public.has_permission('housekeeping','tasks','complete')) THEN RAISE EXCEPTION 'This task is not assigned to you'; END IF;
  IF v_job.status='awaiting-inspection' THEN RETURN jsonb_build_object('ok',true,'idempotent',true,'job_id',_job); END IF;
  IF v_job.status<>'in-progress' THEN RAISE EXCEPTION 'Task must be in progress before completion'; END IF;
  UPDATE public.housekeeping_jobs SET status=CASE WHEN inspection_required THEN 'awaiting-inspection' ELSE 'completed' END,
    inspection_status=CASE WHEN inspection_required THEN 'pending' ELSE 'not-required' END,completed_at=now(),notes=coalesce(_notes,notes),updated_at=now() WHERE id=_job;
  UPDATE public.tasks SET status=CASE WHEN v_job.inspection_required THEN 'in-progress' ELSE 'completed' END,
    completed_at=CASE WHEN v_job.inspection_required THEN NULL ELSE now() END,updated_at=now() WHERE id=v_job.task_id;
  UPDATE public.rooms SET housekeeping_status=CASE WHEN v_job.inspection_required THEN 'awaiting-inspection' ELSE 'clean' END,
    inspection_status=CASE WHEN v_job.inspection_required THEN 'pending' ELSE 'not-required' END,
    last_cleaned_at=now(),sellable=false,updated_at=now() WHERE id=v_job.room_id;
  IF NOT v_job.inspection_required THEN PERFORM public.hk_recalculate_room(v_job.room_id); END IF;
  IF v_job.inspection_required THEN
    SELECT p.id INTO v_inspector FROM public.profiles p WHERE p.organization_id=v_org AND p.account_status='active'
      AND p.department_id=v_job.department_id AND (p.branch_id IS NULL OR p.branch_id=v_job.branch_id)
      AND public.has_permission_for_user(p.id,v_org,'housekeeping','inspections','approve') ORDER BY p.id LIMIT 1;
    IF v_inspector IS NOT NULL THEN
      INSERT INTO public.notifications (organization_id,branch_id,department_id,station_id,user_id,category,title,body,link,priority,idempotency_key,action_required,source_module,source_record_id,event_type)
      VALUES(v_org,v_job.branch_id,v_job.department_id,v_job.station_id,v_inspector,'approval','Room inspection required','Cleaning is complete and awaits inspection.','/housekeeping/inspections','high','hk-inspect:'||_job::text,true,'housekeeping',_job,'housekeeping.inspection.required') RETURNING id INTO v_notification;
    END IF;
  END IF;
  v_event:=public.emit_domain_event(v_org,v_job.branch_id,'housekeeping.cleaning.completed','housekeeping',_job,jsonb_build_object('room_id',v_job.room_id,'inspection_required',v_job.inspection_required),'hk-completed:'||_job::text,NULL);
  v_audit:=public.log_audit_event('housekeeping.task.completed','housekeeping',_job::text,jsonb_build_object('status',v_job.status),jsonb_build_object('status',CASE WHEN v_job.inspection_required THEN 'awaiting-inspection' ELSE 'completed' END),_notes,'housekeeping.tasks.complete',v_job.branch_id,v_job.department_id,v_job.station_id,coalesce(_correlation,gen_random_uuid())::text,NULL,NULL);
  RETURN jsonb_build_object('ok',true,'idempotent',false,'job_id',_job,'inspection_required',v_job.inspection_required,'notification_id',v_notification,'workflow_event_id',v_event,'audit_event_id',v_audit);
END $$;
REVOKE ALL ON FUNCTION public.hk_complete_job(uuid,text,uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.hk_complete_job(uuid,text,uuid) TO authenticated;

CREATE OR REPLACE FUNCTION public.hk_record_inspection(_job uuid,_result text,_notes text DEFAULT NULL,_defects jsonb DEFAULT '[]'::jsonb,_inspection_type text DEFAULT 'standard',_correlation uuid DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE v_org uuid:=public.current_org_id(); v_job public.housekeeping_jobs; v_insp uuid; v_notification uuid; v_event uuid; v_audit uuid; v_sellable boolean;
BEGIN
  IF NOT public.has_permission('housekeeping','inspections','approve') THEN RAISE EXCEPTION 'Missing permission: housekeeping.inspections.approve'; END IF;
  IF _result NOT IN ('passed','passed-with-notes','failed','reinspection-required') THEN RAISE EXCEPTION 'Invalid inspection result'; END IF;
  SELECT * INTO v_job FROM public.housekeeping_jobs WHERE id=_job AND organization_id=v_org FOR UPDATE;
  IF v_job.id IS NULL THEN RAISE EXCEPTION 'Unknown housekeeping task'; END IF;
  IF v_job.status NOT IN ('awaiting-inspection','rework') THEN RAISE EXCEPTION 'Task is not awaiting inspection'; END IF;
  INSERT INTO public.room_inspections(organization_id,branch_id,room_id,job_id,inspection_type,inspector_id,result,defects,notes,rework_required,released_at)
  VALUES(v_org,v_job.branch_id,v_job.room_id,_job,_inspection_type,auth.uid(),_result,coalesce(_defects,'[]'::jsonb),_notes,_result IN ('failed','reinspection-required'),CASE WHEN _result IN ('passed','passed-with-notes') THEN now() END) RETURNING id INTO v_insp;
  IF _result IN ('passed','passed-with-notes') THEN
    UPDATE public.housekeeping_jobs SET status='completed',inspection_status='passed',updated_at=now() WHERE id=_job;
    UPDATE public.tasks SET status='completed',completed_at=now(),updated_at=now() WHERE id=v_job.task_id;
    UPDATE public.rooms SET housekeeping_status='clean',inspection_status='passed',last_inspected_at=now(),updated_at=now() WHERE id=v_job.room_id;
    v_sellable:=public.hk_recalculate_room(v_job.room_id);
  ELSE
    UPDATE public.housekeeping_jobs SET status='rework',inspection_status='failed',rework_count=rework_count+1,completed_at=NULL,updated_at=now() WHERE id=_job;
    UPDATE public.tasks SET status='assigned',completed_at=NULL,updated_at=now() WHERE id=v_job.task_id;
    UPDATE public.rooms SET housekeeping_status='rework',inspection_status='failed',sellable=false,updated_at=now() WHERE id=v_job.room_id;
    IF v_job.assignee_id IS NOT NULL THEN
      INSERT INTO public.notifications(organization_id,branch_id,department_id,station_id,user_id,category,title,body,link,priority,idempotency_key,action_required,source_module,source_record_id,event_type)
      VALUES(v_org,v_job.branch_id,v_job.department_id,v_job.station_id,v_job.assignee_id,'task','Corrective cleaning required',coalesce(_notes,'Inspection failed'),'/housekeeping/tasks','high','hk-rework:'||v_insp::text,true,'housekeeping',_job,'housekeeping.inspection.failed') RETURNING id INTO v_notification;
    END IF;
  END IF;
  v_event:=public.emit_domain_event(v_org,v_job.branch_id,CASE WHEN _result IN ('passed','passed-with-notes') THEN 'housekeeping.room.released' ELSE 'housekeeping.inspection.failed' END,'housekeeping',_job,jsonb_build_object('room_id',v_job.room_id,'inspection_id',v_insp,'result',_result,'sellable',coalesce(v_sellable,false)),'hk-inspection:'||v_insp::text,NULL);
  v_audit:=public.log_audit_event('housekeeping.inspection.'||_result,'housekeeping',_job::text,jsonb_build_object('status',v_job.status),jsonb_build_object('inspection_id',v_insp,'result',_result,'sellable',coalesce(v_sellable,false)),_notes,'housekeeping.inspections.approve',v_job.branch_id,v_job.department_id,v_job.station_id,coalesce(_correlation,gen_random_uuid())::text,NULL,NULL);
  RETURN jsonb_build_object('ok',true,'job_id',_job,'inspection_id',v_insp,'result',_result,'sellable',coalesce(v_sellable,false),'notification_id',v_notification,'workflow_event_id',v_event,'audit_event_id',v_audit);
END $$;
REVOKE ALL ON FUNCTION public.hk_record_inspection(uuid,text,text,jsonb,text,uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.hk_record_inspection(uuid,text,text,jsonb,text,uuid) TO authenticated;

CREATE OR REPLACE FUNCTION public.tg_checkout_housekeeping_handoff()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE v_room public.rooms; v_department uuid; v_job uuid; v_task uuid; v_key text; v_notification uuid;
BEGIN
  IF NEW.status='checked-out' AND OLD.status IS DISTINCT FROM 'checked-out' AND NEW.room_id IS NOT NULL THEN
    SELECT * INTO v_room FROM public.rooms WHERE id=NEW.room_id FOR UPDATE;
    v_key:='checkout:'||NEW.reservation_id::text;
    IF NOT EXISTS(SELECT 1 FROM public.housekeeping_jobs WHERE organization_id=NEW.organization_id AND idempotency_key=v_key) THEN
      SELECT id INTO v_department FROM public.departments WHERE organization_id=NEW.organization_id AND name ILIKE 'housekeeping%' ORDER BY name LIMIT 1;
      INSERT INTO public.tasks(organization_id,branch_id,department_id,reference,title,description,created_by,priority,status)
      VALUES(NEW.organization_id,NEW.branch_id,v_department,'HK-OUT-'||left(NEW.id::text,8),'Clean room '||coalesce(v_room.room_number,''),'Departure cleaning required.',auth.uid(),'high','open') RETURNING id INTO v_task;
      INSERT INTO public.housekeeping_jobs(organization_id,branch_id,department_id,job_number,task_id,room_id,room_type_id,job_type,reservation_id,priority,status,inspection_required,inspection_status,idempotency_key,source,source_record_id,created_by)
      VALUES(NEW.organization_id,NEW.branch_id,v_department,public.next_document_number('housekeeping-job'),v_task,NEW.room_id,v_room.room_type_id,'checkout-cleaning',NEW.reservation_id,'high','pending',true,'pending',v_key,'checkout',NEW.reservation_id,auth.uid()) RETURNING id INTO v_job;
      UPDATE public.rooms SET occupancy_status='vacant',housekeeping_status='dirty',inspection_status='pending',room_condition='vacant-dirty',sellable=false,updated_at=now() WHERE id=NEW.room_id;
      INSERT INTO public.notifications(organization_id,branch_id,department_id,category,title,body,link,priority,idempotency_key,action_required,source_module,source_record_id,event_type)
      SELECT NEW.organization_id,NEW.branch_id,v_department,'task','Departure cleaning — Room '||coalesce(v_room.room_number,''),'Guest checkout created a cleaning task.','/housekeeping/tasks','high','hk-checkout-notify:'||v_job::text,true,'housekeeping',v_job,'housekeeping.task.created'
      RETURNING id INTO v_notification;
      PERFORM public.emit_domain_event(NEW.organization_id,NEW.branch_id,'housekeeping.task.created','housekeeping',v_job,jsonb_build_object('room_id',NEW.room_id,'reservation_id',NEW.reservation_id,'task_id',v_task,'notification_id',v_notification),'hk-checkout:'||NEW.reservation_id::text,NULL);
      INSERT INTO public.audit_logs(organization_id,branch_id,department_id,user_id,user_name,action,module,record_id,new_value,reason,correlation_id)
      VALUES(NEW.organization_id,NEW.branch_id,v_department,auth.uid(),'','housekeeping.checkout_handoff','housekeeping',v_job::text,jsonb_build_object('room_id',NEW.room_id,'reservation_id',NEW.reservation_id,'task_id',v_task,'notification_id',v_notification),'Automatic checkout handoff',gen_random_uuid()::text);
    END IF;
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.tg_checkout_housekeeping_handoff() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS trg_checkout_housekeeping_handoff ON public.stays;
CREATE TRIGGER trg_checkout_housekeeping_handoff AFTER UPDATE OF status ON public.stays FOR EACH ROW EXECUTE FUNCTION public.tg_checkout_housekeeping_handoff();

CREATE OR REPLACE FUNCTION public.pos_save_menu(_name text,_description text,_branch uuid,_service_type text,_idempotency_key text,_correlation uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE v_org uuid:=public.current_org_id(); v_id uuid; v_audit uuid; v_event uuid;
BEGIN
  IF NOT public.has_permission('restaurant','menu','create') THEN RAISE EXCEPTION 'Missing permission: restaurant.menu.create'; END IF;
  IF nullif(btrim(coalesce(_name,'')),'') IS NULL THEN RAISE EXCEPTION 'Menu name is required'; END IF;
  IF _branch IS NULL OR NOT EXISTS(SELECT 1 FROM public.branches WHERE id=_branch AND organization_id=v_org) THEN RAISE EXCEPTION 'Select an authorized property'; END IF;
  IF NOT public.in_my_config_scope(v_org,_branch) THEN RAISE EXCEPTION 'The selected property is outside your configuration scope'; END IF;
  SELECT id INTO v_id FROM public.menus WHERE organization_id=v_org AND branch_id=_branch AND lower(name)=lower(btrim(_name)) LIMIT 1;
  IF v_id IS NULL THEN
    INSERT INTO public.menus(organization_id,branch_id,name,description,service_type,created_by)
    VALUES(v_org,_branch,btrim(_name),nullif(btrim(coalesce(_description,'')),''),coalesce(nullif(_service_type,''),'all-day'),auth.uid()) RETURNING id INTO v_id;
  END IF;
  v_event:=public.emit_domain_event(v_org,_branch,'restaurant.menu.saved','restaurant',v_id,jsonb_build_object('name',btrim(_name)),'menu-save:'||coalesce(nullif(_idempotency_key,''),v_id::text),NULL);
  v_audit:=public.log_audit_event('menu.saved','restaurant',v_id::text,NULL,jsonb_build_object('name',btrim(_name),'branch_id',_branch),NULL,'restaurant.menu.create',_branch,NULL,NULL,coalesce(_correlation,gen_random_uuid())::text,NULL,NULL);
  RETURN jsonb_build_object('ok',true,'menu_id',v_id,'workflow_event_id',v_event,'audit_event_id',v_audit,'menu',(SELECT to_jsonb(m) FROM public.menus m WHERE m.id=v_id));
END $$;
REVOKE ALL ON FUNCTION public.pos_save_menu(text,text,uuid,text,text,uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.pos_save_menu(text,text,uuid,text,text,uuid) TO authenticated;

CREATE OR REPLACE FUNCTION public.pos_import_menu_drafts(_menu uuid,_branch uuid,_file_name text,_file_type text,_checksum text,_rows jsonb,_idempotency_key text,_correlation uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE v_org uuid:=public.current_org_id(); v_batch uuid; v_row jsonb; v_category uuid; v_station uuid; v_item uuid;
  v_parsed int:=jsonb_array_length(coalesce(_rows,'[]'::jsonb)); v_valid int:=0; v_committed int:=0; v_duplicates int:=0; v_mapping int:=0; v_rejected int:=0; v_event uuid; v_audit uuid;
BEGIN
  IF NOT public.has_permission('restaurant','menu','create') THEN RAISE EXCEPTION 'Missing permission: restaurant.menu.create'; END IF;
  IF NOT EXISTS(SELECT 1 FROM public.menus WHERE id=_menu AND organization_id=v_org AND branch_id=_branch) THEN RAISE EXCEPTION 'Select a canonical menu in your authorized property'; END IF;
  IF NOT public.in_my_config_scope(v_org,_branch) THEN RAISE EXCEPTION 'The selected property is outside your configuration scope'; END IF;
  SELECT id INTO v_batch FROM public.menu_import_batches WHERE organization_id=v_org AND checksum=_checksum AND menu_id=_menu LIMIT 1;
  IF v_batch IS NOT NULL THEN
    RETURN jsonb_build_object('ok',true,'idempotent',true,'batch_id',v_batch,'parsed_rows',(SELECT parsed_rows FROM public.menu_import_batches WHERE id=v_batch),'committed_rows',(SELECT committed_rows FROM public.menu_import_batches WHERE id=v_batch));
  END IF;
  INSERT INTO public.menu_import_batches(organization_id,branch_id,menu_id,file_name,file_type,total_rows,parsed_rows,status,checksum,correlation_id,created_by)
  VALUES(v_org,_branch,_menu,_file_name,_file_type,v_parsed,v_parsed,'processing',_checksum,_correlation,auth.uid()) RETURNING id INTO v_batch;
  FOR v_row IN SELECT value FROM jsonb_array_elements(coalesce(_rows,'[]'::jsonb)) LOOP
    IF nullif(btrim(v_row->>'name'),'') IS NULL OR nullif(btrim(v_row->>'category'),'') IS NULL OR (v_row->>'base_price') IS NULL THEN v_rejected:=v_rejected+1; CONTINUE; END IF;
    v_valid:=v_valid+1;
    SELECT id,station_id INTO v_category,v_station FROM public.menu_categories WHERE organization_id=v_org AND menu_id=_menu AND lower(name)=lower(btrim(v_row->>'category')) LIMIT 1;
    IF v_category IS NULL THEN
      INSERT INTO public.menu_categories(organization_id,menu_id,name) VALUES(v_org,_menu,btrim(v_row->>'category')) RETURNING id,station_id INTO v_category,v_station;
    END IF;
    IF v_station IS NULL THEN v_mapping:=v_mapping+1; CONTINUE; END IF;
    SELECT id INTO v_item FROM public.menu_items WHERE organization_id=v_org AND branch_id=_branch AND category_id=v_category AND lower(name)=lower(btrim(v_row->>'name')) LIMIT 1;
    IF v_item IS NOT NULL THEN v_duplicates:=v_duplicates+1; CONTINUE; END IF;
    INSERT INTO public.menu_items(organization_id,branch_id,category_id,station_id,name,description,base_price,currency,availability,publish_status,import_batch_id,created_by,tax_rate,prep_minutes)
    VALUES(v_org,_branch,v_category,v_station,btrim(v_row->>'name'),nullif(v_row->>'description',''),(v_row->>'base_price')::numeric,coalesce(nullif(v_row->>'currency',''),'KES'),coalesce(nullif(v_row->>'availability',''),'available'),'draft',v_batch,auth.uid(),nullif(v_row->>'tax_rate','')::numeric,nullif(v_row->>'prep_minutes','')::integer)
    RETURNING id INTO v_item;
    v_committed:=v_committed+1;
  END LOOP;
  UPDATE public.menu_import_batches SET valid_rows=v_valid,imported_rows=v_committed,committed_rows=v_committed,rejected_rows=v_rejected,duplicate_rows=v_duplicates,mapping_rows=v_mapping,status=CASE WHEN v_committed=0 THEN 'failed' WHEN v_rejected+v_mapping>0 THEN 'partial' ELSE 'completed' END WHERE id=v_batch;
  v_event:=public.emit_domain_event(v_org,_branch,'restaurant.menu.imported','restaurant',v_batch,jsonb_build_object('menu_id',_menu,'parsed',v_parsed,'valid',v_valid,'committed',v_committed,'rejected',v_rejected,'duplicates',v_duplicates,'awaiting_mapping',v_mapping),'menu-import:'||coalesce(nullif(_idempotency_key,''),v_batch::text),NULL);
  v_audit:=public.log_audit_event('menu.import.completed','restaurant',v_batch::text,NULL,jsonb_build_object('file_name',_file_name,'checksum',_checksum,'menu_id',_menu,'parsed_rows',v_parsed,'valid_rows',v_valid,'committed_rows',v_committed,'rejected_rows',v_rejected,'duplicate_rows',v_duplicates,'mapping_rows',v_mapping),NULL,'restaurant.menu.create',_branch,NULL,NULL,coalesce(_correlation,gen_random_uuid())::text,NULL,NULL);
  RETURN jsonb_build_object('ok',v_committed>0,'partial',(v_rejected+v_mapping)>0,'batch_id',v_batch,'parsed_rows',v_parsed,'valid_rows',v_valid,'committed_rows',v_committed,'rejected_rows',v_rejected,'duplicate_rows',v_duplicates,'mapping_rows',v_mapping,'workflow_event_id',v_event,'audit_event_id',v_audit);
END $$;
REVOKE ALL ON FUNCTION public.pos_import_menu_drafts(uuid,uuid,text,text,text,jsonb,text,uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.pos_import_menu_drafts(uuid,uuid,text,text,text,jsonb,text,uuid) TO authenticated;

CREATE INDEX IF NOT EXISTS housekeeping_jobs_scope_idx ON public.housekeeping_jobs(organization_id,branch_id,department_id,station_id,assignee_id,status);
CREATE INDEX IF NOT EXISTS menu_import_batches_menu_idx ON public.menu_import_batches(organization_id,branch_id,menu_id,created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS menus_org_branch_name_unique ON public.menus(organization_id,branch_id,lower(name));