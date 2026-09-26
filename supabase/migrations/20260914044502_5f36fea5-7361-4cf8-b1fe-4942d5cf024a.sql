-- 1. Rider self-claim of an unassigned delivery at their own property.
CREATE OR REPLACE FUNCTION public.neo_delivery_claim(_order uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  r public.rider_profiles;
  o public.delivery_orders;
  active_load int;
BEGIN
  SELECT * INTO r FROM public.rider_profiles
   WHERE profile_id = auth.uid() AND active LIMIT 1;
  IF r.id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_a_rider',
      'detail', 'Only an active rider can pick up a waiting order.');
  END IF;

  SELECT * INTO o FROM public.delivery_orders
   WHERE id = _order AND organization_id = r.organization_id FOR UPDATE;
  IF o.id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'order_not_found');
  END IF;
  IF o.branch_id IS DISTINCT FROM r.branch_id THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'other_property',
      'detail', 'That order belongs to another property.');
  END IF;
  IF o.rider_id IS NOT NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'already_taken',
      'detail', CASE WHEN o.rider_id = r.id THEN 'You already hold this order.'
                     ELSE 'Another rider has already taken this order.' END);
  END IF;
  IF o.order_status NOT IN ('confirmed','in-preparation','ready-for-pickup') THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_claimable',
      'detail', 'That order is ' || o.order_status || ' and cannot be picked up.');
  END IF;

  SELECT count(*) INTO active_load FROM public.delivery_orders d
   WHERE d.rider_id = r.id
     AND d.order_status IN ('rider-assigned','collected','out-for-delivery','en-route','arrived');
  IF active_load >= coalesce(r.max_active_deliveries, 1) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'at_capacity',
      'detail', 'You are already carrying the maximum number of deliveries.');
  END IF;
  IF lower(coalesce(o.payment_method,'')) = 'cash' AND r.cash_handling_allowed IS NOT TRUE THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'cash_not_allowed',
      'detail', 'This is a cash order and you are not cleared to carry cash.');
  END IF;

  UPDATE public.delivery_orders
     SET rider_id = r.id,
         dispatch_status = 'rider-assigned',
         order_status = 'rider-assigned',
         accepted_at = coalesce(accepted_at, now()),
         updated_at = now()
   WHERE id = _order;

  INSERT INTO public.delivery_order_status_history
    (organization_id, delivery_order_id, status_kind, previous_status, new_status, reason, changed_by)
  VALUES (o.organization_id, _order, 'dispatch', 'unassigned',
          coalesce(r.display_name, 'rider'), 'Picked up by the rider from the zone queue', auth.uid());

  INSERT INTO public.audit_logs
    (organization_id, branch_id, user_id, user_name, action, module, record_id,
     previous_value, new_value, reason)
  VALUES (o.organization_id, o.branch_id, auth.uid(), coalesce(r.display_name,''),
    'delivery.dispatch.self-claim', 'delivery', _order::text,
    jsonb_build_object('rider_id', NULL),
    jsonb_build_object('rider_id', r.id, 'rider', r.display_name),
    'Rider claimed a waiting order');

  RETURN jsonb_build_object('ok', true, 'order_id', _order, 'rider_id', r.id,
    'order_number', o.order_number);
END;
$$;

REVOKE ALL ON FUNCTION public.neo_delivery_claim(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.neo_delivery_claim(uuid) TO authenticated;

-- 2. Banquet setup, service and cleanup timings on the banquet order.
CREATE OR REPLACE FUNCTION public.neo_beo_set_timings(
  _beo uuid,
  _setup_at timestamptz,
  _guest_arrival_at timestamptz,
  _start_at timestamptz,
  _end_at timestamptz,
  _breakdown_at timestamptz,
  _serving_times text,
  _seating_layout text,
  _reason text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  b public.banquet_event_orders;
BEGIN
  SELECT * INTO b FROM public.banquet_event_orders WHERE id = _beo FOR UPDATE;
  IF b.id IS NULL OR b.organization_id <> public.current_org_id() THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_found');
  END IF;
  IF NOT (public.has_permission('events','bookings','edit')
          OR public.is_org_admin_for(b.organization_id)) THEN
    RAISE EXCEPTION 'The events.bookings.edit permission is required.' USING ERRCODE = '42501';
  END IF;
  IF NOT public.neo_branch_in_scope(b.branch_id) THEN
    RAISE EXCEPTION 'That property is outside your access scope.' USING ERRCODE = '42501';
  END IF;
  IF b.locked THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'locked',
      'detail', 'This banquet order is locked and cannot be re-timed.');
  END IF;

  IF _start_at IS NOT NULL AND _end_at IS NOT NULL AND _end_at <= _start_at THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'bad_service_window',
      'detail', 'Service must end after it starts.');
  END IF;
  IF _setup_at IS NOT NULL AND _start_at IS NOT NULL AND _setup_at > _start_at THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'bad_setup',
      'detail', 'Setup must be complete before service starts.');
  END IF;
  IF _breakdown_at IS NOT NULL AND _end_at IS NOT NULL AND _breakdown_at < _end_at THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'bad_cleanup',
      'detail', 'Cleanup cannot start before service ends.');
  END IF;
  IF _guest_arrival_at IS NOT NULL AND _setup_at IS NOT NULL AND _guest_arrival_at < _setup_at THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'bad_arrival',
      'detail', 'Guests cannot arrive before setup begins.');
  END IF;

  UPDATE public.banquet_event_orders
     SET setup_at = _setup_at,
         guest_arrival_at = _guest_arrival_at,
         start_at = _start_at,
         end_at = _end_at,
         breakdown_at = _breakdown_at,
         serving_times = coalesce(nullif(btrim(_serving_times),''), serving_times),
         seating_layout = coalesce(nullif(btrim(_seating_layout),''), seating_layout),
         updated_by = auth.uid(),
         updated_at = now()
   WHERE id = _beo;

  INSERT INTO public.event_activity_logs (organization_id, booking_id, action, detail, actor_id)
  VALUES (b.organization_id, b.booking_id, 'events.beo.timings',
    jsonb_build_object('beo_number', b.beo_number, 'setup_at', _setup_at,
      'guest_arrival_at', _guest_arrival_at, 'start_at', _start_at, 'end_at', _end_at,
      'breakdown_at', _breakdown_at, 'reason', nullif(btrim(coalesce(_reason,'')),'')),
    auth.uid());

  RETURN jsonb_build_object('ok', true, 'beo_id', _beo, 'beo_number', b.beo_number);
END;
$$;

REVOKE ALL ON FUNCTION public.neo_beo_set_timings(uuid, timestamptz, timestamptz, timestamptz,
  timestamptz, timestamptz, text, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.neo_beo_set_timings(uuid, timestamptz, timestamptz, timestamptz,
  timestamptz, timestamptz, text, text, text) TO authenticated;

-- 3. Delivery order billing: real invoice plus a balanced posted journal.
CREATE OR REPLACE FUNCTION public.neo_delivery_bill(_order uuid, _reason text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
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
  v_debit uuid;
  v_method text;
  v_paid boolean;
  v_net numeric;
  v_line int := 0;
  v_existing public.invoices;
BEGIN
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
    RETURN jsonb_build_object('ok', true, 'already_billed', true,
      'invoice_id', v_existing.id, 'invoice_number', v_existing.invoice_number,
      'journal_id', v_existing.journal_id);
  END IF;

  v_method := lower(coalesce(o.payment_method, ''));
  v_paid := lower(coalesce(o.payment_status,'')) IN ('paid','settled','captured','completed');
  v_net := coalesce(o.subtotal,0) + coalesce(o.delivery_fee,0) + coalesce(o.tip_amount,0)
           - coalesce(o.discount_total,0);

  SELECT a.id INTO v_revenue FROM public.chart_of_accounts a
   WHERE a.organization_id = org AND a.active AND coalesce(a.postable, true)
     AND a.name ILIKE 'Delivery Revenue'
   ORDER BY a.code LIMIT 1;
  IF v_revenue IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'no_revenue_account',
      'detail', 'This property has no active Delivery Revenue account.');
  END IF;

  IF coalesce(o.tax_total,0) > 0 THEN
    SELECT a.id INTO v_vat FROM public.chart_of_accounts a
     WHERE a.organization_id = org AND a.active AND coalesce(a.postable, true)
       AND a.name ILIKE '%VAT Payable%'
     ORDER BY a.code LIMIT 1;
    IF v_vat IS NULL THEN
      RETURN jsonb_build_object('ok', false, 'reason', 'no_vat_account',
        'detail', 'This order carries tax but the property has no VAT Payable account.');
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
    coalesce(o.subtotal,0) + coalesce(o.delivery_fee,0) + coalesce(o.tip_amount,0),
    coalesce(o.discount_total,0), coalesce(o.tax_total,0), coalesce(o.grand_total,0),
    CASE WHEN v_paid THEN coalesce(o.grand_total,0) ELSE 0 END,
    CASE WHEN v_paid THEN 0 ELSE coalesce(o.grand_total,0) END,
    'issued',
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
    0, coalesce(o.subtotal,0) - coalesce(o.discount_total,0),
    coalesce(o.subtotal,0) - coalesce(o.discount_total,0));

  IF coalesce(o.delivery_fee,0) <> 0 THEN
    v_line := v_line + 1;
    INSERT INTO public.invoice_lines (organization_id, invoice_id, line_number, description,
      source_module, source_record_id, revenue_account_id, quantity, unit_price,
      net_amount, total_amount)
    VALUES (org, v_invoice, v_line, 'Delivery fee', 'delivery', _order, v_revenue, 1,
      o.delivery_fee, o.delivery_fee, o.delivery_fee);
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
  VALUES (org, o.branch_id, v_jnum, 'sales', CURRENT_DATE, 'delivery', 'delivery_invoice',
    v_invoice, v_number, v_key,
    'Delivery order ' || o.order_number || ' billed on invoice ' || v_number
      || coalesce(' — ' || nullif(btrim(coalesce(_reason,'')),''), ''),
    coalesce(o.currency,'KES'), auth.uid(), 'draft')
  RETURNING id INTO v_journal;

  INSERT INTO public.journal_entry_lines (organization_id, journal_id, line_number, account_id,
    description, debit, credit, branch_id, customer_id, revenue_centre, payment_method)
  VALUES (org, v_journal, 1, v_debit,
    CASE WHEN v_paid THEN 'Delivery receipt ' || o.order_number
         ELSE 'Delivery receivable ' || o.order_number END,
    coalesce(o.grand_total,0), 0, o.branch_id, o.customer_id, 'delivery',
    nullif(v_method,''));

  INSERT INTO public.journal_entry_lines (organization_id, journal_id, line_number, account_id,
    description, debit, credit, branch_id, customer_id, revenue_centre, payment_method)
  VALUES (org, v_journal, 2, v_revenue, 'Delivery revenue ' || o.order_number,
    0, v_net, o.branch_id, o.customer_id, 'delivery', nullif(v_method,''));

  IF coalesce(o.tax_total,0) > 0 THEN
    INSERT INTO public.journal_entry_lines (organization_id, journal_id, line_number, account_id,
      description, debit, credit, branch_id, customer_id, revenue_centre, payment_method)
    VALUES (org, v_journal, 3, v_vat, 'Output VAT on ' || o.order_number,
      0, o.tax_total, o.branch_id, o.customer_id, 'delivery', nullif(v_method,''));
  END IF;

  PERFORM public.fin_post_journal(v_journal);

  UPDATE public.invoices SET journal_id = v_journal, updated_at = now() WHERE id = v_invoice;

  INSERT INTO public.audit_logs (organization_id, branch_id, user_id, user_name, action, module,
    record_id, previous_value, new_value, reason)
  VALUES (org, o.branch_id, auth.uid(),
    coalesce((SELECT full_name FROM public.profiles WHERE id = auth.uid()), ''),
    'delivery.billed', 'delivery', o.order_number,
    jsonb_build_object('payment_status', o.payment_status),
    jsonb_build_object('invoice_number', v_number, 'journal_number', v_jnum,
      'total', o.grand_total, 'settled', v_paid),
    nullif(btrim(coalesce(_reason,'')),''));

  RETURN jsonb_build_object('ok', true, 'invoice_id', v_invoice, 'invoice_number', v_number,
    'journal_id', v_journal, 'journal_number', v_jnum, 'settled', v_paid,
    'total', coalesce(o.grand_total,0));
END;
$$;

REVOKE ALL ON FUNCTION public.neo_delivery_bill(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.neo_delivery_bill(uuid, text) TO authenticated;