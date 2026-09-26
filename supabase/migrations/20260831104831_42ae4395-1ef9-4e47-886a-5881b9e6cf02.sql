-- 1. Recognition is atomic: journal + posting receipt + canonical state + outbox events.
CREATE OR REPLACE FUNCTION public.neo_grn_post_accrual(_receipt uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_org uuid;
  r record; pol public.procurement_matching_policies;
  v_value numeric := 0; v_currency text; v_res jsonb; v_journal uuid; v_receipt uuid;
BEGIN
  SELECT * INTO r FROM public.goods_receipts WHERE id = _receipt;
  IF r IS NULL THEN RAISE EXCEPTION 'Receipt not found'; END IF;
  v_org := r.organization_id;
  pol := public.neo_matching_policy(v_org, r.branch_id);

  PERFORM pg_advisory_xact_lock(hashtextextended('grn:' || _receipt::text, 0));

  SELECT COALESCE(sum(
    COALESCE(l.quantity_accepted,
      GREATEST(COALESCE(l.quantity_received,0) - COALESCE(l.quantity_rejected,0)
               - COALESCE(l.quantity_damaged,0) - COALESCE(l.quantity_returned,0), 0))
    * COALESCE(l.unit_price,0)), 0)
    INTO v_value
    FROM public.goods_receipt_lines l WHERE l.receipt_id = _receipt;

  IF round(COALESCE(v_value,0),2) <= 0 THEN
    RETURN jsonb_build_object('ok', true, 'skipped', 'zero_value');
  END IF;

  SELECT COALESCE(po.currency,'KES') INTO v_currency FROM public.purchase_orders po WHERE po.id = r.order_id;
  v_currency := COALESCE(v_currency, 'KES');

  PERFORM public.neo_finance_ensure_account(v_org, pol.inventory_account_code, 'Inventory', 'asset', 'Inventory');
  PERFORM public.neo_finance_ensure_account(v_org, pol.grni_account_code, 'Goods Received Not Invoiced', 'liability', 'Payables');

  v_res := public.neo_gl_post(
    v_org, r.branch_id, 'procurement', 'goods_receipt', _receipt, 'accrual',
    COALESCE(r.received_at::date, CURRENT_DATE), v_currency,
    'Goods received ' || COALESCE(r.grn_number, _receipt::text),
    jsonb_build_array(
      jsonb_build_object('code', pol.inventory_account_code, 'debit', round(v_value,2), 'description','Stock received'),
      jsonb_build_object('code', pol.grni_account_code, 'credit', round(v_value,2), 'description','Goods received not invoiced')
    ));

  v_journal := (v_res->>'journal_id')::uuid;

  UPDATE public.goods_receipts
     SET accrual_journal_id = v_journal,
         accrued_value = round(v_value,2),
         accrual_error = NULL
   WHERE id = _receipt;

  -- Immutable posting receipt: "posted" is only true when a balanced journal exists.
  v_receipt := public.neo_record_posting_receipt(
    v_org, r.branch_id, 'inventory', _receipt, COALESCE(r.grn_number, _receipt::text),
    'posted', round(v_value,2), v_currency, NULL,
    'Stock recognised against goods received not invoiced', NULL,
    COALESCE(r.received_at::date, CURRENT_DATE));

  UPDATE public.finance_posting_receipts
     SET journal_id = v_journal, posting_type = 'accrual'
   WHERE id = v_receipt;

  -- Durable handoff: the consequences of an accepted receipt are events on the
  -- outbox, keyed so a retry re-uses the same event instead of posting twice.
  PERFORM public.emit_domain_event(v_org, r.branch_id, 'grn.accepted', 'procurement', _receipt,
    jsonb_build_object('reference', r.grn_number, 'value', round(v_value,2), 'currency', v_currency),
    'grn:' || _receipt::text || ':accepted');
  PERFORM public.emit_domain_event(v_org, r.branch_id, 'inventory.recognised', 'procurement', _receipt,
    jsonb_build_object('reference', r.grn_number, 'value', round(v_value,2), 'currency', v_currency),
    'grn:' || _receipt::text || ':inventory_recognised');
  PERFORM public.emit_domain_event(v_org, r.branch_id, 'finance.posted', 'procurement', _receipt,
    jsonb_build_object('reference', r.grn_number, 'journal_id', v_journal, 'receipt_id', v_receipt,
                       'value', round(v_value,2), 'currency', v_currency),
    'grn:' || _receipt::text || ':finance_posted');

  PERFORM public.neo_canonical_transaction_set(
    _org := v_org, _branch := r.branch_id, _module := 'procurement', _source := _receipt,
    _reference := r.grn_number, _operational := 'posted', _financial := 'posted',
    _amount := round(v_value,2), _currency := v_currency,
    _idempotency := 'grn:' || _receipt::text, _actor := auth.uid(),
    _owner := 'Finance', _next_action := 'Match against the supplier invoice', _blocker := NULL,
    _journal := v_journal, _receipt := v_receipt,
    _downstream := jsonb_build_object('grn.accepted','emitted','inventory.recognised','emitted','finance.posted','emitted'),
    _metadata := jsonb_build_object('entity_kind', 'grn'));

  RETURN v_res || jsonb_build_object('receipt_id', v_receipt);
END $function$;

-- 2. A receipt marked Posted in Stores is an accepted receipt for Finance purposes.
CREATE OR REPLACE FUNCTION public.neo_finance_post_family(_module text, _source uuid, _silent boolean DEFAULT false)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  org uuid := public.current_org_id();
  res jsonb; branch uuid; amount numeric := 0; ref text; occurred date; cur text;
  journal uuid; okd boolean; msg text;
BEGIN
  IF _module = 'deposit' THEN
    RETURN public.neo_deposit_post(_source, _silent);
  ELSIF _module = 'payment' THEN
    RETURN public.neo_payment_post(_source, _silent);
  ELSIF _module NOT IN ('inventory', 'supplier_invoice', 'supplier_payment') THEN
    RETURN public.neo_finance_post_source(_module, _source, _silent);
  END IF;

  IF org IS NULL THEN RETURN jsonb_build_object('ok', false, 'reason', 'no_organisation'); END IF;
  IF NOT (public.is_org_admin() OR public.has_permission('finance','edit')
          OR public.has_permission('finance','approve')) AND NOT _silent THEN
    RAISE EXCEPTION 'insufficient_privilege' USING ERRCODE = '42501';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(_module || ':' || _source::text, 0));

  IF EXISTS (SELECT 1 FROM public.finance_posting_receipts
              WHERE organization_id = org AND idempotency_key = _module || ':' || _source::text
                AND status = 'posted') THEN
    RETURN jsonb_build_object('ok', true, 'reason', 'already_posted', 'module', _module, 'source_id', _source);
  END IF;

  IF _module = 'inventory' THEN
    SELECT g.branch_id, coalesce(g.total_value,0), coalesce(g.grn_number, g.id::text),
           coalesce(g.delivery_date, (g.received_at)::date, (g.created_at)::date)
      INTO branch, amount, ref, occurred
      FROM public.goods_receipts g WHERE g.id = _source AND g.organization_id = org;
    IF ref IS NULL THEN RETURN jsonb_build_object('ok', false, 'reason', 'not_found'); END IF;

    IF EXISTS (SELECT 1 FROM public.goods_receipts g WHERE g.id = _source AND g.reversed_at IS NOT NULL) THEN
      res := jsonb_build_object('ok', false, 'reason', 'reversed',
             'detail', 'This receipt was reversed — no further posting is required.');
    ELSIF NOT EXISTS (SELECT 1 FROM public.goods_receipts g WHERE g.id = _source
                       AND g.status IN ('received','accepted','completed','closed','posted')) THEN
      res := jsonb_build_object('ok', false, 'reason', 'not_accepted',
             'detail', 'Complete and accept the receipt in Stores before it can be recognised.');
    ELSE
      res := public.neo_grn_post_accrual(_source);
    END IF;

  ELSIF _module = 'supplier_invoice' THEN
    SELECT v.branch_id, coalesce(v.amount,0), coalesce(v.invoice_number, v.id::text),
           coalesce(v.invoice_date, (v.created_at)::date)
      INTO branch, amount, ref, occurred
      FROM public.supplier_invoices v WHERE v.id = _source AND v.organization_id = org;
    IF ref IS NULL THEN RETURN jsonb_build_object('ok', false, 'reason', 'not_found'); END IF;
    res := public.neo_supplier_invoice_accept(_source, NULL);

  ELSE
    SELECT sp.branch_id, coalesce(sp.amount,0), coalesce(sp.payment_number, sp.id::text),
           coalesce(sp.paid_on, (sp.created_at)::date)
      INTO branch, amount, ref, occurred
      FROM public.supplier_payments sp WHERE sp.id = _source AND sp.organization_id = org;
    IF ref IS NULL THEN RETURN jsonb_build_object('ok', false, 'reason', 'not_found'); END IF;
    res := public.neo_supplier_payment_advance(_source, 'settle', NULL);
  END IF;

  okd := coalesce((res->>'ok')::boolean, res ? 'journal_id');
  journal := nullif(res->>'journal_id','')::uuid;
  msg := coalesce(res->>'detail', res->>'reason');
  cur := public.neo_fact_currency(org, branch);

  PERFORM public.neo_record_posting_receipt(
    org, branch, _module, _source, ref,
    CASE WHEN okd THEN 'posted' ELSE 'blocked' END,
    amount, cur, NULL, msg, CASE WHEN okd THEN NULL ELSE msg END, occurred);

  IF okd AND journal IS NOT NULL THEN
    UPDATE public.finance_posting_receipts
       SET journal_id = coalesce(journal_id, journal)
     WHERE organization_id = org AND idempotency_key = _module || ':' || _source::text;
  END IF;

  RETURN res;
END $function$;

-- 3. Backfill receipts already recognised before this repair.
DO $backfill$
DECLARE g record;
BEGIN
  FOR g IN SELECT id FROM public.goods_receipts
            WHERE reversed_at IS NULL
              AND status IN ('received','accepted','completed','closed','posted')
  LOOP
    BEGIN
      PERFORM public.neo_grn_post_accrual(g.id);
    EXCEPTION WHEN OTHERS THEN
      UPDATE public.goods_receipts SET accrual_error = SQLERRM WHERE id = g.id;
    END;
  END LOOP;
END $backfill$;