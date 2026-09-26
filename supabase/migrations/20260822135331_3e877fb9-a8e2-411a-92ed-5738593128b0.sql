-- NEØ: posting drilldowns and reconciliation status. Additive only.

CREATE OR REPLACE FUNCTION public.neo_module_label(_module text)
RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE
    WHEN _module IN ('pos','pos_order') THEN 'pos'
    WHEN _module IN ('folio','folio_charge','folio_payment') THEN 'folio'
    WHEN _module IN ('events','event_earned','event_deposit','event_invoice','event_cancellation') THEN 'events'
    WHEN _module IN ('laundry','laundry_order') THEN 'laundry'
    WHEN _module IN ('delivery','delivery_order') THEN 'delivery'
    WHEN _module IN ('procurement','supplier_invoice','supplier_payment') THEN 'procurement'
    ELSE coalesce(_module,'other') END
$$;
REVOKE ALL ON FUNCTION public.neo_module_label(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.neo_module_label(text) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.neo_posting_plan(_module text, _source uuid)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  org uuid := public.current_org_id();
  st text; branch uuid; ref text; cur text; occurred date;
  amount numeric := 0; net numeric := 0; tax numeric := 0; svc numeric := 0;
  posting text := 'revenue'; eligible boolean := false; blocked text;
  settle text; lines jsonb := '[]'::jsonb; paid numeric; remainder numeric;
  o public.pos_orders; fl public.folio_lines; ev public.event_bookings;
  lo public.guest_laundry_orders; si public.supplier_invoices; deliv record;
  receipt jsonb; journal jsonb; reversal jsonb; jid uuid;
BEGIN
  IF org IS NULL THEN RETURN jsonb_build_object('ok', false, 'reason', 'no_organisation'); END IF;
  IF NOT (public.is_org_admin() OR public.has_permission('finance','view')) THEN
    RAISE EXCEPTION 'insufficient_privilege' USING ERRCODE = '42501';
  END IF;

  st := CASE public.neo_module_label(_module)
          WHEN 'pos' THEN 'pos_order'
          WHEN 'folio' THEN 'folio_charge'
          WHEN 'events' THEN 'event_earned'
          WHEN 'laundry' THEN 'laundry_order'
          WHEN 'delivery' THEN 'delivery_order'
          WHEN 'procurement' THEN 'supplier_invoice'
          ELSE _module END;

  IF st = 'pos_order' THEN
    SELECT * INTO o FROM public.pos_orders WHERE id = _source AND organization_id = org;
    IF o.id IS NULL THEN RETURN jsonb_build_object('ok', false, 'reason', 'not_found'); END IF;
    branch := o.branch_id; ref := o.order_number; amount := coalesce(o.grand_total,0);
    occurred := (coalesce(o.closed_at, o.created_at))::date;
    net := coalesce(o.subtotal,0) - coalesce(o.discount_total,0);
    tax := coalesce(o.tax_total,0); svc := coalesce(o.service_charge_total,0);
    eligible := o.status IN ('closed','paid','settled','completed');
    IF NOT eligible THEN
      blocked := 'Order is ' || o.status || '. Draft, sent, ready and served orders are not revenue.';
    END IF;
    IF o.folio_id IS NOT NULL THEN
      posting := 'room_charge';
      lines := jsonb_build_array(
        jsonb_build_object('code','1060','debit',amount,'description','Guest ledger - routed to folio'),
        jsonb_build_object('code', public.neo_gl_revenue_code(o.order_type),'credit',net,'description','Outlet revenue'),
        jsonb_build_object('code','2040','credit',tax,'description','VAT payable'),
        jsonb_build_object('code','2050','credit',svc,'description','Service charge payable'));
    ELSE
      IF o.corporate_account_id IS NOT NULL AND coalesce(o.paid_total,0) < amount THEN
        settle := '1060';
      ELSE
        SELECT public.neo_gl_settlement_code(p.method) INTO settle
          FROM public.pos_payments p WHERE p.order_id = o.id
           AND p.status IN ('paid','completed','captured','settled')
          ORDER BY p.amount DESC LIMIT 1;
        settle := coalesce(settle,'1010');
      END IF;
      lines := jsonb_build_array(
        jsonb_build_object('code',settle,'debit',amount,'description','Settlement ' || coalesce(ref,'')),
        jsonb_build_object('code', public.neo_gl_revenue_code(o.order_type),'credit',net,'description','Outlet revenue'),
        jsonb_build_object('code','2040','credit',tax,'description','VAT payable'),
        jsonb_build_object('code','2050','credit',svc,'description','Service charge payable'));
    END IF;

  ELSIF st = 'folio_charge' THEN
    SELECT * INTO fl FROM public.folio_lines WHERE id = _source AND organization_id = org;
    IF fl.id IS NULL THEN RETURN jsonb_build_object('ok', false, 'reason', 'not_found'); END IF;
    branch := fl.branch_id; ref := coalesce(fl.reference, fl.description);
    occurred := coalesce(fl.operational_date, fl.posting_date::date);
    net := coalesce(fl.net_amount,0); tax := coalesce(fl.tax_amount,0);
    svc := coalesce(fl.service_charge_amount,0); amount := net + tax + svc;
    eligible := fl.status = 'posted' AND coalesce(fl.line_type,'charge') <> 'payment' AND amount > 0;
    IF NOT eligible THEN blocked := 'Only posted folio charges with a value are recognised.'; END IF;
    lines := jsonb_build_array(
      jsonb_build_object('code','1060','debit',amount,'description','Guest ledger ' || coalesce(ref,'')),
      jsonb_build_object('code', public.neo_gl_revenue_code(fl.category),'credit',net,'description','Revenue'),
      jsonb_build_object('code','2040','credit',tax,'description','VAT payable'),
      jsonb_build_object('code','2050','credit',svc,'description','Service charge payable'));

  ELSIF st = 'event_earned' THEN
    SELECT * INTO ev FROM public.event_bookings WHERE id = _source AND organization_id = org;
    IF ev.id IS NULL THEN RETURN jsonb_build_object('ok', false, 'reason', 'not_found'); END IF;
    branch := ev.branch_id; ref := ev.event_reference; occurred := ev.event_date;
    amount := coalesce(ev.total_amount,0); posting := 'earned';
    eligible := ev.status IN ('completed','closed') AND amount > 0;
    IF NOT eligible THEN
      blocked := 'Event is ' || ev.status || '. Confirmed and provisional bookings are forecast, not revenue.';
    END IF;
    paid := least(coalesce(ev.deposit_paid,0), amount); remainder := amount - paid;
    lines := jsonb_build_array(
      jsonb_build_object('code','2030','debit',paid,'description','Event deposit applied'),
      jsonb_build_object('code','1060','debit',remainder,'description','Event receivable'),
      jsonb_build_object('code','4060','credit',amount,'description','Event revenue ' || coalesce(ref,'')));

  ELSIF st = 'laundry_order' THEN
    SELECT * INTO lo FROM public.guest_laundry_orders WHERE id = _source AND organization_id = org;
    IF lo.id IS NULL THEN RETURN jsonb_build_object('ok', false, 'reason', 'not_found'); END IF;
    branch := lo.branch_id; ref := lo.laundry_number; amount := coalesce(lo.total,0);
    occurred := coalesce(lo.delivered_at, lo.created_at)::date; tax := coalesce(lo.tax_amount,0);
    eligible := lo.status IN ('delivered','completed','closed');
    IF NOT eligible THEN blocked := 'Only completed laundry orders are recognised.'; END IF;
    IF lo.folio_id IS NOT NULL THEN
      posting := 'folio_charge';
      lines := jsonb_build_array(
        jsonb_build_object('code','1060','debit',amount,'description','Guest ledger - laundry ' || coalesce(ref,'')),
        jsonb_build_object('code','4050','credit',amount - tax,'description','Laundry revenue'),
        jsonb_build_object('code','2040','credit',tax,'description','VAT payable'));
    ELSE
      lines := jsonb_build_array(
        jsonb_build_object('code','1010','debit',amount,'description','Laundry ' || coalesce(ref,'')),
        jsonb_build_object('code','4050','credit',amount - tax,'description','Laundry revenue'),
        jsonb_build_object('code','2040','credit',tax,'description','VAT payable'));
    END IF;

  ELSIF st = 'delivery_order' THEN
    SELECT d.id, d.branch_id, d.order_number, d.grand_total, d.tax_total, d.order_status,
           d.payment_status, d.payment_method, d.delivered_at, d.created_at
      INTO deliv FROM public.delivery_orders d WHERE d.id = _source AND d.organization_id = org;
    IF deliv.id IS NULL THEN RETURN jsonb_build_object('ok', false, 'reason', 'not_found'); END IF;
    branch := deliv.branch_id; ref := deliv.order_number; amount := coalesce(deliv.grand_total,0);
    tax := coalesce(deliv.tax_total,0); occurred := coalesce(deliv.delivered_at, deliv.created_at)::date;
    eligible := deliv.order_status IN ('delivered','completed');
    IF NOT eligible THEN blocked := 'Only completed deliveries are recognised.'; END IF;
    settle := CASE WHEN deliv.payment_status IN ('paid','settled','completed')
                   THEN public.neo_gl_settlement_code(deliv.payment_method) ELSE '1060' END;
    lines := jsonb_build_array(
      jsonb_build_object('code',settle,'debit',amount,'description','Delivery ' || coalesce(ref,'')),
      jsonb_build_object('code','4070','credit',amount - tax,'description','Delivery revenue'),
      jsonb_build_object('code','2040','credit',tax,'description','VAT payable'));

  ELSIF st = 'supplier_invoice' THEN
    SELECT * INTO si FROM public.supplier_invoices WHERE id = _source AND organization_id = org;
    IF si.id IS NULL THEN RETURN jsonb_build_object('ok', false, 'reason', 'not_found'); END IF;
    branch := si.branch_id; ref := si.invoice_number; occurred := si.invoice_date;
    amount := coalesce(si.amount,0); tax := coalesce(si.tax_amount,0); posting := 'payable';
    eligible := si.approved_at IS NOT NULL AND si.status IN ('approved','matched','partially_paid','paid');
    IF NOT eligible THEN
      blocked := 'Only approved supplier invoices become payables. Requests and purchase orders do not.';
    END IF;
    lines := jsonb_build_array(
      jsonb_build_object('code','1070','debit',amount - tax,'description','Goods / services received'),
      jsonb_build_object('code','2040','debit',tax,'description','Input VAT'),
      jsonb_build_object('code','2010','credit',amount,'description','Supplier invoice ' || coalesce(ref,'')));
  ELSE
    RETURN jsonb_build_object('ok', false, 'reason', 'unknown_source_type');
  END IF;

  cur := public.neo_fact_currency(org, branch);

  SELECT coalesce(jsonb_agg(x ORDER BY ord), '[]'::jsonb) INTO lines
  FROM (
    SELECT row_number() OVER () AS ord,
           jsonb_build_object(
             'code', l->>'code',
             'account', coalesce(a.name, 'Account ' || (l->>'code') || ' is not in the chart of accounts'),
             'category', a.category,
             'debit', round(coalesce((l->>'debit')::numeric,0),2),
             'credit', round(coalesce((l->>'credit')::numeric,0),2),
             'description', l->>'description',
             'configured', (a.id IS NOT NULL)) AS x
      FROM jsonb_array_elements(lines) l
      LEFT JOIN public.chart_of_accounts a
        ON a.organization_id = org AND a.code = (l->>'code')
     WHERE round(coalesce((l->>'debit')::numeric,0),2) <> 0
        OR round(coalesce((l->>'credit')::numeric,0),2) <> 0
  ) s;

  SELECT to_jsonb(r) INTO receipt FROM (
    SELECT id, status, amount, currency, attempts, detail, last_error, posted_at,
           posting_type, journal_id, reverses_receipt_id
      FROM public.finance_posting_receipts
     WHERE organization_id = org AND source_id = _source
     ORDER BY updated_at DESC LIMIT 1) r;

  jid := (receipt->>'journal_id')::uuid;
  IF jid IS NULL THEN
    SELECT je.id INTO jid FROM public.journal_entries je
     WHERE je.organization_id = org AND je.source_document_id = _source
     ORDER BY je.created_at DESC LIMIT 1;
  END IF;

  IF jid IS NOT NULL THEN
    SELECT jsonb_build_object(
             'id', je.id, 'number', je.journal_number, 'status', je.status,
             'accounting_date', je.accounting_date, 'total_debit', je.total_debit,
             'total_credit', je.total_credit,
             'lines', coalesce((
               SELECT jsonb_agg(jsonb_build_object('code', a.code, 'account', a.name,
                        'debit', jl.debit, 'credit', jl.credit, 'description', jl.description)
                        ORDER BY jl.line_number)
                 FROM public.journal_entry_lines jl
                 JOIN public.chart_of_accounts a ON a.id = jl.account_id
                WHERE jl.journal_id = je.id), '[]'::jsonb))
      INTO journal FROM public.journal_entries je WHERE je.id = jid;

    SELECT jsonb_build_object('id', je.id, 'number', je.journal_number,
                              'accounting_date', je.accounting_date, 'status', je.status)
      INTO reversal FROM public.journal_entries je
     WHERE je.organization_id = org AND je.reverses_journal_id = jid
     ORDER BY je.created_at DESC LIMIT 1;
  END IF;

  RETURN jsonb_build_object(
    'ok', true, 'source_type', st, 'source_id', _source, 'module', public.neo_module_label(_module),
    'reference', ref, 'currency', cur, 'occurred_on', occurred, 'amount', round(amount,2),
    'posting_type', posting, 'eligible', eligible, 'blocked_reason', blocked,
    'lines', lines,
    'total_debit', (SELECT round(coalesce(sum((l->>'debit')::numeric),0),2) FROM jsonb_array_elements(lines) l),
    'total_credit', (SELECT round(coalesce(sum((l->>'credit')::numeric),0),2) FROM jsonb_array_elements(lines) l),
    'receipt', receipt, 'journal', journal, 'reversal', reversal);
END $$;
REVOKE ALL ON FUNCTION public.neo_posting_plan(text,uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.neo_posting_plan(text,uuid) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.neo_reconciliation_status(
  _branch uuid DEFAULT NULL, _from date DEFAULT NULL, _to date DEFAULT NULL)
RETURNS TABLE (module text, eligible integer, blocked integer, posted integer,
               skipped integer, failed integer, duplicate_prevented integer, reversed integer)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public
AS $$
DECLARE org uuid := public.current_org_id(); tz text; f date; t date;
BEGIN
  IF org IS NULL OR NOT (public.is_org_admin() OR public.has_permission('finance','view')) THEN
    RAISE EXCEPTION 'insufficient_privilege' USING ERRCODE = '42501';
  END IF;
  tz := public.neo_fact_timezone(org, _branch);
  t := coalesce(_to, (now() AT TIME ZONE tz)::date);
  f := coalesce(_from, t - 29);

  RETURN QUERY
  WITH q AS (
    SELECT public.neo_module_label(k.source_module) AS m,
           count(*) FILTER (WHERE k.eligible) AS eligible,
           count(*) FILTER (WHERE NOT k.eligible) AS blocked
      FROM public.neo_finance_posting_queue(_branch, f, t) k
     GROUP BY 1
  ), r AS (
    SELECT public.neo_module_label(x.source_module) AS m,
           count(*) FILTER (WHERE x.status = 'posted') AS posted,
           count(*) FILTER (WHERE x.status = 'blocked') AS skipped,
           count(*) FILTER (WHERE x.status = 'failed') AS failed,
           count(*) FILTER (WHERE coalesce(x.detail,'') ILIKE 'Duplicate replay prevented%') AS dup,
           count(*) FILTER (WHERE x.reverses_receipt_id IS NOT NULL) AS reversed
      FROM public.finance_posting_receipts x
     WHERE x.organization_id = org
       AND (_branch IS NULL OR x.branch_id = _branch)
       AND coalesce(x.occurred_on, (x.created_at AT TIME ZONE tz)::date) BETWEEN f AND t
     GROUP BY 1
  )
  SELECT coalesce(q.m, r.m)::text,
         coalesce(q.eligible,0)::int, coalesce(q.blocked,0)::int,
         coalesce(r.posted,0)::int, coalesce(r.skipped,0)::int, coalesce(r.failed,0)::int,
         coalesce(r.dup,0)::int, coalesce(r.reversed,0)::int
    FROM q FULL OUTER JOIN r ON r.m = q.m
   ORDER BY 1;
END $$;
REVOKE ALL ON FUNCTION public.neo_reconciliation_status(uuid,date,date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.neo_reconciliation_status(uuid,date,date) TO authenticated, service_role;