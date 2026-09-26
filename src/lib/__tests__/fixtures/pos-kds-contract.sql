CREATE OR REPLACE FUNCTION public.kitchen_route_order(_order_id uuid)
 RETURNS jsonb
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT public.neo_pos_send_to_kitchen(_order_id, gen_random_uuid());
$function$


CREATE OR REPLACE FUNCTION public.neo_kitchen_item_transition(_item uuid, _to text, _reason text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
$function$


CREATE OR REPLACE FUNCTION public.neo_kitchen_queue(_branch uuid DEFAULT NULL::uuid, _station uuid DEFAULT NULL::uuid, _view text DEFAULT 'live'::text)
 RETURNS TABLE(ticket_id uuid, ticket_number text, status text, priority text, priority_reason text, delay_reason text, branch_id uuid, department_id uuid, station_id uuid, station_name text, station_missing boolean, order_id uuid, order_number text, order_type text, table_code text, guest_name text, guest_count integer, waiter_id uuid, allergy_alert text, dietary_notes text, course text, target_minutes integer, received_at timestamp with time zone, accepted_at timestamp with time zone, started_at timestamp with time zone, ready_at timestamp with time zone, age_minutes integer, is_delayed boolean, items jsonb)
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $function$
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
$function$


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
$function$


CREATE OR REPLACE FUNCTION public.neo_pos_kds_reconciliation(_branch uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE _org uuid := public.current_org_id();
        _missing jsonb; _orphan jsonb; _dupes jsonb; _unrouted jsonb; _conflict jsonb; _zombie jsonb;
BEGIN
  IF _org IS NULL THEN RETURN jsonb_build_object('ok', false, 'reason', 'no_organisation'); END IF;
  IF NOT (public.has_permission('kitchen','queue.view')
          OR public.has_permission('restaurant','orders.view')
          OR public.is_org_admin()) THEN
    RAISE EXCEPTION 'insufficient_privilege' USING ERRCODE = '42501';
  END IF;

  SELECT coalesce(jsonb_agg(x), '[]'::jsonb) INTO _missing FROM (
    SELECT jsonb_build_object('order_item_id', i.id, 'item_name', i.item_name,
             'order_id', i.order_id, 'sent_at', i.sent_at) AS x
      FROM public.pos_order_items i
      JOIN public.pos_orders o ON o.id = i.order_id
     WHERE i.organization_id = _org
       AND (_branch IS NULL OR o.branch_id = _branch)
       AND public.neo_branch_in_scope(o.branch_id)
       AND i.sent_at IS NOT NULL
       AND coalesce(i.status,'') NOT IN ('cancelled','voided')
       AND o.created_at > now() - interval '7 days'
       AND NOT EXISTS (SELECT 1 FROM public.station_ticket_items t WHERE t.order_item_id = i.id)
     LIMIT 200) m;

  SELECT coalesce(jsonb_agg(y), '[]'::jsonb) INTO _orphan FROM (
    SELECT jsonb_build_object('ticket_item_id', t.id, 'ticket_id', t.ticket_id) AS y
      FROM public.station_ticket_items t
      LEFT JOIN public.pos_order_items i ON i.id = t.order_item_id
     WHERE t.organization_id = _org AND i.id IS NULL
     LIMIT 200) o2;

  SELECT coalesce(jsonb_agg(z), '[]'::jsonb) INTO _dupes FROM (
    SELECT jsonb_build_object('order_item_id', t.order_item_id, 'tickets', count(*)) AS z
      FROM public.station_ticket_items t
     WHERE t.organization_id = _org AND t.remake_of_id IS NULL
     GROUP BY t.order_item_id HAVING count(*) > 1
     LIMIT 200) d;

  SELECT coalesce(jsonb_agg(w), '[]'::jsonb) INTO _unrouted FROM (
    SELECT jsonb_build_object('order_item_id', i.id, 'item_name', i.item_name,
             'order_id', i.order_id) AS w
      FROM public.pos_order_items i
      JOIN public.pos_orders o ON o.id = i.order_id
     WHERE i.organization_id = _org
       AND (_branch IS NULL OR o.branch_id = _branch)
       AND public.neo_branch_in_scope(o.branch_id)
       AND i.station_id IS NULL AND i.sent_at IS NOT NULL
       AND o.created_at > now() - interval '7 days'
     LIMIT 200) u;

  SELECT coalesce(jsonb_agg(c), '[]'::jsonb) INTO _conflict FROM (
    SELECT jsonb_build_object('order_item_id', i.id, 'item_name', i.item_name,
             'pos_status', i.status, 'kds_status', t.status, 'ticket_item_id', t.id) AS c
      FROM public.pos_order_items i
      JOIN public.pos_orders o ON o.id = i.order_id
      JOIN public.station_ticket_items t ON t.order_item_id = i.id AND t.remake_of_id IS NULL
     WHERE i.organization_id = _org
       AND (_branch IS NULL OR o.branch_id = _branch)
       AND public.neo_branch_in_scope(o.branch_id)
       AND o.created_at > now() - interval '7 days'
       AND i.status IN ('ready','served')
       AND t.status IN ('new','accepted','preparing','remaking')
     LIMIT 200) sc;

  SELECT coalesce(jsonb_agg(k), '[]'::jsonb) INTO _zombie FROM (
    SELECT jsonb_build_object('order_item_id', i.id, 'item_name', i.item_name,
             'pos_status', i.status, 'kds_status', t.status, 'ticket_item_id', t.id) AS k
      FROM public.pos_order_items i
      JOIN public.pos_orders o ON o.id = i.order_id
      JOIN public.station_ticket_items t ON t.order_item_id = i.id AND t.remake_of_id IS NULL
     WHERE i.organization_id = _org
       AND (_branch IS NULL OR o.branch_id = _branch)
       AND public.neo_branch_in_scope(o.branch_id)
       AND (i.status IN ('cancelled','voided') OR o.status IN ('cancelled','voided'))
       AND t.status NOT IN ('cancelled','completed','served','collected')
     LIMIT 200) zz;

  RETURN jsonb_build_object(
    'ok', true, 'generated_at', now(),
    'missing_tickets', _missing, 'orphan_ticket_items', _orphan,
    'duplicate_sources', _dupes, 'unassigned_station', _unrouted,
    'status_conflicts', _conflict, 'cancelled_still_active', _zombie,
    'healthy', jsonb_array_length(_missing) = 0 AND jsonb_array_length(_orphan) = 0
               AND jsonb_array_length(_dupes) = 0 AND jsonb_array_length(_unrouted) = 0
               AND jsonb_array_length(_conflict) = 0 AND jsonb_array_length(_zombie) = 0);
END $function$


CREATE OR REPLACE FUNCTION public.neo_pos_send_to_kitchen(_order uuid, _attempt uuid DEFAULT gen_random_uuid())
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  _org uuid := public.current_org_id();
  _o public.pos_orders;
  _it record;
  _station uuid;
  _ticket uuid;
  _target int;
  _created int := 0;
  _reused int := 0;
  _tickets int := 0;
  _unassigned int := 0;
  _supervisor boolean;
BEGIN
  IF _org IS NULL THEN RAISE EXCEPTION 'no_organisation' USING ERRCODE = '42501'; END IF;
  IF _attempt IS NULL THEN RAISE EXCEPTION 'attempt_key_required' USING ERRCODE = '22023'; END IF;

  SELECT * INTO _o FROM public.pos_orders WHERE id = _order AND organization_id = _org;
  IF _o.id IS NULL THEN RAISE EXCEPTION 'order_not_found' USING ERRCODE = 'P0002'; END IF;
  IF NOT public.neo_branch_in_scope(_o.branch_id) THEN
    RAISE EXCEPTION 'branch_out_of_scope' USING ERRCODE = '42501';
  END IF;

  _supervisor := public.has_permission('restaurant','orders.manage')
                 OR public.has_permission('kitchen','queue.manage')
                 OR public.is_org_admin();

  IF NOT (_supervisor
          OR ((_o.waiter_id = auth.uid() OR _o.created_by = auth.uid())
              AND public.has_permission('pos','orders.create'))) THEN
    RAISE EXCEPTION 'insufficient_privilege' USING ERRCODE = '42501';
  END IF;

  IF _o.status IN ('held','cancelled','voided') THEN
    RAISE EXCEPTION 'order_not_sendable' USING ERRCODE = '22023';
  END IF;

  -- serialise concurrent sends of the same order
  PERFORM pg_advisory_xact_lock(hashtextextended(_order::text, 42));

  FOR _it IN
    SELECT oi.* FROM public.pos_order_items oi
     WHERE oi.order_id = _order
       AND oi.organization_id = _org
       AND oi.held = false
       AND coalesce(oi.status,'draft') NOT IN ('cancelled','voided')
     ORDER BY oi.created_at
  LOOP
    IF EXISTS (SELECT 1 FROM public.station_ticket_items sti
                WHERE sti.order_item_id = _it.id AND sti.remake_of_id IS NULL) THEN
      _reused := _reused + 1;
      CONTINUE;
    END IF;

    _station := nullif(public.neo_kitchen_route_order_item(_it.id)->>'station_id','')::uuid;
    IF _station IS NULL THEN _unassigned := _unassigned + 1; END IF;

    IF _station IS DISTINCT FROM _it.station_id THEN
      UPDATE public.pos_order_items SET station_id = _station WHERE id = _it.id;
    END IF;

    SELECT COALESCE(
      (SELECT pt.target_minutes FROM public.preparation_targets pt
        WHERE pt.organization_id = _org AND pt.active
          AND (pt.branch_id IS NULL OR pt.branch_id = _o.branch_id)
          AND ((pt.scope='menu-item' AND pt.menu_item_id = _it.menu_item_id)
            OR (pt.scope='station' AND pt.station_id = _station)
            OR (pt.scope='order-type' AND pt.order_type = _o.order_type)
            OR (pt.scope='branch'))
        ORDER BY CASE pt.scope WHEN 'menu-item' THEN 1 WHEN 'station' THEN 2 WHEN 'order-type' THEN 3 ELSE 4 END
        LIMIT 1),
      (SELECT mi.prep_minutes FROM public.menu_items mi WHERE mi.id = _it.menu_item_id),
      15) INTO _target;

    INSERT INTO public.station_tickets (
      organization_id, branch_id, department_id, order_id, station_id, ticket_number, course,
      priority, status, target_minutes, received_at, created_by, routing_note)
    VALUES (_org, _o.branch_id,
      (SELECT s.department_id FROM public.operational_stations s WHERE s.id = _station),
      _order, _station,
      'KT-' || upper(substr(replace(_order::text,'-',''),1,6)) || '-' ||
        upper(substr(md5(COALESCE(_station::text,'unassigned') || _it.course), 1, 4)),
      _it.course, COALESCE(_o.order_type,'dine-in'), 'new', _target, now(), auth.uid(),
      CASE WHEN _station IS NULL THEN 'unassigned-station' ELSE NULL END)
    ON CONFLICT (order_id, COALESCE(station_id, '00000000-0000-0000-0000-000000000000'::uuid), course)
      DO NOTHING;

    IF FOUND THEN _tickets := _tickets + 1; END IF;

    SELECT id INTO _ticket FROM public.station_tickets
      WHERE order_id = _order AND course = _it.course
        AND COALESCE(station_id,'00000000-0000-0000-0000-000000000000'::uuid)
            = COALESCE(_station,'00000000-0000-0000-0000-000000000000'::uuid);
    IF _ticket IS NULL THEN CONTINUE; END IF;

    BEGIN
      INSERT INTO public.station_ticket_items (organization_id, ticket_id, order_item_id, status)
      VALUES (_org, _ticket, _it.id, 'new');
      _created := _created + 1;
    EXCEPTION WHEN unique_violation THEN
      _reused := _reused + 1;
    END;

    UPDATE public.pos_order_items
       SET status = CASE WHEN status IN ('draft','new','held') THEN 'sent' ELSE status END,
           sent_at = COALESCE(sent_at, now())
     WHERE id = _it.id;
  END LOOP;

  IF _o.status IN ('draft','open','new','draft-sent') OR _o.status IS NULL THEN
    UPDATE public.pos_orders SET status = 'sent', sent_at = COALESCE(sent_at, now()) WHERE id = _order AND status NOT IN ('sent','accepted','in-preparation','partially-ready','ready','partially-served','served');
  END IF;

  RETURN jsonb_build_object(
    'ok', true, 'attempt', _attempt, 'order_id', _order,
    'tickets_created', _tickets, 'items_created', _created,
    'items_reused', _reused, 'unassigned_station', _unassigned);
END $function$


CREATE OR REPLACE FUNCTION public.pos_rollup_order_status()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE _total int; _ready int; _served int; _order public.pos_orders; _target text;
BEGIN
  SELECT * INTO _order FROM public.pos_orders WHERE id = NEW.order_id;
  IF _order.id IS NULL THEN RETURN NEW; END IF;
  SELECT count(*) FILTER (WHERE status NOT IN ('cancelled','voided','draft')),
         count(*) FILTER (WHERE status IN ('ready','served')),
         count(*) FILTER (WHERE status = 'served')
    INTO _total, _ready, _served
  FROM public.pos_order_items WHERE order_id = NEW.order_id;
  IF _total = 0 THEN RETURN NEW; END IF;
  _target := CASE
    WHEN _served = _total THEN 'served'
    WHEN _served > 0 THEN 'partially-served'
    WHEN _ready = _total THEN 'ready'
    WHEN _ready > 0 THEN 'partially-ready'
    ELSE NULL END;
  IF _target IS NOT NULL AND _target <> _order.status
     AND _order.status IN ('sent','accepted','in-preparation','partially-ready','ready','partially-served') THEN
    UPDATE public.pos_orders SET status = _target,
      served_at = CASE WHEN _target = 'served' THEN now() ELSE served_at END
    WHERE id = _order.id;
  END IF;
  RETURN NEW;
END; $function$

