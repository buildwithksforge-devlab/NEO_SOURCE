CREATE OR REPLACE FUNCTION public.neo_station_is_usable(_org uuid, _branch uuid, _station uuid)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.operational_stations s
    WHERE s.id = _station
      AND s.organization_id = _org
      AND coalesce(s.active, true)
      AND (s.branch_id IS NULL OR _branch IS NULL OR s.branch_id = _branch)
  );
$$;

CREATE OR REPLACE FUNCTION public.neo_kitchen_resolve_station(
  _org uuid, _branch uuid, _menu_item uuid, _category uuid, _order_type text, _persisted uuid
) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $$
DECLARE _station uuid;
BEGIN
  SELECT rr.station_id INTO _station
  FROM public.station_routing_rules rr
  WHERE rr.organization_id = _org
    AND coalesce(rr.active, true)
    AND rr.menu_item_id IS NOT NULL AND rr.menu_item_id = _menu_item
    AND (rr.branch_id IS NULL OR _branch IS NULL OR rr.branch_id = _branch)
    AND (rr.order_type IS NULL OR _order_type IS NULL OR rr.order_type = _order_type)
    AND public.neo_station_is_usable(_org, _branch, rr.station_id)
  ORDER BY rr.priority NULLS LAST, rr.created_at
  LIMIT 1;
  IF _station IS NOT NULL THEN
    RETURN jsonb_build_object('station_id', _station, 'source', 'rule-item', 'missing', false);
  END IF;

  IF _category IS NOT NULL THEN
    SELECT rr.station_id INTO _station
    FROM public.station_routing_rules rr
    WHERE rr.organization_id = _org
      AND coalesce(rr.active, true)
      AND rr.menu_item_id IS NULL
      AND rr.category_id IS NOT NULL AND rr.category_id = _category
      AND (rr.branch_id IS NULL OR _branch IS NULL OR rr.branch_id = _branch)
      AND (rr.order_type IS NULL OR _order_type IS NULL OR rr.order_type = _order_type)
      AND public.neo_station_is_usable(_org, _branch, rr.station_id)
    ORDER BY rr.priority NULLS LAST, rr.created_at
    LIMIT 1;
    IF _station IS NOT NULL THEN
      RETURN jsonb_build_object('station_id', _station, 'source', 'rule-category', 'missing', false);
    END IF;
  END IF;

  IF _persisted IS NOT NULL AND public.neo_station_is_usable(_org, _branch, _persisted) THEN
    RETURN jsonb_build_object('station_id', _persisted, 'source', 'order-item', 'missing', false);
  END IF;

  SELECT mi.station_id INTO _station FROM public.menu_items mi WHERE mi.id = _menu_item;
  IF _station IS NOT NULL AND public.neo_station_is_usable(_org, _branch, _station) THEN
    RETURN jsonb_build_object('station_id', _station, 'source', 'menu-item', 'missing', false);
  END IF;

  IF _category IS NOT NULL THEN
    SELECT mc.station_id INTO _station FROM public.menu_categories mc WHERE mc.id = _category;
    IF _station IS NOT NULL AND public.neo_station_is_usable(_org, _branch, _station) THEN
      RETURN jsonb_build_object('station_id', _station, 'source', 'menu-category', 'missing', false);
    END IF;
  END IF;

  RETURN jsonb_build_object('station_id', NULL, 'source', 'missing-routing', 'missing', true);
END $$;

CREATE OR REPLACE FUNCTION public.neo_kitchen_route_order_item(_order_item uuid)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $$
DECLARE _r record;
BEGIN
  SELECT oi.organization_id AS org, o.branch_id AS branch, oi.menu_item_id AS menu_item,
         mi.category_id AS category, o.order_type AS order_type, oi.station_id AS persisted
    INTO _r
  FROM public.pos_order_items oi
  JOIN public.pos_orders o ON o.id = oi.order_id
  LEFT JOIN public.menu_items mi ON mi.id = oi.menu_item_id
  WHERE oi.id = _order_item;

  IF _r IS NULL THEN
    RETURN jsonb_build_object('station_id', NULL, 'source', 'missing-order-item', 'missing', true);
  END IF;

  RETURN public.neo_kitchen_resolve_station(_r.org, _r.branch, _r.menu_item, _r.category, _r.order_type, _r.persisted);
END $$;

CREATE OR REPLACE FUNCTION public.kitchen_resolve_station(_org uuid, _branch uuid, _order_item_id uuid)
RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $$
  SELECT nullif(public.neo_kitchen_route_order_item(_order_item_id)->>'station_id', '')::uuid;
$$;

CREATE OR REPLACE FUNCTION public.neo_resolve_item_station(_org uuid, _branch uuid, _menu_item uuid, _order_type text)
RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $$
  SELECT nullif(
    public.neo_kitchen_resolve_station(
      _org, _branch, _menu_item,
      (SELECT mi.category_id FROM public.menu_items mi WHERE mi.id = _menu_item),
      _order_type, NULL
    )->>'station_id', '')::uuid;
$$;

CREATE OR REPLACE FUNCTION public.neo_kitchen_reconcile_stations(_org uuid DEFAULT NULL, _branch uuid DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $$
DECLARE
  _caller_org uuid := public.current_org_id();
  _target uuid := COALESCE(_org, public.current_org_id());
  _t record; _p record; _target_ticket uuid; _state text; _rows int;
  _assigned int := 0; _split int := 0; _moved int := 0; _unresolved int := 0;
BEGIN
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
END $$;

DROP FUNCTION IF EXISTS public.neo_kitchen_invariant_violations();

CREATE FUNCTION public.neo_kitchen_invariant_violations()
RETURNS TABLE(
  ticket_id uuid, ticket_number text, violation text,
  recorded_status text, derived_status text, item_statuses jsonb,
  ticket_station uuid, item_stations jsonb)
LANGUAGE sql STABLE SET search_path TO 'public'
AS $$
  WITH agg AS (
    SELECT t.id, t.ticket_number, t.status AS recorded, t.station_id,
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
      jsonb_agg(DISTINCT i.status) FILTER (WHERE i.id IS NOT NULL) AS statuses,
      jsonb_agg(DISTINCT oi.station_id) FILTER (WHERE i.id IS NOT NULL) AS stations,
      count(DISTINCT oi.station_id) AS distinct_stations,
      count(*) FILTER (WHERE i.id IS NOT NULL AND oi.station_id IS NULL) AS null_item_stations,
      count(*) FILTER (WHERE i.id IS NOT NULL AND oi.station_id IS DISTINCT FROM t.station_id) AS mismatched
    FROM public.station_tickets t
    LEFT JOIN public.station_ticket_items i ON i.ticket_id = t.id
    LEFT JOIN public.pos_order_items oi ON oi.id = i.order_item_id
    GROUP BY t.id, t.ticket_number, t.status, t.station_id
  ), flagged AS (
    SELECT id, ticket_number, recorded, derived, statuses, station_id, stations,
      CASE
        WHEN recorded IS DISTINCT FROM derived THEN 'status-aggregation'
        WHEN station_id IS NULL THEN 'ticket-station-null'
        WHEN distinct_stations > 1 THEN 'ticket-station-mixed'
        WHEN null_item_stations > 0 THEN 'item-station-null'
        WHEN mismatched > 0 THEN 'ticket-item-station-mismatch'
      END AS violation
    FROM agg
  )
  SELECT id, ticket_number, violation, recorded, derived, statuses, station_id, stations
  FROM flagged WHERE violation IS NOT NULL;
$$;

REVOKE ALL ON FUNCTION public.neo_station_is_usable(uuid, uuid, uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.neo_kitchen_resolve_station(uuid, uuid, uuid, uuid, text, uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.neo_kitchen_route_order_item(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.neo_kitchen_reconcile_stations(uuid, uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.neo_kitchen_invariant_violations() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.kitchen_resolve_station(uuid, uuid, uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.neo_resolve_item_station(uuid, uuid, uuid, text) FROM PUBLIC, anon;

GRANT EXECUTE ON FUNCTION public.neo_station_is_usable(uuid, uuid, uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.neo_kitchen_resolve_station(uuid, uuid, uuid, uuid, text, uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.neo_kitchen_route_order_item(uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.neo_kitchen_reconcile_stations(uuid, uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.neo_kitchen_invariant_violations() TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.kitchen_resolve_station(uuid, uuid, uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.neo_resolve_item_station(uuid, uuid, uuid, text) TO authenticated, service_role;

DO $$
DECLARE _o uuid;
BEGIN
  FOR _o IN
    SELECT DISTINCT t.organization_id FROM public.station_tickets t
    JOIN public.station_ticket_items i ON i.ticket_id = t.id
    JOIN public.pos_order_items oi ON oi.id = i.order_item_id
    WHERE t.station_id IS NULL OR oi.station_id IS DISTINCT FROM t.station_id
  LOOP
    PERFORM public.neo_kitchen_reconcile_stations(_o, NULL);
  END LOOP;
END $$;