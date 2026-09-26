CREATE OR REPLACE FUNCTION public.neo_supplier_payment_advance(
  _payment uuid,
  _action text,
  _reason text DEFAULT NULL::text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  _org uuid := public.current_org_id();
  p public.supplier_payments;
  _act text := lower(btrim(coalesce(_action,'')));
  _next text;
  _amt numeric;
  _cur text;
  _cash_code text; _cash_name text;
  _res jsonb; _jid uuid; _msg text;
  _inv public.supplier_invoices;
  _paid numeric;
BEGIN
  IF _org IS NULL THEN RAISE EXCEPTION 'No workspace context'; END IF;
  SELECT * INTO p FROM public.supplier_payments
   WHERE id = _payment AND organization_id = _org FOR UPDATE;
  IF p.id IS NULL THEN RAISE EXCEPTION 'Supplier payment not found'; END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended('supplier-payment:' || _payment::text, 0));

  _next := CASE _act
    WHEN 'submit'  THEN 'awaiting-approval'
    WHEN 'approve' THEN 'approved'
    WHEN 'release' THEN 'released'
    WHEN 'settle'  THEN 'paid'
    WHEN 'fail'    THEN 'failed'
    ELSE NULL END;
  IF _next IS NULL THEN RAISE EXCEPTION 'Unknown supplier payment action "%"', _action; END IF;

  -- Repeat-safe: the step already happened.
  IF p.status = _next AND _act <> 'settle' THEN
    RETURN jsonb_build_object('ok', true, 'idempotent', true, 'status', p.status, 'payment_id', p.id);
  END IF;

  IF _act = 'approve' THEN
    IF NOT (public.has_permission('finance','payment','approve') OR public.is_org_admin()) THEN
      RAISE EXCEPTION 'Not permitted to approve supplier payments' USING ERRCODE = '42501';
    END IF;
    IF p.created_by IS NOT NULL AND p.created_by = auth.uid() AND NOT public.is_org_admin() THEN
      RAISE EXCEPTION 'A supplier payment cannot be approved by the person who raised it';
    END IF;
  ELSE
    IF NOT (public.has_permission('finance','ap','edit') OR public.is_org_admin()) THEN
      RAISE EXCEPTION 'Not permitted to work supplier payments' USING ERRCODE = '42501';
    END IF;
  END IF;

  IF _act = 'submit'  AND p.status NOT IN ('scheduled','draft','pending','failed')
    THEN RAISE EXCEPTION 'Only a scheduled payment can be sent for approval (currently "%")', p.status; END IF;
  IF _act = 'approve' AND p.status <> 'awaiting-approval'
    THEN RAISE EXCEPTION 'Only a payment awaiting approval can be approved (currently "%")', p.status; END IF;
  IF _act = 'release' AND p.status <> 'approved'
    THEN RAISE EXCEPTION 'Only an approved payment can be released (currently "%")', p.status; END IF;
  IF _act = 'settle'  AND p.status NOT IN ('released','paid')
    THEN RAISE EXCEPTION 'Only a released payment can be settled (currently "%")', p.status; END IF;
  IF _act = 'fail'    AND p.status NOT IN ('released','approved','awaiting-approval')
    THEN RAISE EXCEPTION 'This payment cannot be marked failed from "%"', p.status; END IF;
  IF _act = 'fail' AND nullif(btrim(coalesce(_reason,'')),'') IS NULL
    THEN RAISE EXCEPTION 'A reason is required when a supplier payment fails'; END IF;

  _amt := round(coalesce(p.amount,0), 2);
  _cur := coalesce(nullif(p.currency,''), public.neo_fact_currency(_org, p.branch_id));

  IF _act = 'settle' THEN
    IF _amt <= 0 THEN RAISE EXCEPTION 'A supplier payment with no amount cannot be settled'; END IF;

    IF p.journal_id IS NOT NULL
       OR EXISTS (SELECT 1 FROM public.finance_posting_receipts
                   WHERE organization_id = _org
                     AND idempotency_key = 'supplier-payment:' || _payment::text
                     AND status = 'posted') THEN
      RETURN jsonb_build_object('ok', true, 'idempotent', true, 'status', 'paid',
        'payment_id', p.id, 'journal_id', p.journal_id);
    END IF;

    SELECT c.code, c.name INTO _cash_code, _cash_name FROM (VALUES
        ('bank','1020','Bank Accounts'),
        ('transfer','1020','Bank Accounts'),
        ('eft','1020','Bank Accounts'),
        ('cheque','1020','Bank Accounts'),
        ('mpesa','1030','M-Pesa Clearing'),
        ('mobile','1030','M-Pesa Clearing'),
        ('mobile_money','1030','M-Pesa Clearing'),
        ('card','1040','Card Clearing')
      ) AS c(method, code, name)
     WHERE c.method = lower(coalesce(p.method,'bank'));
    _cash_code := coalesce(_cash_code, '1010');
    _cash_name := coalesce(_cash_name, 'Cash on Hand');

    BEGIN
      PERFORM public.neo_finance_ensure_account(_org, _cash_code, _cash_name, 'asset', 'Cash and Bank');
      PERFORM public.neo_finance_ensure_account(_org, '2100', 'Accounts Payable', 'liability', 'Payables');

      _res := public.neo_gl_post(
        _org, p.branch_id, 'payables', 'supplier_payment', _payment, 'settlement',
        coalesce(p.paid_on, CURRENT_DATE), _cur,
        'Supplier payment ' || coalesce(nullif(p.payment_number,''), _payment::text),
        jsonb_build_array(
          jsonb_build_object('code','2100','debit', _amt, 'description','Supplier liability settled'),
          jsonb_build_object('code', _cash_code, 'credit', _amt,
            'description','Paid to supplier (' || coalesce(p.method,'bank') || ')')
        ), NULL);
      _jid := nullif(_res->>'journal_id','')::uuid;
    EXCEPTION WHEN OTHERS THEN
      _msg := SQLERRM;
      UPDATE public.supplier_payments SET status = 'failed', updated_at = now() WHERE id = _payment;
      PERFORM public.neo_record_posting_receipt(_org, p.branch_id, 'supplier-payment', _payment,
        p.payment_number, 'failed', _amt, _cur, NULL, NULL, _msg, coalesce(p.paid_on, CURRENT_DATE));
      RETURN jsonb_build_object('ok', false, 'status','failed', 'payment_id', p.id, 'detail', _msg);
    END;

    UPDATE public.supplier_payments
       SET status = 'paid', journal_id = _jid, updated_at = now()
     WHERE id = _payment;

    PERFORM public.neo_record_posting_receipt(_org, p.branch_id, 'supplier-payment', _payment,
      p.payment_number, CASE WHEN _jid IS NOT NULL THEN 'posted' ELSE 'blocked' END,
      _amt, _cur, NULL, _res->>'detail', NULL, coalesce(p.paid_on, CURRENT_DATE));

    PERFORM public.neo_financial_state_set(_org, p.branch_id, 'supplier-payment', _payment,
      p.payment_number, 'paid', CASE WHEN _jid IS NOT NULL THEN 'posted' ELSE 'blocked' END,
      'Paying a supplier reduces what the business owes and reduces the bank or cash account.',
      _amt, _cur, coalesce(p.paid_on, CURRENT_DATE), _jid, NULL, NULL, auth.uid(), NULL);

    IF p.supplier_invoice_id IS NOT NULL THEN
      SELECT * INTO _inv FROM public.supplier_invoices WHERE id = p.supplier_invoice_id;
      IF _inv.id IS NOT NULL THEN
        SELECT coalesce(sum(sp.amount),0) INTO _paid FROM public.supplier_payments sp
         WHERE sp.supplier_invoice_id = _inv.id AND sp.status = 'paid';
        UPDATE public.supplier_invoices
           SET status = CASE WHEN _paid >= round(coalesce(_inv.total_amount,0),2) - 0.009
                             THEN 'paid' ELSE 'part-paid' END,
               updated_at = now()
         WHERE id = _inv.id;
      END IF;
    END IF;
  ELSE
    UPDATE public.supplier_payments
       SET status = _next,
           approved_by = CASE WHEN _act = 'approve' THEN auth.uid() ELSE approved_by END,
           approved_at = CASE WHEN _act = 'approve' THEN now() ELSE approved_at END,
           updated_at = now()
     WHERE id = _payment;
  END IF;

  INSERT INTO public.audit_logs
    (organization_id, branch_id, user_id, action, module, record_id, previous_value, new_value, reason)
  VALUES (_org, p.branch_id, auth.uid(), 'finance.supplier_payment.' || _act, 'finance',
    _payment::text, jsonb_build_object('status', p.status),
    jsonb_build_object('status', _next, 'amount', _amt, 'journal_id', _jid),
    nullif(btrim(coalesce(_reason,'')),''));

  RETURN jsonb_build_object('ok', _act <> 'fail', 'idempotent', false, 'status', _next,
    'payment_id', p.id, 'amount', _amt, 'currency', _cur, 'journal_id', _jid);
END $function$;

REVOKE ALL ON FUNCTION public.neo_supplier_payment_advance(uuid, text, text) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.neo_supplier_payment_advance(uuid, text, text) TO authenticated;