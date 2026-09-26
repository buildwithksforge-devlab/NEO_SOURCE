-- 1. Canonical housekeeping condition vocabulary ---------------------------
CREATE OR REPLACE FUNCTION public.hk_canonical_condition(_value text)
RETURNS text LANGUAGE sql IMMUTABLE SET search_path TO 'public' AS $$
  SELECT CASE lower(btrim(replace(replace(coalesce(_value,'dirty'),'_','-'),' ','-')))
    WHEN 'cleaning' THEN 'cleaning_in_progress'
    WHEN 'in-progress' THEN 'cleaning_in_progress'
    WHEN 'cleaning-in-progress' THEN 'cleaning_in_progress'
    WHEN 'being-cleaned' THEN 'cleaning_in_progress'
    WHEN 'vacant-dirty' THEN 'dirty'
    WHEN 'soiled' THEN 'dirty'
    WHEN 'cleaned' THEN 'clean'
    WHEN 'vacant-clean' THEN 'clean'
    WHEN 'inspected' THEN 'inspected'
    WHEN 'rework' THEN 'rework'
    WHEN 'failed' THEN 'rework'
    WHEN 'out-of-service' THEN 'out_of_service'
    WHEN 'clean' THEN 'clean'
    WHEN 'dirty' THEN 'dirty'
    ELSE lower(btrim(replace(replace(coalesce(_value,'dirty'),'-','_'),' ','_')))
  END;
$$;

CREATE OR REPLACE FUNCTION public.rooms_canonical_condition()
RETURNS trigger LANGUAGE plpgsql SET search_path TO 'public' AS $$
BEGIN
  NEW.housekeeping_status := public.hk_canonical_condition(NEW.housekeeping_status);
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS rooms_canonical_condition_t ON public.rooms;
CREATE TRIGGER rooms_canonical_condition_t BEFORE INSERT OR UPDATE ON public.rooms
FOR EACH ROW EXECUTE FUNCTION public.rooms_canonical_condition();

UPDATE public.rooms
SET housekeeping_status = public.hk_canonical_condition(housekeeping_status)
WHERE housekeeping_status IS DISTINCT FROM public.hk_canonical_condition(housekeeping_status);

-- 2. Read model returns canonical values -----------------------------------
CREATE OR REPLACE FUNCTION public.ops_room_state(_branch uuid DEFAULT NULL::uuid)
 RETURNS TABLE(room_id uuid, room_number text, room_type_id uuid, room_type_name text, organization_id uuid, property_id uuid, floor text, building text, inventory_status text, occupancy_status text, housekeeping_status text, room_condition text, inspection_status text, maintenance_status text, out_of_order_reason text, sellable boolean, sellability_reason text, current_reservation_id uuid, current_confirmation_number text, arrival_today boolean, departure_today boolean, current_job_id uuid, current_task_id uuid, current_job_status text, assignee_id uuid, assignee_name text, last_cleaned_at timestamp with time zone, last_inspected_at timestamp with time zone, last_status_change timestamp with time zone, data_version timestamp with time zone)
 LANGUAGE sql STABLE SET search_path TO 'public' AS $function$
  WITH base AS (
    SELECT r.*, public.hk_canonical_condition(r.housekeeping_status) AS hk, rt.name AS rt_name
    FROM public.rooms r
    LEFT JOIN public.room_types rt ON rt.id = r.room_type_id
    WHERE (_branch IS NULL OR r.branch_id = _branch)
  ),
  stay AS (
    SELECT DISTINCT ON (res.room_id)
      res.room_id, res.id, res.confirmation_number, res.arrival_date, res.departure_date, res.status
    FROM public.reservations res
    WHERE res.room_id IS NOT NULL
      AND res.status IN ('confirmed','checked-in','in-house','on-hold','guaranteed')
      AND res.departure_date >= current_date
    ORDER BY res.room_id, res.arrival_date
  ),
  job AS (
    SELECT DISTINCT ON (j.room_id)
      j.room_id, j.id, j.task_id, j.status, j.assignee_id
    FROM public.housekeeping_jobs j
    WHERE j.room_id IS NOT NULL AND j.status NOT IN ('completed','cancelled')
    ORDER BY j.room_id, j.created_at DESC
  )
  SELECT
    b.id, b.room_number, b.room_type_id, b.rt_name, b.organization_id, b.branch_id,
    b.floor, b.building,
    coalesce(b.status,'active'),
    coalesce(b.occupancy_status,'vacant'),
    b.hk,
    b.room_condition,
    coalesce(b.inspection_status,'not-required'),
    coalesce(b.maintenance_status,'operational'),
    b.out_of_order_reason,
    (
      coalesce(b.status,'active') = 'active'
      AND coalesce(b.occupancy_status,'vacant') = 'vacant'
      AND b.hk IN ('clean','inspected')
      AND coalesce(b.inspection_status,'not-required') IN ('not-required','passed')
      AND coalesce(b.maintenance_status,'operational') = 'operational'
    ),
    CASE
      WHEN coalesce(b.status,'active') <> 'active' THEN 'Room inventory is not active'
      WHEN coalesce(b.maintenance_status,'operational') = 'out-of-order' THEN coalesce('Out of order: '||b.out_of_order_reason,'Out of order')
      WHEN coalesce(b.maintenance_status,'operational') = 'out-of-service' THEN coalesce('Out of service: '||b.out_of_order_reason,'Out of service')
      WHEN coalesce(b.maintenance_status,'operational') = 'under-maintenance' THEN 'Maintenance block in place'
      WHEN coalesce(b.occupancy_status,'vacant') = 'occupied' THEN 'Currently occupied'
      WHEN coalesce(b.occupancy_status,'vacant') = 'house-use' THEN 'Reserved for house use'
      WHEN b.hk NOT IN ('clean','inspected') THEN 'Housekeeping: '||replace(b.hk,'_',' ')
      WHEN coalesce(b.inspection_status,'not-required') NOT IN ('not-required','passed') THEN 'Inspection '||coalesce(b.inspection_status,'pending')
      WHEN s.id IS NOT NULL THEN 'Held by reservation '||coalesce(s.confirmation_number,'')
      ELSE 'Sellable'
    END,
    s.id, s.confirmation_number,
    (s.arrival_date = current_date),
    (s.departure_date = current_date),
    job.id, job.task_id, job.status, job.assignee_id, p.full_name,
    b.last_cleaned_at, b.last_inspected_at, b.updated_at, b.updated_at
  FROM base b
  LEFT JOIN stay s ON s.room_id = b.id
  LEFT JOIN job ON job.room_id = b.id
  LEFT JOIN public.profiles p ON p.id = job.assignee_id
  ORDER BY b.room_number;
$function$;

-- 3. Typed, unambiguous document numbering inside cleaning-task creation ----
CREATE OR REPLACE FUNCTION public.hk_start_job(_job uuid, _correlation uuid DEFAULT NULL::uuid)
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
  UPDATE public.rooms SET housekeeping_status='cleaning_in_progress',inspection_status='pending',sellable=false,updated_at=now() WHERE id=v_job.room_id;
  v_event:=public.emit_domain_event(v_org,v_job.branch_id,'housekeeping.task.started','housekeeping',_job,jsonb_build_object('room_id',v_job.room_id),'hk-started:'||_job::text,NULL);
  v_audit:=public.log_audit_event('housekeeping.task.started','housekeeping',_job::text,jsonb_build_object('status',v_job.status),jsonb_build_object('status','in-progress'),NULL,'housekeeping.tasks.start',v_job.branch_id,v_job.department_id,v_job.station_id,coalesce(_correlation,gen_random_uuid())::text,NULL,NULL);
  RETURN jsonb_build_object('ok',true,'idempotent',false,'job_id',_job,'workflow_event_id',v_event,'audit_event_id',v_audit);
END $$;