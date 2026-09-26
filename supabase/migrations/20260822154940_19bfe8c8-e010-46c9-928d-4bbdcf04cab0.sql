
-- 1) Canonical aggregation: ticket header is always derived from its items.
CREATE OR REPLACE FUNCTION public.neo_kitchen_aggregate_ticket(_ticket uuid)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
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

  -- Waiter "ready" signal: exactly once per ticket.
  IF _state = 'ready' THEN
    PERFORM public.emit_domain_event(_t.organization_id, _t.branch_id, 'kitchen.order.ready', 'kitchen', _ticket,
      jsonb_build_object('order_id', _t.order_id, 'station_id', _t.station_id),
      'kitchen-ticket-ready-' || _ticket::text, NULL);
    INSERT INTO public.notifications (organization_id, user_id, branch_id, department_id, station_id, category, title, body, link, priority)
    SELECT _t.organization_id, o.waiter_id, _t.branch_id, _t.department_id, _t.station_id, 'kitchen',
           'Order ' || o.order_number || ' is ready',
           'All items on ticket ' || _t.ticket_number || ' are ready for collection.',
           '/pos/orders/' || o.id::text, 'high'
    FROM public.pos_orders o
    WHERE o.id = _t.order_id AND o.waiter_id IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM public.notifications n
        WHERE n.organization_id = _t.organization_id AND n.user_id = o.waiter_id AND n.category = 'kitchen'
          AND n.body = 'All items on ticket ' || _t.ticket_number || ' are ready for collection.');
  END IF;

  RETURN _state;
END
$fn$;

REVOKE ALL ON FUNCTION public.neo_kitchen_aggregate_ticket(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.neo_kitchen_aggregate_ticket(uuid) TO authenticated;

-- 2) Canonical item transition: the only write path for item state.
CREATE OR REPLACE FUNCTION public.neo_kitchen_item_transition(_item uuid, _to text, _reason text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  _org uuid; _ti record; _t record; _allowed text[]; _now timestamptz := now();
  _perm text; _order_state text; _ticket_state text;
BEGIN
  _org := public.current_org_id();
  SELECT * INTO _ti FROM public.station_ticket_items WHERE id = _item AND organization_id = _org;
  IF _ti.id IS NULL THEN RAISE EXCEPTION 'Ticket item not found'; END IF;
  SELECT * INTO _t FROM public.station_tickets WHERE id = _ti.ticket_id;

  _perm := CASE _to
    WHEN 'accepted' THEN 'ticket.accept'
    WHEN 'preparing' THEN 'item.prepare'
    WHEN 'ready' THEN 'item.ready'
    WHEN 'cancel-pending' THEN 'item.cancel_request'
    WHEN 'cancelled' THEN 'item.cancel_request'
    WHEN 'remake-requested' THEN 'item.cancel_request'
    ELSE 'item.prepare' END;
  IF NOT public.has_permission('kitchen', _perm) THEN
    RAISE EXCEPTION 'You do not have the kitchen.% permission', _perm;
  END IF;

  IF public.current_access_scope() = 'station'
     AND _t.station_id IS NOT NULL
     AND NOT (_t.station_id = ANY (COALESCE(public.current_station_ids(), ARRAY[]::uuid[]))) THEN
    RAISE EXCEPTION 'This ticket belongs to a station outside your assigned stations';
  END IF;

  _allowed := CASE _ti.status
    WHEN 'new' THEN ARRAY['accepted','cancel-pending','cancelled']
    WHEN 'accepted' THEN ARRAY['preparing','cancel-pending','cancelled']
    WHEN 'preparing' THEN ARRAY['ready','cancel-pending','cancelled']
    WHEN 'ready' THEN ARRAY['collected','served','remake-requested']
    WHEN 'collected' THEN ARRAY['served','remake-requested']
    WHEN 'served' THEN ARRAY['completed','remake-requested']
    WHEN 'cancel-pending' THEN ARRAY['cancelled','accepted','preparing']
    WHEN 'remake-requested' THEN ARRAY['remaking']
    WHEN 'remaking' THEN ARRAY['ready']
    ELSE ARRAY[]::text[] END;

  IF _ti.status IN ('completed','cancelled') THEN
    RAISE EXCEPTION 'Item is already % and cannot change', _ti.status;
  END IF;
  IF NOT (_to = ANY (_allowed)) THEN
    RAISE EXCEPTION 'Cannot move a % item to %', _ti.status, _to;
  END IF;

  IF _to IN ('ready','collected','served','completed')
     AND EXISTS (SELECT 1 FROM public.quality_holds qh
                  WHERE qh.ticket_item_id = _item AND qh.status = 'active' AND qh.blocks_release) THEN
    RAISE EXCEPTION 'This item is on an active quality hold and cannot be released';
  END IF;

  UPDATE public.station_ticket_items SET
    status = _to,
    chef_id = CASE WHEN _to IN ('accepted','preparing') THEN COALESCE(chef_id, auth.uid()) ELSE chef_id END,
    accepted_at = CASE WHEN _to = 'accepted' THEN COALESCE(accepted_at, _now) ELSE accepted_at END,
    started_at = CASE WHEN _to IN ('preparing','remaking') THEN COALESCE(started_at, _now) ELSE started_at END,
    ready_at = CASE WHEN _to = 'ready' THEN _now ELSE ready_at END,
    collected_at = CASE WHEN _to = 'collected' THEN _now ELSE collected_at END,
    served_at = CASE WHEN _to = 'served' THEN _now ELSE served_at END,
    cancelled_at = CASE WHEN _to = 'cancelled' THEN _now ELSE cancelled_at END,
    completed_at = CASE WHEN _to = 'completed' THEN _now ELSE completed_at END,
    production_note = COALESCE(_reason, production_note)
  WHERE id = _item;

  INSERT INTO public.station_ticket_status_history (organization_id, ticket_id, ticket_item_id, from_status, to_status, reason, changed_by)
  VALUES (_org, _ti.ticket_id, _item, _ti.status, _to, _reason, auth.uid());

  _order_state := CASE _to
    WHEN 'accepted' THEN 'accepted' WHEN 'preparing' THEN 'preparing' WHEN 'remaking' THEN 'preparing'
    WHEN 'ready' THEN 'ready' WHEN 'collected' THEN 'ready' WHEN 'served' THEN 'served'
    WHEN 'completed' THEN 'served'
    WHEN 'cancel-pending' THEN 'cancel-pending' WHEN 'cancelled' THEN 'cancelled' ELSE NULL END;
  IF _order_state IS NOT NULL AND _ti.order_item_id IS NOT NULL THEN
    UPDATE public.pos_order_items SET status = _order_state
    WHERE id = _ti.order_item_id AND status <> _order_state;
  END IF;

  _ticket_state := public.neo_kitchen_aggregate_ticket(_ti.ticket_id);
  RETURN jsonb_build_object('item_status', _to, 'ticket_status', _ticket_state);
END
$fn$;

REVOKE ALL ON FUNCTION public.neo_kitchen_item_transition(uuid, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.neo_kitchen_item_transition(uuid, text, text) TO authenticated;

-- 3) Legacy entry point delegates, so no caller can bypass aggregation/audit/scope.
CREATE OR REPLACE FUNCTION public.kitchen_item_transition(_ticket_item_id uuid, _to_status text, _reason text DEFAULT NULL)
RETURNS jsonb
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $fn$
  SELECT public.neo_kitchen_item_transition(_ticket_item_id, _to_status, _reason);
$fn$;

REVOKE ALL ON FUNCTION public.kitchen_item_transition(uuid, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.kitchen_item_transition(uuid, text, text) TO authenticated;

-- 4) Ticket transition propagates to items, or is rejected.
CREATE OR REPLACE FUNCTION public.neo_kitchen_ticket_transition(_ticket uuid, _to text, _reason text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  _org uuid := public.current_org_id();
  _t record; _i record; _allowed text[]; _moved int := 0;
  _path text[] := ARRAY['new','accepted','preparing','ready','served','completed'];
  _target_idx int; _cur_idx int; _step text; _final text;
BEGIN
  SELECT * INTO _t FROM public.station_tickets WHERE id = _ticket AND organization_id = _org;
  IF _t.id IS NULL THEN RAISE EXCEPTION 'Ticket not found'; END IF;
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
END
$fn$;

REVOKE ALL ON FUNCTION public.neo_kitchen_ticket_transition(uuid, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.neo_kitchen_ticket_transition(uuid, text, text) TO authenticated;

-- 5) Read-only invariant checker: header vs items.
CREATE OR REPLACE FUNCTION public.neo_kitchen_invariant_violations()
RETURNS TABLE (ticket_id uuid, ticket_number text, recorded_status text, derived_status text, item_statuses jsonb)
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  WITH derived AS (
    SELECT t.id, t.ticket_number, t.status AS recorded,
      CASE
        WHEN count(i.*) FILTER (WHERE i.status <> 'cancelled') = 0 THEN 'cancelled'
        WHEN count(i.*) FILTER (WHERE i.status = 'completed') = count(i.*) FILTER (WHERE i.status <> 'cancelled') THEN 'completed'
        WHEN count(i.*) FILTER (WHERE i.status IN ('served','completed')) = count(i.*) FILTER (WHERE i.status <> 'cancelled') THEN 'served'
        WHEN count(i.*) FILTER (WHERE i.status IN ('ready','collected','served','completed')) = count(i.*) FILTER (WHERE i.status <> 'cancelled') THEN 'ready'
        WHEN count(i.*) FILTER (WHERE i.status IN ('ready','collected','served','completed')) > 0 THEN 'partially-ready'
        WHEN count(i.*) FILTER (WHERE i.status IN ('preparing','remaking','remake-requested')) > 0 THEN 'preparing'
        WHEN count(i.*) FILTER (WHERE i.status IN ('accepted','cancel-pending')) > 0 THEN 'accepted'
        ELSE 'new'
      END AS derived,
      jsonb_agg(DISTINCT i.status) AS statuses
    FROM public.station_tickets t
    LEFT JOIN public.station_ticket_items i ON i.ticket_id = t.id
    GROUP BY t.id, t.ticket_number, t.status
  )
  SELECT id, ticket_number, recorded, derived, statuses
  FROM derived WHERE recorded IS DISTINCT FROM derived;
$$;

REVOKE ALL ON FUNCTION public.neo_kitchen_invariant_violations() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.neo_kitchen_invariant_violations() TO authenticated;
