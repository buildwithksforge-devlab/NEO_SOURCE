CREATE OR REPLACE FUNCTION public.neo_kitchen_assert_ticket_scope(_ticket uuid)
 RETURNS void
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE _t record;
BEGIN
  SELECT * INTO _t FROM public.station_tickets WHERE id = _ticket;
  IF _t.id IS NULL THEN RAISE EXCEPTION 'Ticket not found'; END IF;
  -- Acting reach must match seeing reach: visible_station_ids already encodes
  -- property boundary, explicit station assignment, departmental oversight and
  -- the configured kitchen.all_stations.view capability.
  IF public.in_my_scope(_t.organization_id, _t.branch_id, _t.department_id,
                        _t.station_id, _t.assigned_chef_id, _t.created_by) THEN
    RETURN;
  END IF;
  IF _t.organization_id = public.current_org_id()
     AND _t.station_id IS NOT NULL
     AND _t.station_id = ANY (public.neo_kitchen_visible_station_ids()) THEN
    RETURN;
  END IF;
  RAISE EXCEPTION 'Ticket % belongs to a station outside your assigned stations', _t.ticket_number
    USING ERRCODE = '42501';
END;
$function$;