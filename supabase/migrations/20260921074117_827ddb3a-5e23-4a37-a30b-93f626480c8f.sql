CREATE OR REPLACE FUNCTION public.neo_cash_refund_request(_payment uuid, _amount numeric, _reason text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  _org uuid := public.current_org_id(); _p public.payments; _pp public.pos_payments;
  _threshold numeric; _needs boolean; _id uuid;
  _branch uuid; _folio uuid; _receipt text; _currency text; _amount_paid numeric;
  _already numeric := 0;
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

  -- Refunds are cumulative: everything already raised, approved or paid out against
  -- the same receipt counts against what is still refundable.
  SELECT COALESCE(sum(amount),0) INTO _already
    FROM public.cash_refund_requests
   WHERE organization_id = _org
     AND status IN ('pending_approval','approved','settled')
     AND ((_p.id IS NOT NULL AND payment_id = _p.id)
       OR (_p.id IS NULL AND pos_payment_id = _pp.id));

  IF _already + _amount > COALESCE(_amount_paid,0) + 0.009 THEN
    RAISE EXCEPTION 'Refunds already raised against this receipt total %. Only % of the original % can still be refunded.',
      round(_already,2), round(GREATEST(COALESCE(_amount_paid,0) - _already, 0),2), round(COALESCE(_amount_paid,0),2);
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
      'already_refunded',_already,
      'requires_approval',_needs), _reason);

  RETURN jsonb_build_object('status', CASE WHEN _needs THEN 'pending_approval' ELSE 'approved' END,
    'refund_id',_id,'threshold',_threshold,'amount',_amount,'original_receipt_number',_receipt);
END; $function$;

CREATE OR REPLACE FUNCTION public.neo_finance_post_refund(_source_type text, _source_id uuid, _silent boolean DEFAULT false)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  org uuid := public.current_org_id();
  branch uuid; cur text; ref text; occurred date; amount numeric := 0;
  customer uuid; settle text; revenue text; lines jsonb; res jsonb;
  dest uuid;
BEGIN
  IF org IS NULL THEN RETURN jsonb_build_object('ok', false, 'reason', 'no_organisation'); END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(_source_type || ':' || _source_id::text, 0));

  IF _source_type = 'pos_refund' THEN
    SELECT r.amount, r.branch_id, o.order_number, o.order_type, o.customer_id,
           coalesce(r.method, p.method), coalesce(r.decided_at, r.created_at)::date, p.destination_account_id
      INTO amount, branch, ref, revenue, customer, settle, occurred, dest
      FROM public.pos_refund_requests r
      JOIN public.pos_orders o ON o.id = r.order_id
      LEFT JOIN public.pos_payments p ON p.id = r.payment_id
     WHERE r.id = _source_id AND r.organization_id = org;
    IF amount IS NULL THEN RETURN jsonb_build_object('ok', false, 'reason', 'not_found'); END IF;
    revenue := public.neo_gl_revenue_code(revenue);
  ELSIF _source_type = 'folio_refund' THEN
    SELECT r.amount, r.branch_id, coalesce(p.receipt_number, 'Refund'), p.customer_id,
           p.method, coalesce(r.processed_at, r.created_at)::date, p.destination_account_id
      INTO amount, branch, ref, customer, settle, occurred, dest
      FROM public.refunds r
      LEFT JOIN public.payments p ON p.id = r.payment_id
     WHERE r.id = _source_id AND r.organization_id = org;
    IF amount IS NULL THEN RETURN jsonb_build_object('ok', false, 'reason', 'not_found'); END IF;
    revenue := '1060';
  ELSE
    RETURN jsonb_build_object('ok', false, 'reason', 'unknown_source_type');
  END IF;

  IF coalesce(amount,0) <= 0 THEN RETURN jsonb_build_object('ok', false, 'reason', 'zero_amount'); END IF;

  -- Money goes back out of the same account it came into, when one was recorded.
  settle := coalesce(public.neo_gl_account_code(org, settle, dest), '1010');
  cur := public.neo_fact_currency(org, branch);
  occurred := coalesce(occurred, (now() AT TIME ZONE public.neo_fact_timezone(org, branch))::date);

  lines := jsonb_build_array(
    jsonb_build_object('code', revenue, 'debit', amount, 'description', 'Refund ' || coalesce(ref,'')),
    jsonb_build_object('code', settle, 'credit', amount, 'description', 'Cash / settlement returned'));

  res := public.neo_gl_post(org, branch, 'refund', _source_type, _source_id, 'refund',
                            occurred, cur, 'Refund ' || coalesce(ref,''), lines, customer, NULL);

  PERFORM public.neo_record_posting_receipt(org, branch, _source_type, _source_id, ref,
    'posted', amount, cur, NULL, 'Posted to journal ' || (res->>'journal_id'), NULL, occurred);

  PERFORM public.emit_domain_event(org, branch, 'finance.posted', _source_type, _source_id,
    jsonb_build_object('posting_type', 'refund', 'amount', amount, 'currency', cur,
                       'journal_id', res->>'journal_id', 'occurred_on', occurred),
    'finance.posted:' || _source_type || ':' || _source_id::text, customer);

  RETURN res || jsonb_build_object('ok', true, 'amount', amount, 'posting_type', 'refund');
EXCEPTION WHEN OTHERS THEN
  IF _silent THEN RETURN jsonb_build_object('ok', false, 'reason', 'failed', 'detail', SQLERRM); END IF;
  RAISE;
END $function$;

REVOKE ALL ON FUNCTION public.neo_cash_refund_request(uuid, numeric, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.neo_cash_refund_request(uuid, numeric, text) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.neo_finance_post_refund(text, uuid, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.neo_finance_post_refund(text, uuid, boolean) TO authenticated, service_role;