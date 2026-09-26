CREATE OR REPLACE FUNCTION public.pms_record_payment(_folio uuid, _amount numeric, _method text, _reference text DEFAULT NULL::text, _notes text DEFAULT ''::text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE _org uuid := public.current_org_id(); _f public.folios; _id uuid; _receipt text; _status text; _shift uuid;
BEGIN
  IF NOT public.has_permission('pms','payments.record') THEN RAISE EXCEPTION 'Not permitted to record payments'; END IF;
  IF _amount IS NULL OR _amount <= 0 THEN RAISE EXCEPTION 'Payment amount must be greater than zero'; END IF;
  SELECT * INTO _f FROM public.folios WHERE id=_folio AND organization_id=_org FOR UPDATE;
  IF _f.id IS NULL THEN RAISE EXCEPTION 'Folio not found'; END IF;
  IF _f.status NOT IN ('open','under-review') THEN RAISE EXCEPTION 'Folio is % and cannot accept payments', _f.status; END IF;

  -- Cash must be banked against the cashier's own open drawer, so the shift
  -- reconciliation at close counts every note taken at the desk.
  IF _method = 'cash' THEN
    SELECT s.id INTO _shift
      FROM public.pos_shifts s
     WHERE s.cashier_id = auth.uid()
       AND s.status = 'open'
       AND s.organization_id = _org
       AND (s.branch_id IS NULL OR _f.branch_id IS NULL OR s.branch_id = _f.branch_id)
     ORDER BY (s.branch_id = _f.branch_id) DESC NULLS LAST, s.opened_at DESC
     LIMIT 1;
    IF _shift IS NULL THEN
      RAISE EXCEPTION 'Open your cash drawer before taking cash at this desk';
    END IF;
  END IF;

  -- External methods stay pending until a provider or authorised verification confirms them.
  _status := CASE WHEN _method IN ('cash','corporate-credit') THEN 'confirmed' ELSE 'pending' END;
  _receipt := public.next_document_number('receipt');

  INSERT INTO public.payments (organization_id, branch_id, receipt_number, folio_id, reservation_id,
    customer_id, amount, currency, method, external_reference, status, received_by, notes, shift_id)
  VALUES (_org, _f.branch_id, _receipt, _folio, _f.reservation_id, _f.customer_id, _amount, _f.currency,
    _method, _reference, _status, auth.uid(), COALESCE(_notes,''), _shift)
  RETURNING id INTO _id;

  IF _status = 'confirmed' THEN
    INSERT INTO public.payment_allocations (organization_id, payment_id, folio_id, amount, created_by)
    VALUES (_org, _id, _folio, _amount, auth.uid());
    UPDATE public.folios SET total_payments = total_payments + _amount,
      balance = balance - _amount, updated_at = now() WHERE id=_folio;
  END IF;

  INSERT INTO public.audit_logs (organization_id, user_id, user_name, action, module, record_id, new_value, reason)
  VALUES (_org, auth.uid(), '', 'pms.payment.record', 'finance', _id::text,
    jsonb_build_object('folio_id',_folio,'amount',_amount,'method',_method,'status',_status,'shift_id',_shift), _notes);
  RETURN _id;
END; $function$;

REVOKE ALL ON FUNCTION public.pms_record_payment(uuid, numeric, text, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.pms_record_payment(uuid, numeric, text, text, text) TO authenticated, service_role;