CREATE OR REPLACE FUNCTION public.neo_supplier_invoice_accept(_invoice uuid, _reason text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_org uuid := current_org_id();
  inv record; pol public.procurement_matching_policies; l record;
  v_net numeric; v_tax numeric; v_lines jsonb := '[]'::jsonb; v_res jsonb; v_debit_code text; _cur text;
BEGIN
  IF NOT (has_permission('finance','approve') OR is_org_admin()) THEN
    RAISE EXCEPTION 'Not permitted to accept supplier invoices';
  END IF;
  SELECT * INTO inv FROM supplier_invoices WHERE id = _invoice AND organization_id = v_org FOR UPDATE;
  IF inv IS NULL THEN RAISE EXCEPTION 'Invoice not found'; END IF;
    IF auth.uid() IS NULL OR public.neo_branch_in_scope(inv.branch_id) IS NOT TRUE THEN RAISE EXCEPTION 'Invoice outside authorized property scope' USING ERRCODE='42501'; END IF;
    IF inv.amount IS NULL OR inv.amount<=0 OR inv.amount::text IN ('NaN','Infinity','-Infinity') OR inv.tax_amount IS NULL OR inv.tax_amount<0 OR inv.tax_amount>inv.amount OR inv.tax_amount::text IN ('NaN','Infinity','-Infinity') THEN RAISE EXCEPTION 'Invoice amount or tax is incomplete or non-finite'; END IF;
    IF inv.journal_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.journal_entries j WHERE j.id=inv.journal_id AND j.organization_id=v_org AND j.branch_id IS NOT DISTINCT FROM inv.branch_id AND j.status='posted') THEN RAISE EXCEPTION 'Saved invoice journal is not confirmed posted; review before retrying'; END IF;
  IF inv.journal_id IS NOT NULL THEN
    RETURN jsonb_build_object('ok', true, 'already_posted', true, 'journal_id', inv.journal_id);
  END IF;
  IF inv.journal_id IS NULL THEN
    PERFORM public.proc_three_way_match(_invoice);
    SELECT * INTO inv FROM supplier_invoices WHERE id = _invoice;
  END IF;
  IF inv.match_status = 'held' AND COALESCE(btrim(_reason),'') = '' THEN
    RAISE EXCEPTION 'This invoice is on hold. A written override reason is required.';
  END IF;

  pol := public.neo_matching_policy(v_org, inv.branch_id);
  v_tax := round(COALESCE(inv.tax_amount,0), 2);
  v_net := round(COALESCE(inv.amount,0) - v_tax, 2);
  IF v_net + v_tax <= 0 THEN RAISE EXCEPTION 'Invoice has no value to post'; END IF;

  v_debit_code := CASE WHEN inv.order_id IS NULL THEN pol.expense_account_code ELSE pol.grni_account_code END;
  PERFORM public.neo_finance_ensure_account(v_org, v_debit_code,
    CASE WHEN inv.order_id IS NULL THEN 'Other Operating Expenses' ELSE 'Goods Received Not Invoiced' END,
    CASE WHEN inv.order_id IS NULL THEN 'operating_expense' ELSE 'liability' END,
    CASE WHEN inv.order_id IS NULL THEN 'Operating Expenses' ELSE 'Payables' END);
  PERFORM public.neo_finance_ensure_account(v_org, pol.payable_account_code, 'Accounts Payable', 'liability', 'Payables');

  v_lines := v_lines || jsonb_build_object('code', v_debit_code, 'debit', v_net,
    'description', CASE WHEN inv.order_id IS NULL THEN 'Non-order supplier invoice' ELSE 'Clear goods received not invoiced' END);
  IF v_tax > 0 THEN
    PERFORM public.neo_finance_ensure_account(v_org, pol.tax_input_account_code, 'VAT Input (Recoverable)', 'asset', 'Tax');
    v_lines := v_lines || jsonb_build_object('code', pol.tax_input_account_code, 'debit', v_tax, 'description', 'Recoverable input tax');
  END IF;
  v_lines := v_lines || jsonb_build_object('code', pol.payable_account_code, 'credit', round(v_net + v_tax,2), 'description', 'Supplier payable');

  _cur:=public.neo_fact_currency(v_org,inv.branch_id);
  IF nullif(btrim(_cur),'') IS NULL THEN RAISE EXCEPTION 'Invoice property currency could not be verified'; END IF;
  v_res := public.neo_gl_post(v_org, inv.branch_id, 'procurement', 'supplier_invoice', _invoice, 'payable',
    COALESCE(inv.invoice_date, CURRENT_DATE), _cur,
    'Supplier invoice ' || inv.invoice_number, v_lines);

  IF (coalesce((v_res->>'ok')::boolean,false) IS NOT TRUE OR nullif(v_res->>'journal_id','') IS NULL OR NOT EXISTS(SELECT 1 FROM public.journal_entries j WHERE j.id=nullif(v_res->>'journal_id','')::uuid AND j.organization_id=v_org AND j.branch_id IS NOT DISTINCT FROM inv.branch_id AND j.status='posted')) THEN RAISE EXCEPTION 'Supplier invoice acceptance requires its successfully posted journal: %',v_res USING ERRCODE='23514'; END IF;

  UPDATE supplier_invoices
     SET journal_id = (v_res->>'journal_id')::uuid,
         status = 'approved',
         match_status = CASE WHEN match_status = 'held' THEN 'approved-with-variance' ELSE match_status END,
         approved_by = auth.uid(), approved_at = now(),
         notes = COALESCE(notes,'') || CASE WHEN COALESCE(btrim(_reason),'') = '' THEN '' ELSE E'\nAccepted: ' || _reason END
   WHERE id = _invoice;

  -- Reflect what has been invoiced back onto the purchase order trail.
  IF inv.order_id IS NOT NULL THEN
    FOR l IN SELECT * FROM supplier_invoice_lines WHERE supplier_invoice_id = _invoice LOOP
      UPDATE purchase_order_lines pl
         SET invoiced_quantity = COALESCE(pl.invoiced_quantity,0) + l.quantity
       WHERE pl.order_id = inv.order_id
         AND (pl.stock_item_id = l.stock_item_id
              OR (l.stock_item_id IS NULL AND lower(pl.description) = lower(COALESCE(l.description,''))));
    END LOOP;
    UPDATE purchase_orders
       SET invoiced_amount = COALESCE(invoiced_amount,0) + round(COALESCE(inv.amount,0),2),
           status = CASE WHEN status IN ('closed','cancelled','voided') THEN status
                         WHEN COALESCE(invoiced_amount,0) + COALESCE(inv.amount,0) >= COALESCE(total_amount,0) THEN 'fully-invoiced'
                         ELSE 'partially-invoiced' END
     WHERE id = inv.order_id;
  END IF;

  RETURN jsonb_build_object('ok', true, 'journal_id', v_res->>'journal_id', 'amount', round(v_net + v_tax,2));
END $function$
