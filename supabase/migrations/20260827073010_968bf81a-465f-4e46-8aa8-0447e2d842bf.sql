CREATE OR REPLACE FUNCTION public.neo_bar_department_ids(_branch uuid DEFAULT NULL::uuid)
 RETURNS SETOF uuid
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT d.id
    FROM public.departments d
   WHERE d.organization_id = public.current_org_id()
     AND (_branch IS NULL OR d.branch_id = _branch)
     AND (upper(coalesce(d.code, '')) = 'BAR'
          OR d.name ILIKE '%bar%'
          OR d.name ILIKE '%beverage%')
     AND d.name NOT ILIKE '%barista%'
  UNION
  SELECT DISTINCT s.department_id
    FROM public.operational_stations s
   WHERE s.department_id IS NOT NULL
     AND s.id IN (SELECT public.neo_bar_station_ids(_branch));
$function$;

CREATE OR REPLACE FUNCTION public.neo_bar_overview(_branch uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE _org uuid := public.current_org_id(); _out jsonb;
BEGIN
  IF NOT public.has_permission('bar','overview','view') THEN
    RAISE EXCEPTION 'You are not permitted to view the bar overview' USING ERRCODE = '42501';
  END IF;

  WITH stations AS (SELECT public.neo_bar_station_ids(_branch) AS id),
  depts AS (SELECT public.neo_bar_department_ids(_branch) AS id),
  tabs AS (
    SELECT o.id, o.order_number, o.status, o.guest_name, o.grand_total, o.paid_total,
           o.currency, o.created_at, rt.code AS table_code,
           (SELECT count(*) FROM public.pos_order_items oi WHERE oi.order_id = o.id) AS item_count
      FROM public.pos_orders o
      LEFT JOIN public.restaurant_tables rt ON rt.id = o.table_id
     WHERE o.organization_id = _org
       AND (_branch IS NULL OR o.branch_id = _branch)
       AND o.status NOT IN ('paid','charged-to-room','closed','credit','cancelled','void')
       AND (o.order_source = 'bar-pos'
            OR EXISTS (SELECT 1 FROM public.station_tickets t
                        WHERE t.order_id = o.id AND t.station_id IN (SELECT id FROM stations)))
  ),
  queue AS (
    SELECT t.id, t.ticket_number, t.status, t.created_at, t.received_at, t.target_minutes,
           t.course, o.order_number, p.full_name AS attendant,
           round(EXTRACT(EPOCH FROM (now() - coalesce(t.received_at, t.created_at))) / 60)::int AS waiting_minutes
      FROM public.station_tickets t
      LEFT JOIN public.pos_orders o ON o.id = t.order_id
      LEFT JOIN public.profiles p ON p.id = t.assigned_chef_id
     WHERE t.organization_id = _org
       AND t.station_id IN (SELECT id FROM stations)
       AND (_branch IS NULL OR t.branch_id = _branch)
       AND t.status NOT IN ('served','completed','cancelled')
  ),
  approvals AS (
    SELECT r.id, r.reference, r.approval_type, r.amount, r.reason, r.status,
           r.created_at, r.level, pr.full_name AS requester
      FROM public.approval_requests r
      LEFT JOIN public.profiles pr ON pr.id = r.requester_id
     WHERE r.organization_id = _org
       AND r.status = 'pending'
       AND (_branch IS NULL OR r.branch_id = _branch)
       AND (r.department_id IN (SELECT id FROM depts) OR r.department_id IS NULL)
  ),
  low_stock AS (
    SELECT si.id, si.name, si.sku, si.base_unit, si.min_level, si.reorder_quantity,
           sl.name AS location_name,
           sum(lv.quantity_on_hand) AS on_hand
      FROM public.stock_levels lv
      JOIN public.stock_items si ON si.id = lv.stock_item_id
      JOIN public.stock_locations sl ON sl.id = lv.location_id
     WHERE lv.organization_id = _org
       AND si.active
       AND sl.active
       AND (_branch IS NULL OR sl.branch_id = _branch)
       AND sl.department_id IN (SELECT id FROM depts)
     GROUP BY si.id, si.name, si.sku, si.base_unit, si.min_level, si.reorder_quantity, sl.name
    HAVING coalesce(si.min_level, 0) > 0 AND sum(lv.quantity_on_hand) <= si.min_level
  ),
  waste AS (
    SELECT w.id, w.waste_number, w.ingredient_name, w.quantity, w.unit, w.category,
           w.reason, w.status, w.estimated_cost, w.occurred_at
      FROM public.waste_records w
     WHERE w.organization_id = _org
       AND (_branch IS NULL OR w.branch_id = _branch)
       AND w.station_id IN (SELECT id FROM stations)
     ORDER BY w.occurred_at DESC
     LIMIT 8
  )
  SELECT jsonb_build_object(
    'open_tabs', jsonb_build_object(
      'count', (SELECT count(*) FROM tabs),
      'value', (SELECT coalesce(sum(grand_total), 0) FROM tabs),
      'rows', coalesce((SELECT jsonb_agg(to_jsonb(x) ORDER BY x.created_at DESC) FROM tabs x), '[]'::jsonb)
    ),
    'queue', jsonb_build_object(
      'count', (SELECT count(*) FROM queue),
      'delayed', (SELECT count(*) FROM queue WHERE waiting_minutes > coalesce(target_minutes, 10)),
      'rows', coalesce((SELECT jsonb_agg(to_jsonb(x) ORDER BY x.created_at) FROM (SELECT * FROM queue ORDER BY created_at LIMIT 8) x), '[]'::jsonb)
    ),
    'approvals', jsonb_build_object(
      'count', (SELECT count(*) FROM approvals),
      'value', (SELECT coalesce(sum(amount), 0) FROM approvals),
      'rows', coalesce((SELECT jsonb_agg(to_jsonb(x) ORDER BY x.created_at) FROM (SELECT * FROM approvals ORDER BY created_at LIMIT 8) x), '[]'::jsonb)
    ),
    'low_stock', jsonb_build_object(
      'count', (SELECT count(*) FROM low_stock),
      'rows', coalesce((SELECT jsonb_agg(to_jsonb(x)) FROM (SELECT * FROM low_stock ORDER BY on_hand LIMIT 8) x), '[]'::jsonb)
    ),
    'wastage', jsonb_build_object(
      'count', (SELECT count(*) FROM waste),
      'value_today', (SELECT coalesce(sum(estimated_cost), 0) FROM public.waste_records w
                       WHERE w.organization_id = _org
                         AND (_branch IS NULL OR w.branch_id = _branch)
                         AND w.station_id IN (SELECT id FROM stations)
                         AND w.occurred_at::date = current_date),
      'rows', coalesce((SELECT jsonb_agg(to_jsonb(x) ORDER BY x.occurred_at DESC) FROM waste x), '[]'::jsonb)
    )
  ) INTO _out;

  RETURN _out;
END $function$;

REVOKE ALL ON FUNCTION public.neo_bar_department_ids(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.neo_bar_overview(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.neo_bar_department_ids(uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.neo_bar_overview(uuid) TO authenticated, service_role;