CREATE OR REPLACE FUNCTION public.ops_room_state(_branch uuid DEFAULT NULL::uuid)
 RETURNS TABLE(room_id uuid, room_number text, room_type_id uuid, room_type_name text, organization_id uuid, property_id uuid, floor text, building text, inventory_status text, occupancy_status text, housekeeping_status text, housekeeping_state text, readiness_state text, room_condition text, inspection_status text, maintenance_status text, out_of_order_reason text, sellable boolean, sellable_now boolean, sellability_reason text, exclusion_reasons text[], current_reservation_id uuid, current_confirmation_number text, arrival_today boolean, departure_today boolean, current_job_id uuid, current_task_id uuid, current_job_status text, assignee_id uuid, assignee_name text, pending_inspection boolean, last_cleaned_at timestamp with time zone, last_inspected_at timestamp with time zone, last_status_change timestamp with time zone, data_version timestamp with time zone)
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $function$
  WITH base AS (
    SELECT r.*, public.hk_canonical_condition(r.housekeeping_status) AS hk, rt.name AS rt_name,
      (now() AT TIME ZONE coalesce(nullif(br.timezone,''),'UTC'))::date AS room_today
    FROM public.rooms r
    LEFT JOIN public.room_types rt ON rt.id = r.room_type_id
    LEFT JOIN public.branches br ON br.id=r.branch_id AND br.organization_id=r.organization_id
    WHERE r.organization_id=public.current_org_id() AND public.neo_branch_in_scope(r.branch_id)
      AND (_branch IS NULL OR r.branch_id = _branch)
  ),
  stay AS (
    SELECT DISTINCT ON (res.organization_id,res.room_id)
      res.organization_id, res.room_id, res.id, res.confirmation_number, res.arrival_date, res.departure_date, res.status
    FROM public.reservations res JOIN base b ON b.id=res.room_id AND b.organization_id=res.organization_id AND b.branch_id IS NOT DISTINCT FROM res.branch_id
    WHERE res.room_id IS NOT NULL
      AND (
        res.status IN ('checked-in','in-house','checked_in','in_house') OR
        (res.status IN ('confirmed','on-hold','guaranteed') AND res.arrival_date<=b.room_today AND res.departure_date>=b.room_today)
      )
    ORDER BY res.organization_id,res.room_id,
      CASE WHEN res.status IN ('checked-in','in-house','checked_in','in_house') THEN 0 ELSE 1 END,
      res.arrival_date,res.id
  ),
  job AS (
    SELECT DISTINCT ON (j.organization_id,j.room_id)
      j.organization_id,j.room_id, j.id, j.task_id, j.status, j.assignee_id
    FROM public.housekeeping_jobs j JOIN base b ON b.id=j.room_id AND b.organization_id=j.organization_id AND b.branch_id IS NOT DISTINCT FROM j.branch_id
    WHERE j.room_id IS NOT NULL AND public.hk_job_is_open(j.status, j.superseded_by)
    ORDER BY j.organization_id,j.room_id, j.created_at DESC,j.id DESC
  ),
  derived AS (
    SELECT b.*, s.id AS res_id, s.confirmation_number AS res_no,
      s.arrival_date, s.departure_date,
      job.id AS job_id, job.task_id, job.status AS job_status, job.assignee_id,
      coalesce(b.inspection_status,'not-required') AS insp,
      coalesce(b.maintenance_status,'operational') AS mt,
      CASE WHEN s.status IN ('checked-in','in-house','checked_in','in_house') THEN 'occupied' ELSE coalesce(b.occupancy_status,'vacant') END AS occ,
      coalesce(b.status,'active') AS inv,
      CASE
        WHEN job.status='rework' THEN 'rework_required'
        WHEN job.status='awaiting-inspection' THEN 'awaiting_inspection'
        WHEN job.id IS NOT NULL THEN
          CASE WHEN job.status IN ('in-progress','in_progress','cleaning') THEN 'cleaning_in_progress' ELSE 'cleaning_queued' END
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
    LEFT JOIN stay s ON s.room_id = b.id AND s.organization_id=b.organization_id
    LEFT JOIN job ON job.room_id = b.id AND job.organization_id=b.organization_id
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
    (d.arrival_date = d.room_today), (d.departure_date = d.room_today),
    d.job_id, d.task_id, d.job_status, d.assignee_id, p.full_name,
    (d.insp = 'pending'),
    d.last_cleaned_at, d.last_inspected_at, d.updated_at, d.updated_at
  FROM derived d
  LEFT JOIN public.profiles p ON p.id = d.assignee_id
  ORDER BY d.room_number;
$function$
