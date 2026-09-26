-- 1. Permission for confirming physical cash receipt
INSERT INTO public.permissions (module, feature, action, label)
SELECT 'finance', 'till', 'confirm_cash', 'Confirm cash physically received'
WHERE NOT EXISTS (
  SELECT 1 FROM public.permissions WHERE module='finance' AND feature='till' AND action='confirm_cash'
);

-- 2. Cash payment requests
CREATE TABLE IF NOT EXISTS public.cash_payment_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  branch_id uuid,
  source_module text NOT NULL DEFAULT 'pms',
  source_record_id uuid,
  folio_id uuid,
  amount numeric NOT NULL,
  currency text NOT NULL DEFAULT 'KES',
  method text NOT NULL DEFAULT 'cash',
  reference text,
  notes text,
  status text NOT NULL DEFAULT 'pending',
  requested_by uuid,
  assigned_shift_id uuid,
  assigned_cashier_id uuid,
  payment_id uuid,
  receipt_number text,
  confirmed_at timestamptz,
  cancelled_reason text,
  idempotency_key text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS cash_payment_requests_idem
  ON public.cash_payment_requests (organization_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS cash_payment_requests_open
  ON public.cash_payment_requests (organization_id, status, assigned_shift_id);

GRANT SELECT ON public.cash_payment_requests TO authenticated;
GRANT ALL ON public.cash_payment_requests TO service_role;

ALTER TABLE public.cash_payment_requests ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Cash requests visible to the parties and session oversight" ON public.cash_payment_requests;
CREATE POLICY "Cash requests visible to the parties and session oversight"
ON public.cash_payment_requests FOR SELECT TO authenticated
USING (
  organization_id = public.current_org_id()
  AND (
    requested_by = auth.uid()
    OR assigned_cashier_id = auth.uid()
    OR public.has_permission('finance','sessions.view')
    OR public.has_permission('finance','till.confirm_cash')
  )
);

DROP TRIGGER IF EXISTS cash_payment_requests_touch ON public.cash_payment_requests;
CREATE TRIGGER cash_payment_requests_touch
BEFORE UPDATE ON public.cash_payment_requests
FOR EACH ROW EXECUTE FUNCTION public.fin_touch_updated_at();

-- 3. Till context for the current user / outlet
CREATE OR REPLACE FUNCTION public.neo_cash_till_context(_branch uuid DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $$
DECLARE
  _org uuid := public.current_org_id();
  _mine public.pos_shifts;
  _can_open boolean;
  _can_confirm boolean;
  _tills jsonb;
BEGIN
  IF _org IS NULL THEN RETURN jsonb_build_object('active_tills', '[]'::jsonb); END IF;

  _can_open := public.has_permission('finance','till.create') OR public.has_permission('pos','shifts.open');
  _can_confirm := public.has_permission('finance','till.confirm_cash')
               OR public.has_permission('finance','till.edit')
               OR public.has_permission('pos','shifts.open');

  SELECT * INTO _mine FROM public.pos_shifts s
   WHERE s.organization_id=_org AND s.cashier_id=auth.uid() AND s.status='open'
     AND (_branch IS NULL OR s.branch_id IS NULL OR s.branch_id=_branch)
   ORDER BY (s.branch_id = _branch) DESC NULLS LAST, s.opened_at DESC LIMIT 1;

  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'shift_id', s.id, 'shift_number', s.shift_number,
           'cashier_id', s.cashier_id, 'cashier_name', COALESCE(p.full_name,'Cashier'),
           'branch_id', s.branch_id, 'opened_at', s.opened_at) ORDER BY s.opened_at DESC), '[]'::jsonb)
    INTO _tills
    FROM public.pos_shifts s
    LEFT JOIN public.profiles p ON p.id = s.cashier_id
   WHERE s.organization_id=_org AND s.status='open'
     AND (_branch IS NULL OR s.branch_id IS NULL OR s.branch_id=_branch);

  RETURN jsonb_build_object(
    'can_open_drawer', _can_open,
    'can_confirm_cash', _can_confirm,
    'my_shift_id', _mine.id,
    'my_shift_number', _mine.shift_number,
    'self_service', (_mine.id IS NOT NULL AND _can_confirm),
    'active_tills', _tills
  );
END; $$;

-- 4. Atomic settlement of a confirmed cash request
CREATE OR REPLACE FUNCTION public.neo_cash_settle_request(_request uuid)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $$
DECLARE
  _org uuid := public.current_org_id();
  _r public.cash_payment_requests;
  _f public.folios;
  _s public.pos_shifts;
  _pay uuid; _receipt text;
BEGIN
  SELECT * INTO _r FROM public.cash_payment_requests WHERE id=_request AND organization_id=_org FOR UPDATE;
  IF _r.id IS NULL THEN RAISE EXCEPTION 'Cash request not found'; END IF;

  -- Idempotent: a confirmed request always returns the same payment identity.
  IF _r.status = 'confirmed' THEN
    RETURN jsonb_build_object('status','confirmed','request_id',_r.id,
      'payment_id',_r.payment_id,'receipt_number',_r.receipt_number,'amount',_r.amount);
  END IF;
  IF _r.status <> 'pending' THEN RAISE EXCEPTION 'Cash request is % and cannot be settled', _r.status; END IF;

  SELECT * INTO _s FROM public.pos_shifts WHERE id=_r.assigned_shift_id AND organization_id=_org FOR UPDATE;
  IF _s.id IS NULL OR _s.status <> 'open' THEN
    RAISE EXCEPTION 'The assigned cash drawer is no longer open';
  END IF;

  SELECT * INTO _f FROM public.folios WHERE id=_r.folio_id AND organization_id=_org FOR UPDATE;
  IF _f.id IS NULL THEN RAISE EXCEPTION 'Folio not found'; END IF;
  IF _f.status NOT IN ('open','under-review') THEN
    RAISE EXCEPTION 'Folio is % and cannot accept payments', _f.status;
  END IF;

  _receipt := public.next_document_number('receipt');

  INSERT INTO public.payments (organization_id, branch_id, receipt_number, folio_id, reservation_id,
    customer_id, amount, currency, method, external_reference, status, received_by, notes, shift_id,
    station_id, source_module, source_record_id, idempotency_key)
  VALUES (_org, _f.branch_id, _receipt, _f.id, _f.reservation_id, _f.customer_id, _r.amount,
    COALESCE(_f.currency,_r.currency), _r.method, _r.reference, 'confirmed', _s.cashier_id,
    COALESCE(_r.notes,''), _s.id, _s.station_id, _r.source_module, _r.source_record_id,
    'cash-request:' || _r.id::text)
  RETURNING id INTO _pay;

  INSERT INTO public.payment_allocations (organization_id, payment_id, folio_id, amount, created_by)
  VALUES (_org, _pay, _f.id, _r.amount, _s.cashier_id);

  UPDATE public.folios SET total_payments = COALESCE(total_payments,0) + _r.amount,
    balance = COALESCE(balance,0) - _r.amount, updated_at = now() WHERE id=_f.id;

  UPDATE public.cash_payment_requests
     SET status='confirmed', payment_id=_pay, receipt_number=_receipt,
         assigned_cashier_id=_s.cashier_id, confirmed_at=now(), updated_at=now()
   WHERE id=_r.id;

  INSERT INTO public.audit_logs (organization_id, user_id, user_name, action, module, record_id, new_value, reason)
  VALUES (_org, auth.uid(), '', 'finance.cash.receipt.confirm', 'finance', _pay::text,
    jsonb_build_object('request_id',_r.id,'folio_id',_f.id,'amount',_r.amount,'method',_r.method,
      'shift_id',_s.id,'collected_by',_s.cashier_id,'initiated_by',_r.requested_by,
      'receipt_number',_receipt), _r.notes);

  RETURN jsonb_build_object('status','confirmed','request_id',_r.id,'payment_id',_pay,
    'receipt_number',_receipt,'amount',_r.amount,'shift_id',_s.id,'collected_by',_s.cashier_id);
END; $$;

-- 5. Raise a cash payment request (settles immediately for authorised own-till users)
CREATE OR REPLACE FUNCTION public.neo_cash_request_payment(
  _folio uuid, _amount numeric, _reference text DEFAULT NULL, _notes text DEFAULT '',
  _idempotency_key text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $$
DECLARE
  _org uuid := public.current_org_id();
  _f public.folios;
  _ctx jsonb;
  _shift uuid; _cashier uuid; _req uuid; _existing public.cash_payment_requests;
BEGIN
  IF NOT (public.has_permission('pms','payments.record') OR public.is_org_admin()) THEN
    RAISE EXCEPTION 'Not permitted to record payments';
  END IF;
  IF _amount IS NULL OR _amount <= 0 THEN RAISE EXCEPTION 'Payment amount must be greater than zero'; END IF;

  SELECT * INTO _f FROM public.folios WHERE id=_folio AND organization_id=_org;
  IF _f.id IS NULL THEN RAISE EXCEPTION 'Folio not found'; END IF;

  IF _idempotency_key IS NOT NULL THEN
    SELECT * INTO _existing FROM public.cash_payment_requests
     WHERE organization_id=_org AND idempotency_key=_idempotency_key;
    IF _existing.id IS NOT NULL THEN
      RETURN jsonb_build_object('status',_existing.status,'request_id',_existing.id,
        'payment_id',_existing.payment_id,'receipt_number',_existing.receipt_number);
    END IF;
  END IF;

  _ctx := public.neo_cash_till_context(_f.branch_id);

  IF (_ctx->>'self_service')::boolean THEN
    _shift := (_ctx->>'my_shift_id')::uuid;
    _cashier := auth.uid();
  ELSE
    SELECT s.id, s.cashier_id INTO _shift, _cashier
      FROM public.pos_shifts s
     WHERE s.organization_id=_org AND s.status='open'
       AND (s.branch_id IS NULL OR _f.branch_id IS NULL OR s.branch_id=_f.branch_id)
     ORDER BY (s.branch_id = _f.branch_id) DESC NULLS LAST, s.opened_at DESC
     LIMIT 1;
  END IF;

  IF _shift IS NULL THEN
    RETURN jsonb_build_object('status','no_till',
      'message','No active cash drawer is available for this outlet.',
      'can_open_drawer', _ctx->'can_open_drawer');
  END IF;

  INSERT INTO public.cash_payment_requests (organization_id, branch_id, source_module, source_record_id,
    folio_id, amount, currency, method, reference, notes, status, requested_by,
    assigned_shift_id, assigned_cashier_id, idempotency_key)
  VALUES (_org, _f.branch_id, 'pms', _f.id, _f.id, _amount, COALESCE(_f.currency,'KES'), 'cash',
    _reference, COALESCE(_notes,''), 'pending', auth.uid(), _shift, _cashier, _idempotency_key)
  RETURNING id INTO _req;

  INSERT INTO public.audit_logs (organization_id, user_id, user_name, action, module, record_id, new_value)
  VALUES (_org, auth.uid(), '', 'finance.cash.request.create', 'finance', _req::text,
    jsonb_build_object('folio_id',_f.id,'amount',_amount,'assigned_shift',_shift,'assigned_cashier',_cashier));

  IF (_ctx->>'self_service')::boolean THEN
    RETURN public.neo_cash_settle_request(_req);
  END IF;

  RETURN jsonb_build_object('status','pending','request_id',_req,'assigned_shift_id',_shift,
    'assigned_cashier_id',_cashier,'amount',_amount);
END; $$;

-- 6. Cashier confirms physical receipt
CREATE OR REPLACE FUNCTION public.neo_cash_confirm_receipt(_request uuid)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $$
DECLARE _org uuid := public.current_org_id(); _r public.cash_payment_requests;
BEGIN
  SELECT * INTO _r FROM public.cash_payment_requests WHERE id=_request AND organization_id=_org;
  IF _r.id IS NULL THEN RAISE EXCEPTION 'Cash request not found'; END IF;
  IF _r.status = 'confirmed' THEN RETURN public.neo_cash_settle_request(_request); END IF;

  IF _r.assigned_cashier_id IS DISTINCT FROM auth.uid() THEN
    RAISE EXCEPTION 'Only the cashier holding the assigned till can confirm this cash';
  END IF;
  IF NOT (public.has_permission('finance','till.confirm_cash')
       OR public.has_permission('finance','till.edit')
       OR public.has_permission('pos','shifts.open')) THEN
    RAISE EXCEPTION 'Not permitted to confirm cash receipt';
  END IF;

  RETURN public.neo_cash_settle_request(_request);
END; $$;

-- 7. Cancel a routed cash request
CREATE OR REPLACE FUNCTION public.neo_cash_cancel_request(_request uuid, _reason text)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $$
DECLARE _org uuid := public.current_org_id(); _r public.cash_payment_requests;
BEGIN
  IF COALESCE(trim(_reason),'') = '' THEN RAISE EXCEPTION 'A reason is required'; END IF;
  SELECT * INTO _r FROM public.cash_payment_requests WHERE id=_request AND organization_id=_org FOR UPDATE;
  IF _r.id IS NULL THEN RAISE EXCEPTION 'Cash request not found'; END IF;
  IF _r.status <> 'pending' THEN RAISE EXCEPTION 'Cash request is % and cannot be cancelled', _r.status; END IF;
  IF _r.requested_by IS DISTINCT FROM auth.uid() AND _r.assigned_cashier_id IS DISTINCT FROM auth.uid()
     AND NOT public.has_permission('finance','sessions.edit') THEN
    RAISE EXCEPTION 'Not permitted to cancel this cash request';
  END IF;

  UPDATE public.cash_payment_requests
     SET status='cancelled', cancelled_reason=_reason, updated_at=now() WHERE id=_r.id;

  INSERT INTO public.audit_logs (organization_id, user_id, user_name, action, module, record_id, new_value, reason)
  VALUES (_org, auth.uid(), '', 'finance.cash.request.cancel', 'finance', _r.id::text,
    jsonb_build_object('folio_id',_r.folio_id,'amount',_r.amount), _reason);

  RETURN jsonb_build_object('status','cancelled','request_id',_r.id);
END; $$;

GRANT EXECUTE ON FUNCTION public.neo_cash_till_context(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.neo_cash_request_payment(uuid, numeric, text, text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.neo_cash_confirm_receipt(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.neo_cash_cancel_request(uuid, text) TO authenticated;
REVOKE EXECUTE ON FUNCTION public.neo_cash_settle_request(uuid) FROM anon, authenticated;