-- NEØ operational candidate: CORE WAVE 1 ONLY.
-- Project must match zlrrmrcqlerafptkgucl.supabase.co.
-- Run 00_READ_ONLY_PREFLIGHT.sql and save its output before this file.
-- This transaction contains no historical room/accounting corrections and no role grants.
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='60s';
DO $neo_preflight$
BEGIN
  IF to_regclass('public.rooms') IS NULL OR to_regclass('public.delivery_orders') IS NULL THEN
    RAISE EXCEPTION 'Required operational tables are missing';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger t JOIN pg_proc p ON p.oid=t.tgfoid JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE t.tgrelid='public.rooms'::regclass AND NOT t.tgisinternal
      AND t.tgenabled IN ('O','A') AND n.nspname='public' AND p.proname='rooms_derive_state'
  ) THEN RAISE EXCEPTION 'An enabled rooms_derive_state trigger is required'; END IF;
  IF (SELECT md5(replace(prosrc,E'\r\n',E'\n')) FROM pg_proc WHERE oid='public.rooms_derive_state()'::regprocedure)
     <> ALL (ARRAY['c776aac33760edc450ce8f717ea3d272','1d8cf89d05805c1b084292441d74eee6','b42d37b196439cb1c4d53a34da0810ee']) THEN
    RAISE EXCEPTION 'The room-state trigger differs from the three reviewed source versions; review preflight output first';
  END IF;
  IF to_regprocedure('public.neo_delivery_staff_place_order(uuid,text,text,jsonb,text,uuid,jsonb,text,text)') IS NULL
    OR to_regprocedure('public.neo_assert_capability(text,text,text)') IS NULL
    OR to_regprocedure('public.neo_branch_in_scope(uuid)') IS NULL THEN
    RAISE EXCEPTION 'Reviewed delivery validation/scope prerequisites are missing';
  END IF;
END
$neo_preflight$;

-- SOURCE MIGRATION: 20261106090000_housekeeping_preserve_occupancy.sql
-- Wave 1 repair derived from local source 9d18edc. No historical rows are changed.
-- Compare the deployment and reproduce in isolated UAT before applying.

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


-- SOURCE MIGRATION: 20261106090100_grn_retry_confirm_posting.sql
-- Wave 1 repair derived from local source 9d18edc. No historical rows are changed.
-- Compare the deployment and reproduce in isolated UAT before applying.

DO $neo_guard$
BEGIN
  IF replace((SELECT prosrc FROM pg_proc WHERE oid = 'public.neo_grn_retry_accrual(uuid)'::regprocedure), E'\r\n', E'\n')
     IS DISTINCT FROM replace($neo_expected$
DECLARE v_org uuid := public.current_org_id(); r public.goods_receipts; v_res jsonb;
BEGIN
  IF v_org IS NULL THEN RAISE EXCEPTION 'No organisation context'; END IF;
  SELECT * INTO r FROM public.goods_receipts WHERE id = _receipt AND organization_id = v_org;
  IF r.id IS NULL THEN RAISE EXCEPTION 'Receipt not found'; END IF;
  IF NOT public.neo_branch_in_scope(r.branch_id) THEN
    RAISE EXCEPTION 'This delivery belongs to another property' USING ERRCODE='42501';
  END IF;
  IF NOT (public.has_permission('finance','journals.post')
          OR public.has_permission('finance','post')
          OR public.has_permission('procurement','grn.post')
          OR public.is_org_admin()) THEN
    RAISE EXCEPTION 'Not permitted to post this delivery to finance' USING ERRCODE='42501';
  END IF;
  IF r.accrual_journal_id IS NOT NULL THEN
    RETURN jsonb_build_object('ok', true, 'already_posted', true, 'journal_id', r.accrual_journal_id);
  END IF;

  v_res := public.neo_grn_post_accrual(_receipt);
  RETURN COALESCE(v_res, '{}'::jsonb) || jsonb_build_object('ok', true, 'retried', true);
END $neo_expected$, E'\r\n', E'\n') THEN
    RAISE EXCEPTION 'Function differs from reviewed local source; inspect deployment before applying this repair';
  END IF;
END
$neo_guard$;
CREATE OR REPLACE FUNCTION public.neo_grn_retry_accrual(_receipt uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE v_org uuid := public.current_org_id(); r public.goods_receipts; v_res jsonb;
BEGIN
  IF v_org IS NULL THEN RAISE EXCEPTION 'No organisation context'; END IF;
  SELECT * INTO r FROM public.goods_receipts WHERE id = _receipt AND organization_id = v_org;
  IF r.id IS NULL THEN RAISE EXCEPTION 'Receipt not found'; END IF;
  IF NOT public.neo_branch_in_scope(r.branch_id) THEN
    RAISE EXCEPTION 'This delivery belongs to another property' USING ERRCODE='42501';
  END IF;
  IF NOT (public.has_permission('finance','journals.post')
          OR public.has_permission('finance','post')
          OR public.has_permission('procurement','grn.post')
          OR public.is_org_admin()) THEN
    RAISE EXCEPTION 'Not permitted to post this delivery to finance' USING ERRCODE='42501';
  END IF;
  IF r.accrual_journal_id IS NOT NULL THEN
    RETURN jsonb_build_object('ok', true, 'already_posted', true, 'journal_id', r.accrual_journal_id);
  END IF;

  v_res := public.neo_grn_post_accrual(_receipt);
  IF v_res IS NULL OR v_res->>'ok' IS DISTINCT FROM 'true' THEN
    RAISE EXCEPTION 'Delivery accrual was not posted: %',
      coalesce(v_res->>'message', v_res->>'error', 'No successful posting result was returned');
  END IF;
  IF nullif(v_res->>'journal_id', '') IS NULL
     AND coalesce(v_res->>'skipped', '') <> 'zero_value' THEN
    RAISE EXCEPTION 'Delivery accrual was not posted: no journal reference was returned';
  END IF;
  RETURN COALESCE(v_res, '{}'::jsonb) || jsonb_build_object('ok', true, 'retried', true);
END $function$;


-- SOURCE MIGRATION: 20261106090200_delivery_intake_retry_identity.sql
-- Wave 1 delivery intake: retries share one committed business identity.
-- Existing intake validation, pricing, routing and PIN issuance stay in their owning RPC.

ALTER TABLE public.delivery_orders
  ADD COLUMN IF NOT EXISTS intake_idempotency_key text,
  ADD COLUMN IF NOT EXISTS intake_request_hash text;
CREATE UNIQUE INDEX IF NOT EXISTS delivery_orders_intake_identity_idx
  ON public.delivery_orders(organization_id, branch_id, intake_idempotency_key)
  WHERE intake_idempotency_key IS NOT NULL;

CREATE OR REPLACE FUNCTION public.neo_delivery_staff_place_order_once(
  _idempotency_key text,
  _branch uuid,
  _contact_name text,
  _contact_phone text,
  _items jsonb,
  _fulfilment text DEFAULT 'delivery',
  _zone uuid DEFAULT NULL,
  _address jsonb DEFAULT '{}'::jsonb,
  _payment_method text DEFAULT 'cash',
  _notes text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  v_org uuid := public.current_org_id();
  v_key text := nullif(btrim(_idempotency_key), '');
  v_hash text;
  v_existing public.delivery_orders;
  v_result jsonb;
  v_id uuid;
BEGIN
  PERFORM public.neo_assert_capability('delivery','orders','create-assisted');
  IF v_org IS NULL OR NOT EXISTS (
    SELECT 1 FROM public.branches WHERE id = _branch AND organization_id = v_org
  ) THEN
    RAISE EXCEPTION 'Property not found in this workspace';
  END IF;
  IF NOT public.neo_branch_in_scope(_branch) THEN
    RAISE EXCEPTION 'Property is outside your access scope' USING ERRCODE='42501';
  END IF;
  IF v_key IS NULL OR length(v_key) > 200 THEN
    RAISE EXCEPTION 'A delivery intake identity of 1 to 200 characters is required';
  END IF;
  v_hash := md5(jsonb_build_object(
    'name', _contact_name, 'phone', _contact_phone, 'items', _items,
    'fulfilment', _fulfilment, 'zone', _zone, 'address', _address,
    'payment_method', _payment_method, 'notes', _notes
  )::text);
  PERFORM pg_advisory_xact_lock(hashtextextended(v_org::text || ':' || _branch::text || ':' || v_key, 0));
  SELECT * INTO v_existing FROM public.delivery_orders
    WHERE organization_id = v_org AND branch_id = _branch AND intake_idempotency_key = v_key;
  IF v_existing.id IS NOT NULL THEN
    IF v_existing.intake_request_hash IS DISTINCT FROM v_hash THEN
      RAISE EXCEPTION 'This intake identity already belongs to a different order. Open the saved order before starting another.';
    END IF;
    RETURN jsonb_build_object(
      'delivery_order_id',v_existing.id, 'pos_order_id',v_existing.pos_order_id,
      'order_number',v_existing.order_number, 'customer_id',v_existing.customer_id,
      'pin_issued',true, 'delivery_fee',v_existing.delivery_fee,
      'grand_total',v_existing.grand_total, 'eta_minutes',v_existing.estimated_prep_minutes,
      'order_status',v_existing.order_status, 'idempotent',true
    );
  END IF;
  v_result := public.neo_delivery_staff_place_order(
    _branch,_contact_name,_contact_phone,_items,_fulfilment,_zone,_address,_payment_method,_notes
  );
  IF v_result IS NULL OR v_result->>'ok' = 'false'
     OR nullif(v_result->>'delivery_order_id','') IS NULL THEN
    RAISE EXCEPTION 'The delivery intake was not saved';
  END IF;
  v_id := (v_result->>'delivery_order_id')::uuid;
  UPDATE public.delivery_orders
    SET intake_idempotency_key=v_key, intake_request_hash=v_hash
    WHERE id=v_id AND organization_id=v_org AND branch_id=_branch;
  IF NOT FOUND THEN RAISE EXCEPTION 'The delivery intake has no matching saved order'; END IF;
  RETURN v_result || jsonb_build_object('idempotent',false);
END
$function$;
REVOKE ALL ON FUNCTION public.neo_delivery_staff_place_order_once(text,uuid,text,text,jsonb,text,uuid,jsonb,text,text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.neo_delivery_staff_place_order_once(text,uuid,text,text,jsonb,text,uuid,jsonb,text,text) TO authenticated;

COMMIT;
