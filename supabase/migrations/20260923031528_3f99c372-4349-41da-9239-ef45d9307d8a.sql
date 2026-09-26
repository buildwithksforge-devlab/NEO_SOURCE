CREATE OR REPLACE FUNCTION public.neo_delivery_bill(_order uuid, _reason text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
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

  PERFORM public.fin_post_journal(v_journal);

  UPDATE public.invoices SET journal_id = v_journal, updated_at = now() WHERE id = v_invoice;

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
$function$;