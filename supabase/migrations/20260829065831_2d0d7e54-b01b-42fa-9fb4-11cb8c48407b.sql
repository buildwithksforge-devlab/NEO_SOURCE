-- Canonical definition of an OPEN housekeeping cleaning task.
-- A superseded task is history, not work in progress: it must never be counted
-- as open by any invariant, report or repair routine.
CREATE OR REPLACE FUNCTION public.hk_job_is_open(_status text, _superseded_by uuid)
RETURNS boolean
LANGUAGE sql IMMUTABLE
SET search_path TO 'public'
AS $function$
  SELECT _superseded_by IS NULL
     AND coalesce(_status,'') NOT IN ('completed','cancelled','superseded');
$function$;

REVOKE ALL ON FUNCTION public.hk_job_is_open(text, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.hk_job_is_open(text, uuid) TO authenticated, service_role;

-- Room state: the room's current job is the newest genuinely open one.
CREATE OR REPLACE FUNCTION public.ops_room_state(_branch uuid DEFAULT NULL::uuid)
 RETURNS TABLE(room_id uuid, room_number text, room_type_id uuid, room_type_name text, organization_id uuid, property_id uuid, floor text, building text, inventory_status text, occupancy_status text, housekeeping_status text, housekeeping_state text, readiness_state text, room_condition text, inspection_status text, maintenance_status text, out_of_order_reason text, sellable boolean, sellable_now boolean, sellability_reason text, exclusion_reasons text[], current_reservation_id uuid, current_confirmation_number text, arrival_today boolean, departure_today boolean, current_job_id uuid, current_task_id uuid, current_job_status text, assignee_id uuid, assignee_name text, pending_inspection boolean, last_cleaned_at timestamp with time zone, last_inspected_at timestamp with time zone, last_status_change timestamp with time zone, data_version timestamp with time zone)
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $function$
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
    WHERE j.room_id IS NOT NULL AND public.hk_job_is_open(j.status, j.superseded_by)
    ORDER BY j.room_id, j.created_at DESC
  ),
  derived AS (
    SELECT b.*, s.id AS res_id, s.confirmation_number AS res_no,
      s.arrival_date, s.departure_date,
      job.id AS job_id, job.task_id, job.status AS job_status, job.assignee_id,
      coalesce(b.inspection_status,'not-required') AS insp,
      coalesce(b.maintenance_status,'operational') AS mt,
      coalesce(b.occupancy_status,'vacant') AS occ,
      coalesce(b.status,'active') AS inv,
      CASE
        WHEN b.hk = 'rework' OR coalesce(b.inspection_status,'not-required') = 'failed' THEN 'rework_required'
        WHEN b.hk = 'awaiting_inspection' OR (b.hk IN ('clean','inspected') AND coalesce(b.inspection_status,'not-required') = 'pending')
          THEN 'awaiting_inspection'
        WHEN b.hk = 'cleaning_in_progress' THEN 'cleaning_in_progress'
        WHEN b.hk = 'cleaning_queued' THEN 'cleaning_queued'
        WHEN b.hk = 'dirty' THEN 'dirty'
        WHEN b.hk IN ('clean','inspected') THEN 'ready'
        ELSE b.hk
      END AS hk_state,
      job.status IS NOT NULL AS has_open_job
    FROM base b
    LEFT JOIN stay s ON s.room_id = b.id
    LEFT JOIN job ON job.room_id = b.id
  )
  SELECT
    d.id, d.room_number, d.room_type_id, d.rt_name, d.organization_id, d.branch_id,
    d.floor, d.building,
    d.inv, d.occ, d.hk, d.hk_state,
    CASE WHEN d.hk_state='ready' AND d.mt='operational' AND d.occ='vacant' AND d.inv='active'
         THEN 'ready' ELSE 'not_ready' END,
    d.room_condition, d.insp, d.mt, d.out_of_order_reason,
    (d.inv='active' AND d.occ='vacant' AND d.mt='operational' AND d.hk_state='ready'),
    (d.inv='active' AND d.occ='vacant' AND d.mt='operational' AND d.hk_state='ready' AND d.res_id IS NULL),
    CASE
      WHEN d.inv <> 'active' THEN 'Room inventory is not active'
      WHEN d.mt = 'out-of-order' THEN coalesce('Out of order: '||d.out_of_order_reason,'Out of order')
      WHEN d.mt = 'out-of-service' THEN coalesce('Out of service: '||d.out_of_order_reason,'Out of service')
      WHEN d.mt = 'under-maintenance' THEN 'Maintenance block in place'
      WHEN d.occ = 'occupied' THEN 'Currently occupied'
      WHEN d.occ = 'house-use' THEN 'Reserved for house use'
      WHEN d.hk_state <> 'ready' THEN 'Housekeeping: '||replace(d.hk_state,'_',' ')
      WHEN d.res_id IS NOT NULL THEN 'Held by reservation '||coalesce(d.res_no,'')
      ELSE 'Sellable'
    END,
    (SELECT array_remove(ARRAY[
        CASE WHEN d.inv <> 'active' THEN 'inventory-inactive' END,
        CASE WHEN d.mt <> 'operational' THEN 'maintenance-'||d.mt END,
        CASE WHEN d.occ <> 'vacant' THEN 'occupancy-'||d.occ END,
        CASE WHEN d.hk_state <> 'ready' THEN 'housekeeping-'||d.hk_state END,
        CASE WHEN d.res_id IS NOT NULL THEN 'reservation-hold' END
      ], NULL)),
    d.res_id, d.res_no,
    (d.arrival_date = current_date), (d.departure_date = current_date),
    d.job_id, d.task_id, d.job_status, d.assignee_id, p.full_name,
    (d.insp = 'pending'),
    d.last_cleaned_at, d.last_inspected_at, d.updated_at, d.updated_at
  FROM derived d
  LEFT JOIN public.profiles p ON p.id = d.assignee_id
  ORDER BY d.room_number;
$function$;

-- Reconciliation: superseded tasks are history and can never make a room a duplicate.
CREATE OR REPLACE FUNCTION public.ops_room_state_reconciliation(_branch uuid DEFAULT NULL::uuid)
 RETURNS TABLE(room_id uuid, room_number text, issue text, detail text)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  WITH s AS (
    SELECT * FROM public.ops_room_state(_branch) WHERE organization_id = public.current_org_id()
  )
  SELECT s.room_id, s.room_number, 'cleaning-in-progress-without-task',
         'Room reports cleaning in progress but no open housekeeping task exists'
  FROM s WHERE s.housekeeping_state='cleaning_in_progress' AND s.current_job_id IS NULL
  UNION ALL
  SELECT s.room_id, s.room_number, 'awaiting-inspection-without-inspection',
         'Room awaits inspection but no cleaning job is awaiting inspection'
  FROM s WHERE s.housekeeping_state='awaiting_inspection'
    AND NOT EXISTS (SELECT 1 FROM public.housekeeping_jobs j
                    WHERE j.room_id=s.room_id AND j.status IN ('awaiting-inspection','rework')
                      AND j.superseded_by IS NULL)
  UNION ALL
  SELECT s.room_id, s.room_number, 'sellable-with-maintenance-block',
         'Room is marked sellable while a maintenance block is in place'
  FROM s WHERE s.sellable_now AND s.maintenance_status <> 'operational'
  UNION ALL
  SELECT s.room_id, s.room_number, 'duplicate-open-cleaning-task',
         'More than one open cleaning task exists for this room'
  FROM s WHERE (SELECT count(*) FROM public.housekeeping_jobs j
                WHERE j.room_id=s.room_id
                  AND public.hk_job_is_open(j.status, j.superseded_by)) > 1
  UNION ALL
  SELECT s.room_id, s.room_number, 'dirty-without-cleaning-task',
         'Room is dirty or in rework but no open cleaning task exists'
  FROM s WHERE s.housekeeping_state IN ('dirty','rework_required') AND s.current_job_id IS NULL
  UNION ALL
  SELECT s.room_id, s.room_number, 'orphan-inspection-flag',
         'Inspection state is set on a room that is not clean'
  FROM s WHERE s.inspection_status <> 'not-required'
    AND s.housekeeping_state IN ('dirty','cleaning_queued','cleaning_in_progress');
$function$;

-- Automatic room-condition repair uses the same open-task definition.
CREATE OR REPLACE FUNCTION public.hk_reconcile_room_conditions()
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE v_org uuid := public.current_org_id(); v_detected int := 0; v_case uuid; v_evidence jsonb := '[]'::jsonb; r record;
BEGIN
  IF v_org IS NULL THEN RAISE EXCEPTION 'Authenticated organization context required'; END IF;
  FOR r IN
    SELECT rm.id, rm.room_number, rm.branch_id, rm.housekeeping_status, rm.sellable
      FROM public.rooms rm
     WHERE rm.organization_id = v_org
       AND public.hk_canonical_condition(rm.housekeeping_status) = 'cleaning_in_progress'
       AND NOT EXISTS (SELECT 1 FROM public.housekeeping_jobs j
                        WHERE j.room_id = rm.id
                          AND public.hk_job_is_open(j.status, j.superseded_by))
  LOOP
    v_detected := v_detected + 1;
    v_evidence := v_evidence || jsonb_build_object('room_id',r.id,'room_number',r.room_number,'previous_condition',r.housekeeping_status,'restored_condition','dirty');
    UPDATE public.rooms SET housekeeping_status='dirty', sellable=false, updated_at=now() WHERE id=r.id;
    INSERT INTO public.audit_logs(organization_id,branch_id,user_name,action,module,record_id,previous_value,new_value,reason,permission_used)
    VALUES (v_org,r.branch_id,'System integrity repair','housekeeping.room.condition.repaired','housekeeping',r.id::text,
      jsonb_build_object('housekeeping_status',r.housekeeping_status),jsonb_build_object('housekeeping_status','dirty'),
      'Room was cleaning_in_progress with no active cleaning task; restored to the last proven condition.','housekeeping.tasks.manage');
  END LOOP;
  INSERT INTO public.integrity_repair_jobs(organization_id,check_key,idempotency_key,run_window,status,attempts,detected_count,repaired_count,remaining_count,evidence,started_at,finished_at)
  VALUES (v_org,'housekeeping_condition_without_task','hk-condition:'||to_char(now(),'YYYYMMDDHH24MI'),date_trunc('hour',now()),
          CASE WHEN v_detected=0 THEN 'clean' ELSE 'repaired' END,1,v_detected,v_detected,0,
          jsonb_build_object('rooms',v_evidence),now(),now())
  ON CONFLICT DO NOTHING RETURNING id INTO v_case;
  RETURN jsonb_build_object('ok',true,'detected',v_detected,'repaired',v_detected,'repair_case_id',v_case,'evidence',v_evidence);
END $$;

REVOKE EXECUTE ON FUNCTION public.hk_reconcile_room_conditions() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.hk_reconcile_room_conditions() TO authenticated;