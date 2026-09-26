CREATE OR REPLACE FUNCTION public.neo_bar_metrics(_branch uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
  bar_orders AS (
    SELECT o.* FROM public.pos_orders o
     WHERE o.organization_id = _org
       AND (_branch IS NULL OR o.branch_id = _branch)
       AND EXISTS (SELECT 1 FROM public.station_tickets t
                    WHERE t.order_id = o.id
                      AND t.station_id IN (SELECT public.neo_bar_station_ids(_branch)))
  ),
  orders AS (SELECT * FROM bar_orders WHERE created_at::date = current_date),
  settled AS (
    SELECT * FROM orders
     WHERE status IN ('paid','charged-to-room','closed','credit')
  ),
  open_tabs AS (
    SELECT * FROM bar_orders
     WHERE status NOT IN ('paid','charged-to-room','closed','credit','cancelled','void')
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
      'settled_today', (SELECT count(*) FROM settled),
      'revenue_today', (SELECT COALESCE(sum(grand_total), 0) FROM settled),
      'paid_today', (SELECT COALESCE(sum(paid_total), 0) FROM settled),
      'average_order', (SELECT COALESCE(round(avg(grand_total), 2), 0) FROM settled),
      'open_tabs', (SELECT count(*) FROM open_tabs),
      'open_tab_value', (SELECT COALESCE(sum(grand_total), 0) FROM open_tabs)
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
$function$;

CREATE OR REPLACE FUNCTION public.neo_bar_menu(_branch uuid DEFAULT NULL::uuid, _include_drafts boolean DEFAULT false)
 RETURNS TABLE(id uuid, name text, sku text, description text, currency text, image_url text,
               prep_minutes integer, recipe_status text, recipe_id uuid,
               category_id uuid, category_name text, menu_id uuid, menu_name text,
               base_price numeric, tax_rate numeric, availability text, publish_status text,
               branch_id uuid, branch_name text, department_id uuid, department_name text,
               station_id uuid, station_name text, station_source text, station_missing boolean,
               assigned_station_id uuid, updated_at timestamp with time zone)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE _org uuid := public.current_org_id();
BEGIN
  IF _org IS NULL THEN RETURN; END IF;
  IF NOT (public.has_permission('bar','menu','view')
          OR public.has_permission('bar','sell','view')
          OR public.has_permission('pos','menu','view')) THEN
    RAISE EXCEPTION 'You are not permitted to view the bar menu' USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
  WITH src AS (
    SELECT mi.*, mc.name AS cat_name, m.id AS menu_ident, m.name AS menu_nm,
           br.name AS branch_nm,
           rc.id AS rec_id,
           rc.ingredient_count,
           public.neo_kitchen_resolve_station(_org, coalesce(mi.branch_id, _branch), mi.id, mi.category_id, NULL, NULL) AS res
      FROM public.menu_items mi
      LEFT JOIN public.menu_categories mc ON mc.id = mi.category_id
      LEFT JOIN public.menus m ON m.id = mc.menu_id
      LEFT JOIN public.branches br ON br.id = mi.branch_id
      LEFT JOIN LATERAL (
        SELECT r.id, (SELECT count(*) FROM public.recipe_ingredients ri WHERE ri.recipe_id = r.id) AS ingredient_count
          FROM public.recipes r
         WHERE r.menu_item_id = mi.id AND r.organization_id = _org
         ORDER BY r.version DESC NULLS LAST, r.created_at DESC
         LIMIT 1
      ) rc ON true
     WHERE mi.organization_id = _org
       AND (_include_drafts OR mi.publish_status = 'published')
       AND (_branch IS NULL OR mi.branch_id IS NULL OR mi.branch_id = _branch)
       AND public.neo_branch_in_scope(mi.branch_id)
  )
  SELECT r.id, r.name, r.sku, r.description, r.currency, r.image_url, r.prep_minutes,
         CASE WHEN r.rec_id IS NULL THEN 'not-linked'
              WHEN coalesce(r.ingredient_count,0) = 0 THEN 'incomplete'
              ELSE 'linked' END,
         r.rec_id,
         r.category_id, r.cat_name, r.menu_ident, r.menu_nm,
         r.base_price, r.tax_rate, r.availability, r.publish_status,
         r.branch_id, r.branch_nm,
         st.department_id, dp.name,
         st.id, st.name,
         r.res->>'source',
         (r.res->>'missing')::boolean,
         r.station_id,
         r.updated_at
    FROM src r
    JOIN public.operational_stations st ON st.id = nullif(r.res->>'station_id','')::uuid
    LEFT JOIN public.departments dp ON dp.id = st.department_id
   WHERE st.id IN (SELECT public.neo_bar_station_ids(_branch))
   ORDER BY r.branch_nm NULLS FIRST, r.cat_name NULLS LAST, r.name;
END $function$;

CREATE OR REPLACE FUNCTION public.neo_bar_open_orders(_branch uuid DEFAULT NULL::uuid)
 RETURNS TABLE(order_id uuid, order_number text, order_type text, order_source text,
               status text, payment_status text, table_code text, guest_name text,
               waiter_name text, item_count bigint, grand_total numeric, paid_total numeric,
               currency text, created_at timestamp with time zone)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT o.id, o.order_number, o.order_type, o.order_source,
         o.status, o.payment_status, rt.code, o.guest_name, wp.full_name,
         (SELECT count(*) FROM public.pos_order_items oi WHERE oi.order_id = o.id),
         o.grand_total, o.paid_total, o.currency, o.created_at
    FROM public.pos_orders o
    LEFT JOIN public.restaurant_tables rt ON rt.id = o.table_id
    LEFT JOIN public.profiles wp ON wp.id = o.waiter_id
   WHERE o.organization_id = public.current_org_id()
     AND (public.has_permission('bar','queue','view') OR public.has_permission('bar','sell','view'))
     AND (_branch IS NULL OR o.branch_id = _branch)
     AND o.status NOT IN ('paid','charged-to-room','closed','credit','cancelled','void')
     AND (
       o.order_source = 'bar-pos'
       OR EXISTS (SELECT 1 FROM public.station_tickets t
                   WHERE t.order_id = o.id
                     AND t.station_id IN (SELECT public.neo_bar_station_ids(_branch)))
     )
   ORDER BY o.created_at DESC;
$function$;

REVOKE ALL ON FUNCTION public.neo_bar_menu(uuid, boolean) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.neo_bar_open_orders(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.neo_bar_menu(uuid, boolean) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.neo_bar_open_orders(uuid) TO authenticated, service_role;