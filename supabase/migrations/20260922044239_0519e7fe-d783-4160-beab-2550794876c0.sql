CREATE OR REPLACE FUNCTION public.neo_stay_board(_branch uuid)
RETURNS TABLE(
  id uuid,
  confirmation_number text,
  status text,
  arrival_date date,
  departure_date date,
  guest_name text,
  room_number text,
  room_type text
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT r.id,
         r.confirmation_number,
         r.status::text,
         r.arrival_date,
         r.departure_date,
         c.full_name,
         rm.room_number,
         rt.name
  FROM public.reservations r
  LEFT JOIN public.customers c ON c.id = r.customer_id
  LEFT JOIN public.rooms rm ON rm.id = r.room_id
  LEFT JOIN public.room_types rt ON rt.id = r.room_type_id
  WHERE r.organization_id = current_org_id()
    AND r.branch_id = _branch
    AND _branch = ANY (current_branch_ids())
    AND r.status::text IN ('tentative','pending-deposit','waitlisted','enquiry','confirmed','guaranteed','checked-in')
    AND (
      has_permission('front-office','view')
      OR has_permission('pms','view')
      OR has_permission('housekeeping','view')
      OR has_permission('restaurant','view')
    )
  ORDER BY r.arrival_date;
$$;

REVOKE ALL ON FUNCTION public.neo_stay_board(uuid) FROM public;
GRANT EXECUTE ON FUNCTION public.neo_stay_board(uuid) TO authenticated;