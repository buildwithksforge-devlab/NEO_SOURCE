-- Actual saved receipt splits; no posting or payment command is invoked.
BEGIN;
DO $guard$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_proc p JOIN pg_roles owner ON owner.oid=p.proowner WHERE p.oid=to_regprocedure('public.neo_finance_post_txn(text,uuid,boolean)')
   AND owner.rolname NOT IN ('anon','authenticated') AND (md5(regexp_replace(regexp_replace(p.prosrc,'--[^'||chr(10)||']*','','g'),'[[:space:]]','','g'))='98df457b013ff3e99550855871a0ca77' OR md5(regexp_replace(regexp_replace(p.prosrc,'--[^'||chr(10)||']*','','g'),'[[:space:]]','','g'))='58aee2a801d8e5b2e3ba711aec8e866f'))
   OR to_regprocedure('public.neo_tip_payable_account(uuid)') IS NULL THEN
  RAISE EXCEPTION 'Installed posting routine differs from the reviewed Finance parity version; nothing replaced';
 END IF;
END $guard$;
CREATE TEMP TABLE neo_pos_settlement_acl ON COMMIT DROP AS SELECT proowner,coalesce(proacl::text,'') acl FROM pg_proc WHERE oid='public.neo_finance_post_txn(text,uuid,boolean)'::regprocedure;
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
  customer uuid; net numeric; tax numeric; svc numeric; settle text; tip_account uuid; tip_code text;
  o public.pos_orders; fl public.folio_lines; pay public.payments;
  ev public.event_bookings; inv public.invoices; si public.supplier_invoices;
  sp public.supplier_payments; lo public.guest_laundry_orders; deliv record;
  paid numeric; remainder numeric; key text; collection record; collected numeric; refund_deposit_source public.reservation_deposits; refund_deposit_journal uuid;
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
    IF EXISTS(SELECT 1 FROM public.delivery_orders d WHERE d.pos_order_id=o.id AND d.organization_id=org AND d.payment_method='room-charge') THEN
      RETURN public.neo_finance_post_txn('delivery_order',(SELECT d.id FROM public.delivery_orders d WHERE d.pos_order_id=o.id AND d.organization_id=org),true);
    END IF;
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
    IF EXISTS(SELECT 1 FROM public.pos_payments p WHERE p.order_id=o.id
      AND p.status IN ('confirmed','paid','completed','captured','settled') AND
      (p.organization_id IS DISTINCT FROM org OR p.branch_id IS DISTINCT FROM o.branch_id OR p.currency IS DISTINCT FROM o.currency
       OR p.amount IS NULL OR p.amount<=0 OR p.amount::text IN ('NaN','Infinity','-Infinity') OR p.amount<>round(p.amount,2))) THEN
     RAISE EXCEPTION 'POS settlement receipts require consistent property, currency and finite amounts';
    END IF;
    SELECT coalesce(sum(p.amount),0) INTO collected FROM public.pos_payments p WHERE p.order_id=o.id AND p.organization_id=org
      AND p.status IN ('confirmed','paid','completed','captured','settled');
    IF collected>amount+0.005 THEN RAISE EXCEPTION 'Verified POS collections exceed the sale; reconcile the customer overpayment before sale posting'; END IF;
    IF collected<amount-0.005 AND o.corporate_account_id IS NULL THEN RAISE EXCEPTION 'POS sale lacks sufficient saved settlement receipts'; END IF;
    lines:='[]'::jsonb;
    FOR collection IN SELECT p.method,p.destination_account_id,sum(p.amount) AS amount FROM public.pos_payments p
      WHERE p.order_id=o.id AND p.organization_id=org AND p.status IN ('confirmed','paid','completed','captured','settled')
      GROUP BY p.method,p.destination_account_id LOOP
     IF collection.destination_account_id IS NOT NULL AND lower(replace(coalesce(collection.method,''),'-','_')) NOT IN ('card','card_terminal','credit_card','debit_card')
       AND NOT EXISTS(SELECT 1 FROM public.bank_accounts b JOIN public.chart_of_accounts a ON a.id=b.gl_account_id AND a.organization_id=b.organization_id
         WHERE b.id=collection.destination_account_id AND b.organization_id=org AND b.active AND a.active AND a.postable AND NOT coalesce(a.is_header,false)) THEN
      RAISE EXCEPTION 'Saved POS receiving account is unavailable; reconcile it instead of falling back to another account';
     END IF;
     settle:=public.neo_gl_account_code(org,collection.method,collection.destination_account_id);
     IF nullif(btrim(settle),'') IS NULL THEN RAISE EXCEPTION 'POS receipt settlement account is not configured'; END IF;
     lines:=lines||jsonb_build_array(jsonb_build_object('code',settle,'debit',collection.amount,'description','Receipt settlement '||coalesce(ref,'')));
    END LOOP;
    IF collected<amount THEN lines:=lines||jsonb_build_array(jsonb_build_object('code','1060','debit',amount-collected,'description','Corporate credit balance')); END IF;
    lines:=lines||jsonb_build_array(
      jsonb_build_object('code',public.neo_gl_revenue_code_scoped(org,o.order_type,NULL),'credit',net),
      jsonb_build_object('code','2040','credit',tax,'description','Tax'),
      jsonb_build_object('code','2050','credit',svc,'description','Service charge'));

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
    IF fl.category='gratuity' THEN posting:='gratuity-liability'; END IF;
    net := coalesce(fl.gross_amount,0) - coalesce(fl.discount_amount,0);
    IF fl.category='gratuity' THEN
      tip_account:=public.neo_tip_payable_account(org);
      SELECT a.code INTO tip_code FROM public.chart_of_accounts a WHERE a.id=tip_account;
    END IF;
    IF amount <= 0 THEN RETURN jsonb_build_object('ok', false, 'reason', 'zero_amount'); END IF;
    lines := jsonb_build_array(
      jsonb_build_object('code', '1060', 'debit', amount, 'description', 'Guest ledger ' || coalesce(ref,'')),
      jsonb_build_object('code', CASE WHEN fl.category='gratuity' THEN tip_code ELSE public.neo_gl_revenue_code_scoped(org, fl.category, fl.revenue_centre) END, 'credit', net),
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
    SELECT * INTO refund_deposit_source FROM public.reservation_deposits d WHERE d.payment_id=pay.id AND d.organization_id=org AND d.status IN ('held','applied');
    IF refund_deposit_source.id IS NOT NULL THEN
      IF refund_deposit_source.amount IS DISTINCT FROM amount THEN RAISE EXCEPTION 'Original deposit receipt amount differs'; END IF;
      SELECT j.id INTO refund_deposit_journal FROM public.journal_entries j WHERE public.neo_connection_journal_matches(j.id,org,branch,pay.currency,amount,'reservation_deposit:deposit',refund_deposit_source.id) LIMIT 1;
      IF refund_deposit_journal IS NULL THEN RAISE EXCEPTION 'Original deposit receipt requires its posted liability journal'; END IF;
      RETURN jsonb_build_object('ok',true,'journal_id',refund_deposit_journal,'duplicate_prevented',true,'posting_type','deposit','amount',amount);
    END IF;
    IF pay.source_module='cash_refund' THEN
      IF NOT public.neo_cash_refund_payment_valid(pay.id) THEN RAISE EXCEPTION 'Refund receipt requires its settled original-receipt link and matching posted journal'; END IF;
      PERFORM public.neo_record_posting_receipt(org,branch,_source_type,_source_id,ref,'posted',amount,pay.currency,NULL,'Verified separately linked refund payout journal',NULL,occurred);
      UPDATE public.finance_posting_receipts SET posting_type='refund',journal_id=pay.posted_journal_id WHERE organization_id=org AND source_module=_source_type AND source_id=_source_id;
      RETURN jsonb_build_object('ok',true,'journal_id',pay.posted_journal_id,'duplicate_prevented',true,'amount',amount,'posting_type','refund');
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
           d.order_status, d.payment_status, d.payment_method, d.delivered_at, d.created_at,
           d.pos_order_id,d.fulfilment_type,d.service_charge_total,d.tip_amount,d.currency
      INTO deliv FROM public.delivery_orders d
      WHERE d.id = _source_id AND d.organization_id = org FOR UPDATE;
    IF deliv.id IS NULL THEN RETURN jsonb_build_object('ok', false, 'reason', 'not_found'); END IF;
    branch := deliv.branch_id; ref := deliv.order_number; customer := deliv.customer_id;
    occurred := coalesce(deliv.delivered_at, deliv.created_at)::date;
    amount := coalesce(deliv.grand_total,0); tax := coalesce(deliv.tax_total,0);
    IF deliv.payment_method='room-charge' THEN
      SELECT * INTO o FROM public.pos_orders WHERE id=deliv.pos_order_id AND organization_id=org;
      IF o.id IS NULL OR o.folio_id IS NULL OR o.folio_post_status IS DISTINCT FROM 'posted' THEN
        RETURN jsonb_build_object('ok',false,'reason','awaiting_room_folio','detail','Room service must reach its saved guest folio before Finance completion.');
      END IF;
      SELECT coalesce(sum(f.net_amount),0) INTO paid FROM public.folio_lines f
       WHERE f.organization_id=org AND f.folio_id=o.folio_id AND f.status='posted'
         AND f.source_record_uuid=o.id AND f.source_module='pos_order'
         AND f.idempotency_key IN ('guest_room_service:'||o.id::text,'guest_room_service_tip:'||o.id::text);
      IF paid IS DISTINCT FROM amount OR NOT EXISTS(SELECT 1 FROM public.folio_lines f
          WHERE f.organization_id=org AND f.folio_id=o.folio_id AND f.status='posted' AND f.source_record_uuid=o.id
            AND f.idempotency_key='guest_room_service:'||o.id::text)
        OR EXISTS(SELECT 1 FROM public.folio_lines f WHERE f.organization_id=org AND f.folio_id=o.folio_id
          AND f.status='posted' AND f.source_record_uuid=o.id AND f.source_module='pos_order'
          AND f.idempotency_key IN ('guest_room_service:'||o.id::text,'guest_room_service_tip:'||o.id::text)
          AND f.net_amount>0 AND NOT EXISTS(SELECT 1 FROM public.journal_entries j WHERE j.organization_id=org
            AND j.branch_id IS NOT DISTINCT FROM o.branch_id AND j.source_document_id=f.id
            AND j.source_document_type='folio_charge:'||CASE WHEN f.category='gratuity' THEN 'gratuity-liability' ELSE 'revenue' END
            AND j.status='posted' AND j.reversed_by_journal_id IS NULL AND j.currency=o.currency
            AND j.total_debit=f.net_amount AND j.total_credit=f.net_amount
            AND (SELECT coalesce(sum(l.debit),0) FROM public.journal_entry_lines l WHERE l.journal_id=j.id)=f.net_amount
            AND (SELECT coalesce(sum(l.credit),0) FROM public.journal_entry_lines l WHERE l.journal_id=j.id)=f.net_amount
            AND NOT EXISTS(SELECT 1 FROM public.journal_entry_lines l LEFT JOIN public.chart_of_accounts a ON a.id=l.account_id
              WHERE l.journal_id=j.id AND (l.organization_id IS DISTINCT FROM org OR l.branch_id IS DISTINCT FROM o.branch_id
                OR a.organization_id IS DISTINCT FROM org OR l.debit IS NULL OR l.credit IS NULL OR l.debit<0 OR l.credit<0
                OR (l.debit>0 AND l.credit>0) OR l.debit::text IN ('NaN','Infinity','-Infinity') OR l.credit::text IN ('NaN','Infinity','-Infinity'))))) THEN
        RETURN jsonb_build_object('ok',false,'reason','awaiting_folio_journals','detail','The saved folio amounts or their posted journals need reconciliation; no second sale was posted.');
      END IF;
      PERFORM public.neo_record_posting_receipt(org,branch,_source_type,_source_id,ref,'posted',amount,o.currency,NULL,
        'Recognised through guest folio; no duplicate delivery sale',NULL,occurred);
      UPDATE public.finance_posting_receipts SET posting_type='folio-transfer',journal_id=NULL
        WHERE organization_id=org AND source_module=_source_type AND source_id=_source_id;
      RETURN jsonb_build_object('ok',true,'posting_type','folio-transfer','folio_id',o.folio_id,'amount',amount,'duplicate_prevented',true);
    END IF;
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
    IF coalesce(deliv.tip_amount,0)>0 THEN
      tip_account:=public.neo_tip_payable_account(org);
      SELECT a.code INTO tip_code FROM public.chart_of_accounts a WHERE a.id=tip_account;
    END IF;
    lines := jsonb_build_array(
      jsonb_build_object('code', settle, 'debit', amount, 'description', 'Delivery ' || coalesce(ref,'')),
      jsonb_build_object('code', public.neo_gl_revenue_code_scoped(org,'delivery',NULL), 'credit', amount-tax-coalesce(deliv.service_charge_total,0)-coalesce(deliv.tip_amount,0)),
      jsonb_build_object('code', '2040', 'credit', tax, 'description', 'VAT'),
      jsonb_build_object('code', '2050', 'credit', coalesce(deliv.service_charge_total,0), 'description', 'Service charge'));
    IF coalesce(deliv.tip_amount,0)>0 THEN
      lines:=lines||jsonb_build_array(jsonb_build_object('code',tip_code,
        'credit',deliv.tip_amount,'description','Collected rider/staff tips payable'));
    END IF;

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

  IF _source_type='pos_order' AND EXISTS(
    WITH wanted AS (
      SELECT value->>'code' code,sum(round(coalesce((value->>'debit')::numeric,0),2)) debit,sum(round(coalesce((value->>'credit')::numeric,0),2)) credit
      FROM jsonb_array_elements(lines) GROUP BY 1
    ), actual AS (
      SELECT a.code,sum(l.debit) debit,sum(l.credit) credit FROM public.journal_entry_lines l JOIN public.chart_of_accounts a ON a.id=l.account_id
      WHERE l.journal_id=(res->>'journal_id')::uuid GROUP BY a.code
    ) SELECT 1 FROM wanted w FULL JOIN actual a USING(code)
      WHERE coalesce(w.debit,0)<>coalesce(a.debit,0) OR coalesce(w.credit,0)<>coalesce(a.credit,0)
  ) THEN RAISE EXCEPTION 'Existing POS journal differs from the saved receipt account split; reconcile before reuse'; END IF;
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

DO $verify$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_proc p JOIN neo_pos_settlement_acl saved ON saved.proowner=p.proowner AND saved.acl=coalesce(p.proacl::text,'')
   WHERE p.oid='public.neo_finance_post_txn(text,uuid,boolean)'::regprocedure AND p.prosecdef AND p.provolatile='v' AND p.proconfig=ARRAY['search_path=public']
   AND p.prorettype='jsonb'::regtype AND md5(regexp_replace(regexp_replace(p.prosrc,'--[^'||chr(10)||']*','','g'),'[[:space:]]','','g'))='58aee2a801d8e5b2e3ba711aec8e866f') THEN
  RAISE EXCEPTION 'POS settlement definition or permission verification failed; installation rolled back';
 END IF;
END $verify$;
SELECT jsonb_build_object('diagnostic_version','pos-receipt-account-split-v1','definition_matches',true,'permissions_unchanged',true,
 'scope','Future standalone POS posting follows each saved receipt account and corporate remainder. Invalid or excess collections and mismatched historical journals require reconciliation. Installation posts no journal, collects no payment and changes no history or permission.');
COMMIT;
