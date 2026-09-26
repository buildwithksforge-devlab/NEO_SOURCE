-- Finish the production control loops for supplier payments, cash refunds,
-- cashier close/count, business-day open/close, and the 15% discount ceiling.
-- This migration is intentionally additive/replace-only: no business data is
-- deleted and no historical transaction is rewritten.

-- ---------------------------------------------------------------------------
-- 1. Supplier payment state machine: the live functions already use these
--    states, so the table constraints must accept the same canonical lifecycle.
-- ---------------------------------------------------------------------------
ALTER TABLE public.payment_schedules
  DROP CONSTRAINT IF EXISTS payment_schedules_status_check;
ALTER TABLE public.payment_schedules
  ADD CONSTRAINT payment_schedules_status_check CHECK (
    status IN ('draft','scheduled','pending','pending_approval','approved','released','paid','failed','cancelled')
  );

ALTER TABLE public.supplier_payments
  DROP CONSTRAINT IF EXISTS supplier_payments_status_check;
ALTER TABLE public.supplier_payments
  ADD CONSTRAINT supplier_payments_status_check CHECK (
    status IN ('draft','scheduled','pending','awaiting-approval','approved','released','paid','failed','cancelled','reversed')
  );

CREATE OR REPLACE FUNCTION public.neo_payment_schedule_release(
  _schedule uuid,
  _reason text DEFAULT NULL::text,
  _bank_account uuid DEFAULT NULL::uuid,
  _reference text DEFAULT NULL::text,
  _paid_on date DEFAULT NULL::date
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  _org uuid := public.current_org_id();
  s public.payment_schedules;
  _existing public.supplier_payments;
  _bank public.bank_accounts;
  _inv public.supplier_invoices;
  _pid uuid;
  _num text;
  _method text;
  _ref text := nullif(btrim(coalesce(_reference,'')),'');
  _currency text;
  _paid numeric := 0;
  _outstanding numeric := 0;
BEGIN
  IF _org IS NULL THEN RAISE EXCEPTION 'No workspace context'; END IF;

  SELECT * INTO s FROM public.payment_schedules
   WHERE id = _schedule AND organization_id = _org FOR UPDATE;
  IF s.id IS NULL THEN RAISE EXCEPTION 'Payment schedule not found'; END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended('payment-schedule:' || _schedule::text, 0));

  IF NOT (public.has_permission('finance','payment','approve') OR public.is_org_admin()) THEN
    RAISE EXCEPTION 'Only a finance approver or an owner can release a scheduled payment' USING ERRCODE = '42501';
  END IF;
  IF s.branch_id IS NOT NULL AND NOT public.neo_branch_in_scope(s.branch_id) THEN
    RAISE EXCEPTION 'That payment schedule belongs to a property outside your access scope' USING ERRCODE = '42501';
  END IF;
  IF s.created_by IS NOT NULL AND s.created_by = auth.uid() AND NOT public.is_org_admin() THEN
    RAISE EXCEPTION 'A payment cannot be released by the person who scheduled it';
  END IF;

  SELECT * INTO _existing FROM public.supplier_payments
   WHERE organization_id = _org AND schedule_id = _schedule
   ORDER BY created_at LIMIT 1;
  IF _existing.id IS NOT NULL THEN
    RETURN jsonb_build_object('ok', true, 'idempotent', true,
      'status', _existing.status, 'payment_id', _existing.id,
      'payment_number', _existing.payment_number);
  END IF;

  IF s.status NOT IN ('draft','scheduled','pending','pending_approval','approved') THEN
    RAISE EXCEPTION 'Only a payment awaiting release can be released (currently "%")', s.status;
  END IF;
  IF s.supplier_id IS NULL THEN
    RAISE EXCEPTION 'This schedule has no supplier, so it cannot be released';
  END IF;
  IF round(coalesce(s.amount,0),2) <= 0 THEN
    RAISE EXCEPTION 'A schedule with no amount cannot be released';
  END IF;

  -- A payment linked to an invoice may never silently overpay it or cross suppliers.
  IF s.supplier_invoice_id IS NOT NULL THEN
    SELECT * INTO _inv FROM public.supplier_invoices
     WHERE id = s.supplier_invoice_id AND organization_id = _org FOR UPDATE;
    IF _inv.id IS NULL THEN RAISE EXCEPTION 'The linked supplier invoice could not be found'; END IF;
    IF _inv.supplier_id IS DISTINCT FROM s.supplier_id THEN
      RAISE EXCEPTION 'The linked invoice belongs to a different supplier';
    END IF;
    IF coalesce(_inv.match_status,'') = 'held' THEN
      RAISE EXCEPTION 'The linked supplier invoice is held by matching and cannot be paid';
    END IF;
    IF lower(coalesce(_inv.status,'')) IN ('cancelled','void','voided','rejected') THEN
      RAISE EXCEPTION 'The linked supplier invoice is % and cannot be paid', _inv.status;
    END IF;
    IF _inv.approved_at IS NULL OR lower(coalesce(_inv.status,'')) NOT IN ('approved','partially_paid','paid') THEN
      RAISE EXCEPTION 'Accept and post the supplier invoice before releasing payment';
    END IF;

    SELECT coalesce(sum(sp.amount),0) INTO _paid
      FROM public.supplier_payments sp
     WHERE sp.organization_id = _org
       AND sp.supplier_invoice_id = _inv.id
       AND sp.status IN ('released','paid');
    _outstanding := round(greatest(coalesce(_inv.amount,0) - _paid, 0), 2);
    IF round(s.amount,2) > _outstanding + 0.009 THEN
      RAISE EXCEPTION 'This payment is % but only % remains outstanding on invoice %',
        round(s.amount,2), _outstanding, _inv.invoice_number;
    END IF;
  END IF;

  _method := coalesce(nullif(s.method,''),'bank_transfer');
  _currency := coalesce(nullif(public.neo_fact_currency(_org, s.branch_id),''),'KES');

  IF _bank_account IS NOT NULL THEN
    SELECT * INTO _bank FROM public.bank_accounts
     WHERE id = _bank_account AND organization_id = _org;
    IF _bank.id IS NULL THEN RAISE EXCEPTION 'That paying account does not belong to this workspace'; END IF;
    IF NOT _bank.active THEN RAISE EXCEPTION 'That paying account is not active'; END IF;
    IF _bank.branch_id IS NOT NULL AND s.branch_id IS NOT NULL AND _bank.branch_id <> s.branch_id THEN
      RAISE EXCEPTION 'That paying account belongs to another property';
    END IF;
    IF upper(coalesce(_bank.currency,'')) <> upper(_currency) THEN
      RAISE EXCEPTION 'The paying account is held in % but this payment is in %', _bank.currency, _currency;
    END IF;
  END IF;

  IF _method IN ('bank_transfer','bank-transfer','cheque','check','rtgs','eft') THEN
    IF _bank_account IS NULL THEN
      RAISE EXCEPTION 'Choose the bank account this transfer is paid from';
    END IF;
    IF _ref IS NULL THEN
      RAISE EXCEPTION 'Enter the bank transfer or cheque reference for this payment';
    END IF;
  END IF;

  _num := 'SPY-' || to_char(now(),'YYYYMMDD') || '-' || upper(substr(replace(gen_random_uuid()::text,'-',''),1,5));

  INSERT INTO public.supplier_payments (
    organization_id, branch_id, payment_number, supplier_id, supplier_invoice_id,
    schedule_id, amount, currency, method, bank_account_id, external_reference,
    paid_on, status, created_by, approved_by, approved_at
  ) VALUES (
    _org, s.branch_id, _num, s.supplier_id, s.supplier_invoice_id,
    s.id, round(s.amount,2), _currency, _method, _bank_account, coalesce(_ref,''),
    coalesce(_paid_on, CURRENT_DATE), 'released',
    coalesce(s.created_by, auth.uid()), auth.uid(), now()
  ) RETURNING id INTO _pid;

  UPDATE public.payment_schedules
     SET status = 'released', updated_at = now()
   WHERE id = s.id;

  INSERT INTO public.audit_logs (
    organization_id, branch_id, user_id, action, module, record_id,
    previous_value, new_value, reason, permission_used
  ) VALUES (
    _org, s.branch_id, auth.uid(), 'supplier_payment_released', 'finance', _pid::text,
    jsonb_build_object('schedule_id', s.id, 'schedule_status', s.status),
    jsonb_build_object('payment_id', _pid, 'payment_number', _num,
                       'amount', round(s.amount,2), 'supplier_id', s.supplier_id,
                       'bank_account_id', _bank_account, 'external_reference', coalesce(_ref,''),
                       'paid_on', coalesce(_paid_on, CURRENT_DATE), 'status', 'released'),
    nullif(btrim(coalesce(_reason,'')),''), 'finance.payment.approve'
  );

  RETURN jsonb_build_object('ok', true, 'idempotent', false, 'status', 'released',
    'payment_id', _pid, 'payment_number', _num, 'bank_account_id', _bank_account,
    'external_reference', coalesce(_ref,''));
END;
$function$;

REVOKE ALL ON FUNCTION public.neo_payment_schedule_release(uuid, text, uuid, text, date) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.neo_payment_schedule_release(uuid, text, uuid, text, date) TO authenticated;

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
  _paid numeric := 0;
  _other_paid numeric := 0;
  _outstanding numeric := 0;
BEGIN
  IF _org IS NULL THEN RAISE EXCEPTION 'No workspace context'; END IF;
  SELECT * INTO p FROM public.supplier_payments
   WHERE id = _payment AND organization_id = _org FOR UPDATE;
  IF p.id IS NULL THEN RAISE EXCEPTION 'Supplier payment not found'; END IF;
  IF p.branch_id IS NOT NULL AND NOT public.neo_branch_in_scope(p.branch_id) THEN
    RAISE EXCEPTION 'That supplier payment belongs to a property outside your access scope' USING ERRCODE = '42501';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended('supplier-payment:' || _payment::text, 0));

  _next := CASE _act
    WHEN 'submit'  THEN 'awaiting-approval'
    WHEN 'approve' THEN 'approved'
    WHEN 'release' THEN 'released'
    WHEN 'settle'  THEN 'paid'
    WHEN 'fail'    THEN 'failed'
    ELSE NULL END;
  IF _next IS NULL THEN RAISE EXCEPTION 'Unknown supplier payment action "%"', _action; END IF;

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

    IF p.supplier_invoice_id IS NOT NULL THEN
      SELECT * INTO _inv FROM public.supplier_invoices
       WHERE id = p.supplier_invoice_id AND organization_id = _org FOR UPDATE;
      IF _inv.id IS NULL THEN RAISE EXCEPTION 'The linked supplier invoice could not be found'; END IF;
      IF _inv.supplier_id IS DISTINCT FROM p.supplier_id THEN
        RAISE EXCEPTION 'The linked invoice belongs to a different supplier';
      END IF;
      IF coalesce(_inv.match_status,'') = 'held' THEN
        RAISE EXCEPTION 'The linked supplier invoice is held by matching and cannot be paid';
      END IF;
      IF _inv.approved_at IS NULL OR lower(coalesce(_inv.status,'')) NOT IN ('approved','partially_paid','paid') THEN
        RAISE EXCEPTION 'Accept and post the supplier invoice before settlement';
      END IF;
      SELECT coalesce(sum(sp.amount),0) INTO _other_paid
        FROM public.supplier_payments sp
       WHERE sp.organization_id = _org
         AND sp.supplier_invoice_id = _inv.id
         AND sp.status = 'paid'
         AND sp.id <> p.id;
      _outstanding := round(greatest(coalesce(_inv.amount,0) - _other_paid, 0), 2);
      IF _amt > _outstanding + 0.009 THEN
        RAISE EXCEPTION 'This payment is % but only % remains outstanding on invoice %',
          _amt, _outstanding, _inv.invoice_number;
      END IF;
    END IF;

    IF p.journal_id IS NOT NULL
       OR EXISTS (SELECT 1 FROM public.finance_posting_receipts
                   WHERE organization_id = _org
                     AND idempotency_key = 'supplier-payment:' || _payment::text
                     AND status = 'posted') THEN
      UPDATE public.supplier_payments SET status = 'paid', updated_at = now() WHERE id = _payment;
      IF p.schedule_id IS NOT NULL THEN
        UPDATE public.payment_schedules SET status='paid', updated_at=now()
         WHERE id=p.schedule_id AND organization_id=_org;
      END IF;
      IF p.supplier_invoice_id IS NOT NULL THEN
        SELECT coalesce(sum(sp.amount),0) INTO _paid FROM public.supplier_payments sp
         WHERE sp.supplier_invoice_id = p.supplier_invoice_id AND sp.status = 'paid';
        UPDATE public.supplier_invoices
           SET paid_amount = round(_paid,2),
               status = CASE WHEN _paid >= round(coalesce(amount,0),2) - 0.009 THEN 'paid' ELSE 'partially_paid' END,
               updated_at = now()
         WHERE id = p.supplier_invoice_id AND organization_id = _org;
      END IF;
      RETURN jsonb_build_object('ok', true, 'idempotent', true, 'status', 'paid',
        'payment_id', p.id, 'journal_id', p.journal_id);
    END IF;

    SELECT c.code, c.name INTO _cash_code, _cash_name FROM (VALUES
        ('bank','1020','Bank Accounts'),
        ('bank_transfer','1020','Bank Accounts'),
        ('bank-transfer','1020','Bank Accounts'),
        ('transfer','1020','Bank Accounts'),
        ('eft','1020','Bank Accounts'),
        ('rtgs','1020','Bank Accounts'),
        ('cheque','1020','Bank Accounts'),
        ('check','1020','Bank Accounts'),
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
      IF p.schedule_id IS NOT NULL THEN
        UPDATE public.payment_schedules SET status='failed', updated_at=now()
         WHERE id=p.schedule_id AND organization_id=_org;
      END IF;
      PERFORM public.neo_record_posting_receipt(_org, p.branch_id, 'supplier-payment', _payment,
        p.payment_number, 'failed', _amt, _cur, NULL, NULL, _msg, coalesce(p.paid_on, CURRENT_DATE));
      RETURN jsonb_build_object('ok', false, 'status','failed', 'payment_id', p.id, 'detail', _msg);
    END;

    UPDATE public.supplier_payments
       SET status = 'paid', journal_id = _jid, updated_at = now()
     WHERE id = _payment;
    IF p.schedule_id IS NOT NULL THEN
      UPDATE public.payment_schedules SET status='paid', updated_at=now()
       WHERE id=p.schedule_id AND organization_id=_org;
    END IF;

    PERFORM public.neo_record_posting_receipt(_org, p.branch_id, 'supplier-payment', _payment,
      p.payment_number, CASE WHEN _jid IS NOT NULL THEN 'posted' ELSE 'blocked' END,
      _amt, _cur, NULL, _res->>'detail', NULL, coalesce(p.paid_on, CURRENT_DATE));

    PERFORM public.neo_financial_state_set(_org, p.branch_id, 'supplier-payment', _payment,
      p.payment_number, 'paid', CASE WHEN _jid IS NOT NULL THEN 'posted' ELSE 'blocked' END,
      'Paying a supplier reduces what the business owes and reduces the bank or cash account.',
      _amt, _cur, coalesce(p.paid_on, CURRENT_DATE), _jid, NULL, NULL, auth.uid(), NULL);

    IF p.supplier_invoice_id IS NOT NULL THEN
      SELECT coalesce(sum(sp.amount),0) INTO _paid FROM public.supplier_payments sp
       WHERE sp.supplier_invoice_id = p.supplier_invoice_id AND sp.status = 'paid';
      UPDATE public.supplier_invoices
         SET paid_amount = round(_paid,2),
             status = CASE WHEN _paid >= round(coalesce(amount,0),2) - 0.009 THEN 'paid' ELSE 'partially_paid' END,
             updated_at = now()
       WHERE id = p.supplier_invoice_id AND organization_id = _org;
    END IF;
  ELSE
    UPDATE public.supplier_payments
       SET status = _next,
           approved_by = CASE WHEN _act = 'approve' THEN auth.uid() ELSE approved_by END,
           approved_at = CASE WHEN _act = 'approve' THEN now() ELSE approved_at END,
           updated_at = now()
     WHERE id = _payment;

    IF p.schedule_id IS NOT NULL THEN
      UPDATE public.payment_schedules
         SET status = CASE _act
           WHEN 'submit' THEN 'pending_approval'
           WHEN 'approve' THEN 'approved'
           WHEN 'release' THEN 'released'
           WHEN 'fail' THEN 'failed'
           ELSE status END,
             updated_at = now()
       WHERE id = p.schedule_id AND organization_id = _org;
    END IF;
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

-- ---------------------------------------------------------------------------
-- 2. Cash refunds and till movements. Refund is an audit movement but is not a
--    paid-out counter because the negative payment already reduces expected cash.
-- ---------------------------------------------------------------------------
-- Older close/review functions already use variance-review / pending-review /
-- disputed, but the original table constraint did not admit every live state.
ALTER TABLE public.pos_shifts DROP CONSTRAINT IF EXISTS pos_shifts_status_chk;
ALTER TABLE public.pos_shifts ADD CONSTRAINT pos_shifts_status_chk CHECK (
  status IN ('open','pending-closure','closed','variance-review','pending-review','reopened','disputed')
);

ALTER TABLE public.cash_movements DROP CONSTRAINT IF EXISTS cash_movements_type_chk;
ALTER TABLE public.cash_movements ADD CONSTRAINT cash_movements_type_chk CHECK (
  movement_type = ANY (ARRAY[
    'float-in','cash-sale','paid-out','petty-cash','drop','count','adjustment',
    'pickup','float-top-up','rider-cash','refund'
  ])
);

CREATE OR REPLACE FUNCTION public.cash_record_movement(
  _shift uuid,
  _type text,
  _amount numeric,
  _reason text,
  _reference text DEFAULT ''::text
) RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  _org uuid := public.current_org_id();
  _s public.pos_shifts;
  _id uuid;
  _kind text := replace(lower(btrim(coalesce(_type,''))), '_', '-');
BEGIN
  SELECT * INTO _s FROM public.pos_shifts WHERE id=_shift AND organization_id=_org FOR UPDATE;
  IF _s.id IS NULL THEN RAISE EXCEPTION 'Shift not found'; END IF;
  IF NOT (public.has_permission('finance','till','edit')
          OR (_s.cashier_id = auth.uid() AND public.has_permission('finance','till','create'))
          OR public.is_org_admin()) THEN
    RAISE EXCEPTION 'Not permitted to record a till movement';
  END IF;
  IF _s.status <> 'open' THEN RAISE EXCEPTION 'Shift is % and cannot accept movements', _s.status; END IF;
  IF _s.branch_id IS NOT NULL AND NOT public.neo_branch_in_scope(_s.branch_id) THEN
    RAISE EXCEPTION 'That till belongs to a property outside your access scope' USING ERRCODE='42501';
  END IF;
  IF _kind NOT IN ('drop','paid-out','pickup','float-top-up') THEN
    RAISE EXCEPTION 'Unsupported movement type %', _type;
  END IF;
  IF _amount IS NULL OR _amount <= 0 THEN RAISE EXCEPTION 'Movement amount must be greater than zero'; END IF;
  IF COALESCE(trim(_reason),'') = '' THEN RAISE EXCEPTION 'A reason is required'; END IF;

  INSERT INTO public.cash_movements (organization_id, shift_id, movement_type, amount, reason, reference, created_by)
  VALUES (_org, _shift, _kind, round(_amount,2), _reason, _reference, auth.uid()) RETURNING id INTO _id;

  UPDATE public.pos_shifts SET
    total_drops = total_drops + CASE WHEN _kind IN ('drop','pickup') THEN round(_amount,2) ELSE 0 END,
    total_paid_outs = total_paid_outs + CASE WHEN _kind = 'paid-out' THEN round(_amount,2) ELSE 0 END,
    opening_float = opening_float + CASE WHEN _kind = 'float-top-up' THEN round(_amount,2) ELSE 0 END,
    updated_at = now()
  WHERE id = _shift;

  RETURN _id;
END; $function$;

REVOKE ALL ON FUNCTION public.cash_record_movement(uuid,text,numeric,text,text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.cash_record_movement(uuid,text,numeric,text,text) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.neo_cash_refund_settle(_refund uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  _org uuid := public.current_org_id();
  _r public.cash_refund_requests;
  _s public.pos_shifts;
  _f public.folios;
  _pay uuid;
  _receipt text;
  _expected numeric;
  _original_pos_amount numeric := 0;
  _settled_against_pos numeric := 0;
BEGIN
  PERFORM public.neo_assert_capability('finance','payments','refund_payment');
  SELECT * INTO _r FROM public.cash_refund_requests WHERE id=_refund AND organization_id=_org FOR UPDATE;
  IF _r.id IS NULL THEN RAISE EXCEPTION 'Refund not found'; END IF;
  IF _r.status = 'settled' THEN
    RETURN jsonb_build_object('status','settled','refund_id',_r.id,
      'refund_receipt_number',_r.refund_receipt_number,'payment_id',_r.refund_payment_id);
  END IF;
  IF _r.status <> 'approved' THEN RAISE EXCEPTION 'Refund is % and cannot be paid out', _r.status; END IF;
  IF _r.amount IS NULL OR _r.amount <= 0 THEN RAISE EXCEPTION 'Refund amount must be greater than zero'; END IF;
  IF _r.branch_id IS NOT NULL AND NOT public.neo_branch_in_scope(_r.branch_id) THEN
    RAISE EXCEPTION 'That refund belongs to a property outside your access scope' USING ERRCODE='42501';
  END IF;

  SELECT * INTO _s FROM public.pos_shifts
   WHERE organization_id=_org AND cashier_id=auth.uid() AND status='open'
   ORDER BY opened_at DESC LIMIT 1 FOR UPDATE;
  IF _s.id IS NULL THEN RAISE EXCEPTION 'Open your till before paying out a cash refund'; END IF;
  IF _r.branch_id IS NOT NULL AND _s.branch_id IS DISTINCT FROM _r.branch_id THEN
    RAISE EXCEPTION 'Open a till at the same property as the refund before paying it out';
  END IF;

  _expected := round(coalesce(public.cash_shift_expected(_s.id),0),2);
  IF _r.amount > _expected + 0.009 THEN
    RAISE EXCEPTION 'This till holds % expected cash but the refund requires %', _expected, round(_r.amount,2);
  END IF;

  _receipt := public.next_document_number('receipt');

  INSERT INTO public.payments (organization_id, branch_id, receipt_number, folio_id, amount, currency,
    method, external_reference, status, received_by, notes, shift_id, source_module, source_record_id,
    idempotency_key)
  VALUES (_org, _r.branch_id, _receipt, _r.folio_id, -1 * round(_r.amount,2), _r.currency, 'cash',
    _r.original_receipt_number, 'confirmed', auth.uid(),
    'Refund of receipt ' || COALESCE(_r.original_receipt_number,'—') || ' — ' || _r.reason,
    _s.id, 'cash_refund', _r.id, 'cash-refund:' || _r.id::text)
  RETURNING id INTO _pay;

  IF _r.folio_id IS NOT NULL THEN
    SELECT * INTO _f FROM public.folios WHERE id=_r.folio_id AND organization_id=_org FOR UPDATE;
    IF _f.id IS NOT NULL THEN
      UPDATE public.folios SET total_payments = COALESCE(total_payments,0) - _r.amount,
        balance = COALESCE(balance,0) + _r.amount, updated_at = now() WHERE id=_f.id;
    END IF;
  END IF;

  -- A partial refund must not label the entire original POS payment refunded.
  IF _r.pos_payment_id IS NOT NULL THEN
    SELECT abs(coalesce(amount,0)) INTO _original_pos_amount
      FROM public.pos_payments
     WHERE id=_r.pos_payment_id AND organization_id=_org;
    SELECT coalesce(sum(amount),0) INTO _settled_against_pos
      FROM public.cash_refund_requests
     WHERE organization_id=_org AND pos_payment_id=_r.pos_payment_id AND status='settled';
    _settled_against_pos := _settled_against_pos + _r.amount;
    IF _settled_against_pos >= _original_pos_amount - 0.009 THEN
      UPDATE public.pos_payments SET status='refunded', updated_at=now() WHERE id=_r.pos_payment_id;
    END IF;
  END IF;

  -- Audit-only movement. Do not increment paid-outs: the negative payment above
  -- is already included by cash_shift_expected and therefore reduces expected cash once.
  INSERT INTO public.cash_movements
    (organization_id, shift_id, movement_type, amount, reason, reference, created_by)
  VALUES
    (_org, _s.id, 'refund', round(_r.amount,2),
     'Cash refund of receipt ' || COALESCE(_r.original_receipt_number,'—') || ' — ' || _r.reason,
     _receipt, auth.uid());

  UPDATE public.cash_refund_requests
     SET status='settled', settled_by=auth.uid(), settled_at=now(), refund_payment_id=_pay,
         refund_receipt_number=_receipt, shift_id=_s.id, updated_at=now()
   WHERE id=_r.id;

  INSERT INTO public.audit_logs (organization_id, user_id, user_name, action, module, record_id, new_value, reason)
  VALUES (_org, auth.uid(), '', 'finance.cash.refund.settle', 'finance', _pay::text,
    jsonb_build_object('refund_id',_r.id,'amount',_r.amount,'shift_id',_s.id,
      'expected_cash_before',_expected,'original_receipt',_r.original_receipt_number,
      'refund_receipt',_receipt), _r.reason);

  RETURN jsonb_build_object('status','settled','refund_id',_r.id,'payment_id',_pay,
    'refund_receipt_number',_receipt,'amount',_r.amount,'expected_cash_before',_expected);
END; $function$;

REVOKE ALL ON FUNCTION public.neo_cash_refund_settle(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.neo_cash_refund_settle(uuid) TO authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 3. Cashier shift close: counted cash is mandatory, persisted and auditable.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.cash_close_shift(_shift uuid, _counted numeric, _reason text DEFAULT ''::text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  _org uuid := public.current_org_id();
  _s public.pos_shifts;
  _expected numeric;
  _count numeric;
  _variance numeric;
  _appr uuid;
BEGIN
  IF NOT (public.has_permission('finance','till','close')
          OR public.has_permission('finance','till','edit')
          OR public.is_org_admin()) THEN
    RAISE EXCEPTION 'Not permitted to close a cashier shift';
  END IF;
  IF _counted IS NULL OR _counted < 0 THEN
    RAISE EXCEPTION 'Counted cash is required and cannot be negative';
  END IF;

  SELECT * INTO _s FROM public.pos_shifts WHERE id=_shift AND organization_id=_org FOR UPDATE;
  IF _s.id IS NULL THEN RAISE EXCEPTION 'Shift not found'; END IF;
  IF _s.status <> 'open' THEN RAISE EXCEPTION 'Shift is already %', _s.status; END IF;
  IF _s.cashier_id IS DISTINCT FROM auth.uid() AND NOT public.is_org_admin() THEN
    RAISE EXCEPTION 'A cashier may only close their own till' USING ERRCODE='42501';
  END IF;
  IF _s.branch_id IS NOT NULL AND NOT public.neo_branch_in_scope(_s.branch_id) THEN
    RAISE EXCEPTION 'That till belongs to a property outside your access scope' USING ERRCODE='42501';
  END IF;

  _expected := round(coalesce(public.cash_shift_expected(_shift),0),2);
  _count := round(_counted,2);
  _variance := round(_count - _expected, 2);
  IF _variance <> 0 AND COALESCE(trim(_reason),'') = '' THEN
    RAISE EXCEPTION 'A variance reason is required when the count does not match the expected cash';
  END IF;

  IF _variance <> 0 THEN
    INSERT INTO public.approval_requests (organization_id, branch_id, reference, approval_type, requester_id,
      reason, amount, status)
    VALUES (_org, _s.branch_id, 'SHIFT-' || COALESCE(_s.shift_number, substr(_shift::text,1,8)),
      'cash-variance', auth.uid(), _reason, abs(_variance), 'pending')
    RETURNING id INTO _appr;
  END IF;

  INSERT INTO public.cash_movements
    (organization_id, shift_id, movement_type, amount, reason, reference, created_by)
  VALUES
    (_org, _shift, 'count', _count,
     CASE WHEN _variance = 0 THEN 'Closing cash count — balanced'
          ELSE 'Closing cash count — variance: ' || _reason END,
     COALESCE(_s.shift_number, _shift::text), auth.uid());

  UPDATE public.pos_shifts SET status = CASE WHEN _variance = 0 THEN 'closed' ELSE 'variance-review' END,
    expected_cash = _expected, counted_cash = _count, variance = _variance,
    variance_reason = nullif(btrim(coalesce(_reason,'')),''),
    closed_at = now(), closed_by = auth.uid(), review_approval_request_id = _appr, updated_at = now()
  WHERE id = _shift;

  INSERT INTO public.audit_logs (organization_id, user_id, user_name, action, module, record_id, new_value, reason)
  VALUES (_org, auth.uid(), '', 'pos.shift.close', 'pos', _shift::text,
    jsonb_build_object('expected',_expected,'counted',_count,'variance',_variance,
                       'approval_request_id',_appr), nullif(btrim(coalesce(_reason,'')),''));

  RETURN jsonb_build_object('expected',_expected,'counted',_count,'variance',_variance,
    'status', CASE WHEN _variance = 0 THEN 'closed' ELSE 'variance-review' END,
    'approval_request_id', _appr);
END; $function$;

REVOKE ALL ON FUNCTION public.cash_close_shift(uuid, numeric, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.cash_close_shift(uuid, numeric, text) TO authenticated;

-- ---------------------------------------------------------------------------
-- 4. Explicit business-day open/close lifecycle. A closed day is never reopened;
--    corrections belong to the current open date and reference the old one.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.neo_open_business_day(
  _branch uuid,
  _date date DEFAULT NULL::date,
  _note text DEFAULT NULL::text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  _org uuid := public.current_org_id();
  _date_to_open date := coalesce(_date, current_date);
  _day public.business_days;
  _other public.business_days;
BEGIN
  IF _org IS NULL THEN RAISE EXCEPTION 'No workspace context'; END IF;
  IF NOT (public.has_permission('finance','eod','close_business_day') OR public.is_org_admin()) THEN
    RAISE EXCEPTION 'Opening the business day requires finance.eod.close_business_day authority' USING ERRCODE='42501';
  END IF;
  IF _branch IS NULL OR NOT EXISTS(
    SELECT 1 FROM public.branches b WHERE b.id=_branch AND b.organization_id=_org
  ) THEN RAISE EXCEPTION 'Unknown property'; END IF;
  IF NOT public.neo_branch_in_scope(_branch) AND NOT public.is_org_admin() THEN
    RAISE EXCEPTION 'That property is outside your access scope' USING ERRCODE='42501';
  END IF;

  -- Serialise the branch calendar so two operators cannot open two dates at once.
  PERFORM pg_advisory_xact_lock(hashtextextended('business-day:' || _org::text || ':' || _branch::text, 0));

  SELECT * INTO _day FROM public.business_days
   WHERE organization_id=_org AND branch_id=_branch AND business_date=_date_to_open FOR UPDATE;
  IF _day.id IS NOT NULL THEN
    IF _day.status='open' THEN
      RETURN jsonb_build_object('status','already_open','business_date',_date_to_open,'business_day_id',_day.id);
    END IF;
    RAISE EXCEPTION 'Business day % is already closed and cannot be reopened', _date_to_open;
  END IF;

  SELECT * INTO _other FROM public.business_days
   WHERE organization_id=_org AND branch_id=_branch AND status='open'
   ORDER BY business_date DESC LIMIT 1 FOR UPDATE;
  IF _other.id IS NOT NULL THEN
    RETURN jsonb_build_object('status','another_day_open','business_date',_date_to_open,
      'open_business_date',_other.business_date,'business_day_id',_other.id,
      'message','Close the currently open business day before opening another one.');
  END IF;

  INSERT INTO public.business_days
    (organization_id,branch_id,business_date,status,opened_at,opened_by,notes)
  VALUES
    (_org,_branch,_date_to_open,'open',now(),auth.uid(),nullif(btrim(coalesce(_note,'')),''))
  RETURNING * INTO _day;

  INSERT INTO public.audit_logs(organization_id,branch_id,user_id,action,module,record_id,new_value,reason)
  VALUES(_org,_branch,auth.uid(),'finance.business_day_opened','finance',_day.id::text,
    jsonb_build_object('branch_id',_branch,'business_date',_date_to_open,'status','open'),
    nullif(btrim(coalesce(_note,'')),''));

  RETURN jsonb_build_object('status','open','business_date',_date_to_open,'business_day_id',_day.id);
END;
$function$;

REVOKE ALL ON FUNCTION public.neo_open_business_day(uuid,date,text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.neo_open_business_day(uuid,date,text) TO authenticated;

CREATE OR REPLACE FUNCTION public.neo_close_business_day(
  _branch uuid,
  _date date DEFAULT NULL,
  _note text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  _org uuid := public.current_org_id();
  _d date := coalesce(_date,current_date);
  _a public.night_audit_runs;
  _day public.business_days;
  _next public.business_days;
  _unresolved int;
  _open_shifts int := 0;
  _unclosed_orders int := 0;
  _unreconciled_rider_cash int := 0;
  _unsettled_refunds int := 0;
BEGIN
  IF _org IS NULL THEN RAISE EXCEPTION 'No workspace context'; END IF;
  IF NOT (public.has_permission('finance','eod','close_business_day') OR public.is_org_admin()) THEN
    RAISE EXCEPTION 'Closing the business day requires the finance.eod.close_business_day permission';
  END IF;
  IF _branch IS NULL OR NOT EXISTS(
    SELECT 1 FROM public.branches b WHERE b.id=_branch AND b.organization_id=_org
  ) THEN RAISE EXCEPTION 'Unknown property'; END IF;
  IF NOT public.neo_branch_in_scope(_branch) AND NOT public.is_org_admin() THEN
    RAISE EXCEPTION 'That property is outside your access scope' USING ERRCODE='42501';
  END IF;

  -- Use the same branch calendar lock as open, so close/advance is single-writer.
  PERFORM pg_advisory_xact_lock(hashtextextended('business-day:' || _org::text || ':' || _branch::text, 0));

  SELECT * INTO _day FROM public.business_days
   WHERE organization_id=_org AND branch_id=_branch AND business_date=_d FOR UPDATE;
  IF _day.id IS NULL THEN
    RETURN jsonb_build_object('status','not_open','business_date',_d,
      'message','Open this business day before running the close process.');
  END IF;
  IF _day.status='closed' THEN
    RETURN jsonb_build_object('status','already_closed','business_date',_d);
  END IF;

  SELECT * INTO _a FROM public.night_audit_runs
   WHERE organization_id=_org AND branch_id=_branch AND business_date=_d FOR UPDATE;
  IF _a.id IS NULL OR _a.status<>'completed' OR _a.stage<>'signed' OR _a.result_digest IS NULL THEN
    RETURN jsonb_build_object('status','exception','business_date',_d,
      'blocking',coalesce(_a.blocking_count,1),
      'message','Run and complete a signed End-of-Day audit before closing.');
  END IF;

  -- A business day cannot close while cash or revenue-producing operational work
  -- is still open. These checks are deliberately independent of the night-audit
  -- report so a stale/older signed audit can never bypass today's live state.
  SELECT count(*) INTO _open_shifts
    FROM public.pos_shifts s
   WHERE s.organization_id=_org AND s.branch_id=_branch
     AND coalesce(s.status,'open') <> 'closed';

  SELECT count(*) INTO _unclosed_orders
    FROM public.pos_orders o
   WHERE o.organization_id=_org AND o.branch_id=_branch
     AND o.created_at::date <= _d
     AND coalesce(o.status,'draft') NOT IN ('closed','cancelled','voided','charged-to-room','credit');

  SELECT count(*) INTO _unreconciled_rider_cash
    FROM public.rider_cash_remittances r
   WHERE r.organization_id=_org AND r.branch_id=_branch
     AND r.submitted_at::date <= _d
     AND r.status <> 'reconciled';

  SELECT count(*) INTO _unsettled_refunds
    FROM public.cash_refund_requests r
   WHERE r.organization_id=_org AND r.branch_id=_branch
     AND r.created_at::date <= _d
     AND r.status IN ('pending_approval','approved');

  IF _open_shifts > 0 OR _unclosed_orders > 0 OR _unreconciled_rider_cash > 0 OR _unsettled_refunds > 0 THEN
    RETURN jsonb_build_object(
      'status','exception',
      'business_date',_d,
      'blocking',_open_shifts + _unclosed_orders + _unreconciled_rider_cash + _unsettled_refunds,
      'open_shifts',_open_shifts,
      'unclosed_pos_orders',_unclosed_orders,
      'unreconciled_rider_cash',_unreconciled_rider_cash,
      'unsettled_refunds',_unsettled_refunds,
      'message','Close tills and orders, reconcile rider cash, and settle or reject pending refunds before closing the business day.'
    );
  END IF;

  SELECT count(*) INTO _unresolved FROM public.neo_finance_exception_register(_branch,_d,_d);
  _unresolved := _unresolved + (SELECT count(*) FROM public.neo_finance_posting_queue(_branch,_d,_d) WHERE eligible);
  IF _a.blocking_count>0 OR _unresolved>0 THEN
    RETURN jsonb_build_object('status','exception','business_date',_d,
      'blocking',greatest(_a.blocking_count,_unresolved),
      'message','Reconciliation is unresolved. Resolve the canonical Finance exceptions before closing.');
  END IF;

  UPDATE public.business_days
     SET status='closed', closed_at=now(), closed_by=auth.uid(), close_mode='manual',
         notes=coalesce(nullif(btrim(coalesce(_note,'')),''),notes), updated_at=now()
   WHERE id=_day.id
   RETURNING * INTO _day;

  -- The successful close advances the calendar exactly once. If historic dirty
  -- data already has another open day, do not create a second open day.
  IF NOT EXISTS (
    SELECT 1 FROM public.business_days
     WHERE organization_id=_org AND branch_id=_branch AND status='open'
  ) THEN
    INSERT INTO public.business_days(organization_id,branch_id,business_date,status,opened_at,opened_by)
    VALUES(_org,_branch,_d+1,'open',now(),auth.uid())
    ON CONFLICT(organization_id,branch_id,business_date) DO NOTHING;
  END IF;

  SELECT * INTO _next FROM public.business_days
   WHERE organization_id=_org AND branch_id=_branch AND status='open'
   ORDER BY business_date DESC LIMIT 1;

  INSERT INTO public.audit_logs(organization_id,branch_id,user_id,action,module,record_id,new_value,reason)
  VALUES(_org,_branch,auth.uid(),'finance.business_day_closed','finance',_day.id::text,
    jsonb_build_object('branch_id',_branch,'business_date',_d,'audit_id',_a.id,
      'audit_reference',_a.run_reference,'result_digest',_a.result_digest,
      'next_business_date',_next.business_date), nullif(btrim(coalesce(_note,'')),''));

  RETURN jsonb_build_object('status','closed','business_date',_d,'audit_id',_a.id,
    'audit_reference',_a.run_reference,'result_digest',_a.result_digest,
    'next_business_date',_next.business_date);
END;
$function$;

REVOKE ALL ON FUNCTION public.neo_close_business_day(uuid,date,text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.neo_close_business_day(uuid,date,text) TO authenticated;

-- ---------------------------------------------------------------------------
-- 5. Real discount authority. Operations Manager may authorise up to 15%.
--    Anything above 15% is Owner-only, calculated on the effective final
--    discount after configured policy caps. The server owns the ceiling.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.neo_user_has_role_key(_role_key text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  SELECT EXISTS (
    SELECT 1
      FROM unnest(public.current_user_role_ids()) AS rid
     WHERE public.canonical_role_template_key(rid) = _role_key
  );
$function$;
REVOKE ALL ON FUNCTION public.neo_user_has_role_key(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.neo_user_has_role_key(text) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.neo_pos_apply_discount(
  _order uuid,
  _discount uuid,
  _reason text DEFAULT null
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  o public.pos_orders;
  d public.pos_discounts;
  _amount numeric(14,2);
  _raw_amount numeric(14,2);
  _cap numeric(14,2);
  _effective_percent numeric := 0;
  _is_owner boolean := public.neo_user_has_role_key('owner');
  _is_ops boolean := public.neo_user_has_role_key('operations-manager');
  _approval_level text := 'policy';
  _local_time time;
BEGIN
  SELECT * INTO o FROM public.pos_orders WHERE id = _order FOR UPDATE;
  IF o.id IS NULL THEN RAISE EXCEPTION 'That order could not be found.'; END IF;
  IF o.organization_id <> current_org_id() THEN RAISE EXCEPTION 'That order belongs to another workspace.'; END IF;
  IF NOT (o.branch_id = ANY (current_branch_ids())) AND NOT public.is_org_admin() THEN
    RAISE EXCEPTION 'You are not assigned to the property that owns this order.';
  END IF;
  IF NOT (has_permission('pos', 'discount.execute') OR _is_ops OR _is_owner) THEN
    RAISE EXCEPTION 'You do not have permission to apply a discount to a bill.' USING ERRCODE='42501';
  END IF;
  IF coalesce(o.status,'draft') IN ('closed','cancelled','voided') THEN
    RAISE EXCEPTION 'This bill is % and can no longer be discounted.', o.status;
  END IF;
  IF coalesce(o.payment_status,'unpaid') = 'paid' THEN
    RAISE EXCEPTION 'This bill is already paid. Use a refund, not a discount.';
  END IF;

  IF _discount IS NULL THEN
    UPDATE public.pos_orders SET discount_total = 0 WHERE id = _order;
    PERFORM emit_domain_event(o.organization_id, o.branch_id, 'pos.discount.cleared', 'pos',
      _order, jsonb_build_object('reason', _reason), null, null);
    INSERT INTO public.audit_logs(organization_id,branch_id,user_id,action,module,record_id,new_value,reason)
    VALUES(o.organization_id,o.branch_id,auth.uid(),'pos.discount.cleared','pos',_order::text,
      jsonb_build_object('discount_total',0),nullif(btrim(coalesce(_reason,'')),''));
    RETURN jsonb_build_object('ok', true, 'discount_total', 0, 'effective_percent', 0);
  END IF;

  SELECT * INTO d FROM public.pos_discounts WHERE id = _discount;
  IF d.id IS NULL OR d.organization_id <> o.organization_id THEN
    RAISE EXCEPTION 'That discount policy could not be found for this workspace.';
  END IF;
  IF d.branch_id IS NOT NULL AND d.branch_id <> o.branch_id THEN
    RAISE EXCEPTION 'That discount policy belongs to another property.';
  END IF;
  IF NOT coalesce(d.active, false) THEN RAISE EXCEPTION 'That discount policy is not active.'; END IF;
  IF d.valid_from IS NOT NULL AND current_date < d.valid_from THEN RAISE EXCEPTION 'That discount policy is not valid yet.'; END IF;
  IF d.valid_to IS NOT NULL AND current_date > d.valid_to THEN RAISE EXCEPTION 'That discount policy has expired.'; END IF;

  -- Honour configured time windows in the property's own operating timezone,
  -- including overnight windows such as 18:00-02:00.
  _local_time := (now() AT TIME ZONE public.neo_fact_timezone(o.organization_id, o.branch_id))::time;
  IF d.valid_time_from IS NOT NULL AND d.valid_time_to IS NOT NULL THEN
    IF d.valid_time_from <= d.valid_time_to THEN
      IF _local_time < d.valid_time_from OR _local_time > d.valid_time_to THEN
        RAISE EXCEPTION 'That discount policy is outside its configured time window.';
      END IF;
    ELSE
      IF _local_time < d.valid_time_from AND _local_time > d.valid_time_to THEN
        RAISE EXCEPTION 'That discount policy is outside its configured overnight time window.';
      END IF;
    END IF;
  ELSIF d.valid_time_from IS NOT NULL AND _local_time < d.valid_time_from THEN
    RAISE EXCEPTION 'That discount policy is not active yet today.';
  ELSIF d.valid_time_to IS NOT NULL AND _local_time > d.valid_time_to THEN
    RAISE EXCEPTION 'That discount policy is no longer active today.';
  END IF;

  IF d.order_types IS NOT NULL AND array_length(d.order_types, 1) IS NOT NULL
     AND NOT (o.order_type = ANY (d.order_types)) THEN
    RAISE EXCEPTION 'That discount policy does not apply to % orders.', o.order_type;
  END IF;
  IF coalesce(o.subtotal,0) <= 0 THEN RAISE EXCEPTION 'A bill with no subtotal cannot be discounted.'; END IF;

  IF d.discount_type = 'percentage' THEN
    _raw_amount := round(coalesce(o.subtotal, 0) * coalesce(d.value, 0) / 100.0, 2);
  ELSE
    _raw_amount := round(coalesce(d.value, 0), 2);
  END IF;
  _amount := _raw_amount;
  _cap := coalesce(d.max_value, _amount);
  IF _amount > _cap THEN _amount := _cap; END IF;
  IF _amount > coalesce(o.subtotal, 0) THEN _amount := coalesce(o.subtotal, 0); END IF;
  IF _amount < 0 THEN RAISE EXCEPTION 'A discount cannot be negative.'; END IF;

  _effective_percent := round((_amount / o.subtotal) * 100.0, 4);

  -- Hard authority ceiling: no policy flag or browser request can bypass it.
  IF _effective_percent > 15.0000 THEN
    IF NOT _is_owner THEN
      RAISE EXCEPTION 'Discounts above 15 percent require Owner approval. Effective discount: % percent.', _effective_percent
        USING ERRCODE='42501';
    END IF;
    IF nullif(btrim(coalesce(_reason,'')),'') IS NULL THEN
      RAISE EXCEPTION 'Enter the Owner approval reason for this discount.';
    END IF;
    _approval_level := 'owner';
  ELSIF coalesce(d.requires_approval,false) THEN
    IF NOT (_is_ops OR _is_owner) THEN
      RAISE EXCEPTION 'This discount needs approval from the Operations Manager (up to 15 percent) or Owner.'
        USING ERRCODE='42501';
    END IF;
    IF nullif(btrim(coalesce(_reason,'')),'') IS NULL THEN
      RAISE EXCEPTION 'Enter the reason for this approved discount.';
    END IF;
    _approval_level := CASE WHEN _is_owner THEN 'owner' ELSE 'operations-manager' END;
  END IF;

  UPDATE public.pos_orders SET discount_total = _amount WHERE id = _order;

  PERFORM emit_domain_event(o.organization_id, o.branch_id, 'pos.discount.applied', 'pos',
    _order,
    jsonb_build_object('discount_id', d.id, 'discount_name', d.name,
                       'amount', _amount, 'effective_percent', _effective_percent,
                       'approval_level', _approval_level, 'capped_at', d.max_value,
                       'reason', _reason), null, null);

  INSERT INTO public.audit_logs(organization_id,branch_id,user_id,action,module,record_id,new_value,reason)
  VALUES(o.organization_id,o.branch_id,auth.uid(),'pos.discount.applied','pos',_order::text,
    jsonb_build_object('discount_id',d.id,'discount_name',d.name,'amount',_amount,
      'effective_percent',_effective_percent,'approval_level',_approval_level,
      'requires_approval',d.requires_approval,'capped',(_cap < _raw_amount)),
    nullif(btrim(coalesce(_reason,'')),''));

  RETURN jsonb_build_object('ok', true, 'discount_total', _amount,
    'effective_percent', _effective_percent, 'approval_level', _approval_level,
    'capped', (_cap < _raw_amount));
END;
$function$;

REVOKE ALL ON FUNCTION public.neo_pos_apply_discount(uuid, uuid, text) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.neo_pos_apply_discount(uuid, uuid, text) TO authenticated;
