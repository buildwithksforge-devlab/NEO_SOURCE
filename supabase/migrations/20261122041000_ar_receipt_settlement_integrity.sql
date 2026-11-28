BEGIN;

DO $ar_receipt_baseline$
DECLARE
  definition text := pg_get_functiondef(to_regprocedure(
    'public.neo_ar_record_customer_payment(uuid,numeric,text,text,date,text,uuid,text,uuid)'
  ));
BEGIN
  IF NOT coalesce(
    md5(definition) IN ('eafa41a8305e6f621675f9ab66ea753e', 'ce4983e5f70316dcd9cdc185b88a5321')
    OR md5(replace(definition, chr(13) || chr(10), chr(10))) IN (
      'eafa41a8305e6f621675f9ab66ea753e', '06b710c4fa6e97a0643da5db46506d10'
    ), false) THEN
    RAISE EXCEPTION 'Installed receivables receipt definition differs from the reviewed versions.';
  END IF;
END;
$ar_receipt_baseline$;

CREATE OR REPLACE FUNCTION public.neo_ar_record_customer_payment(
  _invoice uuid, _amount numeric, _method text DEFAULT 'cash'::text,
  _reference text DEFAULT NULL::text, _paid_on date DEFAULT NULL::date,
  _notes text DEFAULT NULL::text, _campaign uuid DEFAULT NULL::uuid,
  _intent_key text DEFAULT NULL::text, _account uuid DEFAULT NULL::uuid)
 RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE
  _org uuid := public.current_org_id();
  _inv public.invoices;
  _key text; _pay uuid; _receipt text; _amt numeric; _paid numeric; _bal numeric;
  _status text; _cash_code text; _ar_code text := '1060'; _res jsonb; _journal uuid;
  _date date; _acct uuid; _saved public.payments;
BEGIN
  IF auth.uid() IS NULL OR _org IS NULL THEN RAISE EXCEPTION 'No workspace in context'; END IF;
  IF NOT coalesce(public.has_permission('finance','ar.allocate_receipt') OR public.is_org_admin(), false) THEN
    RAISE EXCEPTION 'Not permitted to record customer receipts' USING ERRCODE = '42501';
  END IF;

  IF _amount IS NULL OR _amount::text IN ('NaN', 'Infinity', '-Infinity')
      OR _amount <= 0 OR _amount <> round(_amount, 2) THEN
    RAISE EXCEPTION 'Enter a positive payment amount with at most two decimal places' USING ERRCODE = '22023';
  END IF;
  _amt := round(_amount, 2);

  SELECT * INTO _inv FROM public.invoices WHERE id = _invoice AND organization_id = _org FOR UPDATE;
  IF _inv.id IS NULL OR _inv.branch_id IS NULL OR NOT coalesce(public.neo_branch_in_scope(_inv.branch_id), false) THEN
    RAISE EXCEPTION 'Invoice is outside your property access' USING ERRCODE = '42501';
  END IF;
  _acct := public.neo_assert_financial_account(_org, _inv.branch_id, _account);

  _key := NULLIF(btrim(coalesce(_intent_key,'')), '');
  IF _key IS NULL THEN
    _key := 'ar:receipt:' || _invoice::text || ':' || _amt::text || ':' || coalesce(_method,'cash')
            || ':' || coalesce(_reference,'') || ':' || coalesce(auth.uid()::text,'system')
            || ':' || to_char(now() at time zone 'utc', 'YYYYMMDD"T"HH24MI');
  END IF;

  SELECT p.* INTO _saved FROM public.payments p
   WHERE p.organization_id = _org AND p.idempotency_key = _key FOR UPDATE;
  IF _saved.id IS NULL AND nullif(btrim(_reference), '') IS NOT NULL THEN
    BEGIN
      SELECT p.* INTO STRICT _saved FROM public.payments p
       WHERE p.organization_id = _org AND p.source_module = 'ar' AND p.source_record_id = _inv.id
         AND p.external_reference = _reference FOR UPDATE;
    EXCEPTION
      WHEN no_data_found THEN NULL;
      WHEN too_many_rows THEN
        RAISE EXCEPTION 'Multiple receipts use this reference on the invoice. Review the saved payments' USING ERRCODE = '23514';
    END;
  END IF;
  IF _saved.id IS NOT NULL THEN
    IF _saved.source_module IS DISTINCT FROM 'ar'
      OR _saved.source_record_id IS DISTINCT FROM _inv.id
      OR _saved.branch_id IS DISTINCT FROM _inv.branch_id
      OR _saved.customer_id IS DISTINCT FROM _inv.customer_id
      OR _saved.currency IS DISTINCT FROM coalesce(_inv.currency, 'KES')
      OR _saved.amount IS DISTINCT FROM _amt
      OR _saved.method IS DISTINCT FROM coalesce(_method, 'cash')
      OR _saved.external_reference IS DISTINCT FROM _reference
      OR _saved.destination_account_id IS DISTINCT FROM _acct
      OR (_paid_on IS NOT NULL AND (_saved.paid_at AT TIME ZONE 'utc')::date IS DISTINCT FROM _paid_on)
      OR _saved.status IS DISTINCT FROM 'confirmed'
      OR _saved.posted_journal_id IS NULL THEN
      RAISE EXCEPTION 'This receipt request does not match the saved payment' USING ERRCODE = '23514';
    END IF;
    RETURN jsonb_build_object('ok', true, 'payment_id', _saved.id, 'receipt_number', _saved.receipt_number,
      'journal_id', _saved.posted_journal_id, 'invoice_status', _inv.status, 'invoice_balance', _inv.balance,
      'destination_account_id', _acct, 'duplicate_prevented', true);
  END IF;

  IF _inv.status NOT IN ('issued','partially_paid','overdue') OR _inv.status IS NULL THEN
    RAISE EXCEPTION 'Invoice % is % and cannot accept a payment', _inv.invoice_number, _inv.status;
  END IF;
  _bal := round(coalesce(_inv.balance, coalesce(_inv.total,0) - coalesce(_inv.amount_paid,0)), 2);
  IF _amt > _bal THEN
    RAISE EXCEPTION 'Payment of % is more than the outstanding balance of % on %', _amt, _bal, _inv.invoice_number;
  END IF;

  _date := coalesce(_paid_on, CURRENT_DATE);
  _receipt := public.next_document_number('receipt');

  INSERT INTO public.payments (organization_id, branch_id, receipt_number, customer_id, amount,
    currency, method, external_reference, paid_at, status, received_by, notes,
    source_module, source_record_id, idempotency_key, shift_id, destination_account_id)
  VALUES (_org, _inv.branch_id, _receipt, _inv.customer_id, _amt,
    coalesce(_inv.currency,'KES'), coalesce(_method,'cash'), _reference,
    (_date::timestamp at time zone 'utc'), 'confirmed', auth.uid(), coalesce(_notes,''),
    'ar', _invoice, _key,
    CASE WHEN coalesce(_method,'cash') = 'cash'
         THEN public.pos_resolve_open_shift(_inv.branch_id) END,
    _acct)
  RETURNING id INTO _pay;

  _paid := round(coalesce(_inv.amount_paid,0) + _amt, 2);
  _bal := round(coalesce(_inv.total,0) - _paid, 2);
  _status := CASE WHEN _bal <= 0.009 THEN 'paid' ELSE 'partially_paid' END;

  UPDATE public.invoices
     SET amount_paid = _paid, balance = GREATEST(_bal, 0), status = _status, updated_at = now()
   WHERE id = _invoice;

  _cash_code := public.neo_gl_account_code(_org, coalesce(_method,'cash'), _acct);
  PERFORM public.neo_finance_ensure_account(_org, _cash_code, 'Settlement account', 'asset', 'Cash & Bank');
  PERFORM public.neo_finance_ensure_account(_org, _ar_code, 'Accounts Receivable', 'asset', 'Receivables');

  SELECT je.id INTO _journal FROM public.journal_entries je
   WHERE je.organization_id = _org AND je.source_document_id = _pay
   ORDER BY je.created_at LIMIT 1;

  IF _journal IS NULL THEN
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
  END IF;
  IF _journal IS NULL THEN
    RAISE EXCEPTION 'The receipt journal could not be confirmed';
  END IF;
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
      'journal_id', _journal, 'invoice_status', _status, 'campaign_id', _campaign,
      'destination_account_id', _acct), _notes);

  RETURN jsonb_build_object('ok', true, 'payment_id', _pay, 'receipt_number', _receipt,
    'journal_id', _journal, 'invoice_status', _status, 'invoice_balance', GREATEST(_bal, 0),
    'destination_account_id', _acct);
END;
$function$;

COMMIT;
