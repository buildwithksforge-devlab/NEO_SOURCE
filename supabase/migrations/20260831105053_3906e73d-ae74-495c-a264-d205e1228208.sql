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

  v_receipt := public.neo_record_posting_receipt(
    v_org, r.branch_id, 'inventory', _receipt, COALESCE(r.grn_number, _receipt::text),
    'posted', round(v_value,2), v_currency, NULL,
    'Stock recognised against goods received not invoiced', NULL,
    COALESCE(r.received_at::date, CURRENT_DATE));

  UPDATE public.finance_posting_receipts
     SET journal_id = v_journal, posting_type = 'accrual'
   WHERE id = v_receipt;

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
    _org := v_org, _branch := r.branch_id, _module := 'inventory', _source := _receipt,
    _reference := r.grn_number, _operational := 'posted', _financial := 'posted',
    _amount := round(v_value,2), _currency := v_currency,
    _idempotency := 'inventory:' || _receipt::text, _actor := auth.uid(),
    _owner := 'Finance', _next_action := 'Match against the supplier invoice', _blocker := NULL,
    _journal := v_journal, _receipt := v_receipt,
    _downstream := jsonb_build_object('grn.accepted','emitted','inventory.recognised','emitted','finance.posted','emitted'),
    _metadata := jsonb_build_object('entity_kind', 'grn'));

  -- A superseded twin keeps its history but stops competing as a read model.
  UPDATE public.canonical_transaction_states
     SET operational_state = 'superseded', financial_state = 'not-applicable',
         next_action = NULL, current_owner = NULL,
         metadata = coalesce(metadata,'{}'::jsonb)
           || jsonb_build_object('superseded_by', 'inventory:' || _receipt::text)
   WHERE organization_id = v_org AND source_id = _receipt
     AND idempotency_key = 'grn:' || _receipt::text
     AND operational_state <> 'superseded';

  RETURN v_res || jsonb_build_object('receipt_id', v_receipt);
END $function$;

UPDATE public.canonical_transaction_states c
   SET operational_state = 'superseded', financial_state = 'not-applicable',
       next_action = NULL, current_owner = NULL,
       metadata = coalesce(c.metadata,'{}'::jsonb)
         || jsonb_build_object('superseded_by', 'inventory:' || c.source_id::text)
 WHERE c.idempotency_key LIKE 'grn:%'
   AND EXISTS (SELECT 1 FROM public.canonical_transaction_states o
                WHERE o.organization_id = c.organization_id
                  AND o.source_id = c.source_id
                  AND o.idempotency_key = 'inventory:' || c.source_id::text);

UPDATE public.goods_receipts SET accrual_error = NULL
 WHERE accrual_error LIKE '%canonical_transaction_state_history%';