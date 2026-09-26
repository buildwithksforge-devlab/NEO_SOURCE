-- Allow the controlled full-refund lifecycle to mark a confirmed POS payment
-- refunded only after the canonical refund request itself is settled. Ordinary
-- edits to confirmed payments remain blocked.

CREATE OR REPLACE FUNCTION public.tg_pos_payment_controls()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE
  _s public.pos_shifts;
  _settled numeric := 0;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.shift_id IS NULL AND NEW.method = 'cash' THEN
      NEW.shift_id := public.pos_resolve_open_shift(NEW.branch_id);
    END IF;
    IF NEW.shift_id IS NOT NULL THEN
      SELECT * INTO _s FROM public.pos_shifts WHERE id = NEW.shift_id;
      IF _s.id IS NULL THEN RAISE EXCEPTION 'Cashier shift not found'; END IF;
      IF _s.status <> 'open' THEN RAISE EXCEPTION 'Cashier shift is % and cannot accept payments', _s.status; END IF;
    ELSIF NEW.method = 'cash' THEN
      RAISE EXCEPTION 'Cash payments must reference an open cashier shift';
    END IF;
    RETURN NEW;
  END IF;

  IF OLD.status = 'confirmed'
     AND (NEW.amount IS DISTINCT FROM OLD.amount OR NEW.method IS DISTINCT FROM OLD.method
          OR NEW.status IS DISTINCT FROM OLD.status) THEN
    -- The only normal transition out of confirmed is the controlled full-refund
    -- transition, after the refund row has already been settled in this same tx.
    IF NEW.amount IS NOT DISTINCT FROM OLD.amount
       AND NEW.method IS NOT DISTINCT FROM OLD.method
       AND NEW.status = 'refunded' THEN
      SELECT COALESCE(sum(r.amount),0) INTO _settled
      FROM public.cash_refund_requests r
      WHERE r.organization_id = OLD.organization_id
        AND r.pos_payment_id = OLD.id
        AND r.status = 'settled';

      IF _settled >= abs(COALESCE(OLD.amount,0)) - 0.009 THEN
        RETURN NEW;
      END IF;
    END IF;

    IF current_setting('neo.payment_maintenance', true) IS DISTINCT FROM 'on' THEN
      RAISE EXCEPTION 'Confirmed payments cannot be edited. Post a refund or reversal instead.';
    END IF;
  END IF;
  RETURN NEW;
END;
$function$;

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

  -- Settle the canonical refund row first. The POS-payment trigger below permits
  -- confirmed -> refunded only when settled refunds cover the original amount.
  UPDATE public.cash_refund_requests
     SET status='settled', settled_by=auth.uid(), settled_at=now(), refund_payment_id=_pay,
         refund_receipt_number=_receipt, shift_id=_s.id, updated_at=now()
   WHERE id=_r.id;

  IF _r.pos_payment_id IS NOT NULL THEN
    SELECT abs(coalesce(amount,0)) INTO _original_pos_amount
      FROM public.pos_payments
     WHERE id=_r.pos_payment_id AND organization_id=_org;
    SELECT coalesce(sum(amount),0) INTO _settled_against_pos
      FROM public.cash_refund_requests
     WHERE organization_id=_org AND pos_payment_id=_r.pos_payment_id AND status='settled';
    IF _settled_against_pos >= _original_pos_amount - 0.009 THEN
      UPDATE public.pos_payments SET status='refunded', updated_at=now() WHERE id=_r.pos_payment_id;
    END IF;
  END IF;

  INSERT INTO public.cash_movements
    (organization_id, shift_id, movement_type, amount, reason, reference, created_by)
  VALUES
    (_org, _s.id, 'refund', round(_r.amount,2),
     'Cash refund of receipt ' || COALESCE(_r.original_receipt_number,'—') || ' — ' || _r.reason,
     _receipt, auth.uid());

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
