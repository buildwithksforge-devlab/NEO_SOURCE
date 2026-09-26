CREATE OR REPLACE FUNCTION public.neo_finance_eligible_sources(_branch uuid DEFAULT NULL::uuid, _from date DEFAULT NULL::date, _to date DEFAULT NULL::date)
 RETURNS TABLE(source_type text, source_id uuid, reference text, source_status text, amount numeric, occurred_on date, branch_id uuid)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  WITH scope AS (SELECT public.current_org_id() org)
  SELECT 'pos_order', o.id, o.order_number, o.status, o.grand_total,
         coalesce(o.closed_at, o.created_at)::date, o.branch_id
    FROM public.pos_orders o, scope s
   WHERE o.organization_id = s.org AND o.status IN ('closed','paid','settled','completed')
  UNION ALL
  SELECT 'folio_charge', f.id, coalesce(f.reference, f.description), f.status,
         coalesce(f.net_amount,0) + coalesce(f.tax_amount,0) + coalesce(f.service_charge_amount,0),
         coalesce(f.operational_date, f.posting_date::date), f.branch_id
    FROM public.folio_lines f, scope s
   WHERE f.organization_id = s.org AND f.status = 'posted'
     AND coalesce(f.line_type,'charge') <> 'payment'
  UNION ALL
  SELECT 'folio_payment', p.id, p.receipt_number, p.status, p.amount,
         coalesce(p.paid_at, p.created_at)::date, p.branch_id
    FROM public.payments p, scope s
   WHERE p.organization_id = s.org
     AND p.status IN ('confirmed','completed','paid','succeeded','captured')
  UNION ALL
  SELECT 'event_deposit', e.id, e.event_reference, e.status, e.deposit_paid,
         coalesce(e.confirmed_at::date, e.event_date), e.branch_id
    FROM public.event_bookings e, scope s
   WHERE e.organization_id = s.org AND coalesce(e.deposit_paid,0) > 0
     AND e.status <> 'cancelled'
  UNION ALL
  SELECT 'event_invoice', i.id, i.invoice_number, i.status, i.total, i.issue_date, i.branch_id
    FROM public.invoices i, scope s
   WHERE i.organization_id = s.org
     AND i.status IN ('issued','sent','partially_paid','paid','overdue')
  UNION ALL
  SELECT 'event_earned', e.id, e.event_reference, e.status, e.total_amount, e.event_date, e.branch_id
    FROM public.event_bookings e, scope s
   WHERE e.organization_id = s.org AND e.status IN ('completed','closed')
  UNION ALL
  SELECT 'event_cancellation', e.id, e.event_reference, e.status,
         greatest(coalesce(e.cancellation_fee,0), coalesce(e.deposit_paid,0)),
         coalesce(e.cancelled_at::date, e.event_date), e.branch_id
    FROM public.event_bookings e, scope s
   WHERE e.organization_id = s.org AND e.status = 'cancelled'
     AND (coalesce(e.cancellation_fee,0) > 0 OR coalesce(e.deposit_paid,0) > 0)
  UNION ALL
  SELECT 'delivery_order', d.id, d.order_number, d.order_status, d.grand_total,
         coalesce(d.delivered_at, d.created_at)::date, d.branch_id
    FROM public.delivery_orders d, scope s
   WHERE d.organization_id = s.org AND d.order_status IN ('delivered','completed')
  UNION ALL
  SELECT 'laundry_order', l.id, l.laundry_number, l.status, l.total,
         coalesce(l.delivered_at, l.created_at)::date, l.branch_id
    FROM public.guest_laundry_orders l, scope s
   WHERE l.organization_id = s.org AND l.status IN ('delivered','completed','closed')
  UNION ALL
  SELECT 'supplier_invoice', v.id, v.invoice_number, v.status, v.amount, v.invoice_date, v.branch_id
    FROM public.supplier_invoices v, scope s
   WHERE v.organization_id = s.org AND v.approved_at IS NOT NULL
     AND v.status IN ('approved','matched','partially_paid','paid')
  UNION ALL
  SELECT 'supplier_payment', sp.id, sp.payment_number, sp.status, sp.amount, sp.paid_on, sp.branch_id
    FROM public.supplier_payments sp, scope s
   WHERE sp.organization_id = s.org AND sp.status IN ('paid','completed','settled');
$function$

CREATE OR REPLACE FUNCTION public.neo_finance_post_txn(_source_type text, _source_id uuid, _silent boolean DEFAULT false)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  org uuid := public.current_org_id();
  branch uuid; cur text; ref text; occurred date; amount numeric := 0;
  posting text := 'revenue'; lines jsonb := '[]'::jsonb; res jsonb;
  customer uuid; net numeric; tax numeric; svc numeric; settle text;
  o public.pos_orders; fl public.folio_lines; pay public.payments;
  ev public.event_bookings; inv public.invoices; si public.supplier_invoices;
  sp public.supplier_payments; lo public.guest_laundry_orders; deliv record;
  paid numeric; remainder numeric; key text;
BEGIN
  IF org IS NULL THEN RETURN jsonb_build_object('ok', false, 'reason', 'no_organisation'); END IF;
  IF NOT _silent AND NOT (public.is_org_admin()
        OR public.has_permission('finance','edit') OR public.has_permission('finance','approve')) THEN
    RAISE EXCEPTION 'insufficient_privilege' USING ERRCODE = '42501';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(_source_type || ':' || _source_id::text, 0));

  IF _source_type = 'pos_order' THEN
    SELECT * INTO o FROM public.pos_orders
      WHERE id = _source_id AND organization_id = org FOR UPDATE;
    IF o.id IS NULL THEN RETURN jsonb_build_object('ok', false, 'reason', 'not_found'); END IF;
    branch := o.branch_id; ref := o.order_number; customer := o.customer_id;
    occurred := (coalesce(o.closed_at, o.created_at))::date; amount := coalesce(o.grand_total,0);
    IF o.status NOT IN ('closed','paid','settled','completed') THEN
      RETURN jsonb_build_object('ok', false, 'reason', 'ineligible_lifecycle',
        'detail', 'Order is ' || o.status || '. Draft, sent, ready and served orders are not revenue.');
    END IF;

    IF o.folio_id IS NOT NULL THEN
      posting := 'room_charge';
      res := public.neo_post_pos_order(o.id);
      PERFORM public.neo_record_posting_receipt(org, branch, 'pos', o.id, ref,
        CASE WHEN coalesce((res->>'ok')::boolean,false) THEN 'posted' ELSE 'blocked' END,
        amount, public.neo_fact_currency(org, branch), nullif(res->>'folio_line_id','')::uuid,
        'Routed to folio ' || o.folio_id::text || ' - revenue is recognised on the folio charge, not on the order.',
        NULL, occurred);
      UPDATE public.finance_posting_receipts SET posting_type = posting
        WHERE organization_id = org AND source_module = 'pos' AND source_id = o.id;
      RETURN coalesce(res,'{}'::jsonb) || jsonb_build_object('posting_type', posting);
    END IF;

    net := coalesce(o.subtotal,0) - coalesce(o.discount_total,0);
    tax := coalesce(o.tax_total,0); svc := coalesce(o.service_charge_total,0);
    IF o.corporate_account_id IS NOT NULL AND coalesce(o.paid_total,0) < amount THEN
      settle := '1060';
    ELSE
      SELECT public.neo_gl_settlement_code(p.method) INTO settle
        FROM public.pos_payments p WHERE p.order_id = o.id
         AND p.status IN ('paid','completed','captured','settled')
        ORDER BY p.amount DESC LIMIT 1;
      settle := coalesce(settle, '1010');
    END IF;
    lines := jsonb_build_array(
      jsonb_build_object('code', settle, 'debit', amount, 'description', 'Settlement ' || coalesce(ref,'')),
      jsonb_build_object('code', public.neo_gl_revenue_code(o.order_type), 'credit', net),
      jsonb_build_object('code', '2040', 'credit', tax, 'description', 'VAT'),
      jsonb_build_object('code', '2050', 'credit', svc, 'description', 'Service charge'));

  ELSIF _source_type = 'folio_charge' THEN
    SELECT * INTO fl FROM public.folio_lines
      WHERE id = _source_id AND organization_id = org FOR UPDATE;
    IF fl.id IS NULL THEN RETURN jsonb_build_object('ok', false, 'reason', 'not_found'); END IF;
    branch := fl.branch_id; ref := coalesce(fl.reference, fl.description); customer := fl.customer_id;
    occurred := coalesce(fl.operational_date, fl.posting_date::date);
    IF fl.status <> 'posted' OR coalesce(fl.line_type,'charge') = 'payment' THEN
      RETURN jsonb_build_object('ok', false, 'reason', 'ineligible_lifecycle',
        'detail', 'Only posted folio charges are recognised.');
    END IF;
    net := coalesce(fl.net_amount, 0); tax := coalesce(fl.tax_amount,0);
    svc := coalesce(fl.service_charge_amount,0);
    amount := net + tax + svc;
    IF amount <= 0 THEN RETURN jsonb_build_object('ok', false, 'reason', 'zero_amount'); END IF;
    lines := jsonb_build_array(
      jsonb_build_object('code', '1060', 'debit', amount, 'description', 'Guest ledger ' || coalesce(ref,'')),
      jsonb_build_object('code', public.neo_gl_revenue_code(fl.category), 'credit', net),
      jsonb_build_object('code', '2040', 'credit', tax, 'description', 'VAT'),
      jsonb_build_object('code', '2050', 'credit', svc, 'description', 'Service charge'));

  ELSIF _source_type = 'folio_payment' THEN
    SELECT * INTO pay FROM public.payments
      WHERE id = _source_id AND organization_id = org FOR UPDATE;
    IF pay.id IS NULL THEN RETURN jsonb_build_object('ok', false, 'reason', 'not_found'); END IF;
    branch := pay.branch_id; ref := pay.receipt_number; customer := pay.customer_id;
    occurred := coalesce(pay.paid_at, pay.created_at)::date; amount := coalesce(pay.amount,0);
    posting := 'collection';
    IF coalesce(pay.status,'') NOT IN ('confirmed','completed','paid','succeeded','captured') THEN
      RETURN jsonb_build_object('ok', false, 'reason', 'ineligible_lifecycle',
        'detail', 'Only confirmed receipts reduce the outstanding balance.');
    END IF;
    IF amount = 0 THEN RETURN jsonb_build_object('ok', false, 'reason', 'zero_amount'); END IF;
    lines := jsonb_build_array(
      jsonb_build_object('code', public.neo_gl_settlement_code(pay.method), 'debit', amount,
                         'description', 'Receipt ' || coalesce(ref,'')),
      jsonb_build_object('code', '1060', 'credit', amount, 'description', 'Guest / customer ledger'));

  ELSIF _source_type = 'event_deposit' THEN
    SELECT * INTO ev FROM public.event_bookings
      WHERE id = _source_id AND organization_id = org FOR UPDATE;
    IF ev.id IS NULL THEN RETURN jsonb_build_object('ok', false, 'reason', 'not_found'); END IF;
    branch := ev.branch_id; ref := ev.event_reference; customer := ev.customer_id;
    occurred := coalesce(ev.confirmed_at::date, ev.event_date); posting := 'deposit';
    amount := coalesce(ev.deposit_paid, 0);
    IF amount <= 0 THEN
      RETURN jsonb_build_object('ok', false, 'reason', 'ineligible_lifecycle',
        'detail', 'No deposit has been received. Forecast is never revenue.');
    END IF;
    lines := jsonb_build_array(
      jsonb_build_object('code', '1010', 'debit', amount, 'description', 'Event deposit ' || coalesce(ref,'')),
      jsonb_build_object('code', '2030', 'credit', amount, 'description', 'Event deposit held'));

  ELSIF _source_type = 'event_invoice' THEN
    SELECT * INTO inv FROM public.invoices
      WHERE id = _source_id AND organization_id = org FOR UPDATE;
    IF inv.id IS NULL THEN RETURN jsonb_build_object('ok', false, 'reason', 'not_found'); END IF;
    branch := inv.branch_id; ref := inv.invoice_number; customer := inv.customer_id;
    occurred := inv.issue_date; posting := 'invoice'; amount := coalesce(inv.total,0);
    IF coalesce(inv.status,'draft') NOT IN ('issued','sent','partially_paid','paid','overdue') THEN
      RETURN jsonb_build_object('ok', false, 'reason', 'ineligible_lifecycle',
        'detail', 'Draft and cancelled invoices are not receivables.');
    END IF;
    net := coalesce(inv.subtotal,0) - coalesce(inv.discount_total,0);
    lines := jsonb_build_array(
      jsonb_build_object('code', '1060', 'debit', amount, 'description', 'Invoice ' || coalesce(ref,'')),
      jsonb_build_object('code', CASE WHEN inv.event_booking_id IS NOT NULL THEN '4060' ELSE '4090' END,
                         'credit', net),
      jsonb_build_object('code', '2050', 'credit', coalesce(inv.service_charge_total,0),
                         'description', 'Service charge'),
      jsonb_build_object('code', '2040', 'credit', coalesce(inv.tax_total,0), 'description', 'VAT'));

  ELSIF _source_type = 'event_earned' THEN
    SELECT * INTO ev FROM public.event_bookings
      WHERE id = _source_id AND organization_id = org FOR UPDATE;
    IF ev.id IS NULL THEN RETURN jsonb_build_object('ok', false, 'reason', 'not_found'); END IF;
    branch := ev.branch_id; ref := ev.event_reference; customer := ev.customer_id;
    occurred := ev.event_date; posting := 'earned'; amount := coalesce(ev.total_amount,0);
    IF ev.status NOT IN ('completed','closed') THEN
      RETURN jsonb_build_object('ok', false, 'reason', 'ineligible_lifecycle',
        'detail', 'Event is ' || ev.status || '. Confirmed and provisional bookings are forecast, not revenue.');
    END IF;
    IF amount <= 0 THEN RETURN jsonb_build_object('ok', false, 'reason', 'zero_amount'); END IF;
    paid := least(coalesce(ev.deposit_paid,0), amount);
    remainder := amount - paid;
    lines := jsonb_build_array(
      jsonb_build_object('code', '2030', 'debit', paid, 'description', 'Deposit applied'),
      jsonb_build_object('code', '1060', 'debit', remainder, 'description', 'Event receivable'),
      jsonb_build_object('code', '4060', 'credit', amount, 'description', 'Event revenue ' || coalesce(ref,'')));

  ELSIF _source_type = 'event_cancellation' THEN
    SELECT * INTO ev FROM public.event_bookings
      WHERE id = _source_id AND organization_id = org FOR UPDATE;
    IF ev.id IS NULL THEN RETURN jsonb_build_object('ok', false, 'reason', 'not_found'); END IF;
    branch := ev.branch_id; ref := ev.event_reference; customer := ev.customer_id;
    occurred := coalesce(ev.cancelled_at::date, ev.event_date); posting := 'cancellation';
    IF ev.status <> 'cancelled' THEN
      RETURN jsonb_build_object('ok', false, 'reason', 'ineligible_lifecycle');
    END IF;
    PERFORM public.neo_finance_reverse_posting('event_earned', ev.id, 'earned', 'Event cancelled');
    amount := coalesce(ev.cancellation_fee, 0);
    paid := coalesce(ev.deposit_paid, 0);
    remainder := greatest(paid - amount, 0);
    IF amount = 0 AND remainder = 0 THEN
      RETURN jsonb_build_object('ok', true, 'reason', 'nothing_to_recognise');
    END IF;
    lines := jsonb_build_array(
      jsonb_build_object('code', '2030', 'debit', paid, 'description', 'Deposit released'),
      jsonb_build_object('code', '1060', 'debit', greatest(amount - paid, 0),
                         'description', 'Cancellation receivable'),
      jsonb_build_object('code', '4060', 'credit', amount, 'description', 'Cancellation fee ' || coalesce(ref,'')),
      jsonb_build_object('code', '1010', 'credit', remainder, 'description', 'Refund to client'));
    amount := greatest(amount, paid);

  ELSIF _source_type = 'delivery_order' THEN
    SELECT d.id, d.branch_id, d.order_number, d.customer_id, d.grand_total, d.tax_total,
           d.order_status, d.payment_status, d.payment_method, d.delivered_at, d.created_at
      INTO deliv FROM public.delivery_orders d
      WHERE d.id = _source_id AND d.organization_id = org FOR UPDATE;
    IF deliv.id IS NULL THEN RETURN jsonb_build_object('ok', false, 'reason', 'not_found'); END IF;
    branch := deliv.branch_id; ref := deliv.order_number; customer := deliv.customer_id;
    occurred := coalesce(deliv.delivered_at, deliv.created_at)::date;
    amount := coalesce(deliv.grand_total,0); tax := coalesce(deliv.tax_total,0);
    IF deliv.order_status NOT IN ('delivered','completed') THEN
      RETURN jsonb_build_object('ok', false, 'reason', 'ineligible_lifecycle',
        'detail', 'Only completed deliveries are recognised.');
    END IF;
    settle := CASE WHEN deliv.payment_status IN ('paid','settled','completed')
                   THEN public.neo_gl_settlement_code(deliv.payment_method) ELSE '1060' END;
    lines := jsonb_build_array(
      jsonb_build_object('code', settle, 'debit', amount, 'description', 'Delivery ' || coalesce(ref,'')),
      jsonb_build_object('code', '4070', 'credit', amount - tax),
      jsonb_build_object('code', '2040', 'credit', tax, 'description', 'VAT'));

  ELSIF _source_type = 'laundry_order' THEN
    SELECT * INTO lo FROM public.guest_laundry_orders
      WHERE id = _source_id AND organization_id = org FOR UPDATE;
    IF lo.id IS NULL THEN RETURN jsonb_build_object('ok', false, 'reason', 'not_found'); END IF;
    branch := lo.branch_id; ref := lo.laundry_number;
    occurred := coalesce(lo.delivered_at, lo.created_at)::date; amount := coalesce(lo.total,0);
    IF lo.status NOT IN ('delivered','completed','closed') THEN
      RETURN jsonb_build_object('ok', false, 'reason', 'ineligible_lifecycle',
        'detail', 'Only completed laundry orders are recognised.');
    END IF;
    IF lo.folio_id IS NOT NULL THEN
      posting := 'folio_charge';
      res := public.laundry_post_charge(lo.id);
      PERFORM public.neo_record_posting_receipt(org, branch, 'laundry', lo.id, ref,
        CASE WHEN coalesce((res->>'ok')::boolean,false) THEN 'posted' ELSE 'blocked' END,
        amount, public.neo_fact_currency(org, branch), nullif(res->>'folio_line_id','')::uuid,
        'Charged to the guest folio - revenue is recognised on the folio charge.', NULL, occurred);
      UPDATE public.finance_posting_receipts SET posting_type = posting
        WHERE organization_id = org AND source_module = 'laundry' AND source_id = lo.id;
      RETURN coalesce(res,'{}'::jsonb) || jsonb_build_object('posting_type', posting);
    END IF;
    tax := coalesce(lo.tax_amount,0);
    lines := jsonb_build_array(
      jsonb_build_object('code', '1010', 'debit', amount, 'description', 'Laundry ' || coalesce(ref,'')),
      jsonb_build_object('code', '4050', 'credit', amount - tax),
      jsonb_build_object('code', '2040', 'credit', tax, 'description', 'VAT'));

  ELSIF _source_type = 'supplier_invoice' THEN
    SELECT * INTO si FROM public.supplier_invoices
      WHERE id = _source_id AND organization_id = org FOR UPDATE;
    IF si.id IS NULL THEN RETURN jsonb_build_object('ok', false, 'reason', 'not_found'); END IF;
    branch := si.branch_id; ref := si.invoice_number; occurred := si.invoice_date;
    amount := coalesce(si.amount,0); tax := coalesce(si.tax_amount,0); posting := 'payable';
    IF si.approved_at IS NULL OR si.status NOT IN ('approved','matched','partially_paid','paid') THEN
      RETURN jsonb_build_object('ok', false, 'reason', 'ineligible_lifecycle',
        'detail', 'Only approved supplier invoices become payables. Requests and purchase orders do not.');
    END IF;
    lines := jsonb_build_array(
      jsonb_build_object('code', '1070', 'debit', amount - tax, 'description', 'Goods / services received'),
      jsonb_build_object('code', '2040', 'debit', tax, 'description', 'Input VAT'),
      jsonb_build_object('code', '2010', 'credit', amount, 'description', 'Supplier invoice ' || coalesce(ref,'')));

  ELSIF _source_type = 'supplier_payment' THEN
    SELECT * INTO sp FROM public.supplier_payments
      WHERE id = _source_id AND organization_id = org FOR UPDATE;
    IF sp.id IS NULL THEN RETURN jsonb_build_object('ok', false, 'reason', 'not_found'); END IF;
    branch := sp.branch_id; ref := sp.payment_number; occurred := sp.paid_on;
    amount := coalesce(sp.amount,0); posting := 'payable_payment';
    IF sp.status NOT IN ('paid','completed','settled') THEN
      RETURN jsonb_build_object('ok', false, 'reason', 'ineligible_lifecycle');
    END IF;
    lines := jsonb_build_array(
      jsonb_build_object('code', '2010', 'debit', amount, 'description', 'Supplier payment ' || coalesce(ref,'')),
      jsonb_build_object('code', public.neo_gl_settlement_code(sp.method), 'credit', amount));

  ELSE
    RETURN jsonb_build_object('ok', false, 'reason', 'unknown_source_type');
  END IF;

  cur := public.neo_fact_currency(org, branch);
  occurred := coalesce(occurred, (now() AT TIME ZONE public.neo_fact_timezone(org, branch))::date);
  key := _source_type || ':' || _source_id::text || ':' || posting;

  res := public.neo_gl_post(org, branch, split_part(_source_type,'_',1), _source_type, _source_id,
                            posting, occurred, cur,
                            initcap(replace(_source_type,'_',' ')) || ' ' || coalesce(ref,''),
                            lines, customer, NULL);

  PERFORM public.neo_record_posting_receipt(org, branch, _source_type, _source_id, ref,
    'posted', amount, cur, NULL,
    CASE WHEN coalesce((res->>'duplicate_prevented')::boolean,false)
         THEN 'Duplicate replay prevented - the existing journal was reused.'
         ELSE 'Posted to journal ' || (res->>'journal_id') END,
    NULL, occurred);

  UPDATE public.finance_posting_receipts
     SET posting_type = posting, journal_id = (res->>'journal_id')::uuid
   WHERE organization_id = org AND source_module = _source_type AND source_id = _source_id;

  PERFORM public.emit_domain_event(org, branch, 'finance.posted', _source_type, _source_id,
    jsonb_build_object('posting_type', posting, 'amount', amount, 'currency', cur,
                       'journal_id', res->>'journal_id', 'occurred_on', occurred),
    'finance.posted:' || key, customer);

  RETURN res || jsonb_build_object('source_type', _source_type, 'source_id', _source_id,
                                   'posting_type', posting, 'amount', amount);
EXCEPTION WHEN OTHERS THEN
  PERFORM public.neo_record_posting_receipt(org, branch, _source_type, _source_id, ref,
    'failed', amount, coalesce(cur,'KES'), NULL, NULL, SQLERRM, occurred);
  IF _silent THEN RETURN jsonb_build_object('ok', false, 'reason', 'failed', 'detail', SQLERRM); END IF;
  RAISE;
END $function$

CREATE OR REPLACE FUNCTION public.neo_finance_reverse_posting(_source_type text, _source_id uuid, _posting_type text, _reason text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE org uuid := public.current_org_id(); j public.journal_entries;
        lines jsonb; res jsonb;
BEGIN
  IF org IS NULL THEN RETURN jsonb_build_object('ok', false, 'reason', 'no_organisation'); END IF;
  SELECT * INTO j FROM public.journal_entries
   WHERE organization_id = org
     AND idempotency_key = _source_type || ':' || _source_id::text || ':' || _posting_type;
  IF j.id IS NULL OR j.status <> 'posted' THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'no_original_posting');
  END IF;
  IF j.reversed_by_journal_id IS NOT NULL THEN
    RETURN jsonb_build_object('ok', true, 'reason', 'already_reversed',
                              'journal_id', j.reversed_by_journal_id);
  END IF;

  SELECT jsonb_agg(jsonb_build_object('code', a.code, 'debit', l.credit, 'credit', l.debit,
                                      'description', coalesce(_reason,'Reversal')))
    INTO lines
    FROM public.journal_entry_lines l
    JOIN public.chart_of_accounts a ON a.id = l.account_id
   WHERE l.journal_id = j.id;

  res := public.neo_gl_post(org, j.branch_id, j.source_module, _source_type, _source_id,
           _posting_type || ':reversal', j.accounting_date, j.currency,
           coalesce(_reason, 'Reversal of ' || j.journal_number), lines, NULL, j.id);

  UPDATE public.journal_entries SET reversed_by_journal_id = (res->>'journal_id')::uuid
   WHERE id = j.id;
  UPDATE public.finance_posting_receipts
     SET status = 'reversed', detail = coalesce(_reason,'Reversed')
   WHERE organization_id = org AND source_module = _source_type
     AND source_id = _source_id AND posting_type = _posting_type;

  RETURN res || jsonb_build_object('reversed_journal_id', j.id);
END $function$

CREATE OR REPLACE FUNCTION public.neo_gl_post(_org uuid, _branch uuid, _module text, _source_type text, _source_id uuid, _posting_type text, _date date, _currency text, _desc text, _lines jsonb, _customer uuid DEFAULT NULL::uuid, _reverses uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE key text := _source_type || ':' || _source_id::text || ':' || _posting_type;
        j uuid; ln jsonb; i int := 0; td numeric := 0; tc numeric := 0; acct uuid;
        d numeric; c numeric;
BEGIN
  SELECT id INTO j FROM public.journal_entries
   WHERE organization_id = _org AND idempotency_key = key;
  IF j IS NOT NULL THEN
    RETURN jsonb_build_object('ok', true, 'journal_id', j, 'duplicate_prevented', true);
  END IF;

  INSERT INTO public.journal_entries
    (organization_id, branch_id, journal_number, journal_type, accounting_date,
     period_id, source_module, source_document_type, source_document_id,
     idempotency_key, description, currency, status, created_by, reverses_journal_id)
  VALUES (_org, _branch, public.next_document_number('journal','JV',_branch),
          CASE WHEN _reverses IS NULL THEN 'system' ELSE 'reversal' END, _date,
          public.neo_gl_period(_org, _date), _module,
          _source_type || ':' || _posting_type, _source_id, key, _desc,
          coalesce(_currency,'KES'), 'draft', auth.uid(), _reverses)
  RETURNING id INTO j;

  FOR ln IN SELECT * FROM jsonb_array_elements(_lines) LOOP
    d := round(coalesce((ln->>'debit')::numeric, 0), 2);
    c := round(coalesce((ln->>'credit')::numeric, 0), 2);
    CONTINUE WHEN d = 0 AND c = 0;
    acct := public.neo_gl_acct(_org, ln->>'code');
    IF acct IS NULL THEN
      RAISE EXCEPTION 'chart_of_accounts is missing postable account %', ln->>'code';
    END IF;
    i := i + 1;
    INSERT INTO public.journal_entry_lines
      (organization_id, journal_id, line_number, account_id, description, debit, credit,
       branch_id, customer_id)
    VALUES (_org, j, i, acct, coalesce(ln->>'description', _desc), d, c, _branch, _customer);
    td := td + d; tc := tc + c;
  END LOOP;

  IF i = 0 THEN RAISE EXCEPTION 'nothing_to_post'; END IF;
  IF round(td,2) <> round(tc,2) THEN
    RAISE EXCEPTION 'journal is not balanced (debit % vs credit %)', td, tc;
  END IF;

  UPDATE public.journal_entries
     SET total_debit = td, total_credit = tc, status = 'posted',
         posted_by = auth.uid(), posted_at = now()
   WHERE id = j;

  RETURN jsonb_build_object('ok', true, 'journal_id', j, 'amount', td);
END $function$

