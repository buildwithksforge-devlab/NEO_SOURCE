CREATE OR REPLACE FUNCTION public.neo_kitchen_aggregate_ticket(_ticket uuid)
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  _t record; _now timestamptz := now();
  _active int; _new int; _accepted int; _preparing int; _ready_plus int; _served_plus int; _completed int;
  _state text;
BEGIN
  SELECT * INTO _t FROM public.station_tickets WHERE id = _ticket;
  IF _t.id IS NULL THEN RAISE EXCEPTION 'Ticket not found'; END IF;

  SELECT
    count(*) FILTER (WHERE status <> 'cancelled'),
    count(*) FILTER (WHERE status = 'new'),
    count(*) FILTER (WHERE status IN ('accepted','cancel-pending')),
    count(*) FILTER (WHERE status IN ('preparing','remaking','remake-requested')),
    count(*) FILTER (WHERE status IN ('ready','collected','served','completed')),
    count(*) FILTER (WHERE status IN ('served','completed')),
    count(*) FILTER (WHERE status = 'completed')
  INTO _active, _new, _accepted, _preparing, _ready_plus, _served_plus, _completed
  FROM public.station_ticket_items WHERE ticket_id = _ticket;

  _state := CASE
    WHEN _active = 0 THEN 'cancelled'
    WHEN _completed = _active THEN 'completed'
    WHEN _served_plus = _active THEN 'served'
    WHEN _ready_plus = _active THEN 'ready'
    WHEN _ready_plus > 0 THEN 'partially-ready'
    WHEN _preparing > 0 THEN 'preparing'
    WHEN _accepted > 0 THEN 'accepted'
    ELSE 'new'
  END;

  UPDATE public.station_tickets SET
    status = _state,
    accepted_at = CASE WHEN _state = 'new' THEN NULL ELSE COALESCE(accepted_at, _now) END,
    started_at = CASE WHEN _state IN ('preparing','partially-ready','ready','served','completed')
                      THEN COALESCE(started_at, _now) ELSE started_at END,
    ready_at = CASE WHEN _state IN ('ready','served','completed') THEN COALESCE(ready_at, _now) ELSE NULL END,
    completed_at = CASE WHEN _state = 'completed' THEN COALESCE(completed_at, _now) ELSE NULL END,
    cancelled_at = CASE WHEN _state = 'cancelled' THEN COALESCE(cancelled_at, _now) ELSE NULL END
  WHERE id = _ticket;

  -- Waiter "ready" signal: exactly once per ticket, keyed explicitly so a
  -- repeat transition can never abort the kitchen update.
  IF _state = 'ready' THEN
    PERFORM public.emit_domain_event(_t.organization_id, _t.branch_id, 'kitchen.order.ready', 'kitchen', _ticket,
      jsonb_build_object('order_id', _t.order_id, 'station_id', _t.station_id),
      'kitchen-ticket-ready-' || _ticket::text, NULL);
    INSERT INTO public.notifications (organization_id, user_id, branch_id, department_id, station_id, category,
                                      title, body, link, priority, source_module, source_record_id,
                                      event_type, idempotency_key)
    SELECT _t.organization_id, o.waiter_id, _t.branch_id, _t.department_id, _t.station_id, 'kitchen',
           'Order ' || o.order_number || ' is ready',
           'All items on ticket ' || _t.ticket_number || ' are ready for collection.',
           '/pos/orders/' || o.id::text, 'high', 'kitchen', _ticket,
           'kitchen.order.ready',
           'kitchen.order.ready:' || _ticket::text || ':' || o.waiter_id::text
    FROM public.pos_orders o
    WHERE o.id = _t.order_id AND o.waiter_id IS NOT NULL
    ON CONFLICT DO NOTHING;
  END IF;

  RETURN _state;
END
$function$;