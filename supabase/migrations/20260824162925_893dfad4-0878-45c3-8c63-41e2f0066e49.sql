-- 1. Bar permission catalogue -------------------------------------------------
INSERT INTO public.permissions (module, feature, action, label)
SELECT 'bar', f.feature, a.action,
       initcap(a.action) || ' · Bar ' || f.label
  FROM (VALUES
      ('overview','Dashboard'),
      ('queue','Queue'),
      ('orders','Orders & Bills'),
      ('pos','Point of Sale'),
      ('menu','Menu'),
      ('stock','Stock'),
      ('requisitions','Requisitions'),
      ('wastage','Wastage'),
      ('approvals','Approvals'),
      ('reports','Reports'),
      ('tasks','Tasks')
  ) AS f(feature,label)
  CROSS JOIN (VALUES ('view'),('create'),('edit'),('approve'),('reject'),('export'),('print'),('void')) AS a(action)
 WHERE NOT EXISTS (
   SELECT 1 FROM public.permissions p
    WHERE p.module = 'bar' AND p.feature = f.feature AND p.action = a.action);

-- 2. Role feature templates ---------------------------------------------------
DELETE FROM public.role_feature_templates WHERE role_key IN ('bar-manager','bar-attendant');

INSERT INTO public.role_feature_templates (role_key, module, feature, action)
VALUES
  -- Bar Manager: full department authority
  ('bar-manager','bar','overview','view'),
  ('bar-manager','bar','overview','export'),
  ('bar-manager','bar','queue','view'),
  ('bar-manager','bar','queue','edit'),
  ('bar-manager','bar','queue','create'),
  ('bar-manager','bar','orders','view'),
  ('bar-manager','bar','orders','create'),
  ('bar-manager','bar','orders','edit'),
  ('bar-manager','bar','orders','void'),
  ('bar-manager','bar','orders','print'),
  ('bar-manager','bar','pos','view'),
  ('bar-manager','bar','pos','create'),
  ('bar-manager','bar','pos','edit'),
  ('bar-manager','bar','menu','view'),
  ('bar-manager','bar','menu','edit'),
  ('bar-manager','bar','stock','view'),
  ('bar-manager','bar','stock','create'),
  ('bar-manager','bar','stock','edit'),
  ('bar-manager','bar','requisitions','view'),
  ('bar-manager','bar','requisitions','create'),
  ('bar-manager','bar','requisitions','edit'),
  ('bar-manager','bar','wastage','view'),
  ('bar-manager','bar','wastage','create'),
  ('bar-manager','bar','wastage','approve'),
  ('bar-manager','bar','wastage','reject'),
  ('bar-manager','bar','approvals','view'),
  ('bar-manager','bar','approvals','approve'),
  ('bar-manager','bar','approvals','reject'),
  ('bar-manager','bar','reports','view'),
  ('bar-manager','bar','reports','export'),
  ('bar-manager','bar','tasks','view'),
  ('bar-manager','bar','tasks','create'),
  ('bar-manager','bar','tasks','edit'),
  ('bar-manager','stores','overview','view'),
  ('bar-manager','ai','insights','view'),
  -- Bar Attendant: own work only
  ('bar-attendant','bar','overview','view'),
  ('bar-attendant','bar','queue','view'),
  ('bar-attendant','bar','queue','edit'),
  ('bar-attendant','bar','orders','view'),
  ('bar-attendant','bar','orders','create'),
  ('bar-attendant','bar','orders','edit'),
  ('bar-attendant','bar','pos','view'),
  ('bar-attendant','bar','pos','create'),
  ('bar-attendant','bar','pos','edit'),
  ('bar-attendant','bar','menu','view'),
  ('bar-attendant','bar','stock','view'),
  ('bar-attendant','bar','requisitions','view'),
  ('bar-attendant','bar','requisitions','create'),
  ('bar-attendant','bar','wastage','view'),
  ('bar-attendant','bar','wastage','create'),
  ('bar-attendant','bar','tasks','view'),
  ('bar-attendant','bar','tasks','edit');

-- 3. Bar stations belong to the Bar department (coffee stays with F&B) --------
UPDATE public.operational_stations s
   SET department_id = d.id, updated_at = now()
  FROM public.departments d
 WHERE d.organization_id = s.organization_id
   AND (d.branch_id = s.branch_id OR d.branch_id IS NULL)
   AND upper(COALESCE(d.code, '')) = 'BAR'
   AND s.station_type = 'beverage'
   AND (s.code ILIKE '%bar%' OR s.name ILIKE '%bar%' OR s.code ILIKE '%beverage%' OR s.name ILIKE '%beverage%')
   AND s.code NOT ILIKE '%coffee%'
   AND s.name NOT ILIKE '%coffee%'
   AND COALESCE(s.department_id, '00000000-0000-0000-0000-000000000000'::uuid) <> d.id;

-- 4. Bar service routines ----------------------------------------------------
CREATE OR REPLACE FUNCTION public.neo_bar_station_ids(_branch uuid DEFAULT NULL)
RETURNS SETOF uuid
LANGUAGE sql
STABLE
SET search_path TO 'public'
AS $$
  SELECT s.id
    FROM public.operational_stations s
    LEFT JOIN public.departments d ON d.id = s.department_id
   WHERE s.station_type = 'beverage'
     AND (_branch IS NULL OR s.branch_id = _branch)
     AND (upper(COALESCE(d.code, '')) = 'BAR'
          OR s.code ILIKE '%bar%' OR s.name ILIKE '%bar%'
          OR s.code ILIKE '%beverage%' OR s.name ILIKE '%beverage%')
     AND s.code NOT ILIKE '%coffee%'
     AND s.name NOT ILIKE '%coffee%';
$$;

CREATE OR REPLACE FUNCTION public.neo_bar_queue(
  _branch uuid DEFAULT NULL,
  _view text DEFAULT 'live',
  _scope text DEFAULT 'all'
)
RETURNS TABLE(
  ticket_id uuid, ticket_number text, status text, priority text,
  branch_id uuid, station_id uuid, station_name text,
  order_id uuid, order_number text, order_type text, source text,
  table_code text, guest_name text, waiter_id uuid, waiter_name text,
  assigned_to uuid, assigned_name text, is_mine boolean,
  target_minutes integer, received_at timestamptz, accepted_at timestamptz,
  ready_at timestamptz, age_minutes integer, is_delayed boolean, items jsonb
)
LANGUAGE sql
STABLE
SET search_path TO 'public'
AS $$
  SELECT
    t.id, t.ticket_number, t.status, COALESCE(t.priority,'normal'),
    t.branch_id, t.station_id, s.name,
    t.order_id, o.order_number, o.order_type,
    CASE
      WHEN o.order_type ILIKE '%room%' THEN 'Room Service'
      WHEN o.order_type ILIKE '%event%' THEN 'Event'
      WHEN o.order_type ILIKE '%delivery%' THEN 'Delivery'
      WHEN o.waiter_id IS NOT NULL AND o.waiter_id <> COALESCE(t.assigned_chef_id, '00000000-0000-0000-0000-000000000000'::uuid)
        THEN 'Restaurant / Waiter'
      ELSE 'Direct Bar POS'
    END,
    rt.code, o.guest_name, o.waiter_id, wp.full_name,
    t.assigned_chef_id, ap.full_name, (t.assigned_chef_id = auth.uid()),
    COALESCE(t.target_minutes, 10),
    COALESCE(t.received_at, t.created_at), t.accepted_at, t.ready_at,
    GREATEST(0, (EXTRACT(EPOCH FROM (now() - COALESCE(t.received_at, t.created_at))) / 60)::int),
    (EXTRACT(EPOCH FROM (now() - COALESCE(t.received_at, t.created_at))) / 60) > COALESCE(t.target_minutes, 10)
      AND t.status NOT IN ('ready','served','completed','cancelled'),
    COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
               'ticket_item_id', i.id,
               'status', i.status,
               'item_name', oi.item_name,
               'quantity', oi.quantity,
               'special_instructions', oi.special_instructions
             ) ORDER BY oi.item_name)
        FROM public.station_ticket_items i
        LEFT JOIN public.pos_order_items oi ON oi.id = i.order_item_id
       WHERE i.ticket_id = t.id), '[]'::jsonb)
  FROM public.station_tickets t
  JOIN public.operational_stations s ON s.id = t.station_id
  LEFT JOIN public.pos_orders o ON o.id = t.order_id
  LEFT JOIN public.restaurant_tables rt ON rt.id = o.table_id
  LEFT JOIN public.profiles wp ON wp.id = o.waiter_id
  LEFT JOIN public.profiles ap ON ap.id = t.assigned_chef_id
 WHERE t.station_id IN (SELECT public.neo_bar_station_ids(_branch))
   AND (_branch IS NULL OR t.branch_id = _branch)
   AND (CASE COALESCE(_scope,'all')
          WHEN 'mine' THEN t.assigned_chef_id = auth.uid()
          WHEN 'unassigned' THEN t.assigned_chef_id IS NULL
          ELSE true END)
   AND (CASE COALESCE(_view,'live')
          WHEN 'live' THEN t.status NOT IN ('served','completed','cancelled')
          WHEN 'all' THEN true
          WHEN 'delayed' THEN t.status NOT IN ('ready','served','completed','cancelled')
            AND (EXTRACT(EPOCH FROM (now() - COALESCE(t.received_at, t.created_at))) / 60) > COALESCE(t.target_minutes, 10)
          ELSE t.status = _view END)
 ORDER BY COALESCE(t.received_at, t.created_at);
$$;

CREATE OR REPLACE FUNCTION public.neo_bar_accept_ticket(_ticket uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE _t record; _org uuid := public.current_org_id();
BEGIN
  IF NOT public.has_permission('bar','queue','edit') THEN
    RAISE EXCEPTION 'You are not permitted to work the bar queue' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO _t FROM public.station_tickets
   WHERE id = _ticket AND organization_id = _org
     AND station_id IN (SELECT public.neo_bar_station_ids(NULL))
   FOR UPDATE;
  IF _t.id IS NULL THEN RAISE EXCEPTION 'Bar ticket not found'; END IF;
  IF _t.assigned_chef_id IS NOT NULL AND _t.assigned_chef_id <> auth.uid() THEN
    RAISE EXCEPTION 'Ticket % is already assigned to another attendant', _t.ticket_number
      USING ERRCODE = '42501';
  END IF;
  IF _t.status NOT IN ('new','accepted') THEN
    RAISE EXCEPTION 'Ticket % is % and cannot be accepted', _t.ticket_number, _t.status;
  END IF;

  UPDATE public.station_tickets
     SET assigned_chef_id = auth.uid(),
         status = 'accepted',
         accepted_at = COALESCE(accepted_at, now()),
         updated_at = now()
   WHERE id = _ticket;

  INSERT INTO public.station_ticket_status_history (ticket_id, from_status, to_status, changed_by, reason)
  SELECT _ticket, _t.status, 'accepted', auth.uid(), 'Accepted by bar attendant'
   WHERE EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema='public' AND table_name='station_ticket_status_history'
                    AND column_name='from_status');

  RETURN jsonb_build_object('ticket_id', _ticket, 'status', 'accepted', 'assigned_to', auth.uid());
END;
$$;

CREATE OR REPLACE FUNCTION public.neo_bar_advance_ticket(_ticket uuid, _to text, _reason text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE _t record; _org uuid := public.current_org_id(); _supervisor boolean;
BEGIN
  _supervisor := public.has_permission('bar','queue','create');
  IF NOT public.has_permission('bar','queue','edit') THEN
    RAISE EXCEPTION 'You are not permitted to work the bar queue' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO _t FROM public.station_tickets
   WHERE id = _ticket AND organization_id = _org
     AND station_id IN (SELECT public.neo_bar_station_ids(NULL));
  IF _t.id IS NULL THEN RAISE EXCEPTION 'Bar ticket not found'; END IF;
  IF NOT _supervisor AND COALESCE(_t.assigned_chef_id, '00000000-0000-0000-0000-000000000000'::uuid) <> auth.uid() THEN
    RAISE EXCEPTION 'Ticket % belongs to another attendant', _t.ticket_number USING ERRCODE = '42501';
  END IF;
  IF _t.assigned_chef_id IS NULL THEN
    RAISE EXCEPTION 'Accept ticket % before moving it forward', _t.ticket_number;
  END IF;
  RETURN public.neo_kitchen_ticket_transition(_ticket, _to, _reason);
END;
$$;

CREATE OR REPLACE FUNCTION public.neo_bar_reassign_ticket(_ticket uuid, _to_user uuid, _reason text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE _t record; _org uuid := public.current_org_id();
BEGIN
  IF NOT public.has_permission('bar','queue','create') THEN
    RAISE EXCEPTION 'Only the Bar Manager may reassign bar orders' USING ERRCODE = '42501';
  END IF;
  IF COALESCE(btrim(_reason), '') = '' THEN
    RAISE EXCEPTION 'A reason is required to reassign a bar order';
  END IF;
  SELECT * INTO _t FROM public.station_tickets
   WHERE id = _ticket AND organization_id = _org
     AND station_id IN (SELECT public.neo_bar_station_ids(NULL));
  IF _t.id IS NULL THEN RAISE EXCEPTION 'Bar ticket not found'; END IF;
  IF _t.status IN ('completed','cancelled') THEN
    RAISE EXCEPTION 'Ticket % is already % and cannot be reassigned', _t.ticket_number, _t.status;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = _to_user AND p.organization_id = _org) THEN
    RAISE EXCEPTION 'The chosen attendant is not a member of this organisation';
  END IF;

  UPDATE public.station_tickets
     SET assigned_chef_id = _to_user, updated_at = now()
   WHERE id = _ticket;

  PERFORM public.emit_domain_event(_org, _t.branch_id, 'bar.ticket.reassigned', 'bar', _ticket,
    jsonb_build_object('from', _t.assigned_chef_id, 'to', _to_user, 'reason', _reason,
                       'ticket_number', _t.ticket_number), NULL, NULL);

  RETURN jsonb_build_object('ticket_id', _ticket, 'assigned_to', _to_user);
END;
$$;

CREATE OR REPLACE FUNCTION public.neo_bar_metrics(_branch uuid DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE _org uuid := public.current_org_id(); _out jsonb;
BEGIN
  IF NOT public.has_permission('bar','overview','view') THEN
    RAISE EXCEPTION 'You are not permitted to view bar performance' USING ERRCODE = '42501';
  END IF;

  WITH tickets AS (
    SELECT * FROM public.station_tickets t
     WHERE t.organization_id = _org
       AND t.station_id IN (SELECT public.neo_bar_station_ids(_branch))
       AND (_branch IS NULL OR t.branch_id = _branch)
  ),
  live AS (SELECT * FROM tickets WHERE created_at::date = current_date),
  orders AS (
    SELECT o.* FROM public.pos_orders o
     WHERE o.organization_id = _org
       AND (_branch IS NULL OR o.branch_id = _branch)
       AND o.created_at::date = current_date
       AND EXISTS (SELECT 1 FROM tickets t WHERE t.order_id = o.id)
  ),
  waste AS (
    SELECT * FROM public.waste_records w
     WHERE w.organization_id = _org
       AND (_branch IS NULL OR w.branch_id = _branch)
       AND w.station_id IN (SELECT public.neo_bar_station_ids(_branch))
       AND w.occurred_at::date = current_date
  )
  SELECT jsonb_build_object(
    'queue', jsonb_build_object(
      'new', (SELECT count(*) FROM tickets WHERE status = 'new'),
      'accepted', (SELECT count(*) FROM tickets WHERE status = 'accepted'),
      'preparing', (SELECT count(*) FROM tickets WHERE status = 'preparing'),
      'ready', (SELECT count(*) FROM tickets WHERE status = 'ready'),
      'unassigned', (SELECT count(*) FROM tickets WHERE assigned_chef_id IS NULL
                       AND status NOT IN ('served','completed','cancelled')),
      'delayed', (SELECT count(*) FROM tickets
                   WHERE status NOT IN ('ready','served','completed','cancelled')
                     AND (EXTRACT(EPOCH FROM (now() - COALESCE(received_at, created_at))) / 60) > COALESCE(target_minutes, 10)),
      'completed_today', (SELECT count(*) FROM live WHERE status IN ('served','completed')),
      'cancelled_today', (SELECT count(*) FROM live WHERE status = 'cancelled')
    ),
    'sales', jsonb_build_object(
      'orders_today', (SELECT count(*) FROM orders),
      'revenue_today', (SELECT COALESCE(sum(total_amount), 0) FROM orders),
      'average_order', (SELECT COALESCE(round(avg(total_amount), 2), 0) FROM orders)
    ),
    'wastage', jsonb_build_object(
      'records_today', (SELECT count(*) FROM waste),
      'value_today', (SELECT COALESCE(sum(estimated_cost), 0) FROM waste),
      'awaiting_approval', (SELECT count(*) FROM public.waste_records w
                             WHERE w.organization_id = _org AND w.status = 'pending'
                               AND w.station_id IN (SELECT public.neo_bar_station_ids(_branch)))
    ),
    'approvals', jsonb_build_object(
      'pending', (SELECT count(*) FROM public.approval_requests r
                   WHERE r.organization_id = _org
                     AND r.status = 'pending'
                     AND (_branch IS NULL OR r.branch_id = _branch)),
      'approved_today', (SELECT count(*) FROM public.approval_requests r
                          WHERE r.organization_id = _org AND r.status = 'approved'
                            AND r.updated_at::date = current_date
                            AND (_branch IS NULL OR r.branch_id = _branch)),
      'rejected_today', (SELECT count(*) FROM public.approval_requests r
                          WHERE r.organization_id = _org AND r.status = 'rejected'
                            AND r.updated_at::date = current_date
                            AND (_branch IS NULL OR r.branch_id = _branch))
    ),
    'attendants', COALESCE((
      SELECT jsonb_agg(x) FROM (
        SELECT p.full_name AS attendant,
               count(*) FILTER (WHERE t.status NOT IN ('served','completed','cancelled')) AS open_tickets,
               count(*) FILTER (WHERE t.status IN ('served','completed')) AS completed_tickets
          FROM tickets t JOIN public.profiles p ON p.id = t.assigned_chef_id
         GROUP BY p.full_name ORDER BY 2 DESC) x), '[]'::jsonb)
  ) INTO _out;

  RETURN _out;
END;
$$;

REVOKE ALL ON FUNCTION public.neo_bar_station_ids(uuid) FROM anon, PUBLIC;
REVOKE ALL ON FUNCTION public.neo_bar_queue(uuid, text, text) FROM anon, PUBLIC;
REVOKE ALL ON FUNCTION public.neo_bar_accept_ticket(uuid) FROM anon, PUBLIC;
REVOKE ALL ON FUNCTION public.neo_bar_advance_ticket(uuid, text, text) FROM anon, PUBLIC;
REVOKE ALL ON FUNCTION public.neo_bar_reassign_ticket(uuid, uuid, text) FROM anon, PUBLIC;
REVOKE ALL ON FUNCTION public.neo_bar_metrics(uuid) FROM anon, PUBLIC;

GRANT EXECUTE ON FUNCTION public.neo_bar_station_ids(uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.neo_bar_queue(uuid, text, text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.neo_bar_accept_ticket(uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.neo_bar_advance_ticket(uuid, text, text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.neo_bar_reassign_ticket(uuid, uuid, text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.neo_bar_metrics(uuid) TO authenticated, service_role;