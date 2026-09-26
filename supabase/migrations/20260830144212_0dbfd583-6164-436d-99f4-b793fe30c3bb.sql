-- 1. Transfers: link to till sessions (additive)
ALTER TABLE public.cash_transfers
  ADD COLUMN IF NOT EXISTS from_shift_id uuid REFERENCES public.pos_shifts(id),
  ADD COLUMN IF NOT EXISTS to_shift_id uuid REFERENCES public.pos_shifts(id),
  ADD COLUMN IF NOT EXISTS to_cashier_id uuid,
  ADD COLUMN IF NOT EXISTS cancelled_reason text;

CREATE INDEX IF NOT EXISTS cash_transfers_to_shift_idx ON public.cash_transfers(to_shift_id) WHERE to_shift_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS cash_transfers_from_shift_idx ON public.cash_transfers(from_shift_id) WHERE from_shift_id IS NOT NULL;

-- 2. Refund policy thresholds
CREATE TABLE IF NOT EXISTS public.cash_refund_policies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  branch_id uuid REFERENCES public.branches(id) ON DELETE CASCADE,
  approval_threshold numeric NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS cash_refund_policies_scope_idx
  ON public.cash_refund_policies(organization_id, COALESCE(branch_id, '00000000-0000-0000-0000-000000000000'::uuid));

GRANT SELECT, INSERT, UPDATE, DELETE ON public.cash_refund_policies TO authenticated;
GRANT ALL ON public.cash_refund_policies TO service_role;
ALTER TABLE public.cash_refund_policies ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "cash_refund_policies_read" ON public.cash_refund_policies;
CREATE POLICY "cash_refund_policies_read" ON public.cash_refund_policies
  FOR SELECT TO authenticated USING (organization_id = public.current_org_id());
DROP POLICY IF EXISTS "cash_refund_policies_write" ON public.cash_refund_policies;
CREATE POLICY "cash_refund_policies_write" ON public.cash_refund_policies
  FOR ALL TO authenticated
  USING (organization_id = public.current_org_id() AND public.is_org_admin_for(organization_id))
  WITH CHECK (organization_id = public.current_org_id() AND public.is_org_admin_for(organization_id));

DROP TRIGGER IF EXISTS cash_refund_policies_touch ON public.cash_refund_policies;
CREATE TRIGGER cash_refund_policies_touch BEFORE UPDATE ON public.cash_refund_policies
  FOR EACH ROW EXECUTE FUNCTION public.fin_touch_updated_at();

-- 3. Refund requests, always tied to an original receipt
CREATE TABLE IF NOT EXISTS public.cash_refund_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  branch_id uuid,
  payment_id uuid,
  pos_payment_id uuid,
  folio_id uuid,
  original_receipt_number text,
  amount numeric NOT NULL,
  currency text NOT NULL DEFAULT 'KES',
  reason text NOT NULL,
  status text NOT NULL DEFAULT 'pending_approval',
  requires_approval boolean NOT NULL DEFAULT true,
  requested_by uuid,
  approved_by uuid,
  approved_at timestamptz,
  decision_note text,
  settled_by uuid,
  settled_at timestamptz,
  refund_payment_id uuid,
  refund_receipt_number text,
  shift_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.cash_refund_requests TO authenticated;
GRANT ALL ON public.cash_refund_requests TO service_role;
ALTER TABLE public.cash_refund_requests ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "cash_refund_requests_read" ON public.cash_refund_requests;
CREATE POLICY "cash_refund_requests_read" ON public.cash_refund_requests
  FOR SELECT TO authenticated USING (organization_id = public.current_org_id());

DROP TRIGGER IF EXISTS cash_refund_requests_touch ON public.cash_refund_requests;
CREATE TRIGGER cash_refund_requests_touch BEFORE UPDATE ON public.cash_refund_requests
  FOR EACH ROW EXECUTE FUNCTION public.fin_touch_updated_at();

CREATE INDEX IF NOT EXISTS cash_refund_requests_status_idx
  ON public.cash_refund_requests(organization_id, status, created_at DESC);

-- 4. POS-side cash request, same path as folio billing
CREATE OR REPLACE FUNCTION public.neo_cash_request_pos_payment(
  _order uuid, _amount numeric, _reference text DEFAULT NULL, _notes text DEFAULT '',
  _idempotency_key text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $function$
DECLARE
  _org uuid := public.current_org_id();
  _o public.pos_orders;
  _ctx jsonb; _shift uuid; _cashier uuid; _req uuid; _existing public.cash_payment_requests;
BEGIN
  IF NOT (public.has_permission('pos','payments.record') OR public.has_permission('pos','orders.edit')
          OR public.is_org_admin()) THEN
    RAISE EXCEPTION 'Not permitted to record payments' USING ERRCODE = '42501';
  END IF;
  IF _amount IS NULL OR _amount <= 0 THEN RAISE EXCEPTION 'Payment amount must be greater than zero'; END IF;

  SELECT * INTO _o FROM public.pos_orders WHERE id=_order AND organization_id=_org;
  IF _o.id IS NULL THEN RAISE EXCEPTION 'Order not found'; END IF;

  IF _idempotency_key IS NOT NULL THEN
    SELECT * INTO _existing FROM public.cash_payment_requests
     WHERE organization_id=_org AND idempotency_key=_idempotency_key;
    IF _existing.id IS NOT NULL THEN
      RETURN jsonb_build_object('status',_existing.status,'request_id',_existing.id,
        'payment_id',_existing.payment_id,'receipt_number',_existing.receipt_number);
    END IF;
  END IF;

  _ctx := public.neo_cash_till_context(_o.branch_id);

  IF (_ctx->>'self_service')::boolean THEN
    _shift := (_ctx->>'my_shift_id')::uuid; _cashier := auth.uid();
  ELSE
    SELECT s.id, s.cashier_id INTO _shift, _cashier
      FROM public.pos_shifts s
     WHERE s.organization_id=_org AND s.status='open'
       AND (s.branch_id IS NULL OR _o.branch_id IS NULL OR s.branch_id=_o.branch_id)
     ORDER BY (s.branch_id = _o.branch_id) DESC NULLS LAST, s.opened_at DESC LIMIT 1;
  END IF;

  IF _shift IS NULL THEN
    RETURN jsonb_build_object('status','no_till',
      'message','No active cash drawer is available for this outlet.',
      'can_open_drawer', _ctx->'can_open_drawer');
  END IF;

  INSERT INTO public.cash_payment_requests (organization_id, branch_id, source_module, source_record_id,
    folio_id, amount, currency, method, reference, notes, status, requested_by,
    assigned_shift_id, assigned_cashier_id, idempotency_key)
  VALUES (_org, _o.branch_id, 'pos', _o.id, NULL, _amount, COALESCE(_o.currency,'KES'), 'cash',
    COALESCE(_reference, _o.order_number), COALESCE(_notes,''), 'pending', auth.uid(),
    _shift, _cashier, _idempotency_key)
  RETURNING id INTO _req;

  INSERT INTO public.audit_logs (organization_id, user_id, user_name, action, module, record_id, new_value)
  VALUES (_org, auth.uid(), '', 'finance.cash.request.create', 'pos', _req::text,
    jsonb_build_object('order_id',_o.id,'amount',_amount,'assigned_shift',_shift,'assigned_cashier',_cashier));

  IF (_ctx->>'self_service')::boolean THEN
    RETURN public.neo_cash_settle_request(_req);
  END IF;

  RETURN jsonb_build_object('status','pending','request_id',_req,'assigned_shift_id',_shift,
    'assigned_cashier_id',_cashier,'amount',_amount);
END; $function$;

REVOKE ALL ON FUNCTION public.neo_cash_request_pos_payment(uuid,numeric,text,text,text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.neo_cash_request_pos_payment(uuid,numeric,text,text,text) TO authenticated;

-- 5. Settlement now understands POS orders as well as folios
CREATE OR REPLACE FUNCTION public.neo_cash_settle_request(_request uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $function$
DECLARE
  _org uuid := public.current_org_id();
  _r public.cash_payment_requests;
  _f public.folios;
  _o public.pos_orders;
  _s public.pos_shifts;
  _pay uuid; _receipt text; _paid numeric;
BEGIN
  SELECT * INTO _r FROM public.cash_payment_requests WHERE id=_request AND organization_id=_org FOR UPDATE;
  IF _r.id IS NULL THEN RAISE EXCEPTION 'Cash request not found'; END IF;

  IF _r.status = 'confirmed' THEN
    RETURN jsonb_build_object('status','confirmed','request_id',_r.id,
      'payment_id',_r.payment_id,'receipt_number',_r.receipt_number,'amount',_r.amount);
  END IF;
  IF _r.status <> 'pending' THEN RAISE EXCEPTION 'Cash request is % and cannot be settled', _r.status; END IF;

  SELECT * INTO _s FROM public.pos_shifts WHERE id=_r.assigned_shift_id AND organization_id=_org FOR UPDATE;
  IF _s.id IS NULL OR _s.status <> 'open' THEN
    RAISE EXCEPTION 'The assigned cash drawer is no longer open';
  END IF;

  _receipt := public.next_document_number('receipt');

  IF _r.source_module = 'pos' THEN
    SELECT * INTO _o FROM public.pos_orders WHERE id=_r.source_record_id AND organization_id=_org FOR UPDATE;
    IF _o.id IS NULL THEN RAISE EXCEPTION 'Order not found'; END IF;

    INSERT INTO public.pos_payments (organization_id, branch_id, order_id, receipt_number, customer_id,
      amount, tendered, currency, method, external_reference, status, paid_at, cashier_id, shift_id,
      created_by, idempotency_key)
    VALUES (_org, _o.branch_id, _o.id, _receipt, _o.customer_id, _r.amount, _r.amount,
      COALESCE(_o.currency,_r.currency), _r.method, _r.reference, 'confirmed', now(), _s.cashier_id, _s.id,
      auth.uid(), 'cash-request:' || _r.id::text)
    RETURNING id INTO _pay;

    _paid := COALESCE(_o.paid_total,0) + _r.amount;
    UPDATE public.pos_orders
       SET paid_total = _paid,
           payment_status = CASE WHEN _paid >= COALESCE(_o.grand_total,0) THEN 'paid' ELSE 'partial' END,
           updated_at = now()
     WHERE id = _o.id;
  ELSE
    SELECT * INTO _f FROM public.folios WHERE id=_r.folio_id AND organization_id=_org FOR UPDATE;
    IF _f.id IS NULL THEN RAISE EXCEPTION 'Folio not found'; END IF;
    IF _f.status NOT IN ('open','under-review') THEN
      RAISE EXCEPTION 'Folio is % and cannot accept payments', _f.status;
    END IF;

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
  END IF;

  UPDATE public.cash_payment_requests
     SET status='confirmed', payment_id=_pay, receipt_number=_receipt,
         assigned_cashier_id=_s.cashier_id, confirmed_at=now(), updated_at=now()
   WHERE id=_r.id;

  INSERT INTO public.audit_logs (organization_id, user_id, user_name, action, module, record_id, new_value, reason)
  VALUES (_org, auth.uid(), '', 'finance.cash.receipt.confirm', 'finance', _pay::text,
    jsonb_build_object('request_id',_r.id,'folio_id',_r.folio_id,'source_module',_r.source_module,
      'source_record_id',_r.source_record_id,'amount',_r.amount,'method',_r.method,
      'shift_id',_s.id,'collected_by',_s.cashier_id,'initiated_by',_r.requested_by,
      'receipt_number',_receipt), _r.notes);

  RETURN jsonb_build_object('status','confirmed','request_id',_r.id,'payment_id',_pay,
    'receipt_number',_receipt,'amount',_r.amount,'shift_id',_s.id,'collected_by',_s.cashier_id);
END; $function$;

-- 6. Controlled transfers between tills
CREATE OR REPLACE FUNCTION public.neo_cash_transfer_send(
  _amount numeric, _to_shift uuid DEFAULT NULL, _destination text DEFAULT 'till', _notes text DEFAULT '')
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $function$
DECLARE
  _org uuid := public.current_org_id();
  _from public.pos_shifts; _to public.pos_shifts; _id uuid; _number text; _expected numeric;
BEGIN
  IF _amount IS NULL OR _amount <= 0 THEN RAISE EXCEPTION 'Transfer amount must be greater than zero'; END IF;

  SELECT * INTO _from FROM public.pos_shifts
   WHERE organization_id=_org AND cashier_id=auth.uid() AND status='open'
   ORDER BY opened_at DESC LIMIT 1 FOR UPDATE;
  IF _from.id IS NULL THEN RAISE EXCEPTION 'You do not hold an open till to send cash from'; END IF;

  _expected := public.cash_shift_expected(_from.id);
  IF _amount > COALESCE(_expected,0) + 0.009 THEN
    RAISE EXCEPTION 'You cannot send more than the cash your till currently holds';
  END IF;

  IF _destination = 'till' THEN
    IF _to_shift IS NULL THEN RAISE EXCEPTION 'Choose the till receiving the cash'; END IF;
    SELECT * INTO _to FROM public.pos_shifts WHERE id=_to_shift AND organization_id=_org;
    IF _to.id IS NULL OR _to.status <> 'open' THEN RAISE EXCEPTION 'The receiving till is not open'; END IF;
    IF _to.id = _from.id THEN RAISE EXCEPTION 'A till cannot transfer cash to itself'; END IF;
  END IF;

  _number := 'CT-' || to_char(now(),'YYMMDD') || '-' || upper(substr(replace(gen_random_uuid()::text,'-',''),1,5));

  INSERT INTO public.cash_transfers (organization_id, branch_id, transfer_number, from_shift_id,
    to_destination, to_shift_id, to_cashier_id, amount, sent_by, sent_at, status, notes)
  VALUES (_org, _from.branch_id, _number, _from.id, _destination, _to.id, _to.cashier_id, _amount,
    auth.uid(), now(), 'in_transit', COALESCE(_notes,''))
  RETURNING id INTO _id;

  PERFORM public.cash_record_movement(_from.id, 'drop', _amount,
    'Cash transfer ' || _number || COALESCE(' — ' || NULLIF(_notes,''), ''), _number);

  INSERT INTO public.audit_logs (organization_id, user_id, user_name, action, module, record_id, new_value)
  VALUES (_org, auth.uid(), '', 'finance.cash.transfer.send', 'finance', _id::text,
    jsonb_build_object('transfer_number',_number,'amount',_amount,'from_shift',_from.id,
      'to_shift',_to.id,'destination',_destination));

  RETURN jsonb_build_object('status','in_transit','transfer_id',_id,'transfer_number',_number,
    'amount',_amount,'to_shift_id',_to.id);
END; $function$;

CREATE OR REPLACE FUNCTION public.neo_cash_transfer_confirm(_transfer uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $function$
DECLARE
  _org uuid := public.current_org_id(); _t public.cash_transfers; _to public.pos_shifts;
BEGIN
  SELECT * INTO _t FROM public.cash_transfers WHERE id=_transfer AND organization_id=_org FOR UPDATE;
  IF _t.id IS NULL THEN RAISE EXCEPTION 'Transfer not found'; END IF;
  IF _t.status = 'received' THEN
    RETURN jsonb_build_object('status','received','transfer_id',_t.id,'idempotent',true);
  END IF;
  IF _t.status <> 'in_transit' THEN RAISE EXCEPTION 'Transfer is % and cannot be confirmed', _t.status; END IF;

  IF _t.to_destination = 'till' THEN
    SELECT * INTO _to FROM public.pos_shifts WHERE id=_t.to_shift_id AND organization_id=_org FOR UPDATE;
    IF _to.id IS NULL OR _to.status <> 'open' THEN RAISE EXCEPTION 'The receiving till is not open'; END IF;
    IF _to.cashier_id <> auth.uid() AND NOT public.is_org_admin() THEN
      RAISE EXCEPTION 'Only the receiving cashier can confirm this transfer' USING ERRCODE = '42501';
    END IF;
    PERFORM public.cash_record_movement(_to.id, 'float_top_up', _t.amount,
      'Cash transfer ' || _t.transfer_number || ' received', _t.transfer_number);
  ELSE
    IF NOT (public.has_permission('finance','till.confirm_cash') OR public.has_permission('finance','banking.edit')
            OR public.is_org_admin()) THEN
      RAISE EXCEPTION 'Not permitted to confirm this transfer' USING ERRCODE = '42501';
    END IF;
  END IF;

  UPDATE public.cash_transfers
     SET status='received', received_by=auth.uid(), received_at=now(), updated_at=now()
   WHERE id=_t.id;

  INSERT INTO public.audit_logs (organization_id, user_id, user_name, action, module, record_id, new_value)
  VALUES (_org, auth.uid(), '', 'finance.cash.transfer.confirm', 'finance', _t.id::text,
    jsonb_build_object('transfer_number',_t.transfer_number,'amount',_t.amount,'to_shift',_t.to_shift_id));

  RETURN jsonb_build_object('status','received','transfer_id',_t.id,'transfer_number',_t.transfer_number,
    'amount',_t.amount);
END; $function$;

CREATE OR REPLACE FUNCTION public.neo_cash_transfer_cancel(_transfer uuid, _reason text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $function$
DECLARE _org uuid := public.current_org_id(); _t public.cash_transfers; _from public.pos_shifts;
BEGIN
  IF COALESCE(trim(_reason),'') = '' THEN RAISE EXCEPTION 'A reason is required to cancel a transfer'; END IF;
  SELECT * INTO _t FROM public.cash_transfers WHERE id=_transfer AND organization_id=_org FOR UPDATE;
  IF _t.id IS NULL THEN RAISE EXCEPTION 'Transfer not found'; END IF;
  IF _t.status <> 'in_transit' THEN RAISE EXCEPTION 'Transfer is % and cannot be cancelled', _t.status; END IF;
  IF _t.sent_by <> auth.uid() AND NOT public.is_org_admin() THEN
    RAISE EXCEPTION 'Only the sending cashier can cancel this transfer' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO _from FROM public.pos_shifts WHERE id=_t.from_shift_id AND organization_id=_org;
  IF _from.id IS NOT NULL AND _from.status = 'open' THEN
    PERFORM public.cash_record_movement(_from.id, 'float_top_up', _t.amount,
      'Cash transfer ' || _t.transfer_number || ' cancelled — ' || _reason, _t.transfer_number);
  END IF;

  UPDATE public.cash_transfers SET status='cancelled', cancelled_reason=_reason, updated_at=now()
   WHERE id=_t.id;

  INSERT INTO public.audit_logs (organization_id, user_id, user_name, action, module, record_id, new_value, reason)
  VALUES (_org, auth.uid(), '', 'finance.cash.transfer.cancel', 'finance', _t.id::text,
    jsonb_build_object('transfer_number',_t.transfer_number,'amount',_t.amount), _reason);

  RETURN jsonb_build_object('status','cancelled','transfer_id',_t.id);
END; $function$;

CREATE OR REPLACE FUNCTION public.neo_cash_transfers(_branch uuid DEFAULT NULL)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $function$
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'id', t.id, 'transfer_number', t.transfer_number, 'amount', t.amount, 'status', t.status,
    'destination', t.to_destination, 'notes', t.notes, 'cancelled_reason', t.cancelled_reason,
    'from_shift_id', t.from_shift_id, 'to_shift_id', t.to_shift_id,
    'sent_at', t.sent_at, 'received_at', t.received_at,
    'sent_by_name', COALESCE(sp.full_name,'—'), 'received_by_name', rp.full_name,
    'to_cashier_id', t.to_cashier_id, 'to_cashier_name', COALESCE(tp.full_name,'—'),
    'mine_to_confirm', (t.status='in_transit' AND t.to_cashier_id = auth.uid())
  ) ORDER BY t.sent_at DESC NULLS LAST), '[]'::jsonb)
  FROM public.cash_transfers t
  LEFT JOIN public.profiles sp ON sp.id = t.sent_by
  LEFT JOIN public.profiles rp ON rp.id = t.received_by
  LEFT JOIN public.profiles tp ON tp.id = t.to_cashier_id
  WHERE t.organization_id = public.current_org_id()
    AND (_branch IS NULL OR t.branch_id IS NULL OR t.branch_id = _branch)
    AND t.sent_at > now() - interval '30 days';
$function$;

-- 7. Refunds against the original receipt
CREATE OR REPLACE FUNCTION public.neo_cash_refund_settle(_refund uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $function$
DECLARE
  _org uuid := public.current_org_id(); _r public.cash_refund_requests;
  _s public.pos_shifts; _f public.folios; _pay uuid; _receipt text;
BEGIN
  SELECT * INTO _r FROM public.cash_refund_requests WHERE id=_refund AND organization_id=_org FOR UPDATE;
  IF _r.id IS NULL THEN RAISE EXCEPTION 'Refund not found'; END IF;
  IF _r.status = 'settled' THEN
    RETURN jsonb_build_object('status','settled','refund_id',_r.id,
      'refund_receipt_number',_r.refund_receipt_number,'payment_id',_r.refund_payment_id);
  END IF;
  IF _r.status <> 'approved' THEN RAISE EXCEPTION 'Refund is % and cannot be paid out', _r.status; END IF;

  SELECT * INTO _s FROM public.pos_shifts
   WHERE organization_id=_org AND cashier_id=auth.uid() AND status='open'
   ORDER BY opened_at DESC LIMIT 1 FOR UPDATE;
  IF _s.id IS NULL THEN RAISE EXCEPTION 'Open your till before paying out a cash refund'; END IF;

  _receipt := public.next_document_number('receipt');

  INSERT INTO public.payments (organization_id, branch_id, receipt_number, folio_id, amount, currency,
    method, external_reference, status, received_by, notes, shift_id, source_module, source_record_id,
    idempotency_key)
  VALUES (_org, _r.branch_id, _receipt, _r.folio_id, -1 * _r.amount, _r.currency, 'cash',
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

  IF _r.pos_payment_id IS NOT NULL THEN
    UPDATE public.pos_payments SET status='refunded', updated_at=now() WHERE id=_r.pos_payment_id;
  END IF;

  PERFORM public.cash_record_movement(_s.id, 'refund', _r.amount,
    'Cash refund of receipt ' || COALESCE(_r.original_receipt_number,'—') || ' — ' || _r.reason, _receipt);

  UPDATE public.cash_refund_requests
     SET status='settled', settled_by=auth.uid(), settled_at=now(), refund_payment_id=_pay,
         refund_receipt_number=_receipt, shift_id=_s.id, updated_at=now()
   WHERE id=_r.id;

  INSERT INTO public.audit_logs (organization_id, user_id, user_name, action, module, record_id, new_value, reason)
  VALUES (_org, auth.uid(), '', 'finance.cash.refund.settle', 'finance', _pay::text,
    jsonb_build_object('refund_id',_r.id,'amount',_r.amount,'shift_id',_s.id,
      'original_receipt',_r.original_receipt_number,'refund_receipt',_receipt), _r.reason);

  RETURN jsonb_build_object('status','settled','refund_id',_r.id,'payment_id',_pay,
    'refund_receipt_number',_receipt,'amount',_r.amount);
END; $function$;

CREATE OR REPLACE FUNCTION public.neo_cash_refund_request(
  _payment uuid, _amount numeric, _reason text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $function$
DECLARE
  _org uuid := public.current_org_id(); _p public.payments; _pp public.pos_payments;
  _threshold numeric; _needs boolean; _id uuid;
  _branch uuid; _folio uuid; _receipt text; _currency text; _amount_paid numeric;
BEGIN
  IF COALESCE(trim(_reason),'') = '' THEN RAISE EXCEPTION 'A refund reason is required'; END IF;
  IF _amount IS NULL OR _amount <= 0 THEN RAISE EXCEPTION 'Refund amount must be greater than zero'; END IF;
  IF NOT (public.has_permission('finance','till.confirm_cash') OR public.has_permission('pms','payments.record')
          OR public.has_permission('pos','payments.record') OR public.is_org_admin()) THEN
    RAISE EXCEPTION 'Not permitted to raise refunds' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO _p FROM public.payments WHERE id=_payment AND organization_id=_org;
  IF _p.id IS NOT NULL THEN
    _branch := _p.branch_id; _folio := _p.folio_id; _receipt := _p.receipt_number;
    _currency := COALESCE(_p.currency,'KES'); _amount_paid := _p.amount;
  ELSE
    SELECT * INTO _pp FROM public.pos_payments WHERE id=_payment AND organization_id=_org;
    IF _pp.id IS NULL THEN RAISE EXCEPTION 'Original payment not found'; END IF;
    _branch := _pp.branch_id; _receipt := _pp.receipt_number;
    _currency := COALESCE(_pp.currency,'KES'); _amount_paid := _pp.amount;
  END IF;

  IF _amount > COALESCE(_amount_paid,0) + 0.009 THEN
    RAISE EXCEPTION 'A refund cannot exceed the original receipt amount';
  END IF;

  SELECT approval_threshold INTO _threshold FROM public.cash_refund_policies
   WHERE organization_id=_org AND (branch_id = _branch OR branch_id IS NULL)
   ORDER BY (branch_id = _branch) DESC NULLS LAST LIMIT 1;
  _threshold := COALESCE(_threshold, 0);
  _needs := _amount > _threshold;

  INSERT INTO public.cash_refund_requests (organization_id, branch_id, payment_id, pos_payment_id, folio_id,
    original_receipt_number, amount, currency, reason, status, requires_approval, requested_by,
    approved_by, approved_at)
  VALUES (_org, _branch, _p.id, _pp.id, _folio, _receipt, _amount, _currency, _reason,
    CASE WHEN _needs THEN 'pending_approval' ELSE 'approved' END, _needs, auth.uid(),
    CASE WHEN _needs THEN NULL ELSE auth.uid() END,
    CASE WHEN _needs THEN NULL ELSE now() END)
  RETURNING id INTO _id;

  INSERT INTO public.audit_logs (organization_id, user_id, user_name, action, module, record_id, new_value, reason)
  VALUES (_org, auth.uid(), '', 'finance.cash.refund.request', 'finance', _id::text,
    jsonb_build_object('original_receipt',_receipt,'amount',_amount,'threshold',_threshold,
      'requires_approval',_needs), _reason);

  RETURN jsonb_build_object('status', CASE WHEN _needs THEN 'pending_approval' ELSE 'approved' END,
    'refund_id',_id,'threshold',_threshold,'amount',_amount,'original_receipt_number',_receipt);
END; $function$;

CREATE OR REPLACE FUNCTION public.neo_cash_refund_decide(_refund uuid, _approve boolean, _note text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $function$
DECLARE _org uuid := public.current_org_id(); _r public.cash_refund_requests;
BEGIN
  SELECT * INTO _r FROM public.cash_refund_requests WHERE id=_refund AND organization_id=_org FOR UPDATE;
  IF _r.id IS NULL THEN RAISE EXCEPTION 'Refund not found'; END IF;
  IF _r.status <> 'pending_approval' THEN
    RETURN jsonb_build_object('status',_r.status,'refund_id',_r.id,'idempotent',true);
  END IF;
  IF NOT (public.has_permission('finance','payment.approve') OR public.has_permission('finance','approve')
          OR public.has_permission('pos','refunds.approve') OR public.is_org_admin()) THEN
    RAISE EXCEPTION 'Not permitted to approve refunds' USING ERRCODE = '42501';
  END IF;
  IF _r.requested_by = auth.uid() AND NOT public.is_org_admin() THEN
    RAISE EXCEPTION 'You cannot approve your own refund request';
  END IF;

  UPDATE public.cash_refund_requests
     SET status = CASE WHEN _approve THEN 'approved' ELSE 'rejected' END,
         approved_by = auth.uid(), approved_at = now(), decision_note = _note, updated_at = now()
   WHERE id = _r.id;

  INSERT INTO public.audit_logs (organization_id, user_id, user_name, action, module, record_id, new_value, reason)
  VALUES (_org, auth.uid(), '', CASE WHEN _approve THEN 'finance.cash.refund.approve' ELSE 'finance.cash.refund.reject' END,
    'finance', _r.id::text, jsonb_build_object('amount',_r.amount,'original_receipt',_r.original_receipt_number), _note);

  RETURN jsonb_build_object('status', CASE WHEN _approve THEN 'approved' ELSE 'rejected' END,'refund_id',_r.id);
END; $function$;

CREATE OR REPLACE FUNCTION public.neo_cash_refunds(_branch uuid DEFAULT NULL)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $function$
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'id', r.id, 'amount', r.amount, 'currency', r.currency, 'reason', r.reason, 'status', r.status,
    'requires_approval', r.requires_approval, 'original_receipt_number', r.original_receipt_number,
    'payment_id', COALESCE(r.payment_id, r.pos_payment_id), 'folio_id', r.folio_id,
    'refund_receipt_number', r.refund_receipt_number, 'refund_payment_id', r.refund_payment_id,
    'requested_by_name', COALESCE(qp.full_name,'—'), 'approved_by_name', ap.full_name,
    'decision_note', r.decision_note, 'created_at', r.created_at, 'settled_at', r.settled_at,
    'mine', (r.requested_by = auth.uid())
  ) ORDER BY r.created_at DESC), '[]'::jsonb)
  FROM public.cash_refund_requests r
  LEFT JOIN public.profiles qp ON qp.id = r.requested_by
  LEFT JOIN public.profiles ap ON ap.id = r.approved_by
  WHERE r.organization_id = public.current_org_id()
    AND (_branch IS NULL OR r.branch_id IS NULL OR r.branch_id = _branch)
    AND r.created_at > now() - interval '90 days';
$function$;

-- 8. End-of-shift reconciliation with journal linkage
CREATE OR REPLACE FUNCTION public.neo_cash_shift_reconciliation(_shift uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public' AS $function$
DECLARE
  _org uuid := public.current_org_id(); _s public.pos_shifts;
  _receipts jsonb; _pos jsonb; _moves jsonb; _in jsonb; _out jsonb; _refunds jsonb; _expected numeric;
BEGIN
  SELECT * INTO _s FROM public.pos_shifts WHERE id=_shift AND organization_id=_org;
  IF _s.id IS NULL THEN RAISE EXCEPTION 'Shift not found'; END IF;
  _expected := public.cash_shift_expected(_shift);

  SELECT COALESCE(jsonb_agg(jsonb_build_object('payment_id',p.id,'receipt_number',p.receipt_number,
    'amount',p.amount,'method',p.method,'paid_at',COALESCE(p.paid_at,p.created_at),'folio_id',p.folio_id,
    'source_module',p.source_module,'journal_id',COALESCE(p.posted_journal_id, fr.journal_id),
    'journal_number',j.journal_number,'posting_status',fr.status) ORDER BY COALESCE(p.paid_at,p.created_at)), '[]'::jsonb)
    INTO _receipts
  FROM public.payments p
  LEFT JOIN public.finance_posting_receipts fr ON fr.source_id = p.id
  LEFT JOIN public.journal_entries j ON j.id = COALESCE(p.posted_journal_id, fr.journal_id)
  WHERE p.shift_id = _shift AND p.organization_id = _org AND p.method='cash' AND p.status='confirmed';

  SELECT COALESCE(jsonb_agg(jsonb_build_object('payment_id',p.id,'receipt_number',p.receipt_number,
    'amount',p.amount,'order_id',p.order_id,'paid_at',COALESCE(p.paid_at,p.created_at),
    'journal_id',fr.journal_id,'journal_number',j.journal_number,'posting_status',fr.status)
    ORDER BY COALESCE(p.paid_at,p.created_at)), '[]'::jsonb) INTO _pos
  FROM public.pos_payments p
  LEFT JOIN public.finance_posting_receipts fr ON fr.source_id = p.order_id
  LEFT JOIN public.journal_entries j ON j.id = fr.journal_id
  WHERE p.shift_id = _shift AND p.organization_id = _org AND p.method='cash' AND p.status='confirmed';

  SELECT COALESCE(jsonb_agg(jsonb_build_object('id',m.id,'type',m.movement_type,'amount',m.amount,
    'reason',m.reason,'reference',m.reference,'created_at',m.created_at) ORDER BY m.created_at), '[]'::jsonb)
    INTO _moves FROM public.cash_movements m WHERE m.shift_id=_shift AND m.organization_id=_org;

  SELECT COALESCE(jsonb_agg(jsonb_build_object('id',t.id,'transfer_number',t.transfer_number,
    'amount',t.amount,'status',t.status,'destination',t.to_destination,'sent_at',t.sent_at,
    'received_at',t.received_at) ORDER BY t.sent_at), '[]'::jsonb) INTO _out
  FROM public.cash_transfers t WHERE t.from_shift_id=_shift AND t.organization_id=_org;

  SELECT COALESCE(jsonb_agg(jsonb_build_object('id',t.id,'transfer_number',t.transfer_number,
    'amount',t.amount,'status',t.status,'sent_at',t.sent_at,'received_at',t.received_at)
    ORDER BY t.sent_at), '[]'::jsonb) INTO _in
  FROM public.cash_transfers t WHERE t.to_shift_id=_shift AND t.organization_id=_org;

  SELECT COALESCE(jsonb_agg(jsonb_build_object('id',r.id,'amount',r.amount,
    'original_receipt_number',r.original_receipt_number,'refund_receipt_number',r.refund_receipt_number,
    'reason',r.reason,'settled_at',r.settled_at) ORDER BY r.settled_at), '[]'::jsonb) INTO _refunds
  FROM public.cash_refund_requests r WHERE r.shift_id=_shift AND r.organization_id=_org AND r.status='settled';

  RETURN jsonb_build_object(
    'shift_id',_s.id,'shift_number',_s.shift_number,'status',_s.status,'branch_id',_s.branch_id,
    'cashier_id',_s.cashier_id,'opened_at',_s.opened_at,'closed_at',_s.closed_at,
    'opening_float',COALESCE(_s.opening_float,0),'total_drops',COALESCE(_s.total_drops,0),
    'total_paid_outs',COALESCE(_s.total_paid_outs,0),'expected_cash',_expected,
    'counted_cash',_s.counted_cash,'variance',_s.variance,'variance_reason',_s.variance_reason,
    'folio_receipts',_receipts,'pos_receipts',_pos,'movements',_moves,
    'transfers_out',_out,'transfers_in',_in,'refunds',_refunds,
    'shift_journal_id',_s.posted_journal_id);
END; $function$;

-- 9. One trace from payment to journal and audit
CREATE OR REPLACE FUNCTION public.neo_cash_payment_trace(_payment uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public' AS $function$
DECLARE
  _org uuid := public.current_org_id(); _p public.payments; _pp public.pos_payments;
  _req public.cash_payment_requests; _s public.pos_shifts; _fr public.finance_posting_receipts;
  _j public.journal_entries; _audit jsonb; _lines jsonb; _shift_id uuid; _source uuid; _amount numeric;
  _receipt text;
BEGIN
  SELECT * INTO _p FROM public.payments WHERE id=_payment AND organization_id=_org;
  IF _p.id IS NOT NULL THEN
    _shift_id := _p.shift_id; _source := _p.id; _amount := _p.amount; _receipt := _p.receipt_number;
  ELSE
    SELECT * INTO _pp FROM public.pos_payments WHERE id=_payment AND organization_id=_org;
    IF _pp.id IS NULL THEN RAISE EXCEPTION 'Payment not found'; END IF;
    _shift_id := _pp.shift_id; _source := COALESCE(_pp.order_id,_pp.id); _amount := _pp.amount;
    _receipt := _pp.receipt_number;
  END IF;

  SELECT * INTO _req FROM public.cash_payment_requests
   WHERE organization_id=_org AND payment_id=_payment;
  SELECT * INTO _s FROM public.pos_shifts WHERE id=_shift_id AND organization_id=_org;
  SELECT * INTO _fr FROM public.finance_posting_receipts
   WHERE organization_id=_org AND source_id=_source ORDER BY created_at DESC LIMIT 1;
  SELECT * INTO _j FROM public.journal_entries
   WHERE organization_id=_org AND id = COALESCE(_p.posted_journal_id, _fr.journal_id);

  SELECT COALESCE(jsonb_agg(jsonb_build_object('account_code',a.code,'account_name',a.name,
    'debit',l.debit,'credit',l.credit) ORDER BY l.created_at), '[]'::jsonb) INTO _lines
  FROM public.journal_entry_lines l
  LEFT JOIN public.chart_of_accounts a ON a.id = l.account_id
  WHERE l.journal_id = _j.id;

  SELECT COALESCE(jsonb_agg(jsonb_build_object('id',al.id,'action',al.action,'created_at',al.created_at,
    'user_name',COALESCE(NULLIF(al.user_name,''), pr.full_name),'reason',al.reason,'new_value',al.new_value)
    ORDER BY al.created_at), '[]'::jsonb) INTO _audit
  FROM public.audit_logs al
  LEFT JOIN public.profiles pr ON pr.id = al.user_id
  WHERE al.organization_id = _org
    AND al.record_id IN (_payment::text, COALESCE(_req.id::text,'-'), COALESCE(_j.id::text,'-'),
                         COALESCE(_source::text,'-'));

  RETURN jsonb_build_object(
    'payment', jsonb_build_object('id',_payment,'receipt_number',_receipt,'amount',_amount,
      'method',COALESCE(_p.method,_pp.method),'status',COALESCE(_p.status,_pp.status),
      'paid_at',COALESCE(_p.paid_at,_pp.paid_at,_p.created_at,_pp.created_at),
      'folio_id',_p.folio_id,'order_id',_pp.order_id,'currency',COALESCE(_p.currency,_pp.currency)),
    'request', CASE WHEN _req.id IS NULL THEN NULL ELSE jsonb_build_object('id',_req.id,
      'status',_req.status,'requested_by',_req.requested_by,'assigned_cashier_id',_req.assigned_cashier_id,
      'confirmed_at',_req.confirmed_at,'source_module',_req.source_module) END,
    'till', CASE WHEN _s.id IS NULL THEN NULL ELSE jsonb_build_object('shift_id',_s.id,
      'shift_number',_s.shift_number,'cashier_id',_s.cashier_id,'status',_s.status,
      'opened_at',_s.opened_at,'closed_at',_s.closed_at,'variance',_s.variance) END,
    'posting', CASE WHEN _fr.id IS NULL THEN NULL ELSE jsonb_build_object('id',_fr.id,
      'status',_fr.status,'posting_type',_fr.posting_type,'attempts',_fr.attempts,
      'last_error',_fr.last_error,'posted_at',_fr.posted_at) END,
    'journal', CASE WHEN _j.id IS NULL THEN NULL ELSE jsonb_build_object('id',_j.id,
      'journal_number',_j.journal_number,'status',_j.status,'accounting_date',_j.accounting_date,
      'total_debit',_j.total_debit,'total_credit',_j.total_credit,'lines',_lines) END,
    'audit', _audit);
END; $function$;

REVOKE ALL ON FUNCTION public.neo_cash_transfer_send(numeric,uuid,text,text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.neo_cash_transfer_confirm(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.neo_cash_transfer_cancel(uuid,text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.neo_cash_transfers(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.neo_cash_refund_request(uuid,numeric,text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.neo_cash_refund_decide(uuid,boolean,text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.neo_cash_refund_settle(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.neo_cash_refunds(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.neo_cash_shift_reconciliation(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.neo_cash_payment_trace(uuid) FROM PUBLIC, anon;

GRANT EXECUTE ON FUNCTION public.neo_cash_transfer_send(numeric,uuid,text,text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.neo_cash_transfer_confirm(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.neo_cash_transfer_cancel(uuid,text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.neo_cash_transfers(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.neo_cash_refund_request(uuid,numeric,text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.neo_cash_refund_decide(uuid,boolean,text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.neo_cash_refund_settle(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.neo_cash_refunds(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.neo_cash_shift_reconciliation(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.neo_cash_payment_trace(uuid) TO authenticated;