CREATE OR REPLACE FUNCTION public.neo_bar_reassign_ticket(
  _ticket uuid,
  _to_user uuid,
  _reason text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  _t record;
  _org uuid := public.current_org_id();
BEGIN
  IF NOT public.has_permission('bar','queue','create') THEN
    RAISE EXCEPTION 'Only the Bar Manager may reassign bar orders'
      USING ERRCODE = '42501';
  END IF;

  IF COALESCE(btrim(_reason), '') = '' THEN
    RAISE EXCEPTION 'A reason is required to reassign a bar order';
  END IF;

  SELECT *
    INTO _t
    FROM public.station_tickets
   WHERE id = _ticket
     AND organization_id = _org
     AND station_id IN (
       SELECT public.neo_bar_station_ids(NULL)
     );

  IF _t.id IS NULL THEN
    RAISE EXCEPTION 'Bar ticket not found';
  END IF;

  IF _t.status IN ('completed','cancelled') THEN
    RAISE EXCEPTION
      'Ticket % is already % and cannot be reassigned',
      _t.ticket_number,
      _t.status;
  END IF;

  /*
   * Canonical worker validation:
   * - same organisation
   * - active profile
   * - active HR employee
   * - exact property
   * - Bar department
   * - active/non-archived Bar role
   */
  PERFORM public.neo_assert_worker_scope(
    _to_user,
    _t.branch_id,
    'bar'
  );

  PERFORM set_config('neo.ticket_allocation', 'on', true);

  UPDATE public.station_tickets
     SET assigned_chef_id = _to_user,
         updated_at = now()
   WHERE id = _ticket;

  PERFORM set_config('neo.ticket_allocation', 'off', true);

  PERFORM public.emit_domain_event(
    _org,
    _t.branch_id,
    'bar.ticket.reassigned',
    'bar',
    _ticket,
    jsonb_build_object(
      'from', _t.assigned_chef_id,
      'to', _to_user,
      'reason', _reason,
      'ticket_number', _t.ticket_number
    ),
    NULL,
    NULL
  );

  RETURN jsonb_build_object(
    'ticket_id', _ticket,
    'assigned_to', _to_user
  );
END;
$function$;

REVOKE ALL
  ON FUNCTION public.neo_bar_reassign_ticket(uuid, uuid, text)
  FROM PUBLIC, anon;

GRANT EXECUTE
  ON FUNCTION public.neo_bar_reassign_ticket(uuid, uuid, text)
  TO authenticated, service_role;

NOTIFY pgrst, 'reload schema';