-- 1. Remove the ambiguous single-argument document-number overload.
DROP FUNCTION IF EXISTS public.next_document_number(text);

-- 2. One authoritative, RLS-protected room operational state service.
CREATE OR REPLACE FUNCTION public.ops_room_state(_branch uuid DEFAULT NULL)
RETURNS TABLE (
  room_id uuid,
  room_number text,
  room_type_id uuid,
  room_type_name text,
  organization_id uuid,
  property_id uuid,
  floor text,
  building text,
  inventory_status text,
  occupancy_status text,
  housekeeping_status text,
  room_condition text,
  inspection_status text,
  maintenance_status text,
  out_of_order_reason text,
  sellable boolean,
  sellability_reason text,
  current_reservation_id uuid,
  current_confirmation_number text,
  arrival_today boolean,
  departure_today boolean,
  current_job_id uuid,
  current_task_id uuid,
  current_job_status text,
  assignee_id uuid,
  assignee_name text,
  last_cleaned_at timestamptz,
  last_inspected_at timestamptz,
  last_status_change timestamptz,
  data_version timestamptz
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path TO 'public'
AS $$
  WITH base AS (
    SELECT r.*, rt.name AS rt_name
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
    coalesce(b.housekeeping_status,'dirty'),
    b.room_condition,
    coalesce(b.inspection_status,'not-required'),
    coalesce(b.maintenance_status,'operational'),
    b.out_of_order_reason,
    (
      coalesce(b.status,'active') = 'active'
      AND coalesce(b.occupancy_status,'vacant') = 'vacant'
      AND coalesce(b.housekeeping_status,'dirty') IN ('clean','inspected')
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
      WHEN coalesce(b.housekeeping_status,'dirty') NOT IN ('clean','inspected') THEN 'Housekeeping: '||replace(coalesce(b.housekeeping_status,'dirty'),'-',' ')
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
$$;

REVOKE ALL ON FUNCTION public.ops_room_state(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.ops_room_state(uuid) TO authenticated;