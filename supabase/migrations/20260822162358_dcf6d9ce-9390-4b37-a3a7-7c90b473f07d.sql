
CREATE TABLE IF NOT EXISTS public.kitchen_reconciliation_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  branch_id uuid,
  ran_by uuid,
  ran_at timestamptz NOT NULL DEFAULT now(),
  tickets_assigned integer NOT NULL DEFAULT 0,
  partitions_created integer NOT NULL DEFAULT 0,
  items_moved integer NOT NULL DEFAULT 0,
  items_without_routing integer NOT NULL DEFAULT 0,
  idempotent boolean NOT NULL DEFAULT true,
  duration_ms integer NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'succeeded',
  error text
);

GRANT SELECT ON public.kitchen_reconciliation_runs TO authenticated;
GRANT ALL ON public.kitchen_reconciliation_runs TO service_role;
ALTER TABLE public.kitchen_reconciliation_runs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "kitchen_recon_runs_read" ON public.kitchen_reconciliation_runs;
CREATE POLICY "kitchen_recon_runs_read" ON public.kitchen_reconciliation_runs
  FOR SELECT TO authenticated
  USING (organization_id = public.current_org_id());

CREATE TABLE IF NOT EXISTS public.kitchen_alert_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  branch_id uuid,
  alert_key text NOT NULL,
  kind text NOT NULL,
  suppressed boolean NOT NULL DEFAULT false,
  notification_id uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS kitchen_alert_log_org_created_idx
  ON public.kitchen_alert_log (organization_id, created_at DESC);

GRANT SELECT ON public.kitchen_alert_log TO authenticated;
GRANT ALL ON public.kitchen_alert_log TO service_role;
ALTER TABLE public.kitchen_alert_log ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "kitchen_alert_log_read" ON public.kitchen_alert_log;
CREATE POLICY "kitchen_alert_log_read" ON public.kitchen_alert_log
  FOR SELECT TO authenticated
  USING (organization_id = public.current_org_id());

-- Routing health: missing-routing rate, invariant violations, partition counts.
CREATE OR REPLACE FUNCTION public.neo_kitchen_routing_health(_branch uuid DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  _org uuid := public.current_org_id();
  _total int := 0; _missing int := 0;
  _violations jsonb := '[]'::jsonb;
  _partitioned int := 0; _partition_orders int := 0; _mixed int := 0; _null_station int := 0;
BEGIN
  IF _org IS NULL THEN RETURN jsonb_build_object('configured', false); END IF;

  SELECT count(*), count(*) FILTER (WHERE oi.station_id IS NULL)
    INTO _total, _missing
  FROM public.station_ticket_items i
  JOIN public.station_tickets t ON t.id = i.ticket_id
  LEFT JOIN public.pos_order_items oi ON oi.id = i.order_item_id
  WHERE t.organization_id = _org
    AND (_branch IS NULL OR t.branch_id = _branch)
    AND t.created_at > now() - interval '30 days';

  SELECT coalesce(jsonb_agg(x ORDER BY x->>'violation'), '[]'::jsonb) INTO _violations
  FROM (
    SELECT jsonb_build_object('violation', v.violation, 'count', count(*)) AS x
    FROM public.neo_kitchen_invariant_violations() v
    JOIN public.station_tickets t ON t.id = v.ticket_id
    WHERE t.organization_id = _org AND (_branch IS NULL OR t.branch_id = _branch)
    GROUP BY v.violation
  ) s;

  SELECT count(*), count(DISTINCT t.order_id) INTO _partitioned, _partition_orders
  FROM public.station_tickets t
  WHERE t.organization_id = _org
    AND (_branch IS NULL OR t.branch_id = _branch)
    AND t.order_id IN (
      SELECT order_id FROM public.station_tickets
      WHERE organization_id = _org AND order_id IS NOT NULL
      GROUP BY order_id HAVING count(*) > 1
    );

  SELECT count(*) FILTER (WHERE violation = 'ticket-station-mixed'),
         count(*) FILTER (WHERE violation = 'ticket-station-null')
    INTO _mixed, _null_station
  FROM public.neo_kitchen_invariant_violations() v
  JOIN public.station_tickets t ON t.id = v.ticket_id
  WHERE t.organization_id = _org AND (_branch IS NULL OR t.branch_id = _branch);

  RETURN jsonb_build_object(
    'configured', true,
    'window_days', 30,
    'items_total', _total,
    'items_missing_routing', _missing,
    'missing_routing_rate', CASE WHEN _total = 0 THEN 0 ELSE round((_missing::numeric / _total) * 100, 2) END,
    'violations', _violations,
    'mixed_station_tickets', coalesce(_mixed, 0),
    'unrouted_tickets', coalesce(_null_station, 0),
    'partitioned_tickets', coalesce(_partitioned, 0),
    'partitioned_orders', coalesce(_partition_orders, 0)
  );
END $$;

REVOKE ALL ON FUNCTION public.neo_kitchen_routing_health(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.neo_kitchen_routing_health(uuid) TO authenticated;

-- Logged, idempotency-checked reconciliation run.
CREATE OR REPLACE FUNCTION public.neo_kitchen_reconcile_stations_run(_branch uuid DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  _org uuid := public.current_org_id();
  _t0 timestamptz := clock_timestamp();
  _res jsonb;
  _run uuid;
BEGIN
  IF _org IS NULL THEN RAISE EXCEPTION 'No workspace in scope'; END IF;
  _res := public.neo_kitchen_reconcile_stations(_org, _branch);

  INSERT INTO public.kitchen_reconciliation_runs (
    organization_id, branch_id, ran_by, tickets_assigned, partitions_created,
    items_moved, items_without_routing, idempotent, duration_ms, status)
  VALUES (
    _org, _branch, auth.uid(),
    coalesce((_res->>'tickets_assigned')::int, 0),
    coalesce((_res->>'partitions_created')::int, 0),
    coalesce((_res->>'items_moved')::int, 0),
    coalesce((_res->>'items_without_routing')::int, 0),
    coalesce((_res->>'tickets_assigned')::int, 0) = 0
      AND coalesce((_res->>'partitions_created')::int, 0) = 0
      AND coalesce((_res->>'items_moved')::int, 0) = 0,
    (extract(milliseconds from clock_timestamp() - _t0))::int,
    'succeeded')
  RETURNING id INTO _run;

  RETURN _res || jsonb_build_object('run_id', _run);
END $$;

REVOKE ALL ON FUNCTION public.neo_kitchen_reconcile_stations_run(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.neo_kitchen_reconcile_stations_run(uuid) TO authenticated;

-- Reconciliation status read model.
CREATE OR REPLACE FUNCTION public.neo_kitchen_reconciliation_status(_branch uuid DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  _org uuid := public.current_org_id();
  _last jsonb; _runs jsonb; _alerts jsonb; _suppressed int := 0; _delivered int := 0;
BEGIN
  IF _org IS NULL THEN RETURN jsonb_build_object('configured', false); END IF;

  SELECT to_jsonb(r) INTO _last
  FROM (
    SELECT id, ran_at, branch_id, tickets_assigned, partitions_created, items_moved,
           items_without_routing, idempotent, duration_ms, status, error
    FROM public.kitchen_reconciliation_runs
    WHERE organization_id = _org AND (_branch IS NULL OR branch_id IS NOT DISTINCT FROM _branch)
      AND status = 'succeeded'
    ORDER BY ran_at DESC LIMIT 1
  ) r;

  SELECT coalesce(jsonb_agg(to_jsonb(r) ORDER BY r.ran_at DESC), '[]'::jsonb) INTO _runs
  FROM (
    SELECT id, ran_at, tickets_assigned, partitions_created, items_moved,
           items_without_routing, idempotent, duration_ms, status, error
    FROM public.kitchen_reconciliation_runs
    WHERE organization_id = _org AND (_branch IS NULL OR branch_id IS NOT DISTINCT FROM _branch)
    ORDER BY ran_at DESC LIMIT 20
  ) r;

  SELECT count(*) FILTER (WHERE suppressed), count(*) FILTER (WHERE NOT suppressed)
    INTO _suppressed, _delivered
  FROM public.kitchen_alert_log
  WHERE organization_id = _org AND (_branch IS NULL OR branch_id IS NOT DISTINCT FROM _branch)
    AND created_at > now() - interval '7 days';

  SELECT coalesce(jsonb_agg(x ORDER BY x->>'kind'), '[]'::jsonb) INTO _alerts
  FROM (
    SELECT jsonb_build_object('kind', kind,
             'delivered', count(*) FILTER (WHERE NOT suppressed),
             'suppressed', count(*) FILTER (WHERE suppressed)) AS x
    FROM public.kitchen_alert_log
    WHERE organization_id = _org AND (_branch IS NULL OR branch_id IS NOT DISTINCT FROM _branch)
      AND created_at > now() - interval '7 days'
    GROUP BY kind
  ) s;

  RETURN jsonb_build_object(
    'configured', true,
    'last_successful_run', _last,
    'runs', _runs,
    'alerts_by_kind', _alerts,
    'alerts_delivered_7d', coalesce(_delivered, 0),
    'alerts_suppressed_7d', coalesce(_suppressed, 0)
  );
END $$;

REVOKE ALL ON FUNCTION public.neo_kitchen_reconciliation_status(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.neo_kitchen_reconciliation_status(uuid) TO authenticated;

-- Deduplicated kitchen alert emitter.
CREATE OR REPLACE FUNCTION public.neo_kitchen_alert(
  _org uuid, _branch uuid, _user uuid, _kind text, _title text, _body text,
  _link text, _priority text, _alert_key text)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE _nid uuid;
BEGIN
  IF _org IS NULL THEN RETURN NULL; END IF;
  _nid := public.neo_notify(_org, _user, _branch, 'operational-alert', _title, _body, _link,
                            coalesce(_priority, 'normal'), false, 'kitchen', NULL, _kind, _alert_key);
  INSERT INTO public.kitchen_alert_log (organization_id, branch_id, alert_key, kind, suppressed, notification_id)
  VALUES (_org, _branch, _alert_key, _kind, _nid IS NULL, _nid);
  RETURN _nid;
END $$;

REVOKE ALL ON FUNCTION public.neo_kitchen_alert(uuid, uuid, uuid, text, text, text, text, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.neo_kitchen_alert(uuid, uuid, uuid, text, text, text, text, text, text) TO authenticated;

-- Station workload + routing regression alerts (deduped per hour).
CREATE OR REPLACE FUNCTION public.neo_kitchen_raise_alerts(_branch uuid DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  _org uuid := public.current_org_id();
  _health jsonb;
  _hour text := to_char(date_trunc('hour', now()), 'YYYYMMDDHH24');
  _raised int := 0; _suppressed int := 0;
  _r record; _nid uuid;
BEGIN
  IF _org IS NULL THEN RETURN jsonb_build_object('configured', false); END IF;

  FOR _r IN
    SELECT t.station_id, coalesce(s.name, 'Unassigned station') AS station_name,
           t.branch_id, count(*) AS open_tickets
    FROM public.station_tickets t
    LEFT JOIN public.stations s ON s.id = t.station_id
    WHERE t.organization_id = _org
      AND (_branch IS NULL OR t.branch_id = _branch)
      AND t.status NOT IN ('completed', 'cancelled', 'served')
    GROUP BY t.station_id, s.name, t.branch_id
    HAVING count(*) >= 8
  LOOP
    _nid := public.neo_kitchen_alert(_org, _r.branch_id, NULL, 'station-workload',
      _r.station_name || ' workload is high',
      _r.open_tickets || ' open production tickets are waiting at ' || _r.station_name || '.',
      '/kitchen/queue', 'high',
      'kitchen-workload:' || coalesce(_r.station_id::text, 'none') || ':' || _hour);
    IF _nid IS NULL THEN _suppressed := _suppressed + 1; ELSE _raised := _raised + 1; END IF;
  END LOOP;

  _health := public.neo_kitchen_routing_health(_branch);

  IF coalesce((_health->>'items_missing_routing')::int, 0) > 0 THEN
    _nid := public.neo_kitchen_alert(_org, _branch, NULL, 'missing-routing',
      'Menu items are missing station routing',
      (_health->>'items_missing_routing') || ' production item(s) (' || (_health->>'missing_routing_rate') ||
      '% of the last 30 days) have no production station configured.',
      '/kitchen/operations', 'high',
      'kitchen-missing-routing:' || coalesce(_branch::text, 'all') || ':' || _hour);
    IF _nid IS NULL THEN _suppressed := _suppressed + 1; ELSE _raised := _raised + 1; END IF;
  END IF;

  IF coalesce((_health->>'mixed_station_tickets')::int, 0) + coalesce((_health->>'unrouted_tickets')::int, 0) > 0 THEN
    _nid := public.neo_kitchen_alert(_org, _branch, NULL, 'invariant-violation',
      'Kitchen ticket routing invariants are violated',
      coalesce(_health->>'mixed_station_tickets', '0') || ' mixed-station and ' ||
      coalesce(_health->>'unrouted_tickets', '0') || ' unrouted ticket(s) need reconciliation.',
      '/kitchen/reconciliation', 'high',
      'kitchen-invariant:' || coalesce(_branch::text, 'all') || ':' || _hour);
    IF _nid IS NULL THEN _suppressed := _suppressed + 1; ELSE _raised := _raised + 1; END IF;
  END IF;

  RETURN jsonb_build_object('configured', true, 'raised', _raised, 'suppressed', _suppressed);
END $$;

REVOKE ALL ON FUNCTION public.neo_kitchen_raise_alerts(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.neo_kitchen_raise_alerts(uuid) TO authenticated;

-- Bulk actions notify the actor about rejected tickets.
CREATE OR REPLACE FUNCTION public.neo_kitchen_bulk_ticket_transition(_tickets uuid[], _to text, _reason text DEFAULT NULL::text)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path TO 'public'
AS $$
DECLARE
  _id uuid; _ok int := 0; _res jsonb; _fail jsonb := '[]'::jsonb;
  _org uuid; _branch uuid; _nid uuid;
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

  IF jsonb_array_length(_fail) > 0 THEN
    SELECT organization_id, branch_id INTO _org, _branch
    FROM public.station_tickets WHERE id = _tickets[1];
    IF _org IS NOT NULL THEN
      _nid := public.neo_kitchen_alert(_org, _branch, auth.uid(), 'bulk-action-rejected',
        'Bulk kitchen action partly rejected',
        jsonb_array_length(_fail) || ' of ' || array_length(_tickets, 1) ||
        ' ticket(s) could not move to ' || _to || '. First reason: ' || coalesce(_fail->0->>'error', 'unknown'),
        '/kitchen/queue', 'high',
        'kitchen-bulk-reject:' || coalesce(auth.uid()::text, 'system') || ':' ||
        md5(_to || coalesce(_fail::text, '')) || ':' || to_char(date_trunc('minute', now()), 'YYYYMMDDHH24MI'));
    END IF;
  END IF;

  RETURN jsonb_build_object('succeeded', _ok, 'failed', _fail);
END $$;

ALTER PUBLICATION supabase_realtime ADD TABLE public.kitchen_alert_log;
