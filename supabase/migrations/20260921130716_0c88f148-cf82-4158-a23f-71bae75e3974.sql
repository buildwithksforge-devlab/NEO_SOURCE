DROP POLICY IF EXISTS pos_order_items_kitchen_production_read ON public.pos_order_items;
DROP POLICY IF EXISTS pos_order_item_modifiers_kitchen_production_read ON public.pos_order_item_modifiers;

CREATE OR REPLACE FUNCTION public.neo_kitchen_ticket_items(_ticket uuid)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $fn$
  SELECT COALESCE((
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
    WHERE i.ticket_id = _ticket
      AND EXISTS (
        SELECT 1 FROM public.station_tickets t
        WHERE t.id = _ticket
          AND t.organization_id = public.current_org_id()
          AND (
            t.station_id IN (SELECT unnest(public.neo_kitchen_visible_station_ids()))
            OR public.in_my_scope(t.organization_id, t.branch_id, t.department_id, t.station_id, t.assigned_chef_id, t.created_by)
          )
      )
  ), '[]'::jsonb);
$fn$;

REVOKE ALL ON FUNCTION public.neo_kitchen_ticket_items(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.neo_kitchen_ticket_items(uuid) TO authenticated, service_role;

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
    public.neo_kitchen_ticket_items(t.id)
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
$function$;