-- NEO P1.3 - PRODUCTION TICKET AUTHORITY
-- LOCAL DRAFT - DO NOT DEPLOY
-- Separate station visibility from ticket transition permissions.
-- Production capability names must be checked against live role catalogue.
CREATE OR REPLACE FUNCTION public.neo_kitchen_assert_station_authority(_ticket uuid)
RETURNS void
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE _t record;
BEGIN
  SELECT * INTO _t FROM public.station_tickets WHERE id = _ticket;
  IF _t.id IS NULL THEN RAISE EXCEPTION 'Ticket not found'; END IF;
  IF _t.organization_id <> public.current_org_id() THEN
    RAISE EXCEPTION 'Ticket % is outside your organisation', _t.ticket_number USING ERRCODE = '42501';
  END IF;
  -- Production authority is station reach only. Raising the order (created_by /
  -- waiter) lets you WATCH the ticket and close it out for service; it never
  -- grants the right to accept, start, finish or cancel another station's work.
  -- Production editing requires an explicit production capability.
  IF NOT (
       public.has_permission('kitchen', 'queue', 'manage')
       OR public.has_permission('kitchen', 'tickets', 'edit')
  ) THEN
    RAISE EXCEPTION 'You do not have permission to operate production tickets'
      USING ERRCODE = '42501';
  END IF;

  -- Both station assignment and chef assignment remain property-scoped.
  IF _t.branch_id IS NOT NULL
     AND NOT (
       _t.branch_id = ANY(public.current_branch_ids())
       OR public.scope_rank(public.current_access_scope()) >= 5
     ) THEN
    RAISE EXCEPTION 'Ticket is outside your property access'
      USING ERRCODE = '42501';
  END IF;

  IF _t.station_id IS NOT NULL
     AND _t.station_id = ANY(public.neo_kitchen_visible_station_ids()) THEN
    RETURN;
  END IF;

  IF _t.assigned_chef_id = auth.uid() THEN RETURN; END IF;
  RAISE EXCEPTION 'You are not assigned to the % station, so you cannot change this ticket',
    COALESCE((SELECT name FROM public.operational_stations WHERE id = _t.station_id), 'production')
    USING ERRCODE = '42501';
END;
$function$;
