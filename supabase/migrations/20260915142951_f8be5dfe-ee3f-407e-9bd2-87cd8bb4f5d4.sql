CREATE OR REPLACE FUNCTION public.neo_my_work(_branch uuid DEFAULT NULL::uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  v_org uuid := public.current_org_id();
  v_tz text; v_today date;
  v_items jsonb := '[]'::jsonb;
  n1 bigint; n2 bigint; n3 bigint;
BEGIN
  PERFORM public.neo_assert_reporting_scope(_branch, NULL, NULL);
  IF v_org IS NULL THEN
    RETURN jsonb_build_object('authorised', false, 'reason', 'no_organisation');
  END IF;

  v_tz := public.neo_fact_timezone(v_org, _branch);
  v_today := (now() AT TIME ZONE v_tz)::date;

  -- ---- Front office --------------------------------------------------------
  IF public.has_permission('front-office', 'view') THEN
    SELECT count(*) INTO n1 FROM public.reservations r
     WHERE r.organization_id = v_org AND (_branch IS NULL OR r.branch_id = _branch)
       AND r.arrival_date = v_today AND r.status IN ('confirmed','guaranteed','tentative','pending-deposit');
    SELECT count(*) INTO n2 FROM public.reservations r
     WHERE r.organization_id = v_org AND (_branch IS NULL OR r.branch_id = _branch)
       AND r.departure_date = v_today AND r.status = 'checked-in';
    SELECT count(*) INTO n3 FROM public.reservations r
     WHERE r.organization_id = v_org AND (_branch IS NULL OR r.branch_id = _branch)
       AND r.arrival_date = v_today AND r.status IN ('confirmed','guaranteed','tentative','pending-deposit')
       AND COALESCE(r.balance, 0) > 0;

    v_items := v_items || jsonb_build_array(
      jsonb_build_object('id','arrivals','module','pms','label','Arrivals to process today',
        'value', n1, 'detail', n2 || ' departure(s) today', 'route','/pms/arrivals',
        'tone', CASE WHEN n1 > 0 THEN 'info' ELSE 'ok' END),
      jsonb_build_object('id','arrivals-unpaid','module','pms','label','Arrivals with an outstanding balance',
        'value', n3, 'detail','Recorded reservation balance greater than zero','route','/pms/reservations',
        'tone', CASE WHEN n3 > 0 THEN 'warning' ELSE 'ok' END));
  END IF;

  -- ---- Housekeeping --------------------------------------------------------
  IF public.has_permission('housekeeping', 'view') THEN
    SELECT count(*) INTO n1 FROM public.rooms r
     WHERE r.organization_id = v_org AND (_branch IS NULL OR r.branch_id = _branch)
       AND r.housekeeping_status IN ('dirty','in-progress','awaiting-inspection');
    SELECT count(*) INTO n2 FROM public.housekeeping_jobs j
     WHERE j.organization_id = v_org AND (_branch IS NULL OR j.branch_id = _branch)
       AND j.status IN ('pending','assigned','in-progress','awaiting-inspection')
       AND j.assignee_id = auth.uid();
    SELECT count(*) INTO n3 FROM public.housekeeping_jobs j
     WHERE j.organization_id = v_org AND (_branch IS NULL OR j.branch_id = _branch)
       AND j.status IN ('pending','assigned','in-progress','awaiting-inspection');

    v_items := v_items || jsonb_build_array(
      jsonb_build_object('id','my-rooms','module','housekeeping','label','Rooms assigned to me',
        'value', n2, 'detail', n3 || ' open housekeeping job(s) in total','route','/housekeeping/my-work',
        'tone', CASE WHEN n2 > 0 THEN 'info' ELSE 'ok' END),
      jsonb_build_object('id','rooms-not-ready','module','housekeeping','label','Rooms not yet ready',
        'value', n1, 'detail','Dirty, being cleaned or awaiting inspection','route','/housekeeping/board',
        'tone', CASE WHEN n1 > 0 THEN 'warning' ELSE 'ok' END));
  END IF;

  -- ---- Kitchen -------------------------------------------------------------
  IF public.has_permission('kitchen', 'view') THEN
    SELECT count(*) INTO n1 FROM public.station_tickets t
     WHERE t.organization_id = v_org AND (_branch IS NULL OR t.branch_id = _branch)
       AND t.status IN ('new','accepted','preparing','partially-ready');
    SELECT count(*) INTO n2 FROM public.station_tickets t
     WHERE t.organization_id = v_org AND (_branch IS NULL OR t.branch_id = _branch)
       AND t.status IN ('new','accepted','preparing','partially-ready','delayed')
       AND t.target_minutes IS NOT NULL
       AND now() > t.created_at + make_interval(mins => t.target_minutes);

    v_items := v_items || jsonb_build_array(
      jsonb_build_object('id','tickets-open','module','kitchen','label','Tickets to prepare',
        'value', n1, 'detail','Open on the kitchen display','route','/kitchen/queue',
        'tone', CASE WHEN n1 > 0 THEN 'info' ELSE 'ok' END),
      jsonb_build_object('id','tickets-late','module','kitchen','label','Tickets past their target time',
        'value', n2, 'detail','Recorded target minutes already exceeded','route','/kitchen/queue',
        'tone', CASE WHEN n2 > 0 THEN 'critical' ELSE 'ok' END));
  END IF;

  -- ---- Restaurant / POS ----------------------------------------------------
  IF public.has_permission('pos', 'view') OR public.has_permission('restaurant', 'view') THEN
    SELECT count(*) INTO n1 FROM public.pos_orders o
     WHERE o.organization_id = v_org AND (_branch IS NULL OR o.branch_id = _branch)
       AND o.status IN ('confirmed','sent','accepted','in-preparation','partially-ready','ready','partially-served','served','awaiting-payment');
    SELECT count(*) INTO n2 FROM public.pos_orders o
     WHERE o.organization_id = v_org AND (_branch IS NULL OR o.branch_id = _branch)
       AND o.status = 'awaiting-payment';

    v_items := v_items || jsonb_build_array(
      jsonb_build_object('id','open-bills','module','pos','label','Open orders',
        'value', n1, 'detail', n2 || ' awaiting settlement','route','/pos/orders',
        'tone', CASE WHEN n2 > 0 THEN 'warning' WHEN n1 > 0 THEN 'info' ELSE 'ok' END));
  END IF;

  -- ---- Delivery ------------------------------------------------------------
  IF public.has_permission('delivery', 'view') THEN
    SELECT count(*) INTO n1 FROM public.delivery_orders d
     WHERE d.organization_id = v_org AND (_branch IS NULL OR d.branch_id = _branch)
       AND d.order_status IN ('confirmed','in-preparation','ready-for-pickup')
       AND d.rider_id IS NULL;
    SELECT count(*) INTO n2 FROM public.delivery_orders d
     WHERE d.organization_id = v_org AND (_branch IS NULL OR d.branch_id = _branch)
       AND d.order_status IN ('rider-assigned','collected','out-for-delivery')
       AND d.estimated_delivery_at IS NOT NULL AND d.estimated_delivery_at < now();
    SELECT count(*) INTO n3 FROM public.delivery_orders d
     WHERE d.organization_id = v_org AND (_branch IS NULL OR d.branch_id = _branch)
       AND d.rider_id = auth.uid()
       AND d.order_status IN ('rider-assigned','collected','out-for-delivery');

    v_items := v_items || jsonb_build_array(
      jsonb_build_object('id','unassigned-deliveries','module','delivery','label','Deliveries without a rider',
        'value', n1, 'detail','Confirmed orders not yet assigned','route','/delivery/dispatch',
        'tone', CASE WHEN n1 > 0 THEN 'warning' ELSE 'ok' END),
      jsonb_build_object('id','late-deliveries','module','delivery','label','Deliveries past their estimate',
        'value', n2, 'detail','Recorded estimated delivery time already passed','route','/delivery/dispatch',
        'tone', CASE WHEN n2 > 0 THEN 'critical' ELSE 'ok' END),
      jsonb_build_object('id','my-deliveries','module','delivery','label','My deliveries in hand',
        'value', n3, 'detail','Assigned to me and not yet delivered','route','/delivery/my-deliveries',
        'tone', CASE WHEN n3 > 0 THEN 'info' ELSE 'ok' END));
  END IF;

  -- ---- Maintenance ---------------------------------------------------------
  IF public.has_permission('maintenance', 'view') THEN
    SELECT count(*) INTO n1 FROM public.maintenance_work_orders w
     WHERE w.organization_id = v_org AND (_branch IS NULL OR w.branch_id = _branch)
       AND w.status IN ('new','assigned','accepted','diagnosis','waiting-parts','waiting-supplier','in-progress','reopened');
    SELECT count(*) INTO n2 FROM public.maintenance_work_orders w
     WHERE w.organization_id = v_org AND (_branch IS NULL OR w.branch_id = _branch)
       AND w.assigned_to = auth.uid()
       AND w.status IN ('new','assigned','accepted','diagnosis','waiting-parts','waiting-supplier','in-progress','reopened');
    SELECT count(*) INTO n3 FROM public.maintenance_work_orders w
     WHERE w.organization_id = v_org AND (_branch IS NULL OR w.branch_id = _branch)
       AND COALESCE(w.blocks_room, false)
       AND w.status NOT IN ('closed','cancelled','completed');

    v_items := v_items || jsonb_build_array(
      jsonb_build_object('id','my-work-orders','module','housekeeping','label','Work orders assigned to me',
        'value', n2, 'detail', n1 || ' open work order(s) in total','route','/maintenance/my-jobs',
        'tone', CASE WHEN n2 > 0 THEN 'info' ELSE 'ok' END),
      jsonb_build_object('id','rooms-blocked','module','housekeeping','label','Rooms held out of service',
        'value', n3, 'detail','Open faults recorded as blocking the room','route','/maintenance/work-orders',
        'tone', CASE WHEN n3 > 0 THEN 'warning' ELSE 'ok' END));
  END IF;

  -- ---- Stock ---------------------------------------------------------------
  IF public.has_permission('inventory', 'view') OR public.has_permission('stores', 'view') THEN
    SELECT count(*) INTO n1 FROM (
      SELECT si.id, COALESCE(sum(sl.quantity_on_hand), 0) AS qty, si.reorder_point
        FROM public.stock_items si
        LEFT JOIN public.stock_levels sl ON sl.stock_item_id = si.id
       WHERE si.organization_id = v_org AND COALESCE(si.active, true)
         AND si.reorder_point IS NOT NULL AND si.reorder_point > 0
         AND (_branch IS NULL OR si.branch_id IS NULL OR si.branch_id = _branch)
       GROUP BY si.id, si.reorder_point
      HAVING COALESCE(sum(sl.quantity_on_hand), 0) <= si.reorder_point) x;
    SELECT count(*) INTO n2 FROM public.stock_items si
     WHERE si.organization_id = v_org AND COALESCE(si.active, true)
       AND (si.reorder_point IS NULL OR si.reorder_point <= 0)
       AND (_branch IS NULL OR si.branch_id IS NULL OR si.branch_id = _branch);

    v_items := v_items || jsonb_build_array(
      jsonb_build_object('id','below-reorder','module','inventory','label','Items at or below reorder point',
        'value', n1, 'detail', n2 || ' item(s) have no reorder point configured','route','/inventory/items',
        'tone', CASE WHEN n1 > 0 THEN 'warning' ELSE 'ok' END));
  END IF;

  -- ---- Procurement ---------------------------------------------------------
  IF public.has_permission('procurement', 'view') THEN
    SELECT count(*) INTO n1 FROM public.purchase_requests pr
     WHERE pr.organization_id = v_org AND (_branch IS NULL OR pr.branch_id = _branch)
       AND pr.status IN ('submitted','draft');
    SELECT count(*) INTO n2 FROM public.purchase_orders po
     WHERE po.organization_id = v_org AND (_branch IS NULL OR po.branch_id = _branch)
       AND po.status NOT IN ('received','closed','cancelled','voided','fully-invoiced')
       AND po.expected_date IS NOT NULL AND po.expected_date < v_today;

    v_items := v_items || jsonb_build_array(
      jsonb_build_object('id','purchase-requests','module','procurement','label','Purchase requests awaiting action',
        'value', n1, 'detail','Submitted or still in draft','route','/procurement/requests',
        'tone', CASE WHEN n1 > 0 THEN 'info' ELSE 'ok' END),
      jsonb_build_object('id','overdue-pos','module','procurement','label','Purchase orders past their expected date',
        'value', n2, 'detail','Not yet fully received','route','/procurement/orders',
        'tone', CASE WHEN n2 > 0 THEN 'warning' ELSE 'ok' END));
  END IF;

  -- ---- Finance -------------------------------------------------------------
  IF public.has_permission('finance', 'view') THEN
    SELECT count(*) INTO n1 FROM public.journal_entries j
     WHERE j.organization_id = v_org AND (_branch IS NULL OR j.branch_id = _branch)
       AND j.status IN ('draft','pending_approval');
    SELECT count(*) INTO n2 FROM public.folios f
     WHERE f.organization_id = v_org AND (_branch IS NULL OR f.branch_id = _branch)
       AND f.status = 'open' AND COALESCE(f.balance, 0) > 0;

    v_items := v_items || jsonb_build_array(
      jsonb_build_object('id','unposted-journals','module','finance','label','Journals not yet posted',
        'value', n1, 'detail','Draft or awaiting approval','route','/finance/journals',
        'tone', CASE WHEN n1 > 0 THEN 'warning' ELSE 'ok' END),
      jsonb_build_object('id','open-folios','module','finance','label','Open folios carrying a balance',
        'value', n2, 'detail','Recorded folio balance greater than zero','route','/finance/ledger',
        'tone', CASE WHEN n2 > 0 THEN 'info' ELSE 'ok' END));
  END IF;

  -- ---- Events --------------------------------------------------------------
  IF public.has_permission('events', 'view') THEN
    SELECT count(*) INTO n1 FROM public.event_bookings e
     WHERE e.organization_id = v_org AND (_branch IS NULL OR e.branch_id = _branch)
       AND e.event_date BETWEEN v_today AND v_today + 7
       AND e.status NOT IN ('cancelled','closed','completed');
    SELECT count(*) INTO n2 FROM public.event_bookings e
     WHERE e.organization_id = v_org AND (_branch IS NULL OR e.branch_id = _branch)
       AND e.status NOT IN ('cancelled','closed','completed')
       AND COALESCE(e.deposit_required, 0) > COALESCE(e.deposit_paid, 0);

    v_items := v_items || jsonb_build_array(
      jsonb_build_object('id','events-week','module','events','label','Events in the next seven days',
        'value', n1, 'detail','Not cancelled or closed','route','/events/calendar',
        'tone', CASE WHEN n1 > 0 THEN 'info' ELSE 'ok' END),
      jsonb_build_object('id','events-deposits','module','events','label','Events with a deposit still due',
        'value', n2, 'detail','Recorded deposit paid is below the deposit required','route','/events/payments',
        'tone', CASE WHEN n2 > 0 THEN 'warning' ELSE 'ok' END));
  END IF;

  -- ---- Approvals and my tasks ---------------------------------------------
  SELECT count(*) INTO n1 FROM public.approval_requests a
   WHERE a.organization_id = v_org AND (_branch IS NULL OR a.branch_id = _branch)
     AND a.status = 'pending_approval' AND a.approver_id = auth.uid();
  IF n1 > 0 OR public.has_permission('approvals', 'view') THEN
    v_items := v_items || jsonb_build_array(
      jsonb_build_object('id','my-approvals','module','workforce','label','Approvals waiting for my decision',
        'value', n1, 'detail','Routed to me and still pending','route','/approvals',
        'tone', CASE WHEN n1 > 0 THEN 'warning' ELSE 'ok' END));
  END IF;

  SELECT count(*) INTO n1 FROM public.tasks t
   WHERE t.organization_id = v_org AND (_branch IS NULL OR t.branch_id = _branch)
     AND t.assignee_id = auth.uid() AND t.status IN ('new','open','assigned','in-progress');
  SELECT count(*) INTO n2 FROM public.tasks t
   WHERE t.organization_id = v_org AND (_branch IS NULL OR t.branch_id = _branch)
     AND t.assignee_id = auth.uid() AND t.status IN ('new','open','assigned','in-progress')
     AND t.due_at IS NOT NULL AND t.due_at < now();

  v_items := v_items || jsonb_build_array(
    jsonb_build_object('id','my-tasks','module','workforce','label','My open tasks',
      'value', n1, 'detail', n2 || ' already past due','route','/tasks',
      'tone', CASE WHEN n2 > 0 THEN 'warning' WHEN n1 > 0 THEN 'info' ELSE 'ok' END));

  RETURN jsonb_build_object(
    'authorised', true,
    'generated_at', now(),
    'timezone', v_tz,
    'today', v_today,
    'branch_id', _branch,
    'items', v_items);
END;
$function$;

REVOKE ALL ON FUNCTION public.neo_my_work(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.neo_my_work(uuid) TO authenticated, service_role;