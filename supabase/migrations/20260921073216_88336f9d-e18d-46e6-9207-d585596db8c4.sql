REVOKE ALL ON FUNCTION public.neo_event_billing_record_payment(uuid, numeric, text, text, text, text, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.neo_event_billing_record_payment(uuid, numeric, text, text, text, text, uuid) TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.pos_record_payment_attempt(uuid, numeric, text, numeric, text, uuid, text, boolean, text, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.pos_record_payment_attempt(uuid, numeric, text, numeric, text, uuid, text, boolean, text, uuid) TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.neo_gl_account_code(uuid, text, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.neo_gl_account_code(uuid, text, uuid) TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.neo_assert_financial_account(uuid, uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.neo_assert_financial_account(uuid, uuid, uuid) TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.neo_gl_cash_code(uuid, text, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.neo_gl_cash_code(uuid, text, uuid) TO authenticated, service_role;

-- ------------------------------------------------ delivery collections
DROP FUNCTION IF EXISTS public.neo_delivery_record_payment(uuid, numeric, text, text, text, text);

CREATE OR REPLACE FUNCTION public.neo_delivery_record_payment(
  _order uuid, _amount numeric, _method text DEFAULT 'cash'::text,
  _entry_type text DEFAULT 'payment'::text, _reference text DEFAULT NULL::text,
  _reason text DEFAULT NULL::text, _account uuid DEFAULT NULL::uuid)
 RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE
  o public.delivery_orders;
  inv public.invoices;
  org uuid;
  v_method text := lower(nullif(btrim(coalesce(_method, '')), ''));
  v_entry text := lower(coalesce(nullif(btrim(_entry_type), ''), 'payment'));
  v_amount numeric := round(coalesce(_amount, 0)::numeric, 2);
  v_debit uuid; v_ar uuid; v_receipt text; v_payment uuid; v_journal uuid; v_jnum text;
  v_key text; v_balance numeric; acct uuid;
BEGIN
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
  IF NOT (public.has_permission('finance','payments','create')
          OR public.has_permission('finance','invoices','create')
          OR public.has_permission('finance','approve')
          OR public.is_org_admin_for(org)) THEN
    RAISE EXCEPTION 'Permission to record a payment is required.' USING ERRCODE = '42501';
  END IF;
  IF NOT public.neo_branch_in_scope(o.branch_id) THEN
    RAISE EXCEPTION 'That order is outside your access scope.' USING ERRCODE = '42501';
  END IF;

  acct := public.neo_assert_financial_account(org, o.branch_id, _account);

  SELECT * INTO inv FROM public.invoices
   WHERE organization_id = org AND notes LIKE '%delivery-order:' || _order::text || '%'
   ORDER BY created_at LIMIT 1
   FOR UPDATE;
  IF inv.id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_billed',
      'detail', 'Raise the invoice for this delivery before recording money against it.');
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

  v_key := 'delivery-payment:' || _order::text || ':' || v_entry || ':'
           || coalesce(nullif(btrim(coalesce(_reference,'')), ''), v_amount::text);

  SELECT id INTO v_payment FROM public.payments
   WHERE organization_id = org AND idempotency_key = v_key LIMIT 1;
  IF v_payment IS NOT NULL THEN
    RETURN jsonb_build_object('ok', true, 'already_recorded', true, 'payment_id', v_payment);
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

  v_receipt := public.next_document_number('receipt', NULL, o.branch_id);

  INSERT INTO public.payments (organization_id, branch_id, receipt_number, customer_id, amount,
    currency, method, external_reference, status, received_by, notes, source_module,
    source_record_id, idempotency_key, destination_account_id)
  VALUES (org, o.branch_id, v_receipt, o.customer_id, v_amount,
    coalesce(o.currency,'KES'), v_method, nullif(btrim(coalesce(_reference,'')), ''),
    'confirmed', auth.uid(),
    initcap(v_entry) || ' for delivery order ' || o.order_number || ' · invoice ' || inv.invoice_number
      || coalesce(' · ' || nullif(btrim(coalesce(_reason,'')), ''), ''),
    'delivery', _order, v_key, acct)
  RETURNING id INTO v_payment;

  v_jnum := public.next_document_number('journal');
  INSERT INTO public.journal_entries (organization_id, branch_id, journal_number, journal_type,
    accounting_date, source_module, source_document_type, source_document_id, document_number,
    idempotency_key, description, currency, created_by, status)
  VALUES (org, o.branch_id, v_jnum, 'receipt', CURRENT_DATE, 'delivery', 'delivery_payment',
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

  PERFORM public.fin_post_journal(v_journal);

  UPDATE public.payments SET posted_journal_id = v_journal, updated_at = now()
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
  ELSIF v_entry = 'deposit' THEN
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
$function$;

REVOKE ALL ON FUNCTION public.neo_delivery_record_payment(uuid, numeric, text, text, text, text, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.neo_delivery_record_payment(uuid, numeric, text, text, text, text, uuid) TO authenticated, service_role;
