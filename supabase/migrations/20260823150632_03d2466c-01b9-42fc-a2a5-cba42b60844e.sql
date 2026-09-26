-- Retry (previous attempt failed: pos_orders has no cashier_id column).
-- Service authority: collecting/serving a ready item is floor work, not kitchen
-- production.

INSERT INTO public.permissions (module, feature, action, label)
SELECT 'restaurant','orders','serve','Mark ordered items collected/served'
WHERE NOT EXISTS (
  SELECT 1 FROM public.permissions WHERE module='restaurant' AND feature='orders' AND action='serve'
);

CREATE OR REPLACE FUNCTION public.neo_kitchen_caller_owns_order_ticket(_ticket uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.station_ticket_items sti
    JOIN public.pos_order_items poi ON poi.id = sti.order_item_id
    JOIN public.pos_orders o ON o.id = poi.order_id
    WHERE sti.ticket_id = _ticket
      AND o.organization_id = public.current_org_id()
      AND (o.waiter_id = auth.uid() OR o.created_by = auth.uid())
  );
$$;

REVOKE ALL ON FUNCTION public.neo_kitchen_caller_owns_order_ticket(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.neo_kitchen_caller_owns_order_ticket(uuid) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.neo_kitchen_item_transition(_item uuid, _to text, _reason text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE
  _org uuid; _ti record; _t record; _allowed text[]; _now timestamptz := now();
  _perm text; _order_state text; _ticket_state text; _is_service boolean;
BEGIN
  _org := public.current_org_id();
  SELECT * INTO _ti FROM public.station_ticket_items WHERE id = _item AND organization_id = _org;
  IF _ti.id IS NULL THEN RAISE EXCEPTION 'Ticket item not found'; END IF;
  SELECT * INTO _t FROM public.station_tickets WHERE id = _ti.ticket_id;

  _is_service := _to IN ('collected','served','completed');

  IF _is_service THEN
    IF NOT (public.has_permission('restaurant','orders.serve')
         OR public.has_permission('restaurant','orders.edit')
         OR public.has_permission('kitchen','item.ready')) THEN
      RAISE EXCEPTION 'You do not have permission to serve ordered items';
    END IF;
  ELSE
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
  END IF;

  IF NOT (_is_service AND public.neo_kitchen_caller_owns_order_ticket(_ti.ticket_id)) THEN
    PERFORM public.neo_kitchen_assert_ticket_scope(_ti.ticket_id);
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
END;
$function$;

CREATE OR REPLACE FUNCTION public.neo_kitchen_ticket_transition(_ticket uuid, _to text, _reason text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE
  _org uuid := public.current_org_id();
  _t record; _i record; _allowed text[]; _moved int := 0;
  _path text[] := ARRAY['new','accepted','preparing','ready','served','completed'];
  _target_idx int; _cur_idx int; _step text; _final text;
BEGIN
  SELECT * INTO _t FROM public.station_tickets WHERE id = _ticket AND organization_id = _org;
  IF _t.id IS NULL THEN RAISE EXCEPTION 'Ticket not found'; END IF;
  IF NOT (_to IN ('served','completed') AND public.neo_kitchen_caller_owns_order_ticket(_ticket)) THEN
    PERFORM public.neo_kitchen_assert_ticket_scope(_ticket);
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

REVOKE ALL ON FUNCTION public.neo_kitchen_item_transition(uuid, text, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.neo_kitchen_ticket_transition(uuid, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.neo_kitchen_item_transition(uuid, text, text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.neo_kitchen_ticket_transition(uuid, text, text) TO authenticated, service_role;