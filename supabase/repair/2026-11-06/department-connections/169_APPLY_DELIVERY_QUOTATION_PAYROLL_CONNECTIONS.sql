BEGIN;
DO $guard$ DECLARE mismatch boolean; BEGIN IF EXISTS(SELECT 1 FROM unnest(ARRAY['public.neo_connection_journal_matches(uuid,uuid,uuid,text,numeric,text,uuid)','public.neo_delivery_record_payment_v2(uuid,numeric,text,text,text,text,uuid,uuid)','public.neo_event_quotation_price(uuid,jsonb,numeric,numeric,numeric,numeric)','public.neo_hr_payroll_release_payslips(uuid,boolean)','public.neo_hr_payroll_release_visible(uuid)']) s WHERE to_regprocedure(s) IS NOT NULL) THEN RAISE EXCEPTION 'A department connection repair already exists; run postcheck'; END IF; WITH expected(signature,hash) AS(VALUES ('public.neo_delivery_bill(uuid,text)','31f686c92a35562abbef29797de56d04'),('public.neo_delivery_record_payment(uuid,numeric,text,text,text,text,uuid)','cda68d658709e2269ad12fc1d52dae79'),('public.neo_finance_post_txn(text,uuid,boolean)','49289eb4484d9655afe8e148f6e3b48a')) SELECT bool_or(md5(pg_get_functiondef(to_regprocedure(signature))) IS DISTINCT FROM hash) INTO mismatch FROM expected;IF mismatch THEN RAISE EXCEPTION 'Delivery/Finance prerequisites changed; inspect before replacing';END IF; END $guard$;
CREATE FUNCTION public.neo_connection_journal_matches(_journal uuid,_org uuid,_branch uuid,_currency text,_amount numeric,_type text,_source uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public AS $f$ SELECT EXISTS(SELECT 1 FROM public.journal_entries j WHERE j.id=_journal AND j.organization_id=_org AND j.branch_id IS NOT DISTINCT FROM _branch AND j.currency=_currency AND j.status='posted' AND j.reversed_by_journal_id IS NULL AND j.source_document_type=_type AND j.source_document_id=_source AND _amount>0 AND _amount::text NOT IN ('NaN','Infinity','-Infinity') AND j.total_debit=_amount AND j.total_credit=_amount AND NOT EXISTS(SELECT 1 FROM public.journal_entry_lines l LEFT JOIN public.chart_of_accounts a ON a.id=l.account_id WHERE l.journal_id=j.id AND (l.organization_id IS DISTINCT FROM _org OR l.branch_id IS DISTINCT FROM _branch OR a.organization_id IS DISTINCT FROM _org OR l.debit IS NULL OR l.credit IS NULL OR l.debit<0 OR l.credit<0 OR l.debit::text IN ('NaN','Infinity','-Infinity') OR l.credit::text IN ('NaN','Infinity','-Infinity'))) AND (SELECT coalesce(sum(l.debit),0) FROM public.journal_entry_lines l WHERE l.journal_id=j.id)=_amount AND (SELECT coalesce(sum(l.credit),0) FROM public.journal_entry_lines l WHERE l.journal_id=j.id)=_amount) $f$;REVOKE ALL ON FUNCTION public.neo_connection_journal_matches(uuid,uuid,uuid,text,numeric,text,uuid) FROM PUBLIC,anon,authenticated,service_role;

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
    IF EXISTS(SELECT 1 FROM public.delivery_orders d WHERE d.pos_order_id=o.id AND d.organization_id=org) THEN
      SELECT i.* INTO inv FROM public.invoices i JOIN public.delivery_orders d ON i.notes LIKE 'delivery-order:'||d.id::text||'%' AND i.organization_id=d.organization_id WHERE d.pos_order_id=o.id AND d.organization_id=org ORDER BY i.created_at LIMIT 1;
      IF inv.id IS NOT NULL AND inv.branch_id IS NOT DISTINCT FROM o.branch_id AND public.neo_connection_journal_matches(inv.journal_id,org,inv.branch_id,inv.currency,inv.total,'delivery_invoice',inv.id) THEN RETURN jsonb_build_object('ok',true,'journal_id',inv.journal_id,'duplicate_prevented',true,'posting_type','invoice','amount',inv.total); END IF;
      RETURN jsonb_build_object('ok',false,'reason','delivery_source_owns_posting','detail','This production order is accounted for by its linked delivery, not a second POS sale.');
    END IF;
    branch := o.branch_id; ref := o.order_number; customer := o.customer_id;
    occurred := (coalesce(o.closed_at, o.created_at))::date; amount := coalesce(o.grand_total,0);
    IF o.status NOT IN ('closed','paid','settled','completed','charged-to-room') THEN
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
        WHERE organization_id = org AND idempotency_key = 'pos:' || o.id::text;
      SELECT coalesce(res,'{}'::jsonb) || jsonb_build_object(
        'posting_type',posting,'posting_receipt_id',r.id,'folio_line_id',r.folio_line_id,'journal_id',r.journal_id,
        'ok',r.status='posted' AND r.folio_line_id IS NOT NULL AND r.journal_id IS NOT NULL,
        'reason',CASE WHEN r.status='posted' AND r.folio_line_id IS NOT NULL AND r.journal_id IS NOT NULL
                     THEN 'room_charge_reconciled' ELSE 'room_charge_journal_unverified' END)
      INTO res FROM public.finance_posting_receipts r
      WHERE r.organization_id=org AND r.idempotency_key='pos:'||o.id::text;
      RETURN coalesce(res,jsonb_build_object('ok',false,'reason','room_charge_receipt_missing'));
    END IF;

    tax := coalesce(o.tax_total,0); svc := coalesce(o.service_charge_total,0);
    amount := greatest(coalesce(o.grand_total,0),
                       coalesce(o.subtotal,0) - coalesce(o.discount_total,0));
    net := amount - tax - svc;
    IF o.corporate_account_id IS NOT NULL AND coalesce(o.paid_total,0) < amount THEN
      settle := '1060';
    ELSE
      -- The money account follows the receipt: the account the cashier chose,
      -- otherwise the account this property uses for that tender.
      SELECT public.neo_gl_account_code(org, p.method, p.destination_account_id) INTO settle
        FROM public.pos_payments p WHERE p.order_id = o.id
         AND p.status IN ('confirmed','paid','completed','captured','settled')
        ORDER BY p.amount DESC LIMIT 1;
      settle := coalesce(settle, public.neo_gl_settlement_code_for(org, 'cash'), '1010');
    END IF;
    lines := jsonb_build_array(
      jsonb_build_object('code', settle, 'debit', amount, 'description', 'Settlement ' || coalesce(ref,'')),
      jsonb_build_object('code', public.neo_gl_revenue_code_scoped(org, o.order_type, NULL), 'credit', net),
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
    tax := coalesce(fl.tax_amount,0);
    svc := coalesce(fl.service_charge_amount,0);
    amount := coalesce(fl.gross_amount,0) - coalesce(fl.discount_amount,0) + tax + svc;
    net := coalesce(fl.gross_amount,0) - coalesce(fl.discount_amount,0);
    IF amount <= 0 THEN RETURN jsonb_build_object('ok', false, 'reason', 'zero_amount'); END IF;
    lines := jsonb_build_array(
      jsonb_build_object('code', '1060', 'debit', amount, 'description', 'Guest ledger ' || coalesce(ref,'')),
      jsonb_build_object('code', public.neo_gl_revenue_code_scoped(org, fl.category, fl.revenue_centre), 'credit', net),
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
    IF pay.source_module='delivery' AND pay.posted_journal_id IS NOT NULL THEN
      IF NOT EXISTS(SELECT 1 FROM public.journal_entries j WHERE j.id=pay.posted_journal_id AND j.organization_id=org AND j.branch_id IS NOT DISTINCT FROM branch AND j.status='posted' AND j.source_module='delivery' AND j.source_document_type='delivery_payment' AND j.source_document_id=pay.id AND j.currency=pay.currency AND j.total_debit=amount AND j.total_credit=amount AND amount>0 AND amount::text NOT IN ('NaN','Infinity','-Infinity') AND NOT EXISTS(SELECT 1 FROM public.journal_entry_lines l WHERE l.journal_id=j.id AND (l.organization_id IS DISTINCT FROM org OR l.branch_id IS DISTINCT FROM branch)) AND (SELECT coalesce(sum(l.debit),0) FROM public.journal_entry_lines l WHERE l.journal_id=j.id)=amount AND (SELECT coalesce(sum(l.credit),0) FROM public.journal_entry_lines l WHERE l.journal_id=j.id)=amount) THEN RAISE EXCEPTION 'Delivery payment journal evidence is incomplete'; END IF;
      PERFORM public.neo_record_posting_receipt(org,branch,_source_type,_source_id,ref,'posted',amount,pay.currency,NULL,'Existing delivery receipt journal verified',NULL,occurred);
      UPDATE public.finance_posting_receipts SET posting_type='collection',journal_id=pay.posted_journal_id WHERE organization_id=org AND source_module=_source_type AND source_id=_source_id;
      RETURN jsonb_build_object('ok',true,'journal_id',pay.posted_journal_id,'duplicate_prevented',true,'amount',amount,'posting_type','collection');
    END IF;
    IF amount = 0 THEN RETURN jsonb_build_object('ok', false, 'reason', 'zero_amount'); END IF;
    lines := jsonb_build_array(
      jsonb_build_object('code', public.neo_gl_account_code(org, pay.method, pay.destination_account_id),
                         'debit', amount, 'description', 'Receipt ' || coalesce(ref,'')),
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
    SELECT public.neo_gl_account_code(org, p.method, p.destination_account_id) INTO settle
      FROM public.payments p
     WHERE p.organization_id = org AND p.source_module = 'events' AND p.source_record_id = ev.id
       AND coalesce(p.status,'') IN ('confirmed','completed','paid','succeeded','captured')
     ORDER BY p.amount DESC LIMIT 1;
    settle := coalesce(settle, public.neo_gl_settlement_code_for(org, 'cash'), '1010');
    lines := jsonb_build_array(
      jsonb_build_object('code', settle, 'debit', amount, 'description', 'Event deposit ' || coalesce(ref,'')),
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
    IF inv.notes LIKE 'delivery-order:%' THEN
      IF NOT public.neo_connection_journal_matches(inv.journal_id,org,branch,inv.currency,amount,'delivery_invoice',inv.id) THEN RAISE EXCEPTION 'Delivery invoice journal evidence needs review'; END IF;
      RETURN jsonb_build_object('ok',true,'journal_id',inv.journal_id,'duplicate_prevented',true,'posting_type','invoice','amount',amount);
    END IF;
    net := coalesce(inv.subtotal,0) - coalesce(inv.discount_total,0);
    lines := jsonb_build_array(
      jsonb_build_object('code', '1060', 'debit', amount, 'description', 'Invoice ' || coalesce(ref,'')),
      jsonb_build_object('code', CASE WHEN inv.event_booking_id IS NOT NULL THEN public.neo_gl_revenue_code_scoped(org, 'events', NULL) ELSE '4090' END,
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
      jsonb_build_object('code', public.neo_gl_revenue_code_scoped(org, 'events', NULL), 'credit', amount, 'description', 'Event revenue ' || coalesce(ref,'')));

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
    SELECT public.neo_gl_account_code(org, p.method, p.destination_account_id) INTO settle
      FROM public.payments p
     WHERE p.organization_id = org AND p.source_module = 'events' AND p.source_record_id = ev.id
     ORDER BY p.amount DESC LIMIT 1;
    settle := coalesce(settle, public.neo_gl_settlement_code_for(org, 'cash'), '1010');
    lines := jsonb_build_array(
      jsonb_build_object('code', '2030', 'debit', paid, 'description', 'Deposit released'),
      jsonb_build_object('code', '1060', 'debit', greatest(amount - paid, 0),
                         'description', 'Cancellation receivable'),
      jsonb_build_object('code', public.neo_gl_revenue_code_scoped(org, 'events', NULL), 'credit', amount, 'description', 'Cancellation fee ' || coalesce(ref,'')),
      jsonb_build_object('code', settle, 'credit', remainder, 'description', 'Refund to client'));
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
    SELECT * INTO inv FROM public.invoices i WHERE i.organization_id=org AND i.notes LIKE 'delivery-order:'||deliv.id::text||'%' ORDER BY i.created_at LIMIT 1;
    IF inv.id IS NOT NULL THEN
      IF inv.branch_id IS DISTINCT FROM branch OR inv.currency IS DISTINCT FROM public.neo_fact_currency(org,branch) OR inv.total IS DISTINCT FROM amount OR NOT public.neo_connection_journal_matches(inv.journal_id,org,branch,inv.currency,amount,'delivery_invoice',inv.id) THEN RAISE EXCEPTION 'Completed delivery invoice evidence needs review'; END IF;
      RETURN jsonb_build_object('ok',true,'journal_id',inv.journal_id,'duplicate_prevented',true,'posting_type','invoice','amount',amount);
    END IF;
    IF deliv.payment_status IN ('paid','settled','completed') THEN
      SELECT public.neo_gl_account_code(org, coalesce(p.method, deliv.payment_method), p.destination_account_id)
        INTO settle
        FROM public.payments p
       WHERE p.organization_id = org AND p.source_module = 'delivery' AND p.source_record_id = deliv.id
         AND coalesce(p.status,'') IN ('confirmed','completed','paid','succeeded','captured')
       ORDER BY p.amount DESC LIMIT 1;
      settle := coalesce(settle, public.neo_gl_account_code(org, deliv.payment_method, NULL), '1010');
    ELSE
      settle := '1060';
    END IF;
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
    IF lo.folio_id IS NULL AND (lo.reservation_id IS NOT NULL OR lo.resident IS TRUE) THEN
      RETURN jsonb_build_object('ok',false,'reason','resident_laundry_missing_folio',
        'detail','Resident laundry must reach a guest folio; it cannot be treated as an assumed cash collection.');
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
    settle := coalesce(public.neo_gl_settlement_code_for(org, 'cash'), '1010');
    lines := jsonb_build_array(
      jsonb_build_object('code', settle, 'debit', amount, 'description', 'Laundry ' || coalesce(ref,'')),
      jsonb_build_object('code', public.neo_gl_revenue_code_scoped(org, 'laundry', NULL), 'credit', amount - tax),
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
    -- Money leaves the account the hotel actually paid from.
    lines := jsonb_build_array(
      jsonb_build_object('code', '2010', 'debit', amount, 'description', 'Supplier payment ' || coalesce(ref,'')),
      jsonb_build_object('code', public.neo_gl_account_code(org, sp.method, sp.bank_account_id),
                         'credit', amount));

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

  -- A duplicate key or ok flag alone is not evidence of a completed posting.
  IF res->>'ok' IS DISTINCT FROM 'true' OR NOT EXISTS(
    SELECT 1 FROM public.journal_entries j
    CROSS JOIN LATERAL(SELECT coalesce(sum(l.debit),0) AS d,coalesce(sum(l.credit),0) AS c
      FROM public.journal_entry_lines l WHERE l.journal_id=j.id) actual
    WHERE j.id=nullif(res->>'journal_id','')::uuid AND j.organization_id=org
      AND j.branch_id IS NOT DISTINCT FROM branch AND j.status='posted'
      AND j.reversed_by_journal_id IS NULL AND j.currency=cur
      AND j.source_document_id=_source_id AND j.source_document_type=_source_type||':'||posting
      AND actual.d=round(amount,2) AND actual.c=round(amount,2)
      AND j.total_debit=actual.d AND j.total_credit=actual.c
      AND NOT EXISTS(SELECT 1 FROM public.journal_entry_lines l WHERE l.journal_id=j.id
        AND (l.organization_id IS DISTINCT FROM org OR l.branch_id IS DISTINCT FROM branch))
  ) THEN
    RAISE EXCEPTION 'Posting did not produce a matching balanced posted journal' USING ERRCODE='23514';
  END IF;

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
;

CREATE OR REPLACE FUNCTION public.neo_delivery_bill(_order uuid, _reason text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  o public.delivery_orders;
  org uuid;
  v_invoice uuid;
  v_number text;
  v_journal uuid;
  v_jnum text;
  v_key text;
  v_revenue uuid;
  v_vat uuid;
  v_service uuid;
  v_debit uuid;
  v_method text;
  v_paid boolean;
  v_tax numeric;
  v_service_amount numeric;
  v_net_items numeric;
  v_revenue_credit numeric;
  v_invoice_subtotal numeric;
  v_line int := 0;
  v_jline int := 0;
  v_existing public.invoices; v_prior text;
BEGIN
  IF auth.uid() IS NULL OR public.current_org_id() IS NULL OR public.current_access_scope() IS NULL OR public.current_access_scope()='technical' THEN RAISE EXCEPTION 'An authorised staff workspace is required'; END IF;
  SELECT * INTO o FROM public.delivery_orders WHERE id = _order FOR UPDATE;
  IF o.id IS NULL THEN RETURN jsonb_build_object('ok', false, 'reason', 'order_not_found'); END IF;
  org := o.organization_id;
  IF org <> public.current_org_id() THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'order_not_found');
  END IF;
  IF NOT (public.has_permission('finance','invoices','create')
          OR public.has_permission('finance','approve')
          OR public.is_org_admin_for(org)) THEN
    RAISE EXCEPTION 'Permission to raise an invoice is required.' USING ERRCODE = '42501';
  END IF;
  IF NOT public.neo_branch_in_scope(o.branch_id) THEN
    RAISE EXCEPTION 'That order is outside your access scope.' USING ERRCODE = '42501';
  END IF;
  IF o.order_status IN ('cancelled','rejected','failed') THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'order_closed',
      'detail', 'A cancelled order cannot be billed.');
  END IF;
  IF coalesce(o.grand_total, 0) <= 0 THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'nothing_to_bill');
  END IF;

  SELECT * INTO v_existing FROM public.invoices
   WHERE organization_id = org AND notes LIKE '%delivery-order:' || _order::text || '%'
   LIMIT 1;
  IF v_existing.id IS NOT NULL THEN
    IF v_existing.branch_id IS DISTINCT FROM o.branch_id OR v_existing.currency IS DISTINCT FROM o.currency OR v_existing.total IS DISTINCT FROM o.grand_total OR NOT public.neo_connection_journal_matches(v_existing.journal_id,org,o.branch_id,o.currency,v_existing.total,'delivery_invoice',v_existing.id) THEN RAISE EXCEPTION 'Saved delivery invoice lacks matching posted journal evidence; reconcile before replay'; END IF;
    RETURN jsonb_build_object('ok', true, 'already_billed', true,
      'invoice_id', v_existing.id, 'invoice_number', v_existing.invoice_number,
      'journal_id', v_existing.journal_id);
  END IF;

  IF o.grand_total::text IN ('NaN','Infinity','-Infinity') OR coalesce(o.subtotal,0)::text IN ('NaN','Infinity','-Infinity') OR coalesce(o.tax_total,0)::text IN ('NaN','Infinity','-Infinity') OR coalesce(o.service_charge_total,0)::text IN ('NaN','Infinity','-Infinity') THEN RAISE EXCEPTION 'Delivery amounts must be finite'; END IF;
  IF EXISTS(SELECT 1 FROM public.journal_entries j WHERE j.organization_id=org AND j.source_document_id=o.id AND j.status='posted' AND j.reversed_by_journal_id IS NULL) THEN RAISE EXCEPTION 'Delivery already has financial recognition; reconcile existing evidence before issuing another invoice'; END IF;
  v_method := lower(coalesce(o.payment_method, ''));
  v_paid := lower(coalesce(o.payment_status,'')) IN ('paid','settled','captured','completed');
  IF v_paid THEN RAISE EXCEPTION 'This delivery is already marked paid. Reconcile its existing receipt before creating a new receivable'; END IF;
  v_tax := coalesce(o.tax_total, 0);
  v_service_amount := coalesce(o.service_charge_total, 0);

  v_net_items := coalesce(o.subtotal,0) - coalesce(o.discount_total,0) - v_tax;
  v_revenue_credit := v_net_items + coalesce(o.delivery_fee,0) + coalesce(o.tip_amount,0);
  v_invoice_subtotal := v_revenue_credit + v_service_amount;

  IF round(v_invoice_subtotal + v_tax, 2) <> round(coalesce(o.grand_total,0), 2) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'totals_mismatch',
      'detail', 'The order total does not equal its items, fee, service charge and tax.',
      'expected', round(v_invoice_subtotal + v_tax, 2), 'grand_total', coalesce(o.grand_total,0));
  END IF;

  SELECT a.id INTO v_revenue FROM public.chart_of_accounts a
   WHERE a.organization_id = org AND a.active AND coalesce(a.postable, true)
     AND a.name ILIKE 'Delivery Revenue'
   ORDER BY a.code LIMIT 1;
  IF v_revenue IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'no_revenue_account',
      'detail', 'This property has no active Delivery Revenue account.');
  END IF;

  IF v_tax > 0 THEN
    SELECT a.id INTO v_vat FROM public.chart_of_accounts a
     WHERE a.organization_id = org AND a.active AND coalesce(a.postable, true)
       AND a.name ILIKE '%VAT Payable%'
     ORDER BY a.code LIMIT 1;
    IF v_vat IS NULL THEN
      RETURN jsonb_build_object('ok', false, 'reason', 'no_vat_account',
        'detail', 'This order carries tax but the property has no VAT Payable account.');
    END IF;
  END IF;

  IF v_service_amount <> 0 THEN
    SELECT a.id INTO v_service FROM public.chart_of_accounts a
     WHERE a.organization_id = org AND a.active AND coalesce(a.postable, true)
       AND a.name ILIKE '%Service Charge%'
     ORDER BY a.code LIMIT 1;
    IF v_service IS NULL THEN
      RETURN jsonb_build_object('ok', false, 'reason', 'no_service_charge_account',
        'detail', 'This order carries a service charge but the property has no Service Charge account.');
    END IF;
  END IF;

  IF v_paid THEN
    SELECT a.id INTO v_debit FROM public.chart_of_accounts a
     WHERE a.organization_id = org AND a.active AND coalesce(a.postable, true)
       AND a.code = public.neo_gl_settlement_code_for(org, v_method)
     LIMIT 1;
  END IF;
  IF v_debit IS NULL THEN
    SELECT a.id INTO v_debit FROM public.chart_of_accounts a
     WHERE a.organization_id = org AND a.active AND coalesce(a.postable, true)
       AND a.name ILIKE 'Accounts Receivable'
     ORDER BY a.code LIMIT 1;
  END IF;
  IF v_debit IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'no_settlement_account',
      'detail', 'No account is configured to carry the money for this order.');
  END IF;

  v_number := public.next_document_number('invoice', NULL, o.branch_id);

  INSERT INTO public.invoices (organization_id, branch_id, invoice_number, document_type,
    customer_id, issue_date, currency, bill_to_snapshot, subtotal, discount_total, tax_total,
    total, amount_paid, balance, status, notes, created_by, issued_at)
  VALUES (org, o.branch_id, v_number, 'tax_invoice', o.customer_id, CURRENT_DATE,
    coalesce(o.currency,'KES'),
    jsonb_build_object('name', o.contact_name, 'phone', o.contact_phone,
                       'address', o.address_snapshot),
    v_invoice_subtotal, coalesce(o.discount_total,0), v_tax, coalesce(o.grand_total,0),
    CASE WHEN v_paid THEN coalesce(o.grand_total,0) ELSE 0 END,
    CASE WHEN v_paid THEN 0 ELSE coalesce(o.grand_total,0) END,
    'draft',
    'delivery-order:' || _order::text || ' · ' || o.order_number
      || coalesce(' · ' || nullif(btrim(coalesce(_reason,'')),''), ''),
    auth.uid(), now())
  RETURNING id INTO v_invoice;

  v_line := v_line + 1;
  INSERT INTO public.invoice_lines (organization_id, invoice_id, line_number, description,
    source_module, source_record_id, revenue_account_id, quantity, unit_price,
    discount_amount, tax_amount, net_amount, total_amount)
  VALUES (org, v_invoice, v_line, 'Delivery order ' || o.order_number || ' — food and beverage',
    'delivery', _order, v_revenue, 1, coalesce(o.subtotal,0), coalesce(o.discount_total,0),
    v_tax, v_net_items, v_net_items + v_tax);

  IF coalesce(o.delivery_fee,0) <> 0 THEN
    v_line := v_line + 1;
    INSERT INTO public.invoice_lines (organization_id, invoice_id, line_number, description,
      source_module, source_record_id, revenue_account_id, quantity, unit_price,
      net_amount, total_amount)
    VALUES (org, v_invoice, v_line, 'Delivery fee', 'delivery', _order, v_revenue, 1,
      o.delivery_fee, o.delivery_fee, o.delivery_fee);
  END IF;

  IF v_service_amount <> 0 THEN
    v_line := v_line + 1;
    INSERT INTO public.invoice_lines (organization_id, invoice_id, line_number, description,
      source_module, source_record_id, revenue_account_id, quantity, unit_price,
      net_amount, total_amount)
    VALUES (org, v_invoice, v_line, 'Service charge', 'delivery', _order, v_service, 1,
      v_service_amount, v_service_amount, v_service_amount);
  END IF;

  IF coalesce(o.tip_amount,0) <> 0 THEN
    v_line := v_line + 1;
    INSERT INTO public.invoice_lines (organization_id, invoice_id, line_number, description,
      source_module, source_record_id, revenue_account_id, quantity, unit_price,
      net_amount, total_amount)
    VALUES (org, v_invoice, v_line, 'Rider tip', 'delivery', _order, v_revenue, 1,
      o.tip_amount, o.tip_amount, o.tip_amount);
  END IF;

  v_key := 'delivery-invoice:' || _order::text;
  v_jnum := public.next_document_number('journal');

  INSERT INTO public.journal_entries (organization_id, branch_id, journal_number, journal_type,
    accounting_date, source_module, source_document_type, source_document_id, document_number,
    idempotency_key, description, currency, created_by, status)
  VALUES (org, o.branch_id, v_jnum, 'automatic', CURRENT_DATE, 'delivery', 'delivery_invoice',
    v_invoice, v_number, v_key,
    'Delivery order ' || o.order_number || ' billed on invoice ' || v_number
      || coalesce(' — ' || nullif(btrim(coalesce(_reason,'')),''), ''),
    coalesce(o.currency,'KES'), auth.uid(), 'draft')
  RETURNING id INTO v_journal;

  v_jline := v_jline + 1;
  INSERT INTO public.journal_entry_lines (organization_id, journal_id, line_number, account_id,
    description, debit, credit, branch_id, customer_id, revenue_centre, payment_method)
  VALUES (org, v_journal, v_jline, v_debit,
    CASE WHEN v_paid THEN 'Delivery receipt ' || o.order_number
         ELSE 'Delivery receivable ' || o.order_number END,
    coalesce(o.grand_total,0), 0, o.branch_id, o.customer_id, 'delivery',
    nullif(v_method,''));

  v_jline := v_jline + 1;
  INSERT INTO public.journal_entry_lines (organization_id, journal_id, line_number, account_id,
    description, debit, credit, branch_id, customer_id, revenue_centre, payment_method)
  VALUES (org, v_journal, v_jline, v_revenue, 'Delivery revenue ' || o.order_number,
    0, v_revenue_credit, o.branch_id, o.customer_id, 'delivery', nullif(v_method,''));

  IF v_service_amount <> 0 THEN
    v_jline := v_jline + 1;
    INSERT INTO public.journal_entry_lines (organization_id, journal_id, line_number, account_id,
      description, debit, credit, branch_id, customer_id, revenue_centre, payment_method)
    VALUES (org, v_journal, v_jline, v_service, 'Service charge on ' || o.order_number,
      0, v_service_amount, o.branch_id, o.customer_id, 'delivery', nullif(v_method,''));
  END IF;

  IF v_tax > 0 THEN
    v_jline := v_jline + 1;
    INSERT INTO public.journal_entry_lines (organization_id, journal_id, line_number, account_id,
      description, debit, credit, branch_id, customer_id, revenue_centre, payment_method)
    VALUES (org, v_journal, v_jline, v_vat, 'Output VAT on ' || o.order_number,
      0, v_tax, o.branch_id, o.customer_id, 'delivery', nullif(v_method,''));
  END IF;

  v_prior:=coalesce(current_setting('neo.system_posting',true),'off');
  BEGIN PERFORM set_config('neo.system_posting','on',true);PERFORM public.fin_post_journal(v_journal);PERFORM set_config('neo.system_posting',v_prior,true);EXCEPTION WHEN OTHERS THEN PERFORM set_config('neo.system_posting',v_prior,true);RAISE;END;
  IF NOT public.neo_connection_journal_matches(v_journal,org,o.branch_id,o.currency,o.grand_total,'delivery_invoice',v_invoice) THEN RAISE EXCEPTION 'Delivery invoice did not produce a matching balanced posted journal'; END IF;

  UPDATE public.invoices SET status='issued',journal_id = v_journal, updated_at = now() WHERE id = v_invoice;

  INSERT INTO public.audit_logs (organization_id, branch_id, user_id, user_name, action, module,
    record_id, previous_value, new_value, reason)
  VALUES (org, o.branch_id, auth.uid(),
    coalesce((SELECT full_name FROM public.profiles WHERE id = auth.uid()), ''),
    'delivery.billed', 'delivery', o.order_number,
    jsonb_build_object('payment_status', o.payment_status),
    jsonb_build_object('invoice_number', v_number, 'journal_number', v_jnum,
      'total', o.grand_total, 'settled', v_paid,
      'service_charge', v_service_amount, 'delivery_fee', coalesce(o.delivery_fee,0)),
    nullif(btrim(coalesce(_reason,'')),''));

  RETURN jsonb_build_object('ok', true, 'invoice_id', v_invoice, 'invoice_number', v_number,
    'journal_id', v_journal, 'journal_number', v_jnum, 'settled', v_paid,
    'total', coalesce(o.grand_total,0), 'delivery_fee', coalesce(o.delivery_fee,0),
    'service_charge', v_service_amount);
END;
$function$
;

CREATE OR REPLACE FUNCTION public.neo_delivery_record_payment_v2(_order uuid, _amount numeric, _method text DEFAULT 'cash'::text, _entry_type text DEFAULT 'payment'::text, _reference text DEFAULT NULL::text, _reason text DEFAULT NULL::text, _account uuid DEFAULT NULL::uuid, _attempt uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  o public.delivery_orders;
  inv public.invoices;
  org uuid;
  v_method text := lower(nullif(btrim(coalesce(_method, '')), ''));
  v_entry text := lower(coalesce(nullif(btrim(_entry_type), ''), 'payment'));
  v_amount numeric := round(coalesce(_amount, 0)::numeric, 2);
  v_debit uuid; v_ar uuid; v_receipt text; v_payment uuid; v_journal uuid; v_jnum text;
  v_shift uuid; v_prior text;
  v_key text; v_balance numeric; acct uuid;
BEGIN
  IF auth.uid() IS NULL OR public.current_org_id() IS NULL OR public.current_access_scope() IS NULL OR public.current_access_scope()='technical' THEN RAISE EXCEPTION 'An authorised staff workspace is required' USING ERRCODE='42501'; END IF;
  IF _attempt IS NULL THEN RAISE EXCEPTION 'A payment attempt identity is required'; END IF;
  IF _amount IS NULL OR _amount::text IN ('NaN','Infinity','-Infinity') OR _amount<=0 OR round(_amount,2)<>_amount THEN RAISE EXCEPTION 'Enter a finite positive payment amount in cents'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('delivery-attempt:'||public.current_org_id()::text||':'||_attempt::text,0));
  IF v_entry NOT IN ('deposit','payment') THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'bad_entry_type',
      'detail', 'Record either a deposit or a payment.');
  END IF;
  IF v_method IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'no_method',
      'detail', 'Choose how the money was received.');
  END IF;
  IF v_amount <= 0 THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'bad_amount',
      'detail', 'The amount must be greater than zero.');
  END IF;

  SELECT * INTO o FROM public.delivery_orders WHERE id = _order FOR UPDATE;
  IF o.id IS NULL THEN RETURN jsonb_build_object('ok', false, 'reason', 'order_not_found'); END IF;
  org := o.organization_id;
  IF org <> public.current_org_id() THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'order_not_found');
  END IF;
  IF NOT public.neo_delivery_can_record_payment(org) THEN
    RAISE EXCEPTION 'Permission to record a payment is required.' USING ERRCODE = '42501';
  END IF;
  IF NOT public.neo_branch_in_scope(o.branch_id) THEN
    RAISE EXCEPTION 'That order is outside your access scope.' USING ERRCODE = '42501';
  END IF;

  IF o.branch_id IS NULL OR o.order_status IN ('cancelled','rejected','failed','refunded') THEN RAISE EXCEPTION 'This delivery is not eligible for a payment'; END IF;
  IF v_method<>'cash' AND nullif(btrim(coalesce(_reference,'')),'') IS NULL THEN RAISE EXCEPTION 'A payment confirmation reference is required'; END IF;
  acct := public.neo_assert_financial_account(org, o.branch_id, _account);

  SELECT * INTO inv FROM public.invoices
   WHERE organization_id = org AND notes LIKE '%delivery-order:' || _order::text || '%'
   ORDER BY created_at LIMIT 1
   FOR UPDATE;
  IF inv.id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_billed',
      'detail', 'Raise the invoice for this delivery before recording money against it.');
  END IF;

  IF inv.branch_id IS DISTINCT FROM o.branch_id OR inv.currency IS DISTINCT FROM o.currency OR inv.status IN ('draft','cancelled','void','voided') OR inv.balance IS NULL OR inv.balance::text IN ('NaN','Infinity','-Infinity') THEN RAISE EXCEPTION 'Delivery invoice property, currency or status needs review'; END IF;
  IF (SELECT count(*) FROM public.invoices i WHERE i.organization_id=org AND i.notes LIKE '%delivery-order:'||_order::text||'%')<>1 THEN RAISE EXCEPTION 'Delivery has ambiguous invoice links; reconcile before collecting'; END IF;
  v_key := 'delivery-payment-v2:' || _attempt::text;

  SELECT id INTO v_payment FROM public.payments
   WHERE organization_id = org AND idempotency_key = v_key LIMIT 1;

  IF v_payment IS NOT NULL THEN
    IF NOT EXISTS (
      SELECT 1
      FROM public.payments existing_payment
      WHERE existing_payment.id = v_payment
        AND existing_payment.organization_id = org
        AND existing_payment.source_record_id = _order
        AND existing_payment.amount = v_amount
        AND existing_payment.method = v_method
        AND existing_payment.source_module='delivery'
        AND existing_payment.status='confirmed'
        AND existing_payment.external_reference IS NOT DISTINCT FROM nullif(btrim(coalesce(_reference,'')),'')
        AND existing_payment.notes LIKE initcap(v_entry)||' for delivery order %'
        AND EXISTS(SELECT 1 FROM public.journal_entries j WHERE j.id=existing_payment.posted_journal_id AND j.organization_id=org AND j.branch_id IS NOT DISTINCT FROM o.branch_id AND j.status='posted' AND j.total_debit=v_amount AND j.total_credit=v_amount)
        AND existing_payment.destination_account_id
            IS NOT DISTINCT FROM acct
    ) THEN
      RETURN jsonb_build_object(
        'ok', false,
        'reason', 'idempotency_conflict',
        'detail', 'This reference already belongs to different payment details.'
      );
    END IF;

    RETURN (SELECT jsonb_build_object('ok',true,'already_recorded',true,'payment_id',p.id,'receipt_number',p.receipt_number,'journal_id',j.id,'journal_number',j.journal_number,'amount',p.amount,'entry_type',v_entry,'invoice_number',inv.invoice_number,'balance',inv.balance,'destination_account_id',p.destination_account_id) FROM public.payments p JOIN public.journal_entries j ON j.id=p.posted_journal_id WHERE p.id=v_payment);
  END IF;

  IF v_method<>'cash' THEN
    PERFORM pg_advisory_xact_lock(hashtextextended('neo:'||v_method||':'||org::text||':'||upper(btrim(_reference)),0));
    IF EXISTS(SELECT 1 FROM public.payments p WHERE p.organization_id=org AND p.status NOT IN ('cancelled','failed') AND upper(btrim(coalesce(p.external_reference,'')))=upper(btrim(_reference))) OR EXISTS(SELECT 1 FROM public.pos_payments p WHERE p.organization_id=org AND p.status NOT IN ('cancelled','failed') AND upper(btrim(coalesce(p.external_reference,'')))=upper(btrim(_reference))) THEN RAISE EXCEPTION 'Payment confirmation reference is already linked to a saved receipt. Review it before collecting again'; END IF;
  END IF;
  v_balance := round(coalesce(inv.balance, 0)::numeric, 2);
  IF v_balance <= 0 THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'nothing_outstanding',
      'detail', 'This delivery invoice is already settled.');
  END IF;
  IF v_amount > v_balance THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'amount_exceeds_balance',
      'detail', 'That is more than the outstanding balance on this delivery invoice.',
      'balance', v_balance);
  END IF;

  SELECT a.id INTO v_debit FROM public.chart_of_accounts a
   WHERE a.organization_id = org AND a.active AND coalesce(a.postable, true)
     AND a.code = public.neo_gl_account_code(org, v_method, acct)
   LIMIT 1;
  IF v_debit IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'no_settlement_account',
      'detail', 'No money account is configured for that payment method.');
  END IF;

  SELECT a.id INTO v_ar FROM public.chart_of_accounts a
   WHERE a.organization_id = org AND a.active AND coalesce(a.postable, true)
     AND a.name ILIKE 'Accounts Receivable'
   ORDER BY a.code LIMIT 1;
  IF v_ar IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'no_receivable_account',
      'detail', 'This property has no Accounts Receivable account.');
  END IF;


  -- neo_delivery_till_journal_v1
  v_shift := NULL;

  IF v_method = 'cash' THEN
    SELECT s.id INTO v_shift
    FROM public.pos_shifts s
    WHERE s.organization_id = org
      AND s.branch_id = o.branch_id
      AND s.cashier_id = auth.uid()
      AND s.status = 'open'
    ORDER BY s.opened_at DESC, s.id
    LIMIT 1
    FOR UPDATE;

    IF v_shift IS NULL THEN
      RAISE EXCEPTION
        'Open your cashier shift at this property before recording cash'
        USING ERRCODE = '23514';
    END IF;
  END IF;

  v_receipt := public.next_document_number('receipt', NULL, o.branch_id);

  INSERT INTO public.payments (organization_id, branch_id, receipt_number, customer_id, amount,
    currency, method, external_reference, status, received_by, notes, source_module,
    source_record_id, idempotency_key, destination_account_id, shift_id)
  VALUES (org, o.branch_id, v_receipt, o.customer_id, v_amount,
    coalesce(o.currency,'KES'), v_method, nullif(btrim(coalesce(_reference,'')), ''),
    'draft', auth.uid(),
    initcap(v_entry) || ' for delivery order ' || o.order_number || ' · invoice ' || inv.invoice_number
      || coalesce(' · ' || nullif(btrim(coalesce(_reason,'')), ''), ''),
    'delivery', _order, v_key, acct, v_shift)
  RETURNING id INTO v_payment;

  v_jnum := public.next_document_number('journal');
  INSERT INTO public.journal_entries (organization_id, branch_id, journal_number, journal_type,
    accounting_date, source_module, source_document_type, source_document_id, document_number,
    idempotency_key, description, currency, created_by, status)
  VALUES (org, o.branch_id, v_jnum, 'automatic', CURRENT_DATE, 'delivery', 'delivery_payment',
    v_payment, v_receipt, v_key,
    initcap(v_entry) || ' received on delivery order ' || o.order_number
      || ' against invoice ' || inv.invoice_number
      || coalesce(' — ' || nullif(btrim(coalesce(_reason,'')), ''), ''),
    coalesce(o.currency,'KES'), auth.uid(), 'draft')
  RETURNING id INTO v_journal;

  INSERT INTO public.journal_entry_lines (organization_id, journal_id, line_number, account_id,
    description, debit, credit, branch_id, customer_id, revenue_centre, payment_method)
  VALUES (org, v_journal, 1, v_debit, initcap(v_entry) || ' ' || v_receipt, v_amount, 0,
    o.branch_id, o.customer_id, 'delivery', v_method);

  INSERT INTO public.journal_entry_lines (organization_id, journal_id, line_number, account_id,
    description, debit, credit, branch_id, customer_id, revenue_centre, payment_method)
  VALUES (org, v_journal, 2, v_ar, 'Settlement of ' || inv.invoice_number, 0, v_amount,
    o.branch_id, o.customer_id, 'delivery', v_method);

  v_prior:=coalesce(current_setting('neo.system_posting',true),'off');
  BEGIN
    PERFORM set_config('neo.system_posting','on',true);
    PERFORM public.fin_post_journal(v_journal);
    PERFORM set_config('neo.system_posting',v_prior,true);
  EXCEPTION WHEN OTHERS THEN PERFORM set_config('neo.system_posting',v_prior,true); RAISE; END;

  IF NOT EXISTS(SELECT 1 FROM public.journal_entries j WHERE j.id=v_journal AND j.organization_id=org AND j.branch_id IS NOT DISTINCT FROM o.branch_id AND j.status='posted' AND j.currency=o.currency AND j.total_debit=v_amount AND j.total_credit=v_amount AND (SELECT coalesce(sum(l.debit),0) FROM public.journal_entry_lines l WHERE l.journal_id=j.id)=v_amount AND (SELECT coalesce(sum(l.credit),0) FROM public.journal_entry_lines l WHERE l.journal_id=j.id)=v_amount) THEN RAISE EXCEPTION 'Delivery receipt requires a balanced posted journal'; END IF;
  UPDATE public.payments SET status='confirmed',paid_at=now(),posted_journal_id = v_journal, updated_at = now()
   WHERE id = v_payment;

  UPDATE public.invoices
     SET amount_paid = round(coalesce(amount_paid,0) + v_amount, 2),
         balance = round(coalesce(balance,0) - v_amount, 2),
         status = CASE WHEN round(coalesce(balance,0) - v_amount, 2) <= 0 THEN 'paid' ELSE status END,
         updated_at = now()
   WHERE id = inv.id
   RETURNING balance INTO v_balance;

  IF v_balance <= 0 THEN
    UPDATE public.delivery_orders
       SET payment_status = 'paid',
           payment_method = coalesce(payment_method, v_method),
           updated_at = now()
     WHERE id = _order;
  ELSE
    UPDATE public.delivery_orders
       SET payment_status = 'partially-paid', updated_at = now()
     WHERE id = _order
       AND lower(coalesce(payment_status,'')) NOT IN ('paid','refunded');
  END IF;

  INSERT INTO public.audit_logs (organization_id, branch_id, user_id, user_name, action, module,
    record_id, previous_value, new_value, reason)
  VALUES (org, o.branch_id, auth.uid(),
    coalesce((SELECT full_name FROM public.profiles WHERE id = auth.uid()), ''),
    'delivery.payment.recorded', 'delivery', o.order_number,
    jsonb_build_object('invoice', inv.invoice_number, 'balance_before', inv.balance),
    jsonb_build_object('entry_type', v_entry, 'amount', v_amount, 'method', v_method,
      'receipt', v_receipt, 'journal', v_jnum, 'balance_after', v_balance,
      'destination_account_id', acct),
    nullif(btrim(coalesce(_reason,'')), ''));

  RETURN jsonb_build_object('ok', true, 'payment_id', v_payment, 'receipt_number', v_receipt,
    'journal_id', v_journal, 'journal_number', v_jnum, 'amount', v_amount,
    'entry_type', v_entry, 'invoice_number', inv.invoice_number, 'balance', v_balance,
    'destination_account_id', acct);
END;
$function$
;

REVOKE ALL ON FUNCTION public.neo_delivery_record_payment_v2(uuid,numeric,text,text,text,text,uuid,uuid) FROM PUBLIC,anon;GRANT EXECUTE ON FUNCTION public.neo_delivery_record_payment_v2(uuid,numeric,text,text,text,text,uuid,uuid) TO authenticated;

CREATE OR REPLACE FUNCTION public.neo_delivery_record_payment(_order uuid,_amount numeric,_method text DEFAULT 'cash',_entry_type text DEFAULT 'payment',_reference text DEFAULT NULL,_reason text DEFAULT NULL,_account uuid DEFAULT NULL) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $f$
DECLARE attempt uuid; oldkey text; old public.payments; o public.delivery_orders; j public.journal_entries;
BEGIN
 IF NOT coalesce(public.neo_delivery_can_record_payment(public.current_org_id()),false) THEN RAISE EXCEPTION 'Permission to record a payment is required' USING ERRCODE='42501'; END IF;
 attempt:=md5('legacy-delivery:'||coalesce(public.current_org_id()::text,'')||':'||_order::text||':'||coalesce(_entry_type,'payment')||':'||coalesce(nullif(btrim(_reference),''),round(_amount,2)::text))::uuid;
 PERFORM pg_advisory_xact_lock(hashtextextended('delivery-attempt:'||public.current_org_id()::text||':'||attempt::text,0));
 SELECT * INTO o FROM public.delivery_orders WHERE id=_order AND organization_id=public.current_org_id() FOR UPDATE;
 IF o.id IS NULL OR NOT coalesce(public.neo_branch_in_scope(o.branch_id),false) THEN RAISE EXCEPTION 'Delivery is outside current property scope'; END IF;
 oldkey:='delivery-payment:'||_order::text||':'||coalesce(_entry_type,'payment')||':'||coalesce(nullif(btrim(_reference),''),round(_amount,2)::text);
 SELECT * INTO old FROM public.payments WHERE organization_id=o.organization_id AND idempotency_key=oldkey;
 IF old.id IS NOT NULL THEN
  IF old.source_module IS DISTINCT FROM 'delivery' OR old.source_record_id IS DISTINCT FROM o.id OR old.branch_id IS DISTINCT FROM o.branch_id OR old.amount IS DISTINCT FROM _amount OR old.method IS DISTINCT FROM lower(_method) OR old.destination_account_id IS DISTINCT FROM public.neo_assert_financial_account(o.organization_id,o.branch_id,_account) OR old.status IS DISTINCT FROM 'confirmed' OR NOT public.neo_connection_journal_matches(old.posted_journal_id,o.organization_id,o.branch_id,old.currency,old.amount,'delivery_payment',old.id) THEN RAISE EXCEPTION 'Legacy payment retry conflicts with its saved receipt'; END IF;
  SELECT * INTO j FROM public.journal_entries WHERE id=old.posted_journal_id;
  RETURN jsonb_build_object('ok',true,'already_recorded',true,'payment_id',old.id,'receipt_number',old.receipt_number,'journal_id',j.id,'journal_number',j.journal_number,'amount',old.amount);
 END IF;
 RETURN public.neo_delivery_record_payment_v2(_order,_amount,_method,_entry_type,_reference,_reason,_account,attempt);
END $f$;

-- E1C-1: Transactional quotation line-item pricing.
-- Code migration only. Requires separate controlled database installation.
--
-- Only draft quotations can be repriced.
-- Prices are derived from line items, not trusted from client totals.

CREATE OR REPLACE FUNCTION public.neo_event_quotation_price(
    _quotation uuid,
    _items jsonb,
    _discount numeric DEFAULT 0,
    _tax_rate numeric DEFAULT 0,
    _service_rate numeric DEFAULT 0,
    _deposit_percent numeric DEFAULT 50
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
    v_org uuid := public.current_org_id();
    v_q public.event_quotations%ROWTYPE;
    v_item jsonb;
    v_description text;
    v_category text;
    v_unit text;
    v_quantity numeric;
    v_price numeric;
    v_cost numeric;
    v_line numeric;
    v_subtotal numeric := 0;
    v_taxable numeric := 0;
    v_discount numeric;
    v_tax numeric;
    v_service numeric;
    v_total numeric;
    v_deposit numeric;
    v_balance numeric;
    v_count integer := 0;
    v_sort integer := 0;
BEGIN
    IF auth.uid() IS NULL OR v_org IS NULL THEN
        RAISE EXCEPTION 'An authenticated workspace is required.'
            USING ERRCODE = '42501';
    END IF;

    IF NOT public.has_permission('events', 'quotations', 'edit') THEN
        RAISE EXCEPTION 'Quotation editing permission is required.'
            USING ERRCODE = '42501';
    END IF;

    SELECT *
      INTO v_q
      FROM public.event_quotations
     WHERE id = _quotation
       AND organization_id = v_org
     FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Quotation not found in this workspace.'
            USING ERRCODE = 'P0002';
    END IF;

    IF v_q.branch_id IS NULL OR NOT coalesce(public.neo_branch_in_scope(v_q.branch_id),false) THEN
        RAISE EXCEPTION 'Quotation property is outside your access scope.'
            USING ERRCODE = '42501';
    END IF;

    IF v_q.status <> 'draft' THEN
        RAISE EXCEPTION 'Only draft quotations can be edited. Create a revision first.'
            USING ERRCODE = '22023';
    END IF;

    IF _items IS NULL
       OR jsonb_typeof(_items) <> 'array'
       OR jsonb_array_length(_items) = 0 THEN
        RAISE EXCEPTION 'Provide at least one quotation line item.'
            USING ERRCODE = '22023';
    END IF;

    IF jsonb_array_length(_items) > 200 THEN
        RAISE EXCEPTION 'A quotation cannot contain more than 200 lines.'
            USING ERRCODE = '22023';
    END IF;

    IF _discount::text IN ('NaN','Infinity','-Infinity') OR _tax_rate::text IN ('NaN','Infinity','-Infinity') OR _service_rate::text IN ('NaN','Infinity','-Infinity') OR _deposit_percent::text IN ('NaN','Infinity','-Infinity') OR _discount IS NULL OR _discount < 0
       OR _tax_rate IS NULL OR _tax_rate < 0 OR _tax_rate > 100
       OR _service_rate IS NULL OR _service_rate < 0 OR _service_rate > 100
       OR _deposit_percent IS NULL
       OR _deposit_percent < 0 OR _deposit_percent > 100 THEN
        RAISE EXCEPTION 'Invalid discount, tax, service charge or deposit percentage.'
            USING ERRCODE = '22023';
    END IF;

    -- Existing lines belong to this draft only.
    -- Any error below rolls back the entire operation.
    DELETE FROM public.event_quotation_items
     WHERE quotation_id = _quotation
       AND organization_id = v_org;

    FOR v_item IN
        SELECT value FROM jsonb_array_elements(_items)
    LOOP
        IF jsonb_typeof(v_item) <> 'object' THEN
            RAISE EXCEPTION 'Every quotation line must be an object.'
                USING ERRCODE = '22023';
        END IF;

        v_description := nullif(btrim(coalesce(v_item->>'description', '')), '');
        v_category := coalesce(nullif(btrim(v_item->>'category'), ''), 'other');
        v_unit := coalesce(nullif(btrim(v_item->>'unit'), ''), 'unit');

        v_quantity := nullif(v_item->>'quantity', '')::numeric;
        v_price := nullif(v_item->>'unit_price', '')::numeric;
        v_cost := coalesce(nullif(v_item->>'unit_cost', '')::numeric, 0);

        IF v_quantity::text IN ('NaN','Infinity','-Infinity') OR v_price::text IN ('NaN','Infinity','-Infinity') OR v_cost::text IN ('NaN','Infinity','-Infinity') OR v_description IS NULL
           OR v_quantity IS NULL OR v_quantity <= 0
           OR v_price IS NULL OR v_price < 0
           OR v_cost < 0 THEN
            RAISE EXCEPTION 'Invalid description, quantity or price on quotation line %.',
                v_sort + 1
                USING ERRCODE = '22023';
        END IF;

        v_line := round(v_quantity * v_price, 2);
        v_sort := v_sort + 1;

        INSERT INTO public.event_quotation_items (
            organization_id,
            quotation_id,
            category,
            description,
            quantity,
            unit,
            unit_price,
            line_total,
            taxable,
            unit_cost,
            sort_order
        )
        VALUES (
            v_org,
            _quotation,
            v_category,
            v_description,
            v_quantity,
            v_unit,
            v_price,
            v_line,
            coalesce((v_item->>'taxable')::boolean, true),
            v_cost,
            v_sort
        );

        v_subtotal := v_subtotal + v_line;

        IF coalesce((v_item->>'taxable')::boolean, true) THEN
            v_taxable := v_taxable + v_line;
        END IF;

        v_count := v_count + 1;
    END LOOP;

    IF _discount > v_subtotal THEN
        RAISE EXCEPTION 'Discount cannot exceed the quotation subtotal.'
            USING ERRCODE = '22023';
    END IF;

    v_discount := round(_discount, 2);

    -- Allocate the discount proportionately across taxable and non-taxable lines.
    IF v_subtotal > 0 THEN
        v_taxable := greatest(
            0,
            v_taxable - (v_discount * v_taxable / v_subtotal)
        );
    END IF;

    v_tax := round(v_taxable * _tax_rate / 100, 2);
    v_service := round((v_subtotal - v_discount) * _service_rate / 100, 2);

    v_total := round(
        v_subtotal - v_discount + v_service + v_tax,
        2
    );

    v_deposit := round(v_total * _deposit_percent / 100, 2);
    v_balance := v_total - v_deposit;

    UPDATE public.event_quotations
       SET subtotal = v_subtotal,
           discount_amount = v_discount,
           service_charge_rate = _service_rate,
           service_charge_amount = v_service,
           tax_rate = _tax_rate,
           tax_amount = v_tax,
           grand_total = v_total,
           deposit_percent = _deposit_percent,
           deposit_amount = v_deposit,
           balance_due = v_balance,
           updated_by = auth.uid(),
           updated_at = now()
     WHERE id = _quotation
       AND organization_id = v_org;

    RETURN jsonb_build_object(
        'quotation_id', _quotation,
        'line_count', v_count,
        'subtotal', v_subtotal,
        'discount', v_discount,
        'service_charge', v_service,
        'tax', v_tax,
        'grand_total', v_total,
        'deposit_required', v_deposit,
        'post_deposit_remainder', v_balance,
        'status', 'draft'
    );
END;
$function$;

REVOKE ALL ON FUNCTION public.neo_event_quotation_price(
    uuid, jsonb, numeric, numeric, numeric, numeric
) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION public.neo_event_quotation_price(
    uuid, jsonb, numeric, numeric, numeric, numeric
) TO authenticated;

CREATE FUNCTION public.neo_hr_payroll_release_visible(_period uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public AS $f$ SELECT auth.uid() IS NOT NULL AND EXISTS(SELECT 1 FROM public.payroll_periods p JOIN public.journal_entries j ON j.id=p.posted_journal_id WHERE p.id=_period AND p.organization_id=public.current_org_id() AND p.status='exported' AND p.posted_at IS NOT NULL AND p.payslips_released_at IS NOT NULL AND j.organization_id=p.organization_id AND j.branch_id IS NOT DISTINCT FROM p.branch_id AND j.status='posted' AND j.source_document_type='payroll_period:payroll' AND j.source_document_id=p.id AND j.total_debit>0 AND j.total_debit=j.total_credit AND j.total_debit::text NOT IN ('NaN','Infinity','-Infinity') AND NOT EXISTS(SELECT 1 FROM public.journal_entry_lines l WHERE l.journal_id=j.id AND (l.organization_id IS DISTINCT FROM j.organization_id OR l.branch_id IS DISTINCT FROM j.branch_id)) AND (SELECT coalesce(sum(l.debit),0) FROM public.journal_entry_lines l WHERE l.journal_id=j.id)=j.total_debit AND (SELECT coalesce(sum(l.credit),0) FROM public.journal_entry_lines l WHERE l.journal_id=j.id)=j.total_credit AND EXISTS(SELECT 1 FROM public.payroll_input_records i JOIN public.employees e ON e.id=i.employee_id AND e.organization_id=i.organization_id WHERE i.period_id=p.id AND i.organization_id=p.organization_id AND e.profile_id=auth.uid())) $f$; REVOKE ALL ON FUNCTION public.neo_hr_payroll_release_visible(uuid) FROM PUBLIC,anon;GRANT EXECUTE ON FUNCTION public.neo_hr_payroll_release_visible(uuid) TO authenticated;
-- Payroll payslips are a view of posted payroll truth, not a pre-posting preview.
-- Preserve historical rows, but refuse new releases until the payroll journal exists
-- and hide any historically premature release from employee self-service.

CREATE OR REPLACE FUNCTION public.neo_hr_payroll_release_payslips(
  _period uuid,
  _release boolean DEFAULT true
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  _org uuid := public.current_org_id();
  _p public.payroll_periods;
BEGIN
  IF auth.uid() IS NULL OR _org IS NULL OR public.current_access_scope() IS NULL OR public.current_access_scope()='technical' THEN
    RAISE EXCEPTION 'No organisation context';
  END IF;

  IF NOT (public.has_permission('hr-payroll','approve') OR public.is_org_admin()) THEN
    RAISE EXCEPTION 'Not authorised to release payslips' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO _p
    FROM public.payroll_periods
   WHERE id = _period AND organization_id = _org
   FOR UPDATE;

  IF _p.id IS NULL THEN
    RAISE EXCEPTION 'Payroll period not found in this organisation';
  END IF;

  IF _release IS NULL THEN RAISE EXCEPTION 'Choose release or withdraw'; END IF;
  IF (_p.branch_id IS NOT NULL AND NOT coalesce(public.neo_branch_in_scope(_p.branch_id),false)) OR (_p.branch_id IS NULL AND NOT coalesce(public.is_org_admin() OR public.current_access_scope()='organisation',false)) THEN RAISE EXCEPTION 'Payroll period is outside your authorised scope' USING ERRCODE='42501'; END IF;
  IF _release THEN
    IF _p.status <> 'exported'
       OR _p.posted_journal_id IS NULL
       OR _p.posted_at IS NULL THEN
      RAISE EXCEPTION 'Post this payroll to Finance before releasing payslips';
    END IF;

    IF NOT EXISTS(SELECT 1 FROM public.journal_entries j WHERE j.id=_p.posted_journal_id AND j.organization_id=_org AND j.branch_id IS NOT DISTINCT FROM _p.branch_id AND j.status='posted' AND j.source_document_type='payroll_period:payroll' AND j.source_document_id=_p.id AND j.total_debit>0 AND j.total_debit=j.total_credit AND j.total_debit::text NOT IN ('NaN','Infinity','-Infinity') AND NOT EXISTS(SELECT 1 FROM public.journal_entry_lines l WHERE l.journal_id=j.id AND (l.organization_id IS DISTINCT FROM j.organization_id OR l.branch_id IS DISTINCT FROM j.branch_id)) AND (SELECT coalesce(sum(l.debit),0) FROM public.journal_entry_lines l WHERE l.journal_id=j.id)=j.total_debit AND (SELECT coalesce(sum(l.credit),0) FROM public.journal_entry_lines l WHERE l.journal_id=j.id)=j.total_credit) THEN RAISE EXCEPTION 'Payroll requires its matching balanced posted Finance journal'; END IF;
    UPDATE public.payroll_periods
       SET payslips_released_at = COALESCE(payslips_released_at, now()),
           payslips_released_by = COALESCE(payslips_released_by, auth.uid()),
           updated_at = now()
     WHERE id = _p.id;
  ELSE
    UPDATE public.payroll_periods
       SET payslips_released_at = NULL,
           payslips_released_by = NULL,
           updated_at = now()
     WHERE id = _p.id;
  END IF;

  PERFORM public.log_audit_event(
    _org,
    CASE WHEN _release THEN 'hr.payroll.payslips_released' ELSE 'hr.payroll.payslips_withdrawn' END,
    'human-resources',
    _p.id::text,
    jsonb_build_object(
      'released_at', _p.payslips_released_at,
      'status', _p.status,
      'posted_journal_id', _p.posted_journal_id
    ),
    jsonb_build_object(
      'released', _release,
      'journal_id', _p.posted_journal_id
    ),
    CASE WHEN _release
      THEN 'Payslips released after payroll posting'
      ELSE 'Payslips withdrawn from employee self-service'
    END
  );

  RETURN jsonb_build_object(
    'ok', true,
    'period_id', _p.id,
    'released', _release,
    'journal_id', _p.posted_journal_id
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.neo_hr_payroll_release_payslips(uuid, boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.neo_hr_payroll_release_payslips(uuid, boolean) TO authenticated;

DROP POLICY IF EXISTS "staff read own released payslip" ON public.payroll_input_records;
CREATE POLICY "staff read own released payslip" ON public.payroll_input_records FOR SELECT TO authenticated USING(organization_id=public.current_org_id() AND public.neo_hr_payroll_release_visible(period_id));
DROP POLICY IF EXISTS "staff read own released payroll periods" ON public.payroll_periods;
CREATE POLICY "staff read own released payroll periods" ON public.payroll_periods FOR SELECT TO authenticated USING(organization_id=public.current_org_id() AND public.neo_hr_payroll_release_visible(id));

NOTIFY pgrst,'reload schema';
WITH expected(signature,hash) AS(VALUES ('public.neo_event_quotation_price(uuid,jsonb,numeric,numeric,numeric,numeric)','e8a19dc4eb7306b54f3c2ab89b938814'),('public.neo_hr_payroll_release_payslips(uuid,boolean)','9152244202f172cafc3d50d04327c6f0'),('public.neo_hr_payroll_release_visible(uuid)','c751466ee23ae6e1b02560f9ade7596a'),('public.neo_connection_journal_matches(uuid,uuid,uuid,text,numeric,text,uuid)','209395bb00e8b95f142fd52b2abd0a4e'),('public.neo_delivery_bill(uuid,text)','a69b953a703f6c8f3805652314a740a7'),('public.neo_delivery_record_payment(uuid,numeric,text,text,text,text,uuid)','145d64b276c4305434345eabd7eefdc7'),('public.neo_delivery_record_payment_v2(uuid,numeric,text,text,text,text,uuid,uuid)','7cb0ed3bf99b8e210973c6344d88be53'),('public.neo_finance_post_txn(text,uuid,boolean)','dbb01aba5b96dd7badbdf3e30a5bc7dc')), checked AS(SELECT signature,coalesce(md5(pg_get_functiondef(to_regprocedure(signature)))=hash,false) matches FROM expected) SELECT jsonb_build_object('diagnostic_version','delivery-quotation-payroll-connections-v1','definitions_match',(SELECT bool_and(matches) FROM checked),'definition_checks',(SELECT jsonb_agg(to_jsonb(checked)) FROM checked),'staff_release_policies_present',(SELECT count(*)=2 FROM pg_policies WHERE schemaname='public' AND policyname IN ('staff read own released payslip','staff read own released payroll periods')),'scope','Installs missing delivery payment, event pricing and payroll release commands with verified journal ownership and staff visibility. No invoice, payment, quotation pricing or payroll release is executed by installation. Refund and remaining card work continue separately.') result;
COMMIT;
