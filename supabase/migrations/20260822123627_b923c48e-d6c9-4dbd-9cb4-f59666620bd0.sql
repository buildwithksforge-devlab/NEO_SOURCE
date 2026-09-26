CREATE OR REPLACE FUNCTION public.neo_fact_timezone(_org uuid, _branch uuid DEFAULT NULL)
RETURNS text LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
  SELECT coalesce(
    (SELECT nullif(b.timezone, '') FROM public.branches b
      WHERE b.organization_id = _org AND (_branch IS NULL OR b.id = _branch)
      ORDER BY (b.id = _branch) DESC, b.created_at LIMIT 1),
    'Africa/Nairobi');
$$;

CREATE OR REPLACE FUNCTION public.neo_fact_currency(_org uuid, _branch uuid DEFAULT NULL)
RETURNS text LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
  SELECT coalesce(
    (SELECT nullif(b.currency, '') FROM public.branches b
      WHERE b.organization_id = _org AND (_branch IS NULL OR b.id = _branch)
      ORDER BY (b.id = _branch) DESC, b.created_at LIMIT 1),
    'KES');
$$;

CREATE OR REPLACE FUNCTION public.neo_local_today(_branch uuid DEFAULT NULL)
RETURNS date LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
  SELECT (now() AT TIME ZONE public.neo_fact_timezone(public.current_org_id(), _branch))::date;
$$;

CREATE OR REPLACE FUNCTION public.neo_recognised_revenue(
  _org uuid, _branch uuid, _from date, _to date, _tz text)
RETURNS numeric LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
  SELECT
    coalesce((SELECT sum(fl.net_amount) FROM public.folio_lines fl
       WHERE fl.organization_id = _org AND (_branch IS NULL OR fl.branch_id = _branch)
         AND fl.line_type = 'charge' AND fl.status = 'posted'
         AND coalesce(fl.operational_date, (fl.posting_date AT TIME ZONE _tz)::date) BETWEEN _from AND _to), 0)
  + coalesce((SELECT sum(o.grand_total) FROM public.pos_orders o
       WHERE o.organization_id = _org AND (_branch IS NULL OR o.branch_id = _branch)
         AND o.status IN ('closed','paid','settled','completed') AND o.folio_post_status <> 'posted'
         AND (o.created_at AT TIME ZONE _tz)::date BETWEEN _from AND _to), 0)
  + coalesce((SELECT sum(d.grand_total) FROM public.delivery_orders d
       WHERE d.organization_id = _org AND (_branch IS NULL OR d.branch_id = _branch)
         AND d.order_status = 'delivered'
         AND (d.created_at AT TIME ZONE _tz)::date BETWEEN _from AND _to), 0)
  - coalesce((SELECT sum(abs(fl.net_amount)) FROM public.folio_lines fl
       WHERE fl.organization_id = _org AND (_branch IS NULL OR fl.branch_id = _branch)
         AND (fl.reverses_line_id IS NOT NULL OR fl.status = 'reversed')
         AND coalesce(fl.operational_date, (fl.posting_date AT TIME ZONE _tz)::date) BETWEEN _from AND _to), 0)
  - coalesce((SELECT sum(cn.total) FROM public.credit_notes cn
       WHERE cn.organization_id = _org AND (_branch IS NULL OR cn.branch_id = _branch)
         AND cn.status IN ('issued','approved','applied') AND cn.issue_date BETWEEN _from AND _to), 0);
$$;

CREATE OR REPLACE FUNCTION public.neo_facts(
  _branch uuid DEFAULT NULL, _from date DEFAULT NULL, _to date DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
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
  ar_open numeric := 0; ar_overdue numeric := 0; folio_bal numeric := 0;
  ap_open numeric := 0; refunds numeric := 0; collected numeric := 0;
  by_method jsonb := '{}'::jsonb;
  rev_today numeric := 0; rev_week numeric := 0; rev_month numeric := 0;
  net_recognised numeric := 0; staff_active int := 0; props_active int := 0;
BEGIN
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
                             THEN l.debit - l.credit ELSE 0 END), 0)
      INTO gl_rev, gl_exp
      FROM public.journal_entry_lines l
      JOIN public.journal_entries j ON j.id = l.journal_id AND j.status = 'posted'
      JOIN public.chart_of_accounts a ON a.id = l.account_id
     WHERE j.organization_id = org AND (_branch IS NULL OR j.branch_id = _branch)
       AND j.accounting_date BETWEEN f AND t;

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

  SELECT count(*) INTO staff_active FROM public.profiles pr
   WHERE pr.organization_id = org AND coalesce(pr.status,'active') = 'active';
  SELECT count(*) INTO props_active FROM public.branches b
   WHERE b.organization_id = org AND coalesce(b.is_active, true);

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
      'net_recognised_revenue', net_recognised, 'reversals', folio_reversals, 'refunds', refunds,
      'revenue_today', rev_today, 'revenue_week', rev_week, 'revenue_month', rev_month),
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
      'payables', 'Approved supplier invoices that are not paid or cancelled.'));
END $$;

CREATE OR REPLACE FUNCTION public.neo_fact_reconciliation(
  _branch uuid DEFAULT NULL, _from date DEFAULT NULL, _to date DEFAULT NULL)
RETURNS TABLE(stream text, operational_eligible numeric, posted numeric, reversals numeric,
  net_recognised numeric, collected numeric, outstanding_receivable numeric, unmatched_records int)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE facts jsonb := public.neo_facts(_branch, _from, _to);
BEGIN
  IF NOT coalesce((facts->>'monetary_authorised')::boolean, false) THEN
    RAISE EXCEPTION 'insufficient_privilege' USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
  SELECT 'Rooms & folio'::text,
         (facts#>>'{operational,room_folio_revenue}')::numeric + (facts#>>'{operational,other_folio_revenue}')::numeric,
         (facts#>>'{operational,room_folio_revenue}')::numeric + (facts#>>'{operational,other_folio_revenue}')::numeric,
         (facts#>>'{accounting,reversals}')::numeric,
         (facts#>>'{operational,room_folio_revenue}')::numeric + (facts#>>'{operational,other_folio_revenue}')::numeric
           - (facts#>>'{accounting,reversals}')::numeric,
         (facts#>>'{collections,total}')::numeric,
         (facts#>>'{receivables,open_folio_balances}')::numeric,
         0
  UNION ALL
  SELECT 'Point of sale',
         (facts#>>'{operational,pos_finalised_sales}')::numeric,
         (facts#>>'{operational,pos_finalised_sales}')::numeric,
         (facts#>>'{operational,pos_void_value}')::numeric,
         (facts#>>'{operational,pos_finalised_sales}')::numeric,
         0::numeric, 0::numeric,
         (facts#>>'{operational,pos_open_orders}')::int
  UNION ALL
  SELECT 'Delivery',
         (facts#>>'{operational,delivery_sales}')::numeric,
         (facts#>>'{operational,delivery_sales}')::numeric,
         0::numeric, (facts#>>'{operational,delivery_sales}')::numeric, 0::numeric, 0::numeric, 0
  UNION ALL
  SELECT 'Events',
         (facts#>>'{events,confirmed_forecast}')::numeric,
         (facts#>>'{events,invoiced}')::numeric,
         0::numeric,
         (facts#>>'{events,invoiced}')::numeric,
         (facts#>>'{events,collected}')::numeric,
         GREATEST((facts#>>'{events,invoiced}')::numeric - (facts#>>'{events,collected}')::numeric, 0),
         (facts#>>'{events,confirmed_bookings}')::int
  UNION ALL
  SELECT 'All streams',
         (facts#>>'{operational,room_folio_revenue}')::numeric + (facts#>>'{operational,other_folio_revenue}')::numeric
           + (facts#>>'{operational,pos_finalised_sales}')::numeric + (facts#>>'{operational,delivery_sales}')::numeric,
         (facts#>>'{accounting,posted_revenue}')::numeric,
         (facts#>>'{accounting,reversals}')::numeric + (facts#>>'{accounting,refunds}')::numeric,
         (facts#>>'{accounting,net_recognised_revenue}')::numeric,
         (facts#>>'{collections,total}')::numeric,
         (facts#>>'{receivables,total}')::numeric,
         0;
END $$;

CREATE OR REPLACE FUNCTION public.neo_unmatched_facts(
  _branch uuid DEFAULT NULL, _from date DEFAULT NULL, _to date DEFAULT NULL)
RETURNS TABLE(source_module text, source_id uuid, reference text, status text,
  amount numeric, occurred_on date, reason text, drill_to text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE org uuid := public.current_org_id(); tz text; t date; f date;
BEGIN
  IF org IS NULL OR NOT (public.is_org_admin() OR public.has_permission('finance','view')
      OR public.has_permission('analytics','view') OR public.has_permission('reports','view')) THEN
    RAISE EXCEPTION 'insufficient_privilege' USING ERRCODE = '42501';
  END IF;
  tz := public.neo_fact_timezone(org, _branch);
  t := coalesce(_to, (now() AT TIME ZONE tz)::date);
  f := coalesce(_from, t - 29);

  RETURN QUERY
  SELECT * FROM (
    SELECT 'pos'::text AS source_module, o.id AS source_id, o.order_number AS reference,
           o.status AS status, o.grand_total AS amount,
           (o.created_at AT TIME ZONE tz)::date AS occurred_on,
           CASE WHEN o.status IN ('closed','paid','settled','completed')
                THEN 'Finalised but not posted to a folio'
                ELSE 'Not finalised — ' || o.status || ' orders are operational value, not revenue' END AS reason,
           '/pos/orders'::text AS drill_to
      FROM public.pos_orders o
     WHERE o.organization_id = org AND (_branch IS NULL OR o.branch_id = _branch)
       AND (o.created_at AT TIME ZONE tz)::date BETWEEN f AND t
       AND o.status NOT IN ('void','voided','cancelled')
       AND (o.status NOT IN ('closed','paid','settled','completed') OR o.folio_post_status <> 'posted')
    UNION ALL
    SELECT 'events', e.id, coalesce(e.event_reference, e.id::text), e.status, e.total_amount, e.event_date,
           CASE WHEN e.status IN ('confirmed','completed')
                THEN 'Confirmed forecast — no invoice issued, so not accounting revenue'
                ELSE 'Provisional forecast — excluded from revenue until confirmed and invoiced' END,
           '/events/bookings'
      FROM public.event_bookings e
     WHERE e.organization_id = org AND (_branch IS NULL OR e.branch_id = _branch)
       AND e.event_date BETWEEN f AND t
       AND NOT EXISTS (SELECT 1 FROM public.invoices i WHERE i.event_booking_id = e.id AND i.status <> 'cancelled')
    UNION ALL
    SELECT 'delivery', d.id, d.order_number, d.order_status, d.grand_total,
           (d.created_at AT TIME ZONE tz)::date,
           'Not delivered — excluded until the delivery is confirmed', '/delivery'
      FROM public.delivery_orders d
     WHERE d.organization_id = org AND (_branch IS NULL OR d.branch_id = _branch)
       AND (d.created_at AT TIME ZONE tz)::date BETWEEN f AND t
       AND d.order_status NOT IN ('delivered','cancelled','rejected','failed')
  ) u
  ORDER BY u.occurred_on DESC
  LIMIT 200;
END $$;

CREATE OR REPLACE FUNCTION public.neo_post_pos_order(_order uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE org uuid := public.current_org_id(); o public.pos_orders; line uuid;
BEGIN
  IF org IS NULL OR NOT (public.is_org_admin() OR public.has_permission('finance','view')) THEN
    RAISE EXCEPTION 'insufficient_privilege' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO o FROM public.pos_orders WHERE id = _order AND organization_id = org;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'reason', 'not_found'); END IF;
  IF o.status NOT IN ('closed','paid','settled','completed') THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_finalised', 'status', o.status);
  END IF;
  IF o.folio_post_status = 'posted' THEN
    RETURN jsonb_build_object('ok', true, 'reason', 'already_posted');
  END IF;
  IF o.folio_id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'no_folio',
      'detail', 'The order is not attached to a guest folio, so it cannot be posted as a folio charge.');
  END IF;
  line := public.folio_post_charge(o.folio_id, 'food-beverage',
    'Point of sale order ' || o.order_number, 1, o.grand_total, o.tax_total,
    o.service_charge_total, o.discount_total, 'pos', o.id, 'fnb', 'pos:' || o.id::text, NULL);
  UPDATE public.pos_orders SET folio_post_status = 'posted', updated_at = now() WHERE id = o.id;
  RETURN jsonb_build_object('ok', true, 'folio_line_id', line);
END $$;

CREATE OR REPLACE FUNCTION public.neo_backfill_operational_postings(
  _branch uuid DEFAULT NULL, _from date DEFAULT NULL, _to date DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE org uuid := public.current_org_id(); tz text; f date; t date; r record; res jsonb;
  posted int := 0; skipped int := 0; failed int := 0; details jsonb := '[]'::jsonb;
BEGIN
  IF org IS NULL OR NOT (public.is_org_admin() OR public.has_permission('finance','view')) THEN
    RAISE EXCEPTION 'insufficient_privilege' USING ERRCODE = '42501';
  END IF;
  tz := public.neo_fact_timezone(org, _branch);
  t := coalesce(_to, (now() AT TIME ZONE tz)::date);
  f := coalesce(_from, t - 365);

  FOR r IN
    SELECT o.id, o.order_number FROM public.pos_orders o
     WHERE o.organization_id = org AND (_branch IS NULL OR o.branch_id = _branch)
       AND o.status IN ('closed','paid','settled','completed')
       AND o.folio_post_status <> 'posted'
       AND (o.created_at AT TIME ZONE tz)::date BETWEEN f AND t
  LOOP
    BEGIN
      res := public.neo_post_pos_order(r.id);
      IF coalesce((res->>'ok')::boolean, false) THEN posted := posted + 1;
      ELSE
        skipped := skipped + 1;
        details := details || jsonb_build_object('order', r.order_number, 'reason', res->>'reason');
      END IF;
    EXCEPTION WHEN OTHERS THEN
      failed := failed + 1;
      details := details || jsonb_build_object('order', r.order_number, 'error', SQLERRM);
      INSERT INTO public.integrity_repair_jobs(organization_id, check_key, idempotency_key,
        run_window, status, last_error, evidence)
      VALUES (org, 'pos_folio_handoff', 'pos_folio_handoff:' || r.id::text, now(), 'failed', SQLERRM,
        jsonb_build_object('pos_order_id', r.id, 'order_number', r.order_number))
      ON CONFLICT DO NOTHING;
    END;
  END LOOP;

  RETURN jsonb_build_object('posted', posted, 'skipped', skipped, 'failed', failed, 'details', details);
END $$;

REVOKE ALL ON FUNCTION public.neo_fact_timezone(uuid, uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.neo_fact_currency(uuid, uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.neo_local_today(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.neo_recognised_revenue(uuid, uuid, date, date, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.neo_facts(uuid, date, date) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.neo_fact_reconciliation(uuid, date, date) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.neo_unmatched_facts(uuid, date, date) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.neo_post_pos_order(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.neo_backfill_operational_postings(uuid, date, date) FROM PUBLIC, anon;

GRANT EXECUTE ON FUNCTION public.neo_local_today(uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.neo_facts(uuid, date, date) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.neo_fact_reconciliation(uuid, date, date) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.neo_unmatched_facts(uuid, date, date) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.neo_post_pos_order(uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.neo_backfill_operational_postings(uuid, date, date) TO authenticated, service_role;