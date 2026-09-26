CREATE OR REPLACE FUNCTION public.pos_record_payment_attempt(
  _order_id uuid, _amount numeric, _method text, _tendered numeric DEFAULT NULL::numeric,
  _reference text DEFAULT NULL::text, _shift_id uuid DEFAULT NULL::uuid,
  _idempotency_key text DEFAULT NULL::text, _manual_confirm boolean DEFAULT false,
  _note text DEFAULT NULL::text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  _org uuid := public.current_org_id();
  _o public.pos_orders;
  _existing public.pos_payments;
  _confirmed numeric := 0;
  _active numeric := 0;
  _balance numeric;
  _headroom numeric;
  _status text;
  _provider boolean;
  _needs_reference boolean;
  _change numeric := 0;
  _payment uuid;
  _shift public.pos_shifts;
  _receipt text;
  _settle jsonb;
  _finance jsonb := jsonb_build_object('ok', true, 'reason', 'not_due');
  _key text := coalesce(nullif(_idempotency_key,''), 'pos-pay:' || _order_id::text || ':' || gen_random_uuid()::text);
BEGIN
  IF NOT public.has_permission('pos','payments','process') THEN
    RAISE EXCEPTION 'Not permitted to take payments';
  END IF;

  SELECT * INTO _existing FROM public.pos_payments
   WHERE organization_id = _org AND idempotency_key = _key;
  IF _existing.id IS NOT NULL THEN
    RETURN jsonb_build_object('payment_id', _existing.id, 'status', _existing.status, 'duplicate', true,
                              'receipt_number', _existing.receipt_number)
        || public.pos_reconcile_settlement_internal(_existing.order_id);
  END IF;

  SELECT * INTO _o FROM public.pos_orders WHERE id = _order_id AND organization_id = _org FOR UPDATE;
  IF _o.id IS NULL THEN RAISE EXCEPTION 'Order not found'; END IF;
  IF NOT public.neo_branch_in_scope(_o.branch_id) THEN
    RAISE EXCEPTION 'That bill belongs to a property outside your access';
  END IF;
  IF _o.status IN ('closed','cancelled','voided','charged-to-room') THEN
    RAISE EXCEPTION 'Bill is % and cannot take further payment', _o.status;
  END IF;

  -- Till first: a cash tender is refused before anything is written unless a
  -- drawer that can actually hold the money is open.
  IF _method = 'cash' THEN
    _shift_id := coalesce(_shift_id, public.pos_resolve_open_shift(_o.branch_id));
    IF _shift_id IS NULL THEN
      RAISE EXCEPTION 'No cash drawer is open for this property. Open your till before taking cash.';
    END IF;
    SELECT * INTO _shift FROM public.pos_shifts WHERE id = _shift_id AND organization_id = _org FOR UPDATE;
    IF _shift.id IS NULL THEN RAISE EXCEPTION 'Cash drawer not found for this property'; END IF;
    IF _shift.status <> 'open' THEN
      RAISE EXCEPTION 'That cash drawer is % and cannot take cash. Open a till first.', _shift.status;
    END IF;
  END IF;

  SELECT coalesce(sum(amount) FILTER (WHERE status = 'confirmed'), 0),
         coalesce(sum(amount) FILTER (WHERE status IN ('initiated','pending')), 0)
    INTO _confirmed, _active
    FROM public.pos_payments WHERE order_id = _order_id;

  _balance := round(coalesce(_o.grand_total,0) - _confirmed, 2);
  _headroom := round(_balance - _active, 2);

  IF coalesce(_amount,0) <= 0 THEN RAISE EXCEPTION 'Payment amount must be greater than zero'; END IF;
  IF _amount > _headroom + 0.005 THEN
    RAISE EXCEPTION 'Payment of % exceeds the settleable balance of % (outstanding %, awaiting provider %)',
      _amount, greatest(_headroom,0), greatest(_balance,0), _active;
  END IF;

  _provider := _method IN ('mpesa','card-terminal','qr');
  _needs_reference := _method <> 'cash' AND _method <> 'complimentary';

  IF _needs_reference AND coalesce(btrim(coalesce(_reference,'')),'') = '' THEN
    RAISE EXCEPTION 'A reference is required for a % payment', _method;
  END IF;

  IF _manual_confirm THEN
    IF NOT public.has_permission('pos','payments','manual-confirm') THEN
      RAISE EXCEPTION 'Not permitted to confirm payments manually';
    END IF;
    IF NOT _provider THEN
      RAISE EXCEPTION 'Manual confirmation applies to provider-backed payments only';
    END IF;
    IF coalesce(btrim(coalesce(_note,'')),'') = '' THEN
      RAISE EXCEPTION 'A verification note is required for a manually confirmed payment';
    END IF;
    _status := 'confirmed';
  ELSE
    _status := CASE WHEN _provider THEN 'pending' ELSE 'confirmed' END;
  END IF;

  IF _method = 'cash' AND _tendered IS NOT NULL THEN
    _change := greatest(0, _tendered - _amount);
  END IF;

  -- Money taken always carries a receipt; both are written in this one
  -- transaction, so a receipt can never be missing from a settled payment.
  IF _status = 'confirmed' THEN
    _receipt := public.next_document_number('receipt');
  END IF;

  INSERT INTO public.pos_payments (
    organization_id, branch_id, order_id, amount, tendered, change_due, currency, method,
    external_reference, receipt_number, status, provider_status, paid_at, cashier_id, shift_id, customer_id,
    created_by, verified_by, verification_note, idempotency_key
  ) VALUES (
    _org, _o.branch_id, _order_id, round(_amount,2), _tendered, _change, _o.currency, _method,
    nullif(btrim(coalesce(_reference,'')),''), _receipt, _status,
    CASE WHEN _manual_confirm THEN 'manual-confirmed'
         WHEN _provider THEN 'awaiting-provider'
         WHEN _method = 'cash' THEN NULL
         ELSE 'recorded-unverified' END,
    CASE WHEN _status = 'confirmed' THEN now() ELSE NULL END,
    auth.uid(), _shift_id, _o.customer_id, auth.uid(),
    CASE WHEN _manual_confirm THEN auth.uid() ELSE NULL END,
    nullif(btrim(coalesce(_note,'')),''), _key
  ) RETURNING id INTO _payment;

  INSERT INTO public.audit_logs (organization_id, branch_id, user_id, action, module, record_id, new_value)
  VALUES (_org, _o.branch_id, auth.uid(), 'pos.payment.record', 'pos', _order_id,
          jsonb_build_object('paymentId', _payment, 'amount', round(_amount,2), 'method', _method,
                             'status', _status, 'manualConfirm', _manual_confirm,
                             'providerBacked', _provider, 'receiptNumber', _receipt,
                             'shiftId', _shift_id,
                             'reference', nullif(btrim(coalesce(_reference,'')),'')));

  _settle := public.pos_reconcile_settlement_internal(_order_id);

  -- Recognise the sale in the accounts in the same transaction once the bill is
  -- fully settled. A posting refusal is reported, never silently swallowed, and
  -- never leaves a half-written payment behind.
  IF coalesce((_settle->>'payment_status'), '') = 'paid' THEN
    _finance := public.neo_finance_post_source('pos', _order_id, true);
  END IF;

  RETURN jsonb_build_object('payment_id', _payment, 'status', _status, 'duplicate', false,
                            'provider_backed', _provider, 'receipt_number', _receipt,
                            'shift_id', _shift_id, 'finance', _finance)
      || _settle;
END
$fn$;

REVOKE ALL ON FUNCTION public.pos_record_payment_attempt(uuid,numeric,text,numeric,text,uuid,text,boolean,text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.pos_record_payment_attempt(uuid,numeric,text,numeric,text,uuid,text,boolean,text) TO authenticated, service_role;