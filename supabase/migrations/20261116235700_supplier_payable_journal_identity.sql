-- STAGED ONLY: verify future acceptance/replay against the original payable journal.
-- No supplier invoice, journal, purchase quantity or historical amount changed on installation.
BEGIN;
DO $guard$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_proc p JOIN pg_roles r ON r.oid=p.proowner
 WHERE p.oid=to_regprocedure('public.neo_supplier_invoice_accept(uuid,text)') AND r.rolname NOT IN ('anon','authenticated')
 AND md5(regexp_replace(regexp_replace(p.prosrc,'--[^'||chr(10)||']*','','g'),'[[:space:]]','','g')) IN ('1cb2e313cbc65768dcbb947afe9e49e0','d579a60754acdfdac6dcc374186ebd63')) THEN
 RAISE EXCEPTION 'Supplier acceptance differs from reviewed source; nothing replaced'; END IF;
END $guard$;
CREATE TEMP TABLE neo_supplier_acceptance_acl ON COMMIT DROP AS SELECT proowner,coalesce(proacl::text,'') acl
 FROM pg_proc WHERE oid='public.neo_supplier_invoice_accept(uuid,text)'::regprocedure;
CREATE OR REPLACE FUNCTION public.neo_supplier_invoice_accept(_invoice uuid, _reason text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_org uuid := current_org_id();
  inv record; pol public.procurement_matching_policies; l record;
  v_net numeric; v_tax numeric; v_lines jsonb := '[]'::jsonb; v_res jsonb; v_debit_code text; _cur text; allocation_line record; quantity_left numeric; allocated_quantity numeric; last_order_line uuid;
BEGIN
  IF NOT coalesce(has_permission('finance','approve') OR is_org_admin(),false) THEN
    RAISE EXCEPTION 'Not permitted to accept supplier invoices';
  END IF;
  SELECT * INTO inv FROM supplier_invoices WHERE id = _invoice AND organization_id = v_org FOR UPDATE;
  IF inv IS NULL THEN RAISE EXCEPTION 'Invoice not found'; END IF;
    IF auth.uid() IS NULL OR public.neo_branch_in_scope(inv.branch_id) IS NOT TRUE THEN RAISE EXCEPTION 'Invoice outside authorized property scope' USING ERRCODE='42501'; END IF;
    IF inv.amount IS NULL OR inv.amount<=0 OR inv.amount::text IN ('NaN','Infinity','-Infinity') OR inv.tax_amount IS NULL OR inv.tax_amount<0 OR inv.tax_amount>inv.amount OR inv.tax_amount::text IN ('NaN','Infinity','-Infinity') THEN RAISE EXCEPTION 'Invoice amount or tax is incomplete or non-finite'; END IF;
    IF inv.journal_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.journal_entries j
      WHERE j.id=inv.journal_id AND j.organization_id=v_org AND j.branch_id IS NOT DISTINCT FROM inv.branch_id
        AND j.status='posted' AND j.reversed_by_journal_id IS NULL
        AND j.source_document_type='supplier_invoice:payable' AND j.source_document_id=_invoice
        AND j.currency=public.neo_fact_currency(v_org,inv.branch_id)
        AND (inv.invoice_date IS NULL OR j.accounting_date=inv.invoice_date)
        AND j.total_debit=round(inv.amount,2) AND j.total_credit=round(inv.amount,2)
        AND (SELECT sum(journal_line.debit) FROM public.journal_entry_lines journal_line WHERE journal_line.journal_id=j.id)=round(inv.amount,2)
        AND (SELECT sum(journal_line.credit) FROM public.journal_entry_lines journal_line WHERE journal_line.journal_id=j.id)=round(inv.amount,2)
        AND NOT EXISTS(SELECT 1 FROM public.journal_entry_lines journal_line LEFT JOIN public.chart_of_accounts a ON a.id=journal_line.account_id
          WHERE journal_line.journal_id=j.id AND (journal_line.organization_id IS DISTINCT FROM v_org OR a.organization_id IS DISTINCT FROM v_org
            OR journal_line.branch_id IS DISTINCT FROM inv.branch_id OR journal_line.debit IS NULL OR journal_line.credit IS NULL OR journal_line.debit<0 OR journal_line.credit<0
            OR journal_line.debit::text IN ('NaN','Infinity','-Infinity') OR journal_line.credit::text IN ('NaN','Infinity','-Infinity')
            OR (journal_line.debit>0 AND journal_line.credit>0)))) THEN RAISE EXCEPTION 'Saved invoice journal is not confirmed posted; review before retrying'; END IF;
  IF inv.status IS NULL OR inv.status IN ('cancelled','canceled','void','voided','rejected','reversed') THEN
    RAISE EXCEPTION 'Supplier invoice cannot be accepted from status %',coalesce(inv.status,'missing');
  END IF;
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

  IF (coalesce((v_res->>'ok')::boolean,false) IS NOT TRUE OR nullif(v_res->>'journal_id','') IS NULL OR NOT EXISTS(SELECT 1 FROM public.journal_entries j
      WHERE j.id=nullif(v_res->>'journal_id','')::uuid AND j.organization_id=v_org AND j.branch_id IS NOT DISTINCT FROM inv.branch_id
        AND j.status='posted' AND j.reversed_by_journal_id IS NULL
        AND j.source_document_type='supplier_invoice:payable' AND j.source_document_id=_invoice
        AND j.currency=public.neo_fact_currency(v_org,inv.branch_id)
        AND (inv.invoice_date IS NULL OR j.accounting_date=inv.invoice_date)
        AND j.total_debit=round(inv.amount,2) AND j.total_credit=round(inv.amount,2)
        AND (SELECT sum(journal_line.debit) FROM public.journal_entry_lines journal_line WHERE journal_line.journal_id=j.id)=round(inv.amount,2)
        AND (SELECT sum(journal_line.credit) FROM public.journal_entry_lines journal_line WHERE journal_line.journal_id=j.id)=round(inv.amount,2)
        AND NOT EXISTS(SELECT 1 FROM public.journal_entry_lines journal_line LEFT JOIN public.chart_of_accounts a ON a.id=journal_line.account_id
          WHERE journal_line.journal_id=j.id AND (journal_line.organization_id IS DISTINCT FROM v_org OR a.organization_id IS DISTINCT FROM v_org
            OR journal_line.branch_id IS DISTINCT FROM inv.branch_id OR journal_line.debit IS NULL OR journal_line.credit IS NULL OR journal_line.debit<0 OR journal_line.credit<0
            OR journal_line.debit::text IN ('NaN','Infinity','-Infinity') OR journal_line.credit::text IN ('NaN','Infinity','-Infinity')
            OR (journal_line.debit>0 AND journal_line.credit>0))))) THEN RAISE EXCEPTION 'Supplier invoice acceptance requires its successfully posted journal: %',v_res USING ERRCODE='23514'; END IF;

  UPDATE supplier_invoices
     SET journal_id = (v_res->>'journal_id')::uuid,
         status = 'approved',
         match_status = CASE WHEN match_status = 'held' THEN 'approved-with-variance' ELSE match_status END,
         approved_by = auth.uid(), approved_at = now(),
         notes = COALESCE(notes,'') || CASE WHEN COALESCE(btrim(_reason),'') = '' THEN '' ELSE E'\nAccepted: ' || _reason END
   WHERE id = _invoice;

  -- Reflect what has been invoiced back onto the purchase order trail.
  IF inv.order_id IS NOT NULL THEN
    FOR l IN SELECT il.stock_item_id,CASE WHEN il.stock_item_id IS NULL THEN lower(coalesce(il.description,'')) ELSE '' END AS match_description,
       sum(il.quantity) AS quantity FROM public.supplier_invoice_lines il
       WHERE il.supplier_invoice_id=_invoice AND il.organization_id=v_org GROUP BY 1,2 LOOP
      quantity_left:=l.quantity;last_order_line:=NULL;
      FOR allocation_line IN SELECT pl.* FROM public.purchase_order_lines pl WHERE pl.order_id=inv.order_id AND pl.organization_id=v_org
         AND (pl.stock_item_id=l.stock_item_id OR (l.stock_item_id IS NULL AND lower(coalesce(pl.description,''))=l.match_description))
         ORDER BY pl.created_at NULLS LAST,pl.id FOR UPDATE LOOP
        last_order_line:=allocation_line.id;
        IF allocation_line.quantity IS NULL OR allocation_line.quantity::text IN ('NaN','Infinity','-Infinity')
          OR coalesce(allocation_line.cancelled_quantity,0)::text IN ('NaN','Infinity','-Infinity')
          OR coalesce(allocation_line.invoiced_quantity,0)::text IN ('NaN','Infinity','-Infinity')
          OR allocation_line.quantity<0 OR coalesce(allocation_line.cancelled_quantity,0)<0 OR coalesce(allocation_line.invoiced_quantity,0)<0 THEN
         RAISE EXCEPTION 'Purchase order invoice quantity trail needs reconciliation';
        END IF;
        allocated_quantity:=least(quantity_left,greatest(allocation_line.quantity-coalesce(allocation_line.cancelled_quantity,0)-coalesce(allocation_line.invoiced_quantity,0),0));
        IF allocated_quantity>0 THEN
          UPDATE public.purchase_order_lines SET invoiced_quantity=coalesce(invoiced_quantity,0)+allocated_quantity WHERE id=allocation_line.id AND organization_id=v_org;
          quantity_left:=quantity_left-allocated_quantity;
        END IF;
      END LOOP;
      -- A configured tolerance or written approved variance may exceed the PO.
      -- Record that remainder once, never once against every matching line.
      IF quantity_left>0 AND last_order_line IS NOT NULL THEN
       UPDATE public.purchase_order_lines SET invoiced_quantity=coalesce(invoiced_quantity,0)+quantity_left WHERE id=last_order_line AND organization_id=v_org;
      END IF;
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
;
DO $verify$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_proc p CROSS JOIN neo_supplier_acceptance_acl old
 WHERE p.oid='public.neo_supplier_invoice_accept(uuid,text)'::regprocedure AND p.proowner=old.proowner AND coalesce(p.proacl::text,'')=old.acl) THEN
 RAISE EXCEPTION 'Supplier acceptance owner or grants changed'; END IF;
END $verify$;
COMMIT;
