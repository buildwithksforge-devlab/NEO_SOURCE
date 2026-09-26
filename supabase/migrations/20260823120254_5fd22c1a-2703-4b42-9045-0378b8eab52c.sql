
-- 1. Authoritative POS item -> KDS contract -------------------------------
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

  IF _o.status IN ('draft','held','cancelled','voided') THEN
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

  IF _o.status IN ('open','new','draft-sent') OR _o.status IS NULL THEN
    UPDATE public.pos_orders SET status = 'sent' WHERE id = _order AND status NOT IN ('sent','accepted','in-preparation','partially-ready','ready','partially-served','served');
  END IF;

  RETURN jsonb_build_object(
    'ok', true, 'attempt', _attempt, 'order_id', _order,
    'tickets_created', _tickets, 'items_created', _created,
    'items_reused', _reused, 'unassigned_station', _unassigned);
END $function$;

REVOKE ALL ON FUNCTION public.neo_pos_send_to_kitchen(uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.neo_pos_send_to_kitchen(uuid, uuid) TO authenticated;

-- 2. Legacy path now delegates to the single contract ---------------------
CREATE OR REPLACE FUNCTION public.kitchen_route_order(_order_id uuid)
RETURNS jsonb
LANGUAGE sql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  SELECT public.neo_pos_send_to_kitchen(_order_id, gen_random_uuid());
$function$;

REVOKE ALL ON FUNCTION public.kitchen_route_order(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.kitchen_route_order(uuid) TO authenticated;

-- 3. Reconciliation monitor: add status drift + cancelled-still-active ----
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
END $function$;

REVOKE ALL ON FUNCTION public.neo_pos_kds_reconciliation(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.neo_pos_kds_reconciliation(uuid) TO authenticated;
