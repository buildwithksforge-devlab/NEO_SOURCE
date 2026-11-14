BEGIN;
DO $guard$ DECLARE mismatch boolean; BEGIN WITH expected(signature,hash) AS(VALUES ('public.hk_complete_job(uuid,text,uuid)','a7622f3bfa707afa366d0f6b0b9397fd'),('public.hk_recalculate_room(uuid)','b1f8c190fd5857e64be6f30ca54cc356'),('public.hk_record_inspection(uuid,text,text,jsonb,text,uuid)','831b71f2d6c8d743605c90a85159e5fa'),('public.hk_start_job(uuid,uuid)','cdab633eba4fc23400959f9c6d528f9b')) SELECT bool_or(md5(pg_get_functiondef(to_regprocedure(signature))) IS DISTINCT FROM hash) INTO mismatch FROM expected; IF mismatch THEN RAISE EXCEPTION 'Housekeeping definitions changed or repair exists; use postcheck before reinstalling'; END IF; END $guard$;
CREATE OR REPLACE FUNCTION public.hk_start_job(_job uuid, _correlation uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE v_org uuid:=public.current_org_id(); v_job public.housekeeping_jobs; v_audit uuid; v_event uuid; v_attempt text;
BEGIN
  SELECT * INTO v_job FROM public.housekeeping_jobs WHERE id=_job AND organization_id=v_org FOR UPDATE;
  IF v_job.id IS NULL THEN RAISE EXCEPTION 'Unknown housekeeping task'; END IF;
  IF auth.uid() IS NULL OR public.current_access_scope() IS NULL OR public.current_access_scope()='technical' OR NOT coalesce(public.in_my_scope(v_job.organization_id,v_job.branch_id,v_job.department_id,v_job.station_id,v_job.assignee_id,v_job.created_by),false) THEN RAISE EXCEPTION 'This task is outside your authorized scope' USING ERRCODE='42501'; END IF;
  IF NOT (v_job.assignee_id=auth.uid() OR public.has_permission('housekeeping','tasks','assign')) THEN RAISE EXCEPTION 'This task is not assigned to you'; END IF;
  IF v_job.status='in-progress' THEN RETURN jsonb_build_object('ok',true,'idempotent',true,'job_id',_job,
    'workflow_event_id',(SELECT id FROM public.domain_events WHERE organization_id=v_org AND source_record_id=_job AND event_type='housekeeping.task.started' ORDER BY created_at DESC LIMIT 1),
    'audit_event_id',(SELECT id FROM public.audit_logs WHERE organization_id=v_org AND record_id=_job::text ORDER BY created_at DESC LIMIT 1)); END IF;
  IF v_job.status NOT IN ('pending','assigned','rework') THEN RAISE EXCEPTION 'Task cannot be started from status %',v_job.status; END IF;
  v_attempt := coalesce(v_job.rework_count,0)::text;
  UPDATE public.housekeeping_jobs SET status='in-progress',started_at=coalesce(started_at,now()),assignee_id=coalesce(assignee_id,auth.uid()),updated_at=now() WHERE id=_job;
  UPDATE public.tasks SET status='in-progress',assignee_id=coalesce(assignee_id,auth.uid()),updated_at=now() WHERE id=v_job.task_id;
  UPDATE public.rooms SET housekeeping_status='in-progress',inspection_status='not-required',sellable=false,updated_at=now() WHERE id=v_job.room_id;
  v_event:=public.emit_domain_event(v_org,v_job.branch_id,'housekeeping.task.started','housekeeping',_job,jsonb_build_object('room_id',v_job.room_id,'attempt',v_attempt),'hk-started:'||_job::text||':'||v_attempt,NULL);
  v_audit:=public.log_audit_event('housekeeping.task.started','housekeeping',_job::text,jsonb_build_object('status',v_job.status),jsonb_build_object('status','in-progress'),NULL,'housekeeping.tasks.start',v_job.branch_id,v_job.department_id,v_job.station_id,coalesce(_correlation,gen_random_uuid())::text,NULL,NULL);
  RETURN jsonb_build_object('ok',true,'idempotent',false,'job_id',_job,'workflow_event_id',v_event,'audit_event_id',v_audit);
END $function$
;

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
  IF auth.uid() IS NULL OR public.current_access_scope() IS NULL OR public.current_access_scope()='technical' OR NOT coalesce(public.in_my_scope(v_job.organization_id,v_job.branch_id,v_job.department_id,v_job.station_id,v_job.assignee_id,v_job.created_by),false) THEN RAISE EXCEPTION 'This task is outside your authorized scope' USING ERRCODE='42501'; END IF;
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
$function$
;

CREATE OR REPLACE FUNCTION public.hk_record_inspection(_job uuid, _result text, _notes text DEFAULT NULL::text, _defects jsonb DEFAULT '[]'::jsonb, _inspection_type text DEFAULT 'standard'::text, _correlation uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE v_org uuid:=public.current_org_id(); v_job public.housekeeping_jobs; v_insp uuid; v_notification uuid; v_event uuid; v_audit uuid; v_sellable boolean;
BEGIN
  IF NOT public.has_permission('housekeeping','inspections','approve') THEN RAISE EXCEPTION 'Missing permission: housekeeping.inspections.approve'; END IF;
  IF _result NOT IN ('passed','passed-with-notes','failed','reinspection-required') THEN RAISE EXCEPTION 'Invalid inspection result'; END IF;
  SELECT * INTO v_job FROM public.housekeeping_jobs WHERE id=_job AND organization_id=v_org FOR UPDATE;
  IF v_job.id IS NULL THEN RAISE EXCEPTION 'Unknown housekeeping task'; END IF;
  IF auth.uid() IS NULL OR public.current_access_scope() IS NULL OR public.current_access_scope()='technical' OR NOT coalesce(public.in_my_scope(v_job.organization_id,v_job.branch_id,v_job.department_id,v_job.station_id,v_job.assignee_id,v_job.created_by),false) THEN RAISE EXCEPTION 'This task is outside your authorized scope' USING ERRCODE='42501'; END IF;
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
END $function$
;

CREATE OR REPLACE FUNCTION public.hk_recalculate_room(_room uuid)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE v_room public.rooms; v_sellable boolean;
BEGIN
  SELECT * INTO v_room FROM public.rooms WHERE id=_room AND organization_id=public.current_org_id() FOR UPDATE;
  IF v_room.id IS NULL THEN RAISE EXCEPTION 'Unknown room'; END IF;
  IF auth.uid() IS NULL OR public.current_access_scope() IS NULL OR public.current_access_scope()='technical' OR NOT coalesce(public.neo_branch_in_scope(v_room.branch_id),false) THEN RAISE EXCEPTION 'This room is outside your authorized property' USING ERRCODE='42501'; END IF;
  -- Re-running the derivation trigger keeps one single definition of truth.
  UPDATE public.rooms SET updated_at=now() WHERE id=_room;
  SELECT sellable INTO v_sellable FROM public.rooms WHERE id=_room;
  RETURN v_sellable;
END $function$
;

REVOKE ALL ON FUNCTION public.hk_complete_job(uuid,text,uuid) FROM PUBLIC,anon; GRANT EXECUTE ON FUNCTION public.hk_complete_job(uuid,text,uuid) TO authenticated;
REVOKE ALL ON FUNCTION public.hk_recalculate_room(uuid) FROM PUBLIC,anon; GRANT EXECUTE ON FUNCTION public.hk_recalculate_room(uuid) TO authenticated;
REVOKE ALL ON FUNCTION public.hk_record_inspection(uuid,text,text,jsonb,text,uuid) FROM PUBLIC,anon; GRANT EXECUTE ON FUNCTION public.hk_record_inspection(uuid,text,text,jsonb,text,uuid) TO authenticated;
REVOKE ALL ON FUNCTION public.hk_start_job(uuid,uuid) FROM PUBLIC,anon; GRANT EXECUTE ON FUNCTION public.hk_start_job(uuid,uuid) TO authenticated;
NOTIFY pgrst,'reload schema';
WITH expected(signature,hash) AS(VALUES ('public.hk_complete_job(uuid,text,uuid)','1e63ef1796d73c7e14f8467569941f67'),('public.hk_recalculate_room(uuid)','0d91349fa63e6335f91aa0fdae0494ed'),('public.hk_record_inspection(uuid,text,text,jsonb,text,uuid)','bd18c23a3806c68dcde56a3305fffb43'),('public.hk_start_job(uuid,uuid)','baa7ccf10ca3837df6777c0445ae6e90')),checked AS(SELECT signature,coalesce(md5(pg_get_functiondef(to_regprocedure(signature)))=hash,false) matches FROM expected) SELECT jsonb_build_object('diagnostic_version','housekeeping-scoped-handoff-v1','definitions_match',(SELECT bool_and(matches) FROM checked),'definition_checks',(SELECT jsonb_agg(to_jsonb(checked)) FROM checked),'scope','Adds staff task/property boundaries to four existing housekeeping commands. No task started/completed, inspection approved or room status changed by installation.') result;
COMMIT;
