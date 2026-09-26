
-- Guard used by every analytics function.
CREATE OR REPLACE FUNCTION public.bi_guard()
RETURNS uuid LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE _org uuid;
BEGIN
  _org := public.current_org_id();
  IF _org IS NULL THEN RAISE EXCEPTION 'No active organization'; END IF;
  IF NOT (public.is_org_admin() OR public.has_permission('analytics','view')) THEN
    RAISE EXCEPTION 'Not authorized for analytics';
  END IF;
  RETURN _org;
END; $$;
REVOKE ALL ON FUNCTION public.bi_guard() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.bi_guard() TO authenticated;

-- ============================================================
-- Headline KPI bundle
-- ============================================================
CREATE OR REPLACE FUNCTION public.bi_kpis(_branch uuid DEFAULT NULL, _from date DEFAULT NULL, _to date DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  _org uuid := public.bi_guard();
  f date := coalesce(_from, current_date - 29);
  t date := coalesce(_to, current_date);
  days int;
  sellable_rooms int;
  ooo_nights numeric := 0;
  avail_nights numeric;
  occ_nights numeric := 0;
  stays int := 0;
  room_rev numeric := 0;
  room_rev_basis text := 'folio_lines';
  res_total int := 0; res_cancel int := 0; res_noshow int := 0;
  pos_rev numeric := 0; pos_orders_n int := 0; pos_disc numeric := 0; pos_void int := 0; covers int := 0;
  del_rev numeric := 0; del_n int := 0; del_failed int := 0; del_ontime int := 0;
  ev_rev numeric := 0; ev_n int := 0; ev_pipeline numeric := 0;
  gl_rev numeric := 0; gl_exp numeric := 0;
  ar numeric := 0; ap numeric := 0;
  stock_value numeric := 0; low_stock int := 0; oos int := 0; cos numeric := 0;
  hk_done int := 0; hk_avg numeric; mt_open int := 0; mt_avg numeric;
  emp_n int := 0; fb_rating numeric; fb_open int := 0;
  cust_total int := 0; cust_new int := 0;
BEGIN
  days := GREATEST((t - f) + 1, 1);

  SELECT count(*) INTO sellable_rooms FROM public.rooms r
   WHERE r.organization_id = _org AND coalesce(r.sellable, true)
     AND (_branch IS NULL OR r.branch_id = _branch);

  SELECT coalesce(sum(GREATEST(0,
      (LEAST(coalesce(r.out_of_order_to::date, t), t) - GREATEST(coalesce(r.out_of_order_from::date, f), f)) + 1)), 0)
    INTO ooo_nights
    FROM public.rooms r
   WHERE r.organization_id = _org AND r.out_of_order_from IS NOT NULL
     AND (_branch IS NULL OR r.branch_id = _branch)
     AND r.out_of_order_from::date <= t AND coalesce(r.out_of_order_to::date, t) >= f;

  avail_nights := GREATEST(sellable_rooms::numeric * days - ooo_nights, 0);

  SELECT coalesce(sum(GREATEST(LEAST(res.departure_date, t + 1) - GREATEST(res.arrival_date, f), 0)), 0)
    INTO occ_nights
    FROM public.reservations res
   WHERE res.organization_id = _org
     AND (_branch IS NULL OR res.branch_id = _branch)
     AND res.status IN ('checked_in','in_house','checked_out','departed')
     AND res.arrival_date <= t AND res.departure_date > f;

  SELECT count(*) INTO stays FROM public.reservations res
   WHERE res.organization_id = _org AND (_branch IS NULL OR res.branch_id = _branch)
     AND res.status IN ('checked_out','departed') AND res.departure_date BETWEEN f AND t;

  SELECT coalesce(sum(fl.net_amount), 0) INTO room_rev
    FROM public.folio_lines fl
   WHERE fl.organization_id = _org AND (_branch IS NULL OR fl.branch_id = _branch)
     AND coalesce(fl.status,'posted') <> 'void'
     AND (lower(coalesce(fl.line_type,'')) LIKE '%room%' OR lower(coalesce(fl.category,'')) LIKE '%room%')
     AND coalesce(fl.operational_date, fl.posting_date::date) BETWEEN f AND t;

  IF room_rev = 0 THEN
    room_rev_basis := 'reservation_nightly_rate';
    SELECT coalesce(sum(coalesce(res.nightly_rate,0)
        * GREATEST(LEAST(res.departure_date, t + 1) - GREATEST(res.arrival_date, f), 0)), 0)
      INTO room_rev FROM public.reservations res
     WHERE res.organization_id = _org AND (_branch IS NULL OR res.branch_id = _branch)
       AND res.status IN ('checked_in','in_house','checked_out','departed')
       AND res.arrival_date <= t AND res.departure_date > f;
  END IF;

  SELECT count(*) FILTER (WHERE res.arrival_date BETWEEN f AND t),
         count(*) FILTER (WHERE res.status = 'cancelled' AND res.arrival_date BETWEEN f AND t),
         count(*) FILTER (WHERE res.status = 'no_show' AND res.arrival_date BETWEEN f AND t)
    INTO res_total, res_cancel, res_noshow
    FROM public.reservations res
   WHERE res.organization_id = _org AND (_branch IS NULL OR res.branch_id = _branch);

  SELECT coalesce(sum(o.grand_total) FILTER (WHERE o.status IN ('closed','paid','settled','completed')), 0),
         count(*) FILTER (WHERE o.status IN ('closed','paid','settled','completed')),
         coalesce(sum(o.discount_total) FILTER (WHERE o.status IN ('closed','paid','settled','completed')), 0),
         count(*) FILTER (WHERE o.status IN ('void','voided','cancelled')),
         coalesce(sum(o.guest_count) FILTER (WHERE o.status IN ('closed','paid','settled','completed')), 0)
    INTO pos_rev, pos_orders_n, pos_disc, pos_void, covers
    FROM public.pos_orders o
   WHERE o.organization_id = _org AND (_branch IS NULL OR o.branch_id = _branch)
     AND o.created_at::date BETWEEN f AND t;

  SELECT coalesce(sum(d.grand_total) FILTER (WHERE d.order_status = 'delivered'), 0),
         count(*) FILTER (WHERE d.order_status = 'delivered'),
         count(*) FILTER (WHERE d.order_status IN ('failed','cancelled','rejected')),
         count(*) FILTER (WHERE d.order_status = 'delivered' AND d.estimated_delivery_at IS NOT NULL
                            AND d.delivered_at <= d.estimated_delivery_at)
    INTO del_rev, del_n, del_failed, del_ontime
    FROM public.delivery_orders d
   WHERE d.organization_id = _org AND (_branch IS NULL OR d.branch_id = _branch)
     AND d.created_at::date BETWEEN f AND t;

  SELECT coalesce(sum(e.total_amount) FILTER (WHERE e.status IN ('confirmed','completed')), 0),
         count(*) FILTER (WHERE e.status IN ('confirmed','completed')),
         coalesce(sum(e.total_amount) FILTER (WHERE e.status IN ('enquiry','tentative','provisional','pending')), 0)
    INTO ev_rev, ev_n, ev_pipeline
    FROM public.event_bookings e
   WHERE e.organization_id = _org AND (_branch IS NULL OR e.branch_id = _branch)
     AND e.event_date BETWEEN f AND t;

  SELECT coalesce(sum(CASE WHEN lower(coalesce(a.category,a.account_group,'')) LIKE '%revenue%'
                             OR lower(coalesce(a.category,a.account_group,'')) LIKE '%income%'
                           THEN l.credit - l.debit ELSE 0 END), 0),
         coalesce(sum(CASE WHEN lower(coalesce(a.category,a.account_group,'')) LIKE '%expense%'
                             OR lower(coalesce(a.category,a.account_group,'')) LIKE '%cost%'
                           THEN l.debit - l.credit ELSE 0 END), 0)
    INTO gl_rev, gl_exp
    FROM public.journal_entry_lines l
    JOIN public.journal_entries j ON j.id = l.journal_id
    JOIN public.chart_of_accounts a ON a.id = l.account_id
   WHERE j.organization_id = _org AND j.status = 'posted'
     AND (_branch IS NULL OR j.branch_id = _branch)
     AND j.accounting_date BETWEEN f AND t;

  SELECT coalesce(sum(i.balance), 0) INTO ar FROM public.invoices i
   WHERE i.organization_id = _org AND (_branch IS NULL OR i.branch_id = _branch)
     AND coalesce(i.balance,0) > 0 AND i.status <> 'cancelled';

  SELECT coalesce(sum(GREATEST(coalesce(si.amount,0) - coalesce(si.paid_amount,0), 0)), 0) INTO ap
    FROM public.supplier_invoices si
   WHERE si.organization_id = _org AND (_branch IS NULL OR si.branch_id = _branch)
     AND coalesce(si.status,'') NOT IN ('paid','cancelled');

  SELECT coalesce(sum(sl.quantity_on_hand * coalesce(si.average_cost,0)), 0),
         count(*) FILTER (WHERE sl.quantity_on_hand > 0 AND sl.quantity_on_hand <= coalesce(si.min_level,0)),
         count(*) FILTER (WHERE sl.quantity_on_hand <= 0)
    INTO stock_value, low_stock, oos
    FROM public.stock_levels sl
    JOIN public.stock_items si ON si.id = sl.stock_item_id
   WHERE sl.organization_id = _org AND (_branch IS NULL OR si.branch_id = _branch);

  SELECT coalesce(sum(abs(coalesce(m.value,0))), 0) INTO cos
    FROM public.stock_movements m
   WHERE m.organization_id = _org AND (_branch IS NULL OR m.branch_id = _branch)
     AND lower(m.movement_type) IN ('issue','consumption','production_issue','wastage')
     AND m.created_at::date BETWEEN f AND t;

  SELECT count(*) FILTER (WHERE h.status = 'completed'),
         avg(EXTRACT(EPOCH FROM (h.completed_at - h.started_at))/60) FILTER (WHERE h.completed_at IS NOT NULL AND h.started_at IS NOT NULL)
    INTO hk_done, hk_avg
    FROM public.housekeeping_jobs h
   WHERE h.organization_id = _org AND (_branch IS NULL OR h.branch_id = _branch)
     AND h.created_at::date BETWEEN f AND t;

  SELECT count(*) FILTER (WHERE w.status NOT IN ('completed','closed','cancelled')),
         avg(EXTRACT(EPOCH FROM (w.completed_at - w.reported_at))/3600) FILTER (WHERE w.completed_at IS NOT NULL)
    INTO mt_open, mt_avg
    FROM public.maintenance_work_orders w
   WHERE w.organization_id = _org AND (_branch IS NULL OR w.branch_id = _branch);

  SELECT count(*) INTO emp_n FROM public.employees e
   WHERE e.organization_id = _org AND (_branch IS NULL OR e.branch_id = _branch)
     AND coalesce(e.employment_status,'active') IN ('active','probation','confirmed');

  SELECT avg(cf.rating) FILTER (WHERE cf.rating IS NOT NULL),
         count(*) FILTER (WHERE cf.status NOT IN ('resolved','closed'))
    INTO fb_rating, fb_open
    FROM public.customer_feedback cf
   WHERE cf.organization_id = _org AND (_branch IS NULL OR cf.branch_id = _branch)
     AND cf.created_at::date BETWEEN f AND t;

  SELECT count(*), count(*) FILTER (WHERE c.created_at::date BETWEEN f AND t)
    INTO cust_total, cust_new
    FROM public.customers c WHERE c.organization_id = _org AND c.archived_at IS NULL;

  RETURN jsonb_build_object(
    'period', jsonb_build_object('from', f, 'to', t, 'days', days),
    'generated_at', now(),
    'rooms', jsonb_build_object(
      'sellable_rooms', sellable_rooms,
      'available_room_nights', avail_nights,
      'out_of_order_nights', ooo_nights,
      'occupied_room_nights', occ_nights,
      'occupancy_rate', CASE WHEN avail_nights > 0 THEN round(occ_nights / avail_nights * 100, 2) END,
      'adr', CASE WHEN occ_nights > 0 THEN round(room_rev / occ_nights, 2) END,
      'revpar', CASE WHEN avail_nights > 0 THEN round(room_rev / avail_nights, 2) END,
      'room_revenue', room_rev,
      'room_revenue_basis', room_rev_basis,
      'alos', CASE WHEN stays > 0 THEN round(occ_nights / stays, 2) END,
      'completed_stays', stays,
      'reservations', res_total,
      'cancellation_rate', CASE WHEN res_total > 0 THEN round(res_cancel::numeric / res_total * 100, 2) END,
      'no_show_rate', CASE WHEN res_total > 0 THEN round(res_noshow::numeric / res_total * 100, 2) END
    ),
    'fnb', jsonb_build_object(
      'revenue', pos_rev, 'orders', pos_orders_n, 'covers', covers,
      'average_order_value', CASE WHEN pos_orders_n > 0 THEN round(pos_rev / pos_orders_n, 2) END,
      'discounts', pos_disc, 'voided_orders', pos_void,
      'cost_of_sales', cos,
      'cost_percentage', CASE WHEN pos_rev > 0 THEN round(cos / pos_rev * 100, 2) END,
      'cost_basis', 'stock issues, consumption and wastage over F&B revenue'
    ),
    'delivery', jsonb_build_object(
      'revenue', del_rev, 'orders', del_n, 'failed', del_failed,
      'on_time_rate', CASE WHEN del_n > 0 THEN round(del_ontime::numeric / del_n * 100, 2) END,
      'average_order_value', CASE WHEN del_n > 0 THEN round(del_rev / del_n, 2) END
    ),
    'events', jsonb_build_object('revenue', ev_rev, 'confirmed', ev_n, 'pipeline_value', ev_pipeline),
    'finance', jsonb_build_object(
      'posted_revenue', gl_rev, 'posted_expense', gl_exp,
      'net_profit', gl_rev - gl_exp,
      'net_margin', CASE WHEN gl_rev > 0 THEN round((gl_rev - gl_exp) / gl_rev * 100, 2) END,
      'accounts_receivable', ar, 'accounts_payable', ap,
      'labour_cost', NULL, 'labour_cost_availability', 'not_available'
    ),
    'inventory', jsonb_build_object('stock_value', stock_value, 'low_stock_items', low_stock, 'out_of_stock_items', oos),
    'operations', jsonb_build_object(
      'housekeeping_completed', hk_done,
      'housekeeping_avg_minutes', round(coalesce(hk_avg,0), 1),
      'maintenance_open', mt_open,
      'maintenance_avg_hours', round(coalesce(mt_avg,0), 1)
    ),
    'people', jsonb_build_object('active_employees', emp_n),
    'customers', jsonb_build_object(
      'total', cust_total, 'new', cust_new,
      'average_rating', CASE WHEN fb_rating IS NOT NULL THEN round(fb_rating, 2) END,
      'open_feedback', fb_open
    )
  );
END; $$;
REVOKE ALL ON FUNCTION public.bi_kpis(uuid, date, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.bi_kpis(uuid, date, date) TO authenticated;

-- ============================================================
-- Daily revenue series
-- ============================================================
CREATE OR REPLACE FUNCTION public.bi_revenue_series(_branch uuid DEFAULT NULL, _from date DEFAULT NULL, _to date DEFAULT NULL)
RETURNS TABLE(day date, rooms numeric, fnb numeric, delivery numeric, events numeric, posted numeric)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE _org uuid := public.bi_guard();
  f date := coalesce(_from, current_date - 29);
  t date := coalesce(_to, current_date);
BEGIN
  RETURN QUERY
  WITH d AS (SELECT generate_series(f, t, interval '1 day')::date AS day)
  SELECT d.day,
    coalesce((SELECT sum(fl.net_amount) FROM public.folio_lines fl
       WHERE fl.organization_id = _org AND (_branch IS NULL OR fl.branch_id = _branch)
         AND coalesce(fl.status,'posted') <> 'void'
         AND (lower(coalesce(fl.line_type,'')) LIKE '%room%' OR lower(coalesce(fl.category,'')) LIKE '%room%')
         AND coalesce(fl.operational_date, fl.posting_date::date) = d.day), 0)::numeric,
    coalesce((SELECT sum(o.grand_total) FROM public.pos_orders o
       WHERE o.organization_id = _org AND (_branch IS NULL OR o.branch_id = _branch)
         AND o.status IN ('closed','paid','settled','completed') AND o.created_at::date = d.day), 0)::numeric,
    coalesce((SELECT sum(dl.grand_total) FROM public.delivery_orders dl
       WHERE dl.organization_id = _org AND (_branch IS NULL OR dl.branch_id = _branch)
         AND dl.order_status = 'delivered' AND dl.created_at::date = d.day), 0)::numeric,
    coalesce((SELECT sum(e.total_amount) FROM public.event_bookings e
       WHERE e.organization_id = _org AND (_branch IS NULL OR e.branch_id = _branch)
         AND e.status IN ('confirmed','completed') AND e.event_date = d.day), 0)::numeric,
    coalesce((SELECT sum(l.credit - l.debit) FROM public.journal_entry_lines l
       JOIN public.journal_entries j ON j.id = l.journal_id
       JOIN public.chart_of_accounts a ON a.id = l.account_id
       WHERE j.organization_id = _org AND j.status = 'posted'
         AND (_branch IS NULL OR j.branch_id = _branch)
         AND (lower(coalesce(a.category,a.account_group,'')) LIKE '%revenue%'
              OR lower(coalesce(a.category,a.account_group,'')) LIKE '%income%')
         AND j.accounting_date = d.day), 0)::numeric
  FROM d ORDER BY d.day;
END; $$;
REVOKE ALL ON FUNCTION public.bi_revenue_series(uuid, date, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.bi_revenue_series(uuid, date, date) TO authenticated;

-- ============================================================
-- Daily occupancy series
-- ============================================================
CREATE OR REPLACE FUNCTION public.bi_occupancy_series(_branch uuid DEFAULT NULL, _from date DEFAULT NULL, _to date DEFAULT NULL)
RETURNS TABLE(day date, available integer, occupied integer, on_books integer, occupancy numeric)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE _org uuid := public.bi_guard();
  f date := coalesce(_from, current_date - 29);
  t date := coalesce(_to, current_date);
  sellable int;
BEGIN
  SELECT count(*) INTO sellable FROM public.rooms r
   WHERE r.organization_id = _org AND coalesce(r.sellable,true)
     AND (_branch IS NULL OR r.branch_id = _branch);

  RETURN QUERY
  WITH d AS (SELECT generate_series(f, t, interval '1 day')::date AS day)
  SELECT d.day,
    GREATEST(sellable - coalesce((SELECT count(*)::int FROM public.rooms r
        WHERE r.organization_id = _org AND (_branch IS NULL OR r.branch_id = _branch)
          AND r.out_of_order_from IS NOT NULL AND r.out_of_order_from::date <= d.day
          AND coalesce(r.out_of_order_to::date, d.day) >= d.day), 0), 0),
    coalesce((SELECT count(*)::int FROM public.reservations res
       WHERE res.organization_id = _org AND (_branch IS NULL OR res.branch_id = _branch)
         AND res.status IN ('checked_in','in_house','checked_out','departed')
         AND res.arrival_date <= d.day AND res.departure_date > d.day), 0),
    coalesce((SELECT count(*)::int FROM public.reservations res
       WHERE res.organization_id = _org AND (_branch IS NULL OR res.branch_id = _branch)
         AND res.status IN ('confirmed','tentative','guaranteed','checked_in','in_house')
         AND res.arrival_date <= d.day AND res.departure_date > d.day), 0),
    CASE WHEN sellable > 0 THEN round(coalesce((SELECT count(*) FROM public.reservations res
       WHERE res.organization_id = _org AND (_branch IS NULL OR res.branch_id = _branch)
         AND res.status IN ('checked_in','in_house','checked_out','departed')
         AND res.arrival_date <= d.day AND res.departure_date > d.day), 0)::numeric / sellable * 100, 2) ELSE NULL END
  FROM d ORDER BY d.day;
END; $$;
REVOKE ALL ON FUNCTION public.bi_occupancy_series(uuid, date, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.bi_occupancy_series(uuid, date, date) TO authenticated;

-- ============================================================
-- Revenue breakdown by dimension (department | branch | source)
-- ============================================================
CREATE OR REPLACE FUNCTION public.bi_revenue_breakdown(_dimension text DEFAULT 'department', _branch uuid DEFAULT NULL, _from date DEFAULT NULL, _to date DEFAULT NULL)
RETURNS TABLE(label text, amount numeric)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE _org uuid := public.bi_guard();
  f date := coalesce(_from, current_date - 29);
  t date := coalesce(_to, current_date);
BEGIN
  IF _dimension = 'branch' THEN
    RETURN QUERY
      SELECT coalesce(b.name,'Unassigned')::text, coalesce(sum(l.credit - l.debit), 0)::numeric
      FROM public.journal_entry_lines l
      JOIN public.journal_entries j ON j.id = l.journal_id
      JOIN public.chart_of_accounts a ON a.id = l.account_id
      LEFT JOIN public.branches b ON b.id = coalesce(l.branch_id, j.branch_id)
      WHERE j.organization_id = _org AND j.status='posted' AND j.accounting_date BETWEEN f AND t
        AND (lower(coalesce(a.category,a.account_group,'')) LIKE '%revenue%'
             OR lower(coalesce(a.category,a.account_group,'')) LIKE '%income%')
      GROUP BY 1 HAVING coalesce(sum(l.credit - l.debit),0) <> 0 ORDER BY 2 DESC;
  ELSIF _dimension = 'source' THEN
    RETURN QUERY
      SELECT coalesce(res.booking_source,'Direct')::text,
             coalesce(sum(coalesce(res.total_amount,0)),0)::numeric
      FROM public.reservations res
      WHERE res.organization_id = _org AND (_branch IS NULL OR res.branch_id = _branch)
        AND res.arrival_date BETWEEN f AND t
        AND res.status NOT IN ('cancelled','no_show')
      GROUP BY 1 ORDER BY 2 DESC;
  ELSE
    RETURN QUERY
      SELECT coalesce(d.name,'Unassigned')::text, coalesce(sum(l.credit - l.debit), 0)::numeric
      FROM public.journal_entry_lines l
      JOIN public.journal_entries j ON j.id = l.journal_id
      JOIN public.chart_of_accounts a ON a.id = l.account_id
      LEFT JOIN public.departments d ON d.id = l.department_id
      WHERE j.organization_id = _org AND j.status='posted' AND j.accounting_date BETWEEN f AND t
        AND (_branch IS NULL OR coalesce(l.branch_id, j.branch_id) = _branch)
        AND (lower(coalesce(a.category,a.account_group,'')) LIKE '%revenue%'
             OR lower(coalesce(a.category,a.account_group,'')) LIKE '%income%')
      GROUP BY 1 HAVING coalesce(sum(l.credit - l.debit),0) <> 0 ORDER BY 2 DESC;
  END IF;
END; $$;
REVOKE ALL ON FUNCTION public.bi_revenue_breakdown(text, uuid, date, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.bi_revenue_breakdown(text, uuid, date, date) TO authenticated;

-- ============================================================
-- Data quality scan (read-only)
-- ============================================================
CREATE OR REPLACE FUNCTION public.bi_data_quality_scan(_branch uuid DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE _org uuid := public.bi_guard(); out jsonb := '[]'::jsonb;
  n bigint;
BEGIN
  SELECT count(*) INTO n FROM public.reservations r WHERE r.organization_id=_org AND r.branch_id IS NULL;
  out := out || jsonb_build_object('code','reservations_missing_branch','category','Missing branch','module','Front Office','severity','warning','count',n);

  SELECT count(*) INTO n FROM public.pos_orders o WHERE o.organization_id=_org AND o.branch_id IS NULL;
  out := out || jsonb_build_object('code','pos_missing_branch','category','Missing branch','module','Restaurant','severity','warning','count',n);

  SELECT count(*) INTO n FROM public.journal_entries j WHERE j.organization_id=_org AND j.status <> 'posted';
  out := out || jsonb_build_object('code','unposted_journals','category','Unposted transactions','module','Finance','severity','warning','count',n);

  SELECT count(*) INTO n FROM public.invoices i WHERE i.organization_id=_org AND i.journal_id IS NULL AND i.status NOT IN ('draft','cancelled');
  out := out || jsonb_build_object('code','invoices_without_journal','category','Missing accounting mapping','module','Finance','severity','critical','count',n);

  SELECT count(*) INTO n FROM public.stock_levels sl WHERE sl.organization_id=_org AND sl.quantity_on_hand < 0;
  out := out || jsonb_build_object('code','negative_stock','category','Negative stock','module','Stores','severity','critical','count',n);

  SELECT count(*) INTO n FROM (
    SELECT si.supplier_id, si.invoice_number FROM public.supplier_invoices si
    WHERE si.organization_id=_org AND si.invoice_number IS NOT NULL
    GROUP BY 1,2 HAVING count(*) > 1) x;
  out := out || jsonb_build_object('code','duplicate_supplier_invoices','category','Duplicate transactions','module','Procurement','severity','critical','count',n);

  SELECT count(*) INTO n FROM public.customers c
   WHERE c.organization_id=_org AND c.archived_at IS NULL AND c.merged_into_id IS NULL
     AND coalesce(c.email,'') <> '' AND c.marketing_consent IS NULL;
  out := out || jsonb_build_object('code','customers_missing_consent','category','Missing consent','module','CRM','severity','warning','count',n);

  SELECT count(*) INTO n FROM public.customers c WHERE c.organization_id=_org AND c.merged_into_id IS NOT NULL;
  out := out || jsonb_build_object('code','merged_customers','category','Duplicate customers','module','CRM','severity','info','count',n);

  SELECT count(*) INTO n FROM public.rooms r
   WHERE r.organization_id=_org AND (r.housekeeping_status IS NULL OR r.occupancy_status IS NULL);
  out := out || jsonb_build_object('code','rooms_invalid_status','category','Invalid room status','module','Housekeeping','severity','warning','count',n);

  SELECT count(*) INTO n FROM public.attendance_records a
   WHERE a.organization_id=_org AND a.clock_in_at IS NOT NULL AND a.clock_out_at IS NULL
     AND a.work_date < current_date;
  out := out || jsonb_build_object('code','incomplete_attendance','category','Incomplete attendance','module','Human Resources','severity','warning','count',n);

  RETURN jsonb_build_object('generated_at', now(), 'issues', out);
END; $$;
REVOKE ALL ON FUNCTION public.bi_data_quality_scan(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.bi_data_quality_scan(uuid) TO authenticated;

-- ============================================================
-- Risk / anomaly scan (read-only, advisory)
-- ============================================================
CREATE OR REPLACE FUNCTION public.bi_risk_scan(_branch uuid DEFAULT NULL, _days integer DEFAULT 30)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE _org uuid := public.bi_guard();
  f date := current_date - GREATEST(coalesce(_days,30),1);
  out jsonb := '[]'::jsonb; n bigint; v numeric;
BEGIN
  SELECT count(*) INTO n FROM public.pos_orders o
   WHERE o.organization_id=_org AND (_branch IS NULL OR o.branch_id=_branch)
     AND o.status IN ('void','voided') AND o.created_at::date >= f;
  out := out || jsonb_build_object('code','excessive_voids','category','Bill voids','module','Restaurant','severity','warning','observed',n);

  SELECT coalesce(sum(o.discount_total),0) INTO v FROM public.pos_orders o
   WHERE o.organization_id=_org AND (_branch IS NULL OR o.branch_id=_branch)
     AND o.created_at::date >= f;
  out := out || jsonb_build_object('code','discount_value','category','Discounts','module','Restaurant','severity','info','observed',v);

  SELECT count(*) INTO n FROM public.delivery_orders d
   WHERE d.organization_id=_org AND (_branch IS NULL OR d.branch_id=_branch)
     AND d.payment_status = 'refunded' AND d.created_at::date >= f;
  out := out || jsonb_build_object('code','delivery_refunds','category','Refunds','module','Delivery','severity','warning','observed',n);

  SELECT count(*) INTO n FROM public.stock_levels sl WHERE sl.organization_id=_org AND sl.quantity_on_hand < 0;
  out := out || jsonb_build_object('code','negative_stock','category','Inventory discrepancy','module','Stores','severity','critical','observed',n);

  SELECT coalesce(sum(abs(coalesce(m.value,0))),0) INTO v FROM public.stock_movements m
   WHERE m.organization_id=_org AND (_branch IS NULL OR m.branch_id=_branch)
     AND lower(m.movement_type) IN ('wastage','damage','write_off') AND m.created_at::date >= f;
  out := out || jsonb_build_object('code','waste_value','category','Excessive waste','module','Kitchen','severity','warning','observed',v);

  SELECT count(*) INTO n FROM public.invoices i
   WHERE i.organization_id=_org AND (_branch IS NULL OR i.branch_id=_branch)
     AND coalesce(i.balance,0) > 0 AND i.due_date < current_date - 30;
  out := out || jsonb_build_object('code','overdue_invoices','category','Debt collection','module','Finance','severity','critical','observed',n);

  SELECT count(*) INTO n FROM (
    SELECT si.supplier_id, si.invoice_number FROM public.supplier_invoices si
     WHERE si.organization_id=_org AND si.invoice_number IS NOT NULL
     GROUP BY 1,2 HAVING count(*) > 1) x;
  out := out || jsonb_build_object('code','duplicate_supplier_invoices','category','Duplicate supplier invoice','module','Procurement','severity','critical','observed',n);

  RETURN jsonb_build_object('generated_at', now(), 'window_days', _days, 'signals', out);
END; $$;
REVOKE ALL ON FUNCTION public.bi_risk_scan(uuid, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.bi_risk_scan(uuid, integer) TO authenticated;
