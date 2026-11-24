-- NEØ: Require accountable payment schedule maker before release.
-- Forward-only migration. No historical records are modified.
-- Shared function: review compatibility before deployment.

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
  IF s.created_by IS NULL THEN
    RAISE EXCEPTION 'Payment schedule has no maker; assign an accountable creator before release'
      USING ERRCODE = '23514';
  END IF;

  IF s.created_by = auth.uid() AND NOT public.is_org_admin() THEN
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

REVOKE ALL ON FUNCTION public.neo_payment_schedule_release(uuid, text, uuid, text, date)
FROM PUBLIC, anon;

GRANT EXECUTE ON FUNCTION public.neo_payment_schedule_release(uuid, text, uuid, text, date)
TO authenticated;
