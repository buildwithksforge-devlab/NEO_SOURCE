CREATE OR REPLACE FUNCTION public.neo_kitchen_reconcile_stations(_org uuid DEFAULT NULL::uuid, _branch uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  _caller_org uuid := public.current_org_id();
  _target uuid := COALESCE(_org, public.current_org_id());
  _t record; _p record; _target_ticket uuid; _state text; _rows int;
  _assigned int := 0; _split int := 0; _moved int := 0; _unresolved int := 0;
BEGIN
  IF NOT (public.has_permission('kitchen','queue.manage')
          OR public.has_permission('kitchen','all_stations')
          OR public.has_permission('kitchen','access')) THEN
    RAISE EXCEPTION 'Not permitted to reconcile kitchen stations';
  END IF;
  IF _target IS NULL THEN RAISE EXCEPTION 'No active organization'; END IF;
  IF _caller_org IS NOT NULL AND _target <> _caller_org THEN
    RAISE EXCEPTION 'Cross-organisation reconciliation is not permitted';
  END IF;

  FOR _t IN
    SELECT t.* FROM public.station_tickets t
    WHERE t.organization_id = _target
      AND (_branch IS NULL OR t.branch_id = _branch)
      AND EXISTS (
        SELECT 1 FROM public.station_ticket_items i
        JOIN public.pos_order_items oi ON oi.id = i.order_item_id
        WHERE i.ticket_id = t.id
          AND (t.station_id IS NULL OR oi.station_id IS DISTINCT FROM t.station_id)
      )
    ORDER BY t.created_at
  LOOP
    CREATE TEMP TABLE _reconcile_items AS
      SELECT i.id AS link_id,
             nullif(public.neo_kitchen_route_order_item(i.order_item_id)->>'station_id','')::uuid AS station_id
      FROM public.station_ticket_items i
      WHERE i.ticket_id = _t.id;

    _unresolved := _unresolved + (SELECT count(*) FROM _reconcile_items WHERE station_id IS NULL)::int;

    FOR _p IN
      SELECT station_id, count(*) AS items
      FROM _reconcile_items
      WHERE station_id IS NOT NULL
      GROUP BY station_id
      ORDER BY count(*) DESC, station_id::text
    LOOP
      _target_ticket := NULL;

      IF _t.station_id IS NULL AND NOT EXISTS (
           SELECT 1 FROM public.station_tickets k
           WHERE k.order_id = _t.order_id AND k.course = _t.course AND k.station_id = _p.station_id
         ) THEN
        UPDATE public.station_tickets SET
          station_id = _p.station_id,
          department_id = COALESCE(department_id,
            (SELECT s.department_id FROM public.operational_stations s WHERE s.id = _p.station_id)),
          routing_note = COALESCE(routing_note, '') ||
            CASE WHEN COALESCE(routing_note,'') = '' THEN '' ELSE ' | ' END ||
            'Station reconciled from resolved item routing',
          updated_at = now()
        WHERE id = _t.id;
        _target_ticket := _t.id;
        _assigned := _assigned + 1;
        _t.station_id := _p.station_id;
      ELSE
        SELECT k.id INTO _target_ticket FROM public.station_tickets k
        WHERE k.order_id = _t.order_id AND k.course = _t.course AND k.station_id = _p.station_id;

        IF _target_ticket IS NULL THEN
          INSERT INTO public.station_tickets (
            organization_id, branch_id, department_id, order_id, station_id, ticket_number, course,
            priority, priority_reason, status, target_minutes, delay_reason, received_at,
            accepted_at, started_at, ready_at, completed_at, cancelled_at, assigned_chef_id,
            created_by, routing_note, created_at)
          VALUES (
            _t.organization_id, _t.branch_id,
            (SELECT s.department_id FROM public.operational_stations s WHERE s.id = _p.station_id),
            _t.order_id, _p.station_id,
            _t.ticket_number || '-' || upper(substr(md5(_p.station_id::text), 1, 4)),
            _t.course, _t.priority, _t.priority_reason, _t.status, _t.target_minutes, _t.delay_reason,
            _t.received_at, _t.accepted_at, _t.started_at, _t.ready_at, _t.completed_at, _t.cancelled_at,
            _t.assigned_chef_id, _t.created_by,
            'Station partition of ' || _t.ticket_number || ' (reconciled item routing)', _t.created_at)
          RETURNING id INTO _target_ticket;
          _split := _split + 1;
        END IF;

        UPDATE public.station_ticket_items i SET ticket_id = _target_ticket
        WHERE i.ticket_id = _t.id
          AND i.id IN (SELECT link_id FROM _reconcile_items WHERE station_id = _p.station_id)
          AND NOT EXISTS (
            SELECT 1 FROM public.station_ticket_items d
            WHERE d.ticket_id = _target_ticket AND d.order_item_id = i.order_item_id);
        GET DIAGNOSTICS _rows = ROW_COUNT;
        _moved := _moved + _rows;
      END IF;

      SELECT CASE
        WHEN count(*) = 0 THEN NULL
        WHEN count(*) FILTER (WHERE status <> 'cancelled') = 0 THEN 'cancelled'
        WHEN count(*) FILTER (WHERE status = 'completed') = count(*) FILTER (WHERE status <> 'cancelled') THEN 'completed'
        WHEN count(*) FILTER (WHERE status IN ('served','completed')) = count(*) FILTER (WHERE status <> 'cancelled') THEN 'served'
        WHEN count(*) FILTER (WHERE status IN ('ready','collected','served','completed')) = count(*) FILTER (WHERE status <> 'cancelled') THEN 'ready'
        WHEN count(*) FILTER (WHERE status IN ('ready','collected','served','completed')) > 0 THEN 'partially-ready'
        WHEN count(*) FILTER (WHERE status IN ('preparing','remaking','remake-requested')) > 0 THEN 'preparing'
        WHEN count(*) FILTER (WHERE status IN ('accepted','cancel-pending')) > 0 THEN 'accepted'
        ELSE 'new'
      END INTO _state
      FROM public.station_ticket_items WHERE ticket_id = _target_ticket;

      IF _state IS NOT NULL THEN
        UPDATE public.station_tickets SET status = _state, updated_at = now()
        WHERE id = _target_ticket AND status IS DISTINCT FROM _state;
      END IF;
    END LOOP;

    SELECT CASE
      WHEN count(*) = 0 THEN NULL
      WHEN count(*) FILTER (WHERE status <> 'cancelled') = 0 THEN 'cancelled'
      WHEN count(*) FILTER (WHERE status = 'completed') = count(*) FILTER (WHERE status <> 'cancelled') THEN 'completed'
      WHEN count(*) FILTER (WHERE status IN ('served','completed')) = count(*) FILTER (WHERE status <> 'cancelled') THEN 'served'
      WHEN count(*) FILTER (WHERE status IN ('ready','collected','served','completed')) = count(*) FILTER (WHERE status <> 'cancelled') THEN 'ready'
      WHEN count(*) FILTER (WHERE status IN ('ready','collected','served','completed')) > 0 THEN 'partially-ready'
      WHEN count(*) FILTER (WHERE status IN ('preparing','remaking','remake-requested')) > 0 THEN 'preparing'
      WHEN count(*) FILTER (WHERE status IN ('accepted','cancel-pending')) > 0 THEN 'accepted'
      ELSE 'new'
    END INTO _state
    FROM public.station_ticket_items WHERE ticket_id = _t.id;

    IF _state IS NOT NULL THEN
      UPDATE public.station_tickets SET status = _state, updated_at = now()
      WHERE id = _t.id AND status IS DISTINCT FROM _state;
    END IF;

    DROP TABLE _reconcile_items;
  END LOOP;

  RETURN jsonb_build_object(
    'tickets_assigned', _assigned,
    'partitions_created', _split,
    'items_moved', _moved,
    'items_without_routing', _unresolved);
END $function$;

DROP FUNCTION IF EXISTS public.neo_kitchen_reconcile_stations_guard();