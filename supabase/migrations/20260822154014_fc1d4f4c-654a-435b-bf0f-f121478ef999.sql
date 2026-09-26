
-- 1) Canonical read: one source for POS KDS and Kitchen Live Queue. SECURITY INVOKER: RLS applies.
CREATE OR REPLACE FUNCTION public.neo_kitchen_queue(
  _branch uuid DEFAULT NULL,
  _station uuid DEFAULT NULL,
  _view text DEFAULT 'live'
)
RETURNS TABLE (
  ticket_id uuid,
  ticket_number text,
  status text,
  priority text,
  priority_reason text,
  delay_reason text,
  branch_id uuid,
  department_id uuid,
  station_id uuid,
  station_name text,
  station_missing boolean,
  order_id uuid,
  order_number text,
  order_type text,
  table_code text,
  guest_name text,
  guest_count integer,
  waiter_id uuid,
  allergy_alert text,
  dietary_notes text,
  course text,
  target_minutes integer,
  received_at timestamptz,
  accepted_at timestamptz,
  started_at timestamptz,
  ready_at timestamptz,
  age_minutes integer,
  is_delayed boolean,
  items jsonb
)
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  SELECT
    t.id,
    t.ticket_number,
    t.status,
    COALESCE(t.priority, 'normal'),
    t.priority_reason,
    t.delay_reason,
    t.branch_id,
    t.department_id,
    t.station_id,
    s.name,
    (t.station_id IS NULL),
    t.order_id,
    o.order_number,
    o.order_type,
    rt.code,
    o.guest_name,
    o.guest_count,
    o.waiter_id,
    o.allergy_alert,
    o.dietary_notes,
    t.course,
    COALESCE(t.target_minutes, 15),
    COALESCE(t.received_at, t.created_at),
    t.accepted_at,
    t.started_at,
    t.ready_at,
    GREATEST(0, (EXTRACT(EPOCH FROM (now() - COALESCE(t.received_at, t.created_at))) / 60)::int),
    (EXTRACT(EPOCH FROM (now() - COALESCE(t.received_at, t.created_at))) / 60) > COALESCE(t.target_minutes, 15)
      AND t.status NOT IN ('ready','served','completed','cancelled'),
    COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
               'ticket_item_id', i.id,
               'order_item_id', i.order_item_id,
               'status', i.status,
               'chef_id', i.chef_id,
               'production_note', i.production_note,
               'item_name', oi.item_name,
               'quantity', oi.quantity,
               'course', oi.course,
               'special_instructions', oi.special_instructions,
               'allergy_note', oi.allergy_note,
               'modifiers', COALESCE((
                  SELECT jsonb_agg(jsonb_build_object('group_name', m.group_name, 'option_name', m.option_name))
                  FROM public.pos_order_item_modifiers m WHERE m.order_item_id = oi.id), '[]'::jsonb)
             ) ORDER BY oi.item_name)
      FROM public.station_ticket_items i
      LEFT JOIN public.pos_order_items oi ON oi.id = i.order_item_id
      WHERE i.ticket_id = t.id
    ), '[]'::jsonb)
  FROM public.station_tickets t
  LEFT JOIN public.operational_stations s ON s.id = t.station_id
  LEFT JOIN public.pos_orders o ON o.id = t.order_id
  LEFT JOIN public.restaurant_tables rt ON rt.id = o.table_id
  WHERE (_branch IS NULL OR t.branch_id = _branch)
    AND (_station IS NULL OR t.station_id = _station)
    AND (
      CASE
        WHEN COALESCE(_view, 'live') = 'live' THEN t.status NOT IN ('served','completed','cancelled')
        WHEN _view = 'all' THEN true
        WHEN _view = 'delayed' THEN t.status NOT IN ('ready','served','completed','cancelled')
          AND (EXTRACT(EPOCH FROM (now() - COALESCE(t.received_at, t.created_at))) / 60) > COALESCE(t.target_minutes, 15)
        WHEN _view = 'unassigned-station' THEN t.station_id IS NULL AND t.status NOT IN ('served','completed','cancelled')
        ELSE t.status = _view
      END
    )
  ORDER BY COALESCE(t.received_at, t.created_at);
$$;

REVOKE ALL ON FUNCTION public.neo_kitchen_queue(uuid, uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.neo_kitchen_queue(uuid, uuid, text) TO authenticated;

-- 2) Ready notification must fire at most once per ticket.
CREATE OR REPLACE FUNCTION public.kitchen_item_transition(_ticket_item_id uuid, _to_status text, _reason text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  _org uuid; _ti record; _t record; _allowed text[]; _now timestamptz := now();
  _active int; _ready int; _order_state text; _ticket_state text; _perm text;
BEGIN
  _org := public.current_org_id();
  SELECT * INTO _ti FROM public.station_ticket_items WHERE id = _ticket_item_id AND organization_id = _org;
  IF _ti.id IS NULL THEN RAISE EXCEPTION 'Ticket item not found'; END IF;
  SELECT * INTO _t FROM public.station_tickets WHERE id = _ti.ticket_id;

  _perm := CASE _to_status
    WHEN 'accepted' THEN 'ticket.accept'
    WHEN 'preparing' THEN 'item.prepare'
    WHEN 'ready' THEN 'item.ready'
    WHEN 'cancel-pending' THEN 'item.cancel_request'
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
    WHEN 'ready' THEN ARRAY['collected','remake-requested','cancelled']
    WHEN 'collected' THEN ARRAY['served','remake-requested']
    WHEN 'served' THEN ARRAY['completed','remake-requested']
    WHEN 'cancel-pending' THEN ARRAY['cancelled','accepted','preparing']
    WHEN 'remake-requested' THEN ARRAY['remaking','cancelled']
    WHEN 'remaking' THEN ARRAY['ready','cancelled']
    ELSE ARRAY[]::text[] END;
  IF NOT (_to_status = ANY (_allowed)) THEN
    RAISE EXCEPTION 'Cannot move a % item to %', _ti.status, _to_status;
  END IF;

  IF _to_status IN ('ready','collected','served','completed')
     AND EXISTS (SELECT 1 FROM public.quality_holds qh
                  WHERE qh.ticket_item_id = _ticket_item_id AND qh.status = 'active' AND qh.blocks_release) THEN
    RAISE EXCEPTION 'This item is on an active quality hold and cannot be released';
  END IF;

  UPDATE public.station_ticket_items SET
    status = _to_status,
    chef_id = CASE WHEN _to_status IN ('accepted','preparing') THEN COALESCE(chef_id, auth.uid()) ELSE chef_id END,
    accepted_at = CASE WHEN _to_status = 'accepted' THEN COALESCE(accepted_at, _now) ELSE accepted_at END,
    started_at = CASE WHEN _to_status IN ('preparing','remaking') THEN COALESCE(started_at, _now) ELSE started_at END,
    ready_at = CASE WHEN _to_status = 'ready' THEN _now ELSE ready_at END,
    collected_at = CASE WHEN _to_status = 'collected' THEN _now ELSE collected_at END,
    served_at = CASE WHEN _to_status = 'served' THEN _now ELSE served_at END,
    cancelled_at = CASE WHEN _to_status = 'cancelled' THEN _now ELSE cancelled_at END,
    completed_at = CASE WHEN _to_status = 'completed' THEN _now ELSE completed_at END,
    production_note = COALESCE(_reason, production_note)
  WHERE id = _ticket_item_id;

  INSERT INTO public.station_ticket_status_history (organization_id, ticket_id, ticket_item_id, from_status, to_status, reason, changed_by)
  VALUES (_org, _ti.ticket_id, _ticket_item_id, _ti.status, _to_status, _reason, auth.uid());

  _order_state := CASE _to_status
    WHEN 'accepted' THEN 'accepted' WHEN 'preparing' THEN 'preparing' WHEN 'remaking' THEN 'preparing'
    WHEN 'ready' THEN 'ready' WHEN 'served' THEN 'served' WHEN 'cancel-pending' THEN 'cancel-pending'
    WHEN 'cancelled' THEN 'cancelled' ELSE NULL END;
  IF _order_state IS NOT NULL THEN
    UPDATE public.pos_order_items SET status = _order_state WHERE id = _ti.order_item_id AND status <> _order_state;
  END IF;

  SELECT count(*) FILTER (WHERE status NOT IN ('cancelled')),
         count(*) FILTER (WHERE status IN ('ready','collected','served','completed'))
    INTO _active, _ready
  FROM public.station_ticket_items WHERE ticket_id = _ti.ticket_id;

  _ticket_state := CASE
    WHEN _active = 0 THEN 'cancelled'
    WHEN _ready = 0 AND EXISTS (SELECT 1 FROM public.station_ticket_items WHERE ticket_id=_ti.ticket_id AND status='preparing') THEN 'preparing'
    WHEN _ready = 0 AND EXISTS (SELECT 1 FROM public.station_ticket_items WHERE ticket_id=_ti.ticket_id AND status='accepted') THEN 'accepted'
    WHEN _ready = 0 THEN 'new'
    WHEN _ready < _active THEN 'partially-ready'
    WHEN (SELECT count(*) FROM public.station_ticket_items WHERE ticket_id=_ti.ticket_id AND status IN ('completed')) = _active THEN 'completed'
    WHEN (SELECT count(*) FROM public.station_ticket_items WHERE ticket_id=_ti.ticket_id AND status IN ('served','completed')) = _active THEN 'served'
    ELSE 'ready' END;

  UPDATE public.station_tickets SET
    status = _ticket_state,
    accepted_at = CASE WHEN _ticket_state <> 'new' THEN COALESCE(accepted_at, _now) ELSE accepted_at END,
    started_at = CASE WHEN _ticket_state IN ('preparing','partially-ready','ready') THEN COALESCE(started_at, _now) ELSE started_at END,
    ready_at = CASE WHEN _ticket_state = 'ready' THEN COALESCE(ready_at, _now) ELSE ready_at END,
    completed_at = CASE WHEN _ticket_state = 'completed' THEN COALESCE(completed_at, _now) ELSE completed_at END,
    cancelled_at = CASE WHEN _ticket_state = 'cancelled' THEN COALESCE(cancelled_at, _now) ELSE cancelled_at END
  WHERE id = _ti.ticket_id;

  IF _ticket_state = 'ready' THEN
    PERFORM public.emit_domain_event(_org, _t.branch_id, 'kitchen.order.ready', 'kitchen', _ti.ticket_id,
      jsonb_build_object('order_id', _t.order_id, 'station_id', _t.station_id),
      'kitchen-ticket-ready-' || _ti.ticket_id::text, NULL);
    INSERT INTO public.notifications (organization_id, user_id, branch_id, department_id, station_id, category, title, body, link, priority)
    SELECT _org, o.waiter_id, _t.branch_id, _t.department_id, _t.station_id, 'kitchen',
           'Order ' || o.order_number || ' is ready',
           'All items on ticket ' || _t.ticket_number || ' are ready for collection.',
           '/pos/orders/' || o.id::text, 'high'
    FROM public.pos_orders o
    WHERE o.id = _t.order_id AND o.waiter_id IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM public.notifications n
        WHERE n.organization_id = _org AND n.user_id = o.waiter_id AND n.category = 'kitchen'
          AND n.body = 'All items on ticket ' || _t.ticket_number || ' are ready for collection.'
      );
  END IF;

  RETURN jsonb_build_object('item_status', _to_status, 'ticket_status', _ticket_state);
END
$fn$;

REVOKE ALL ON FUNCTION public.kitchen_item_transition(uuid, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.kitchen_item_transition(uuid, text, text) TO authenticated;

-- 3) Canonical ticket-level transition: one contract for both live pages.
CREATE OR REPLACE FUNCTION public.neo_kitchen_ticket_transition(_ticket uuid, _to text, _reason text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  _org uuid := public.current_org_id();
  _t record; _i record; _path text[] := ARRAY['new','accepted','preparing','ready','collected','served','completed'];
  _target_idx int; _cur_idx int; _step text; _moved int := 0; _allowed text[];
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
    FOR _i IN SELECT * FROM public.station_ticket_items WHERE ticket_id = _ticket AND status <> 'cancelled' LOOP
      IF _i.status IN ('new','accepted','preparing') THEN
        PERFORM public.kitchen_item_transition(_i.id, 'cancel-pending', _reason);
        PERFORM public.kitchen_item_transition(_i.id, 'cancelled', _reason);
        _moved := _moved + 1;
      END IF;
    END LOOP;
    RETURN jsonb_build_object('ticket_status', (SELECT status FROM public.station_tickets WHERE id = _ticket), 'items_moved', _moved);
  END IF;

  _target_idx := array_position(_path, _to);
  FOR _i IN SELECT * FROM public.station_ticket_items WHERE ticket_id = _ticket AND status <> 'cancelled' LOOP
    _cur_idx := array_position(_path, _i.status);
    IF _cur_idx IS NULL THEN CONTINUE; END IF;
    WHILE _cur_idx < _target_idx LOOP
      _cur_idx := _cur_idx + 1;
      _step := _path[_cur_idx];
      PERFORM public.kitchen_item_transition(_i.id, _step, _reason);
      _moved := _moved + 1;
    END LOOP;
  END LOOP;

  RETURN jsonb_build_object(
    'ticket_status', (SELECT status FROM public.station_tickets WHERE id = _ticket),
    'items_moved', _moved);
END
$fn$;

REVOKE ALL ON FUNCTION public.neo_kitchen_ticket_transition(uuid, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.neo_kitchen_ticket_transition(uuid, text, text) TO authenticated;

-- 4) Delay is metadata + event, never a lifecycle state.
CREATE OR REPLACE FUNCTION public.neo_kitchen_ticket_delay(_ticket uuid, _reason text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE _org uuid := public.current_org_id(); _t record;
BEGIN
  IF COALESCE(btrim(_reason), '') = '' THEN RAISE EXCEPTION 'A delay reason is required'; END IF;
  SELECT * INTO _t FROM public.station_tickets WHERE id = _ticket AND organization_id = _org;
  IF _t.id IS NULL THEN RAISE EXCEPTION 'Ticket not found'; END IF;
  IF NOT public.has_permission('kitchen', 'item.prepare') THEN
    RAISE EXCEPTION 'You do not have the kitchen.item.prepare permission';
  END IF;

  UPDATE public.station_tickets SET delay_reason = _reason WHERE id = _ticket;

  INSERT INTO public.station_ticket_status_history (organization_id, ticket_id, from_status, to_status, reason, changed_by)
  VALUES (_org, _ticket, _t.status, _t.status, 'delay: ' || _reason, auth.uid());

  PERFORM public.emit_domain_event(_org, _t.branch_id, 'kitchen.ticket.delayed', 'kitchen', _ticket,
    jsonb_build_object('reason', _reason, 'order_id', _t.order_id, 'station_id', _t.station_id),
    'kitchen-ticket-delay-' || _ticket::text || '-' || md5(_reason), NULL);

  RETURN jsonb_build_object('ticket_status', _t.status, 'delay_reason', _reason);
END
$fn$;

REVOKE ALL ON FUNCTION public.neo_kitchen_ticket_delay(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.neo_kitchen_ticket_delay(uuid, text) TO authenticated;

-- 5) Idempotent backfill of production tickets for open POS orders.
CREATE OR REPLACE FUNCTION public.neo_kitchen_backfill_tickets(_branch uuid DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE _org uuid := public.current_org_id(); _o record; _res jsonb; _orders int := 0; _items int := 0;
BEGIN
  IF _org IS NULL THEN RAISE EXCEPTION 'No active organization'; END IF;
  FOR _o IN
    SELECT DISTINCT o.id FROM public.pos_orders o
    JOIN public.pos_order_items oi ON oi.order_id = o.id
    WHERE o.organization_id = _org
      AND (_branch IS NULL OR o.branch_id = _branch)
      AND o.status NOT IN ('draft','held','cancelled','voided','closed')
      AND oi.held = false
      AND oi.status IN ('sent','accepted','preparing')
      AND NOT EXISTS (SELECT 1 FROM public.station_ticket_items sti WHERE sti.order_item_id = oi.id)
  LOOP
    _res := public.kitchen_route_order(_o.id);
    _orders := _orders + 1;
    _items := _items + COALESCE((_res->>'items_routed')::int, 0);
  END LOOP;
  RETURN jsonb_build_object('orders_processed', _orders, 'items_routed', _items);
END
$fn$;

REVOKE ALL ON FUNCTION public.neo_kitchen_backfill_tickets(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.neo_kitchen_backfill_tickets(uuid) TO authenticated;
