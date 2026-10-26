-- NEO P1.2 - KDS TRANSITION CONCURRENCY
-- LOCAL DRAFT - DO NOT DEPLOY
--
-- Serialise transitions on the same production ticket.
-- Preserve existing station authority and lifecycle rules.
CREATE OR REPLACE FUNCTION public.neo_kitchen_ticket_transition(_ticket uuid, _to text, _reason text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  _org uuid := public.current_org_id();
  _t record; _i record; _allowed text[]; _moved int := 0;
  _path text[] := ARRAY['new','accepted','preparing','ready','served','completed'];
  _target_idx int; _cur_idx int; _step text; _final text;
BEGIN
  SELECT * INTO _t FROM public.station_tickets WHERE id = _ticket AND organization_id = _org FOR UPDATE;
  IF _t.id IS NULL THEN RAISE EXCEPTION 'Ticket not found'; END IF;
  IF _to IN ('served','completed') AND public.neo_kitchen_caller_owns_order_ticket(_ticket) THEN
    PERFORM public.neo_kitchen_assert_ticket_scope(_ticket);
  ELSE
    PERFORM public.neo_kitchen_assert_station_authority(_ticket);
  END IF;
  IF _t.status IN ('completed','cancelled') THEN
    RAISE EXCEPTION 'Ticket % is already % and cannot change', _t.ticket_number, _t.status;
  END IF;

  _allowed := CASE _t.status
    WHEN 'new' THEN ARRAY['accepted','cancelled']
    WHEN 'accepted' THEN ARRAY['preparing','cancelled']
    WHEN 'preparing' THEN ARRAY['ready','cancelled']
    WHEN 'partially-ready' THEN ARRAY['ready','cancelled']
    WHEN 'ready' THEN ARRAY['served']
    WHEN 'served' THEN ARRAY['completed']
    ELSE ARRAY[]::text[] END;
  IF NOT (_to = ANY (_allowed)) THEN
    RAISE EXCEPTION 'Cannot move ticket % from % to %', _t.ticket_number, _t.status, _to;
  END IF;

  IF _to = 'cancelled' THEN
    IF COALESCE(btrim(_reason), '') = '' THEN RAISE EXCEPTION 'A reason is required to cancel a ticket'; END IF;
    FOR _i IN SELECT * FROM public.station_ticket_items WHERE ticket_id = _ticket AND status NOT IN ('cancelled','completed') LOOP
      IF _i.status IN ('ready','collected','served') THEN
        RAISE EXCEPTION 'Ticket % cannot be cancelled: item is already %', _t.ticket_number, _i.status;
      END IF;
      IF _i.status <> 'cancel-pending' THEN
        PERFORM public.neo_kitchen_item_transition(_i.id, 'cancel-pending', _reason);
      END IF;
      PERFORM public.neo_kitchen_item_transition(_i.id, 'cancelled', _reason);
      _moved := _moved + 1;
    END LOOP;
    _final := public.neo_kitchen_aggregate_ticket(_ticket);
    RETURN jsonb_build_object('ticket_status', _final, 'items_moved', _moved);
  END IF;

  _target_idx := array_position(_path, _to);
  FOR _i IN SELECT * FROM public.station_ticket_items WHERE ticket_id = _ticket AND status NOT IN ('cancelled','completed') LOOP
    _cur_idx := array_position(_path, _i.status);
    IF _cur_idx IS NULL AND _i.status = 'collected' THEN
      _cur_idx := array_position(_path, 'ready');
    END IF;
    IF _cur_idx IS NULL THEN
      RAISE EXCEPTION 'Ticket % cannot move to %: item is %', _t.ticket_number, _to, _i.status;
    END IF;
    WHILE _cur_idx < _target_idx LOOP
      _cur_idx := _cur_idx + 1;
      _step := _path[_cur_idx];
      PERFORM public.neo_kitchen_item_transition(_i.id, _step, _reason);
      _moved := _moved + 1;
    END LOOP;
  END LOOP;

  _final := public.neo_kitchen_aggregate_ticket(_ticket);
  IF _final <> _to THEN
    RAISE EXCEPTION 'Ticket % could not reach % (items resolve to %)', _t.ticket_number, _to, _final;
  END IF;
  RETURN jsonb_build_object('ticket_status', _final, 'items_moved', _moved);
END;
$function$;
