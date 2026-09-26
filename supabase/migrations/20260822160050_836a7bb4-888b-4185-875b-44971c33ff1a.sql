
-- Bulk ticket transition: each ticket in its own subtransaction.
CREATE OR REPLACE FUNCTION public.neo_kitchen_bulk_ticket_transition(_tickets uuid[], _to text, _reason text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  _id uuid; _ok int := 0; _res jsonb; _fail jsonb := '[]'::jsonb;
BEGIN
  IF _tickets IS NULL OR array_length(_tickets, 1) IS NULL THEN
    RETURN jsonb_build_object('succeeded', 0, 'failed', _fail);
  END IF;
  FOREACH _id IN ARRAY _tickets LOOP
    BEGIN
      _res := public.neo_kitchen_ticket_transition(_id, _to, _reason);
      _ok := _ok + 1;
    EXCEPTION WHEN OTHERS THEN
      _fail := _fail || jsonb_build_object('ticket_id', _id, 'error', SQLERRM);
    END;
  END LOOP;
  RETURN jsonb_build_object('succeeded', _ok, 'failed', _fail);
END $$;

CREATE OR REPLACE FUNCTION public.neo_kitchen_bulk_item_transition(_items uuid[], _to text, _reason text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  _id uuid; _ok int := 0; _fail jsonb := '[]'::jsonb;
BEGIN
  IF _items IS NULL OR array_length(_items, 1) IS NULL THEN
    RETURN jsonb_build_object('succeeded', 0, 'failed', _fail);
  END IF;
  FOREACH _id IN ARRAY _items LOOP
    BEGIN
      PERFORM public.neo_kitchen_item_transition(_id, _to, _reason);
      _ok := _ok + 1;
    EXCEPTION WHEN OTHERS THEN
      _fail := _fail || jsonb_build_object('item_id', _id, 'error', SQLERRM);
    END;
  END LOOP;
  RETURN jsonb_build_object('succeeded', _ok, 'failed', _fail);
END $$;

-- Station workload metrics, derived from the same canonical tables.
CREATE OR REPLACE FUNCTION public.neo_kitchen_ops_metrics(_branch uuid DEFAULT NULL)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
  WITH scoped AS (
    SELECT t.*, COALESCE(s.name, 'Station not configured') AS station_name
    FROM public.station_tickets t
    LEFT JOIN public.operational_stations s ON s.id = t.station_id
    WHERE (_branch IS NULL OR t.branch_id = _branch)
      AND t.created_at > now() - interval '7 days'
  ),
  open_t AS (SELECT * FROM scoped WHERE status NOT IN ('completed','cancelled'))
  SELECT jsonb_build_object(
    'open_tickets', (SELECT count(*) FROM open_t),
    'delayed_tickets', (
      SELECT count(*) FROM open_t
      WHERE COALESCE(received_at, created_at) < now() - (COALESCE(target_minutes, 15) || ' minutes')::interval
    ),
    'avg_prep_minutes', (
      SELECT round(avg(EXTRACT(epoch FROM (ready_at - COALESCE(received_at, created_at))) / 60.0)::numeric, 1)
      FROM scoped WHERE ready_at IS NOT NULL
    ),
    'backlog_by_status', COALESCE((
      SELECT jsonb_agg(x ORDER BY x->>'status')
      FROM (SELECT jsonb_build_object('status', status, 'count', count(*)) x
            FROM open_t GROUP BY status) q
    ), '[]'::jsonb),
    'stations', COALESCE((
      SELECT jsonb_agg(y ORDER BY y->>'station_name')
      FROM (
        SELECT jsonb_build_object(
          'station_id', station_id,
          'station_name', station_name,
          'open_tickets', count(*) FILTER (WHERE status NOT IN ('completed','cancelled')),
          'delayed_tickets', count(*) FILTER (
            WHERE status NOT IN ('completed','cancelled')
              AND COALESCE(received_at, created_at) < now() - (COALESCE(target_minutes, 15) || ' minutes')::interval),
          'oldest_minutes', COALESCE(round(max(EXTRACT(epoch FROM (now() - COALESCE(received_at, created_at))) / 60.0)
             FILTER (WHERE status NOT IN ('completed','cancelled'))::numeric, 0), 0),
          'avg_prep_minutes', round(avg(EXTRACT(epoch FROM (ready_at - COALESCE(received_at, created_at))) / 60.0)
             FILTER (WHERE ready_at IS NOT NULL)::numeric, 1),
          'completed_24h', count(*) FILTER (WHERE status IN ('completed','served') AND updated_at > now() - interval '24 hours')
        ) y
        FROM scoped GROUP BY station_id, station_name
      ) q2
    ), '[]'::jsonb)
  );
$$;

-- Ticket audit trail (items + ticket-level status changes).
CREATE OR REPLACE FUNCTION public.neo_kitchen_ticket_audit(_ticket uuid)
RETURNS TABLE (
  id uuid,
  created_at timestamptz,
  scope text,
  item_name text,
  from_status text,
  to_status text,
  reason text,
  actor_name text
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
  SELECT h.id,
         h.created_at,
         CASE WHEN h.ticket_item_id IS NULL THEN 'ticket' ELSE 'item' END,
         oi.item_name,
         h.from_status,
         h.to_status,
         h.reason,
         p.full_name
  FROM public.station_ticket_status_history h
  LEFT JOIN public.station_ticket_items ti ON ti.id = h.ticket_item_id
  LEFT JOIN public.pos_order_items oi ON oi.id = ti.order_item_id
  LEFT JOIN public.profiles p ON p.id = h.changed_by
  WHERE h.ticket_id = _ticket
  ORDER BY h.created_at DESC
  LIMIT 200;
$$;

REVOKE EXECUTE ON FUNCTION public.neo_kitchen_bulk_ticket_transition(uuid[], text, text) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.neo_kitchen_bulk_item_transition(uuid[], text, text) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.neo_kitchen_ops_metrics(uuid) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.neo_kitchen_ticket_audit(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.neo_kitchen_bulk_ticket_transition(uuid[], text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.neo_kitchen_bulk_item_transition(uuid[], text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.neo_kitchen_ops_metrics(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.neo_kitchen_ticket_audit(uuid) TO authenticated;

ALTER PUBLICATION supabase_realtime ADD TABLE public.station_ticket_status_history;
