CREATE OR REPLACE FUNCTION public.neo_facts(_branch uuid DEFAULT NULL::uuid, _from date DEFAULT NULL::date, _to date DEFAULT NULL::date)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  org uuid := public.current_org_id();
  tz text; today date; f date; t date; days int;
  can_money boolean; can_ops boolean; cur text;
  sellable int := 0; ooo_nights numeric := 0; avail numeric := 0;
  occ numeric := 0; on_books numeric := 0;
  folio_room numeric := 0; folio_other numeric := 0; folio_reversals numeric := 0;
  folio_discounts numeric := 0; folio_comp numeric := 0;
  pos_final numeric := 0; pos_final_n int := 0; pos_open numeric := 0; pos_open_n int := 0;
  pos_void numeric := 0; pos_void_n int := 0; pos_unposted numeric := 0; pos_disc numeric := 0;
  del_sales numeric := 0; del_n int := 0;
  ev_confirmed numeric := 0; ev_confirmed_n int := 0; ev_provisional numeric := 0;
  ev_provisional_n int := 0; ev_invoiced numeric := 0; ev_paid numeric := 0;
  gl_rev numeric := 0; gl_exp numeric := 0;
  gl_cos numeric := 0; gl_opex numeric := 0;
  payroll_cost numeric := 0; payroll_headcount int := 0; payroll_periods_n int := 0;
  stock_value numeric := 0; stock_issued numeric := 0;
  stock_turnover numeric; stock_days numeric;
  gross_profit numeric; gross_margin numeric; net_profit numeric; net_margin numeric;
  ar_open numeric := 0; ar_overdue numeric := 0; folio_bal numeric := 0;
  ap_open numeric := 0; refunds numeric := 0; collected numeric := 0;
  by_method jsonb := '{}'::jsonb;
  rev_today numeric := 0; rev_week numeric := 0; rev_month numeric := 0;
  net_recognised numeric := 0; staff_active int := 0; props_active int := 0;
BEGIN
  PERFORM public.neo_assert_reporting_scope(_branch, _from, _to);
  IF org IS NULL THEN
    RETURN jsonb_build_object('authorised', false, 'reason', 'no_organisation');
  END IF;

  can_money := public.is_org_admin()
    OR public.has_permission('finance', 'view')
    OR public.has_permission('analytics', 'view')
    OR public.has_permission('reports', 'view');
  can_ops := can_money OR public.has_permission('front-office', 'view');

  IF NOT can_ops THEN
    RETURN jsonb_build_object('authorised', false, 'reason', 'insufficient_capability');
  END IF;

  tz := public.neo_fact_timezone(org, _branch);
  cur := public.neo_fact_currency(org, _branch);
  today := (now() AT TIME ZONE tz)::date;
  t := coalesce(_to, today);
  f := coalesce(_from, t - 29);
  days := GREATEST((t - f) + 1, 1);

  SELECT count(*) INTO sellable FROM public.rooms r
   WHERE r.organization_id = org AND coalesce(r.sellable, true)
     AND (_branch IS NULL OR r.branch_id = _branch);

  SELECT coalesce(sum(GREATEST(0,
      (LEAST(coalesce(r.out_of_order_to::date, t), t) - GREATEST(coalesce(r.out_of_order_from::date, f), f)) + 1)), 0)
    INTO ooo_nights FROM public.rooms r
   WHERE r.organization_id = org AND r.out_of_order_from IS NOT NULL
     AND (_branch IS NULL OR r.branch_id = _branch)
     AND r.out_of_order_from::date <= t AND coalesce(r.out_of_order_to::date, t) >= f;

  avail := GREATEST(sellable::numeric * days - ooo_nights, 0);

  SELECT
    coalesce(sum(GREATEST(LEAST(res.departure_date, t + 1) - GREATEST(res.arrival_date, f), 0))
       FILTER (WHERE res.status IN ('checked_in','in_house','checked-in','in-house','checked_out','departed','checked-out')), 0),
    coalesce(sum(GREATEST(LEAST(res.departure_date, t + 1) - GREATEST(res.arrival_date, f), 0))
       FILTER (WHERE res.status IN ('confirmed','guaranteed','tentative','pending-deposit')), 0)
    INTO occ, on_books
    FROM public.reservations res
   WHERE res.organization_id = org AND (_branch IS NULL OR res.branch_id = _branch)
     AND res.arrival_date <= t AND res.departure_date > f;

  IF can_money THEN
    SELECT
      coalesce(sum(fl.net_amount) FILTER (WHERE fl.line_type = 'charge' AND fl.status = 'posted'
        AND (fl.category = 'accommodation' OR fl.revenue_centre = 'rooms')), 0),
      coalesce(sum(fl.net_amount) FILTER (WHERE fl.line_type = 'charge' AND fl.status = 'posted'
        AND NOT (fl.category = 'accommodation' OR fl.revenue_centre = 'rooms')), 0),
      coalesce(sum(abs(fl.net_amount)) FILTER (WHERE fl.reverses_line_id IS NOT NULL OR fl.status = 'reversed'), 0),
      coalesce(sum(fl.discount_amount) FILTER (WHERE fl.status = 'posted'), 0),
      coalesce(sum(fl.net_amount) FILTER (WHERE fl.status = 'posted' AND fl.category = 'complimentary'), 0)
      INTO folio_room, folio_other, folio_reversals, folio_discounts, folio_comp
      FROM public.folio_lines fl
     WHERE fl.organization_id = org AND (_branch IS NULL OR fl.branch_id = _branch)
       AND coalesce(fl.operational_date, (fl.posting_date AT TIME ZONE tz)::date) BETWEEN f AND t;

    SELECT
      coalesce(sum(o.grand_total) FILTER (WHERE o.status IN ('closed','paid','settled','completed')), 0),
      count(*) FILTER (WHERE o.status IN ('closed','paid','settled','completed')),
      coalesce(sum(o.grand_total) FILTER (WHERE o.status IN ('draft','sent','ready','served','open','in-progress')), 0),
      count(*) FILTER (WHERE o.status IN ('draft','sent','ready','served','open','in-progress')),
      coalesce(sum(o.grand_total) FILTER (WHERE o.status IN ('void','voided','cancelled')), 0),
      count(*) FILTER (WHERE o.status IN ('void','voided','cancelled')),
      coalesce(sum(o.grand_total) FILTER (WHERE o.status IN ('closed','paid','settled','completed')
        AND o.folio_post_status <> 'posted'), 0),
      coalesce(sum(o.discount_total) FILTER (WHERE o.status IN ('closed','paid','settled','completed')), 0)
      INTO pos_final, pos_final_n, pos_open, pos_open_n, pos_void, pos_void_n, pos_unposted, pos_disc
      FROM public.pos_orders o
     WHERE o.organization_id = org AND (_branch IS NULL OR o.branch_id = _branch)
       AND (o.created_at AT TIME ZONE tz)::date BETWEEN f AND t;

    SELECT coalesce(sum(d.grand_total) FILTER (WHERE d.order_status = 'delivered'), 0),
           count(*) FILTER (WHERE d.order_status = 'delivered')
      INTO del_sales, del_n
      FROM public.delivery_orders d
     WHERE d.organization_id = org AND (_branch IS NULL OR d.branch_id = _branch)
       AND (d.created_at AT TIME ZONE tz)::date BETWEEN f AND t;

    SELECT
      coalesce(sum(e.total_amount) FILTER (WHERE e.status IN ('confirmed','completed')), 0),
      count(*) FILTER (WHERE e.status IN ('confirmed','completed')),
      coalesce(sum(e.total_amount) FILTER (WHERE e.status IN ('enquiry','tentative','provisional','provisional-hold','pending')), 0),
      count(*) FILTER (WHERE e.status IN ('enquiry','tentative','provisional','provisional-hold','pending')),
      coalesce(sum(e.paid_amount), 0)
      INTO ev_confirmed, ev_confirmed_n, ev_provisional, ev_provisional_n, ev_paid
      FROM public.event_bookings e
     WHERE e.organization_id = org AND (_branch IS NULL OR e.branch_id = _branch)
       AND e.event_date BETWEEN f AND t;

    SELECT coalesce(sum(i.total), 0) INTO ev_invoiced FROM public.invoices i
     WHERE i.organization_id = org AND i.event_booking_id IS NOT NULL AND i.status <> 'cancelled'
       AND (_branch IS NULL OR i.branch_id = _branch) AND i.issue_date BETWEEN f AND t;

    SELECT coalesce(sum(CASE WHEN a.category = 'revenue' THEN l.credit - l.debit ELSE 0 END), 0),
           coalesce(sum(CASE WHEN a.category IN ('cost_of_sales','operating_expense','other_expense')
                             THEN l.debit - l.credit ELSE 0 END), 0),
           coalesce(sum(CASE WHEN a.category = 'cost_of_sales' THEN l.debit - l.credit ELSE 0 END), 0),
           coalesce(sum(CASE WHEN a.category IN ('operating_expense','other_expense')
                             THEN l.debit - l.credit ELSE 0 END), 0)
      INTO gl_rev, gl_exp, gl_cos, gl_opex
      FROM public.journal_entry_lines l
      JOIN public.journal_entries j ON j.id = l.journal_id AND j.status = 'posted'
      JOIN public.chart_of_accounts a ON a.id = l.account_id
     WHERE j.organization_id = org AND (_branch IS NULL OR j.branch_id = _branch)
       AND j.accounting_date BETWEEN f AND t;

    SELECT coalesce(sum(pir.gross_pay), 0),
           count(DISTINCT pir.employee_id),
           count(DISTINCT pp.id)
      INTO payroll_cost, payroll_headcount, payroll_periods_n
      FROM public.payroll_input_records pir
      JOIN public.payroll_periods pp ON pp.id = pir.period_id
     WHERE pp.organization_id = org
       AND (_branch IS NULL OR coalesce(pir.branch_id, pp.branch_id) = _branch)
       AND coalesce(pp.status, '') IN ('approved','locked','posted','closed')
       AND pp.period_end BETWEEN f AND t;

    SELECT coalesce(sum(sl.quantity_on_hand * coalesce(si.average_cost, 0)), 0)
      INTO stock_value
      FROM public.stock_levels sl
      JOIN public.stock_items si ON si.id = sl.stock_item_id
     WHERE sl.organization_id = org AND coalesce(si.active, true)
       AND (_branch IS NULL OR si.branch_id = _branch);

    SELECT coalesce(sum(abs(coalesce(sm.value, 0))), 0)
      INTO stock_issued
      FROM public.stock_movements sm
     WHERE sm.organization_id = org
       AND (_branch IS NULL OR sm.branch_id = _branch)
       AND sm.movement_type IN ('consumption','issue','wastage','waste')
       AND (sm.created_at AT TIME ZONE tz)::date BETWEEN f AND t;

    IF stock_value > 0 THEN
      stock_turnover := round(stock_issued / stock_value, 3);
      IF stock_issued > 0 THEN
        stock_days := round(stock_value / (stock_issued / days::numeric), 1);
      END IF;
    END IF;

    IF gl_rev <> 0 OR gl_cos <> 0 THEN
      gross_profit := gl_rev - gl_cos;
      IF gl_rev > 0 THEN gross_margin := round(gross_profit / gl_rev * 100, 2); END IF;
    END IF;
    IF gl_rev <> 0 OR gl_exp <> 0 THEN
      net_profit := gl_rev - gl_exp;
      IF gl_rev > 0 THEN net_margin := round(net_profit / gl_rev * 100, 2); END IF;
    END IF;

    SELECT coalesce(sum(i.balance) FILTER (WHERE i.balance > 0), 0),
           coalesce(sum(i.balance) FILTER (WHERE i.balance > 0 AND i.due_date < today), 0)
      INTO ar_open, ar_overdue FROM public.invoices i
     WHERE i.organization_id = org AND (_branch IS NULL OR i.branch_id = _branch)
       AND i.status IN ('issued','partially_paid','overdue');

    SELECT coalesce(sum(fo.balance), 0) INTO folio_bal FROM public.folios fo
     WHERE fo.organization_id = org AND fo.status = 'open'
       AND (_branch IS NULL OR fo.branch_id = _branch);

    SELECT coalesce(sum(GREATEST(coalesce(si.amount,0) - coalesce(si.paid_amount,0), 0)), 0)
      INTO ap_open FROM public.supplier_invoices si
     WHERE si.organization_id = org AND (_branch IS NULL OR si.branch_id = _branch)
       AND coalesce(si.status,'') NOT IN ('paid','cancelled','draft','rejected');

    SELECT coalesce(sum(cn.total), 0) INTO refunds FROM public.credit_notes cn
     WHERE cn.organization_id = org AND (_branch IS NULL OR cn.branch_id = _branch)
       AND cn.status IN ('issued','approved','applied') AND cn.issue_date BETWEEN f AND t;

    SELECT coalesce(sum(p.amount), 0) INTO collected FROM public.payments p
     WHERE p.organization_id = org AND (_branch IS NULL OR p.branch_id = _branch)
       AND p.status IN ('confirmed','successful')
       AND (p.paid_at AT TIME ZONE tz)::date BETWEEN f AND t;

    SELECT coalesce(jsonb_object_agg(m.method, m.total), '{}'::jsonb) INTO by_method
      FROM (SELECT p.method, sum(p.amount) total FROM public.payments p
             WHERE p.organization_id = org AND (_branch IS NULL OR p.branch_id = _branch)
               AND p.status IN ('confirmed','successful')
               AND (p.paid_at AT TIME ZONE tz)::date BETWEEN f AND t
             GROUP BY p.method) m;

    net_recognised := folio_room + folio_other + pos_unposted + del_sales - folio_reversals - refunds;
    rev_today := public.neo_recognised_revenue(org, _branch, today, today, tz);
    rev_week := public.neo_recognised_revenue(org, _branch, date_trunc('week', today)::date, today, tz);
    rev_month := public.neo_recognised_revenue(org, _branch, date_trunc('month', today)::date, today, tz);
  END IF;

  staff_active := public.neo_workforce_active_count(org, _branch);
  SELECT count(*) INTO props_active FROM public.branches b
   WHERE b.organization_id = org AND coalesce(b.active, true);

  RETURN jsonb_build_object(
    'authorised', true,
    'monetary_authorised', can_money,
    'generated_at', now(),
    'scope', jsonb_build_object('organization_id', org, 'branch_id', _branch,
      'timezone', tz, 'currency', cur, 'active_properties', props_active, 'active_staff', staff_active),
    'period', jsonb_build_object('from', f, 'to', t, 'days', days, 'local_today', today),
    'rooms', jsonb_build_object(
      'sellable_rooms', sellable, 'available_room_nights', avail,
      'out_of_order_nights', ooo_nights, 'occupied_room_nights', occ,
      'on_the_books_room_nights', on_books,
      'occupancy_rate', CASE WHEN avail > 0 THEN round(occ / avail * 100, 2) ELSE NULL END,
      'adr', CASE WHEN occ > 0 THEN round(folio_room / occ, 2) ELSE NULL END,
      'revpar', CASE WHEN avail > 0 THEN round(folio_room / avail, 2) ELSE NULL END),
    'operational', jsonb_build_object(
      'pos_finalised_sales', pos_final, 'pos_finalised_orders', pos_final_n,
      'pos_open_value', pos_open, 'pos_open_orders', pos_open_n,
      'pos_void_value', pos_void, 'pos_void_orders', pos_void_n,
      'pos_discounts', pos_disc, 'delivery_sales', del_sales, 'delivery_orders', del_n,
      'room_folio_revenue', folio_room, 'other_folio_revenue', folio_other,
      'complimentary_value', folio_comp, 'discounts', folio_discounts + pos_disc),
    'events', jsonb_build_object(
      'confirmed_forecast', ev_confirmed, 'confirmed_bookings', ev_confirmed_n,
      'provisional_forecast', ev_provisional, 'provisional_bookings', ev_provisional_n,
      'invoiced', ev_invoiced, 'collected', ev_paid),
    'accounting', jsonb_build_object(
      'posted_revenue', gl_rev, 'posted_expenses', gl_exp,
      'cost_of_sales', gl_cos, 'operating_expenses', gl_opex,
      'payroll_cost', payroll_cost,
      'gross_profit', gross_profit, 'gross_margin', gross_margin,
      'net_profit', net_profit, 'net_margin', net_margin,
      'net_recognised_revenue', net_recognised, 'reversals', folio_reversals, 'refunds', refunds,
      'revenue_today', rev_today, 'revenue_week', rev_week, 'revenue_month', rev_month),
    'payroll', jsonb_build_object(
      'approved_cost', payroll_cost, 'employees_paid', payroll_headcount,
      'periods', payroll_periods_n),
    'inventory', jsonb_build_object(
      'closing_valuation', stock_value, 'cost_of_issues', stock_issued,
      'stock_turnover', stock_turnover, 'days_on_hand', stock_days),
    'receivables', jsonb_build_object('invoices_outstanding', ar_open, 'invoices_overdue', ar_overdue,
      'open_folio_balances', folio_bal, 'total', ar_open + folio_bal),
    'payables', jsonb_build_object('supplier_invoices_outstanding', ap_open, 'total', ap_open),
    'collections', jsonb_build_object('total', collected, 'by_method', by_method),
    'eligibility', jsonb_build_object(
      'recognised_revenue', 'Posted folio charges, finalised point-of-sale orders not yet posted to a folio, and delivered delivery orders, less reversals and credit notes.',
      'pos', 'Only orders with status closed, paid, settled or completed are recognised. Draft, sent, ready and served orders are operational value, not revenue.',
      'events', 'Confirmed and provisional event bookings are forecast. Event revenue is recognised only when invoiced or posted.',
      'occupancy', 'Occupied room nights count stays that were checked in, in house, checked out or departed. Confirmed reservations not yet checked in are reported as on the books.',
      'receivables', 'Issued, partially paid and overdue invoices with a remaining balance, plus open folio balances.',
      'payables', 'Approved supplier invoices that are not paid or cancelled.',
      'profitability', 'Cost of sales, operating expenses and profit come from posted journal entries only. Unposted operational activity is never included.',
      'payroll', 'Approved, locked or posted payroll periods ending inside the reporting period. Draft payroll is excluded.',
      'stock_turnover', 'Cost of stock issued, consumed or wasted in the period divided by the value currently on hand at weighted average cost.'));
END $function$;