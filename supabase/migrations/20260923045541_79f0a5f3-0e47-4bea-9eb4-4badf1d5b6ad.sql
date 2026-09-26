CREATE OR REPLACE FUNCTION public.neo_kitchen_item_transition(_item uuid, _to text, _reason text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  _org uuid; _ti record; _t record; _allowed text[]; _now timestamptz := now();
  _perm text; _order_state text; _ticket_state text; _is_service boolean;
  _pos_path text[] := ARRAY['draft','sent','accepted','preparing','ready','served'];
  _pos_current text; _cur_rank int; _new_rank int;
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
    SELECT status INTO _pos_current FROM public.pos_order_items WHERE id = _ti.order_item_id;
    -- The service line mirrors production, but never walks backwards: a POS line
    -- already at or past the mirrored state (e.g. served) must not be rewound,
    -- which the POS status trigger rightly rejects and which would abort the
    -- legitimate kitchen transition.
    _cur_rank := array_position(_pos_path, _pos_current);
    _new_rank := array_position(_pos_path, _order_state);
    IF _pos_current IS DISTINCT FROM _order_state
       AND (
         _cur_rank IS NULL OR _new_rank IS NULL
         OR _new_rank > _cur_rank
       )
       AND COALESCE(_pos_current, '') NOT IN ('cancelled','voided') THEN
      UPDATE public.pos_order_items SET status = _order_state
      WHERE id = _ti.order_item_id AND status <> _order_state;
    END IF;
  END IF;

  _ticket_state := public.neo_kitchen_aggregate_ticket(_ti.ticket_id);
  RETURN jsonb_build_object('item_status', _to, 'ticket_status', _ticket_state);
END;
$function$;