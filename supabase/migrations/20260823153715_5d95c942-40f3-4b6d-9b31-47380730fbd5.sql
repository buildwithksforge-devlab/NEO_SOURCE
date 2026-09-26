CREATE OR REPLACE FUNCTION public.neo_operational_facts(_branch uuid DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE
  org uuid := public.current_org_id();
  me uuid := auth.uid();
  stations uuid[] := coalesce(public.current_station_ids(), '{}'::uuid[]);
  tz text; today date; day_start timestamptz; day_end timestamptz;
  kitchen jsonb; station jsonb; restaurant jsonb; waiter jsonb; housekeeping jsonb;
  procurement jsonb; inventory jsonb; events jsonb; delivery jsonb; hr jsonb;
  maintenance jsonb; laundry jsonb; crm jsonb; finance jsonb;
BEGIN
  IF org IS NULL THEN RETURN jsonb_build_object('authorised', false); END IF;

  SELECT coalesce(b.timezone, 'Africa/Nairobi') INTO tz FROM public.branches b
   WHERE b.organization_id = org AND (_branch IS NULL OR b.id = _branch)
   ORDER BY (b.id = _branch) DESC LIMIT 1;
  tz := coalesce(tz, 'Africa/Nairobi');
  today := (now() AT TIME ZONE tz)::date;
  day_start := (today::timestamp) AT TIME ZONE tz;
  day_end := ((today + 1)::timestamp) AT TIME ZONE tz;

  WITH items AS (
    SELECT sti.status, st.station_id, st.received_at, st.target_minutes,
           sti.accepted_at, sti.ready_at
      FROM public.station_ticket_items sti
      JOIN public.station_tickets st ON st.id = sti.ticket_id
     WHERE st.organization_id = org
       AND (_branch IS NULL OR st.branch_id = _branch)
       AND st.created_at >= day_start AND st.created_at < day_end
  )
  SELECT
    jsonb_build_object(
      'new_items', count(*) FILTER (WHERE status IN ('new','queued','pending','sent')),
      'items_preparing', count(*) FILTER (WHERE status IN ('accepted','preparing','in-progress','started')),
      'items_ready', count(*) FILTER (WHERE status = 'ready'),
      'avg_prep_minutes', round(coalesce(avg(EXTRACT(epoch FROM (ready_at - accepted_at)) / 60)
        FILTER (WHERE ready_at IS NOT NULL AND accepted_at IS NOT NULL), 0)::numeric, 1),
      'delayed_items', count(*) FILTER (WHERE ready_at IS NULL AND received_at IS NOT NULL
        AND now() > received_at + make_interval(mins => coalesce(target_minutes, 20)))),
    jsonb_build_object(
      'new_items', count(*) FILTER (WHERE status IN ('new','queued','pending','sent') AND station_id = ANY(stations)),
      'items_preparing', count(*) FILTER (WHERE status IN ('accepted','preparing','in-progress','started') AND station_id = ANY(stations)),
      'items_ready', count(*) FILTER (WHERE status = 'ready' AND station_id = ANY(stations)),
      'avg_prep_minutes', round(coalesce(avg(EXTRACT(epoch FROM (ready_at - accepted_at)) / 60)
        FILTER (WHERE station_id = ANY(stations) AND ready_at IS NOT NULL AND accepted_at IS NOT NULL), 0)::numeric, 1))
    INTO kitchen, station
    FROM items;

  WITH o AS (
    SELECT * FROM public.pos_orders po
     WHERE po.organization_id = org
       AND (_branch IS NULL OR po.branch_id = _branch)
       AND po.created_at >= day_start AND po.created_at < day_end
  )
  SELECT
    jsonb_build_object(
      'active_tables', count(DISTINCT table_id) FILTER (WHERE table_id IS NOT NULL
        AND status NOT IN ('closed','paid','settled','completed','cancelled','void')),
      'orders_in_progress', count(*) FILTER (WHERE status IN ('draft','sent','confirmed','preparing','partially-served')),
      'orders_ready', count(*) FILTER (WHERE status = 'ready'),
      'open_bills', count(*) FILTER (WHERE status NOT IN ('closed','paid','settled','completed','cancelled','void')),
      'open_value', round(coalesce(sum(grand_total) FILTER (WHERE status NOT IN ('closed','paid','settled','completed','cancelled','void')), 0)::numeric, 2),
      'sales_today', round(coalesce(sum(grand_total) FILTER (WHERE status IN ('closed','paid','settled','completed')), 0)::numeric, 2),
      'avg_service_minutes', round(coalesce(avg(EXTRACT(epoch FROM (served_at - sent_at)) / 60)
        FILTER (WHERE served_at IS NOT NULL AND sent_at IS NOT NULL), 0)::numeric, 1)),
    jsonb_build_object(
      'assigned_tables', count(DISTINCT table_id) FILTER (WHERE waiter_id = me AND table_id IS NOT NULL
        AND status NOT IN ('closed','paid','settled','completed','cancelled','void')),
      'orders_awaiting_service', count(*) FILTER (WHERE waiter_id = me AND status IN ('draft','sent','confirmed','preparing','partially-served')),
      'orders_ready', count(*) FILTER (WHERE waiter_id = me AND status = 'ready'),
      'open_bills', count(*) FILTER (WHERE waiter_id = me AND status NOT IN ('closed','paid','settled','completed','cancelled','void')),
      'service_delays', count(*) FILTER (WHERE waiter_id = me AND status = 'ready'
        AND updated_at < now() - interval '10 minutes'))
    INTO restaurant, waiter
    FROM o;

  SELECT jsonb_build_object(
      'dirty_rooms', (SELECT count(*) FROM public.ops_room_state(_branch) s WHERE s.room_condition = 'dirty'),
      'ready_rooms', (SELECT count(*) FROM public.ops_room_state(_branch) s WHERE s.room_condition = 'clean' AND s.occupancy_status <> 'occupied'),
      'cleaning_in_progress', count(*) FILTER (WHERE j.status IN ('in-progress','started')),
      'awaiting_inspection', count(*) FILTER (WHERE j.inspection_required AND j.status IN ('completed','awaiting-inspection')
        AND coalesce(j.inspection_status, 'pending') NOT IN ('passed','approved')),
      'open_jobs', count(*) FILTER (WHERE j.status NOT IN ('completed','cancelled','verified')),
      'my_open_jobs', count(*) FILTER (WHERE j.assignee_id = me AND j.status NOT IN ('completed','cancelled','verified')))
    INTO housekeeping
    FROM public.housekeeping_jobs j
   WHERE j.organization_id = org AND (_branch IS NULL OR j.branch_id = _branch);

  SELECT jsonb_build_object(
      'open_requests', (SELECT count(*) FROM public.purchase_requests pr
         WHERE pr.organization_id = org AND (_branch IS NULL OR pr.branch_id = _branch)
           AND pr.status IN ('draft','submitted','pending','pending-approval')),
      'awaiting_approval', (SELECT count(*) FROM public.purchase_requests pr
         WHERE pr.organization_id = org AND (_branch IS NULL OR pr.branch_id = _branch)
           AND pr.status IN ('submitted','pending','pending-approval')),
      'open_orders', count(*) FILTER (WHERE po.status NOT IN ('closed','cancelled','void')),
      'awaiting_receipt', count(*) FILTER (WHERE po.status IN ('approved','sent','partially-received')),
      'order_value_open', round(coalesce(sum(po.total_amount) FILTER (WHERE po.status NOT IN ('closed','cancelled','void')), 0)::numeric, 2),
      'lead_time_days', round(coalesce(avg(EXTRACT(epoch FROM (po.closed_at - po.approved_at)) / 86400)
        FILTER (WHERE po.closed_at IS NOT NULL AND po.approved_at IS NOT NULL), 0)::numeric, 1),
      'active_suppliers', (SELECT count(*) FROM public.suppliers s
         WHERE s.organization_id = org AND s.active AND (_branch IS NULL OR s.branch_id IS NULL OR s.branch_id = _branch)))
    INTO procurement
    FROM public.purchase_orders po
   WHERE po.organization_id = org AND (_branch IS NULL OR po.branch_id = _branch);

  SELECT jsonb_build_object(
      'low_stock', count(*) FILTER (WHERE onhand <= coalesce(min_level, 0) AND coalesce(min_level, 0) > 0),
      'negative_stock', count(*) FILTER (WHERE onhand < 0),
      'valuation', round(coalesce(sum(onhand * coalesce(average_cost, 0)), 0)::numeric, 2),
      'goods_received_today', (SELECT count(*) FROM public.goods_receipts gr
         WHERE gr.organization_id = org AND (_branch IS NULL OR gr.branch_id = _branch)
           AND gr.received_at >= day_start AND gr.received_at < day_end),
      'expiring_items', (SELECT count(*) FROM public.stock_batches sb
         JOIN public.stock_items si2 ON si2.id = sb.stock_item_id
        WHERE sb.organization_id = org AND (_branch IS NULL OR si2.branch_id = _branch)
          AND sb.expiry_date IS NOT NULL AND sb.expiry_date <= today + 30 AND sb.quantity > 0))
    INTO inventory
    FROM (
      SELECT si.min_level, si.average_cost,
             coalesce((SELECT sum(sl.quantity_on_hand) FROM public.stock_levels sl WHERE sl.stock_item_id = si.id), 0) AS onhand
        FROM public.stock_items si
       WHERE si.organization_id = org AND si.active AND (_branch IS NULL OR si.branch_id = _branch)
    ) t;

  SELECT jsonb_build_object(
      'upcoming', count(*) FILTER (WHERE eb.event_date >= today AND eb.status IN ('confirmed','provisional-hold','tentative')),
      'confirmed', count(*) FILTER (WHERE eb.status = 'confirmed'),
      'today', count(*) FILTER (WHERE eb.event_date = today AND eb.status <> 'cancelled'),
      'deposits_received', round(coalesce(sum(eb.paid_amount), 0)::numeric, 2),
      'outstanding_balance', round(coalesce(sum(greatest(coalesce(eb.total_amount, 0) - coalesce(eb.paid_amount, 0), 0)), 0)::numeric, 2),
      'quotations_sent', (SELECT count(*) FROM public.event_quotations q
         WHERE q.organization_id = org AND (_branch IS NULL OR q.branch_id = _branch)
           AND q.status IN ('sent','viewed','pending')),
      'open_enquiries', (SELECT count(*) FROM public.event_enquiries e
         WHERE e.organization_id = org AND (_branch IS NULL OR e.branch_id = _branch)
           AND e.status IN ('new','open','in-progress','quoted','followup')))
    INTO events
    FROM public.event_bookings eb
   WHERE eb.organization_id = org AND (_branch IS NULL OR eb.branch_id = _branch);

  SELECT jsonb_build_object(
      'incoming', count(*) FILTER (WHERE d.order_status IN ('placed','pending','accepted','confirmed')),
      'preparing', count(*) FILTER (WHERE d.order_status IN ('preparing','ready')),
      'dispatched', count(*) FILTER (WHERE d.order_status IN ('out-for-delivery','collected','dispatched')),
      'delivered_today', count(*) FILTER (WHERE d.delivered_at >= day_start AND d.delivered_at < day_end),
      'unassigned', count(*) FILTER (WHERE d.rider_id IS NULL AND d.order_status NOT IN ('delivered','cancelled','rejected')),
      'avg_delivery_minutes', round(coalesce(avg(EXTRACT(epoch FROM (d.delivered_at - d.accepted_at)) / 60)
        FILTER (WHERE d.delivered_at IS NOT NULL AND d.accepted_at IS NOT NULL), 0)::numeric, 1),
      'sales_today', round(coalesce(sum(d.grand_total) FILTER (WHERE d.delivered_at >= day_start AND d.delivered_at < day_end), 0)::numeric, 2),
      'riders_on_shift', (SELECT count(DISTINCT rs.rider_id) FROM public.rider_shifts rs
         WHERE rs.organization_id = org AND (_branch IS NULL OR rs.branch_id = _branch)
           AND rs.status = 'active' AND rs.starts_at <= now() AND (rs.ends_at IS NULL OR rs.ends_at >= now())),
      'zones', (SELECT count(*) FROM public.delivery_zones z WHERE z.organization_id = org
           AND (_branch IS NULL OR z.branch_id = _branch)))
    INTO delivery
    FROM public.delivery_orders d
   WHERE d.organization_id = org AND (_branch IS NULL OR d.branch_id = _branch);

  SELECT jsonb_build_object(
      'active_employees', count(*) FILTER (WHERE e.employment_status NOT IN ('terminated','exited','resigned')),
      'contracts_expiring', count(*) FILTER (WHERE e.contract_end IS NOT NULL AND e.contract_end <= today + 60),
      'probation_due', count(*) FILTER (WHERE e.probation_end_date IS NOT NULL AND e.probation_end_date <= today + 30),
      'present_today', (SELECT count(*) FROM public.attendance_records a
         WHERE a.organization_id = org AND (_branch IS NULL OR a.branch_id = _branch)
           AND a.work_date = today AND a.clock_in_at IS NOT NULL),
      'on_leave_today', (SELECT count(*) FROM public.leave_requests l
         WHERE l.organization_id = org AND (_branch IS NULL OR l.branch_id = _branch)
           AND l.status = 'approved' AND today BETWEEN l.start_date AND l.end_date),
      'open_leave_requests', (SELECT count(*) FROM public.leave_requests l
         WHERE l.organization_id = org AND (_branch IS NULL OR l.branch_id = _branch)
           AND l.status IN ('submitted','pending','supervisor-review')))
    INTO hr
    FROM public.employees e
   WHERE e.organization_id = org AND (_branch IS NULL OR e.branch_id = _branch);

  SELECT jsonb_build_object(
      'open_work_orders', count(*) FILTER (WHERE w.status NOT IN ('completed','closed','cancelled','verified')),
      'in_progress', count(*) FILTER (WHERE w.status IN ('in-progress','accepted','assigned')),
      'rooms_blocked', count(*) FILTER (WHERE w.blocks_room AND w.status NOT IN ('completed','closed','cancelled')),
      'completed_today', count(*) FILTER (WHERE w.completed_at >= day_start AND w.completed_at < day_end),
      'preventive_due', (SELECT count(*) FROM public.preventive_maintenance_occurrences p
         WHERE p.organization_id = org AND p.status NOT IN ('completed','cancelled')
           AND p.due_date <= today + 7))
    INTO maintenance
    FROM public.maintenance_work_orders w
   WHERE w.organization_id = org AND (_branch IS NULL OR w.branch_id = _branch);

  SELECT jsonb_build_object(
      'open_orders', count(*) FILTER (WHERE l.status NOT IN ('delivered','cancelled','closed')),
      'due_today', count(*) FILTER (WHERE l.required_delivery_at >= day_start AND l.required_delivery_at < day_end
        AND l.status NOT IN ('delivered','cancelled','closed')),
      'delivered_today', count(*) FILTER (WHERE l.delivered_at >= day_start AND l.delivered_at < day_end),
      'unposted_charges', count(*) FILTER (WHERE coalesce(l.posting_status, 'pending') <> 'posted'
        AND l.status <> 'cancelled'))
    INTO laundry
    FROM public.guest_laundry_orders l
   WHERE l.organization_id = org AND (_branch IS NULL OR l.branch_id = _branch);

  SELECT jsonb_build_object(
      'new_guests_today', (SELECT count(*) FROM public.customers c
         WHERE c.organization_id = org AND c.created_at >= day_start AND c.created_at < day_end),
      'vip_guests', (SELECT count(*) FROM public.customers c
         WHERE c.organization_id = org AND c.is_vip AND c.archived_at IS NULL),
      'open_feedback', count(*) FILTER (WHERE f.status NOT IN ('resolved','closed')),
      'feedback_today', count(*) FILTER (WHERE f.received_at >= day_start AND f.received_at < day_end),
      'avg_rating', round(coalesce(avg(f.rating) FILTER (WHERE f.rating IS NOT NULL), 0)::numeric, 2),
      'active_campaigns', (SELECT count(*) FROM public.campaigns cp
         WHERE cp.organization_id = org AND (_branch IS NULL OR cp.branch_id = _branch)
           AND cp.status IN ('running','active','scheduled','launched')))
    INTO crm
    FROM public.customer_feedback f
   WHERE f.organization_id = org AND (_branch IS NULL OR f.branch_id = _branch);

  SELECT jsonb_build_object(
      'open_shifts', count(*) FILTER (WHERE s.status = 'open'),
      'shifts_awaiting_review', count(*) FILTER (WHERE s.status IN ('closed','pending-review') AND s.reviewed_at IS NULL),
      'cash_variance_today', round(coalesce(sum(s.variance) FILTER (WHERE s.closed_at >= day_start AND s.closed_at < day_end), 0)::numeric, 2),
      'cash_expected_open', round(coalesce(sum(s.expected_cash) FILTER (WHERE s.status = 'open'), 0)::numeric, 2),
      'payments_today', (SELECT round(coalesce(sum(p.amount), 0)::numeric, 2) FROM public.payments p
         WHERE p.organization_id = org AND (_branch IS NULL OR p.branch_id = _branch)
           AND p.status IN ('confirmed','completed','posted','captured')
           AND p.paid_at >= day_start AND p.paid_at < day_end))
    INTO finance
    FROM public.pos_shifts s
   WHERE s.organization_id = org AND (_branch IS NULL OR s.branch_id = _branch);

  RETURN jsonb_build_object(
    'authorised', true,
    'local_date', today,
    'timezone', tz,
    'kitchen', kitchen,
    'station', station,
    'restaurant', restaurant,
    'waiter', waiter,
    'housekeeping', housekeeping,
    'procurement', procurement,
    'inventory', inventory,
    'events', events,
    'delivery', delivery,
    'hr', hr,
    'maintenance', maintenance,
    'laundry', laundry,
    'crm', crm,
    'finance', finance);
END;
$function$;

REVOKE ALL ON FUNCTION public.neo_operational_facts(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.neo_operational_facts(uuid) TO authenticated, service_role;