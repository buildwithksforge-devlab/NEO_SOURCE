CREATE OR REPLACE FUNCTION public.neo_ar_record_customer_payment(
  _invoice uuid,
  _amount numeric,
  _method text DEFAULT 'cash',
  _reference text DEFAULT NULL,
  _paid_on date DEFAULT NULL,
  _notes text DEFAULT NULL,
  _campaign uuid DEFAULT NULL,
  _intent_key text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  _org uuid := public.current_org_id();
  _inv public.invoices;
  _key text;
  _pay uuid;
  _receipt text;
  _amt numeric;
  _paid numeric;
  _bal numeric;
  _status text;
  _cash_code text;
  _ar_code text := '1060';
  _res jsonb;
  _journal uuid;
  _date date;
BEGIN
  IF _org IS NULL THEN RAISE EXCEPTION 'No workspace in context'; END IF;
  IF NOT (public.has_permission('finance','ar.allocate_receipt') OR public.is_org_admin()) THEN
    RAISE EXCEPTION 'Not permitted to record customer receipts' USING ERRCODE = '42501';
  END IF;

  _amt := round(coalesce(_amount, 0), 2);
  IF _amt <= 0 THEN RAISE EXCEPTION 'Payment amount must be greater than zero'; END IF;

  SELECT * INTO _inv FROM public.invoices WHERE id = _invoice AND organization_id = _org FOR UPDATE;
  IF _inv.id IS NULL THEN RAISE EXCEPTION 'Invoice not found in this workspace'; END IF;
  IF _inv.status NOT IN ('issued','partially_paid','overdue') THEN
    RAISE EXCEPTION 'Invoice % is % and cannot accept a payment', _inv.invoice_number, _inv.status;
  END IF;

  _bal := round(coalesce(_inv.balance, coalesce(_inv.total,0) - coalesce(_inv.amount_paid,0)), 2);
  IF _amt > _bal THEN
    RAISE EXCEPTION 'Payment of % is more than the outstanding balance of % on %', _amt, _bal, _inv.invoice_number;
  END IF;

  _key := NULLIF(btrim(coalesce(_intent_key,'')), '');
  IF _key IS NULL THEN
    _key := 'ar:receipt:' || _invoice::text || ':' || _amt::text || ':' || coalesce(_method,'cash')
            || ':' || coalesce(_reference,'') || ':' || coalesce(auth.uid()::text,'system')
            || ':' || to_char(now() at time zone 'utc', 'YYYYMMDD"T"HH24MI');
  END IF;

  SELECT p.id INTO _pay FROM public.payments p
   WHERE p.organization_id = _org AND p.idempotency_key = _key LIMIT 1;
  IF _pay IS NOT NULL THEN
    RETURN jsonb_build_object('ok', true, 'payment_id', _pay, 'duplicate_prevented', true);
  END IF;

  _date := coalesce(_paid_on, CURRENT_DATE);
  _receipt := public.next_document_number('receipt');

  BEGIN
    INSERT INTO public.payments (organization_id, branch_id, receipt_number, customer_id, amount,
      currency, method, external_reference, paid_at, status, received_by, notes,
      source_module, source_record_id, idempotency_key)
    VALUES (_org, _inv.branch_id, _receipt, _inv.customer_id, _amt,
      coalesce(_inv.currency,'KES'), coalesce(_method,'cash'), _reference,
      (_date::timestamp at time zone 'utc'), 'confirmed', auth.uid(), coalesce(_notes,''),
      'ar', _invoice, _key)
    RETURNING id INTO _pay;
  EXCEPTION WHEN unique_violation THEN
    SELECT p.id INTO _pay FROM public.payments p
     WHERE p.organization_id = _org AND p.idempotency_key = _key LIMIT 1;
    IF _pay IS NULL THEN RAISE; END IF;
    RETURN jsonb_build_object('ok', true, 'payment_id', _pay, 'duplicate_prevented', true);
  END;

  _paid := round(coalesce(_inv.amount_paid,0) + _amt, 2);
  _bal := round(coalesce(_inv.total,0) - _paid, 2);
  _status := CASE WHEN _bal <= 0.009 THEN 'paid' ELSE 'partially_paid' END;

  UPDATE public.invoices
     SET amount_paid = _paid, balance = GREATEST(_bal, 0), status = _status, updated_at = now()
   WHERE id = _invoice;

  _cash_code := public.neo_gl_settlement_code_for(_org, coalesce(_method,'cash'));
  PERFORM public.neo_finance_ensure_account(_org, _cash_code, 'Settlement account', 'asset', 'Cash & Bank');
  PERFORM public.neo_finance_ensure_account(_org, _ar_code, 'Accounts Receivable', 'asset', 'Receivables');

  _res := public.neo_gl_post(
    _org, _inv.branch_id, 'finance', 'customer_payment', _pay, 'settlement',
    _date, coalesce(_inv.currency,'KES'),
    'Customer receipt ' || _receipt || ' against invoice ' || _inv.invoice_number,
    jsonb_build_array(
      jsonb_build_object('code', _cash_code, 'debit', _amt, 'description', 'Money received'),
      jsonb_build_object('code', _ar_code, 'credit', _amt, 'description', 'Customer debt settled')
    ),
    _inv.customer_id);

  _journal := (_res->>'journal_id')::uuid;
  UPDATE public.payments SET posted_journal_id = _journal, updated_at = now() WHERE id = _pay;

  IF _campaign IS NOT NULL THEN
    INSERT INTO public.campaign_conversions (organization_id, branch_id, campaign_id, customer_id,
      conversion_type, source_module, source_record_id, revenue, attribution_model, confidence,
      occurred_at, idempotency_key)
    SELECT _org, _inv.branch_id, c.id, _inv.customer_id, 'payment', 'finance', _pay, _amt,
      'declared', 'declared', now(), 'ar-payment:' || _pay::text
      FROM public.campaigns c
     WHERE c.id = _campaign AND c.organization_id = _org
    ON CONFLICT DO NOTHING;
  END IF;

  INSERT INTO public.audit_logs (organization_id, user_id, user_name, action, module, record_id, new_value, reason)
  VALUES (_org, auth.uid(), '', 'finance.ar.receipt', 'finance', _pay::text,
    jsonb_build_object('invoice_id', _invoice, 'invoice_number', _inv.invoice_number,
      'amount', _amt, 'method', coalesce(_method,'cash'), 'receipt_number', _receipt,
      'journal_id', _journal, 'invoice_status', _status, 'campaign_id', _campaign), _notes);

  RETURN jsonb_build_object('ok', true, 'payment_id', _pay, 'receipt_number', _receipt,
    'journal_id', _journal, 'invoice_status', _status, 'invoice_balance', GREATEST(_bal, 0));
END;
$fn$;

REVOKE ALL ON FUNCTION public.neo_ar_record_customer_payment(uuid,numeric,text,text,date,text,uuid,text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.neo_ar_record_customer_payment(uuid,numeric,text,text,date,text,uuid,text) TO authenticated, service_role;