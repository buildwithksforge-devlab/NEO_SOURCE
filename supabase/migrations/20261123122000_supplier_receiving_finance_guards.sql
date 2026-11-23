-- Guard property scope and invoice posting on every organization's shared functions.
-- This migration validates future writes only; it does not rewrite existing records.

CREATE OR REPLACE FUNCTION public.neo_supplier_invoice_capture(_payload jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE
  v_org uuid := current_org_id();
  v_branch uuid := NULLIF(_payload->>'branch_id','')::uuid;
  v_supplier uuid := NULLIF(_payload->>'supplier_id','')::uuid;
  v_number text := btrim(COALESCE(_payload->>'invoice_number',''));
  v_id uuid; ln jsonb; i integer := 0;
  v_net numeric := 0; v_tax numeric := 0; v_total numeric := 0;
  v_q numeric; v_p numeric; v_lt numeric; v_ltax numeric;
BEGIN
  IF v_org IS NULL THEN RAISE EXCEPTION 'No active organization'; END IF;
  IF NOT (has_permission('finance','edit') OR is_org_admin()) THEN
    RAISE EXCEPTION 'Not permitted to capture supplier invoices';
  END IF;
  IF v_branch IS NULL OR NOT public.neo_branch_in_scope(v_branch) THEN
    RAISE EXCEPTION 'Property is required and must be in scope' USING ERRCODE='42501'; END IF;
  IF v_supplier IS NULL OR NOT EXISTS (SELECT 1 FROM public.suppliers s
      WHERE s.id=v_supplier AND s.organization_id=v_org AND s.active IS TRUE
        AND (s.branch_id IS NULL OR s.branch_id=v_branch)) THEN
    RAISE EXCEPTION 'Supplier is not active at this property' USING ERRCODE='22023'; END IF;
  IF _payload->>'order_id' IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.purchase_orders po WHERE po.id=(_payload->>'order_id')::uuid
      AND po.organization_id=v_org AND po.branch_id=v_branch AND po.supplier_id=v_supplier
      AND po.status NOT IN ('cancelled','voided')) THEN
    RAISE EXCEPTION 'Order does not match property and supplier' USING ERRCODE='22023'; END IF;
  IF _payload->>'receipt_id' IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.goods_receipts gr WHERE gr.id=(_payload->>'receipt_id')::uuid
      AND gr.organization_id=v_org AND gr.branch_id=v_branch AND gr.supplier_id=v_supplier
      AND gr.order_id IS NOT DISTINCT FROM NULLIF(_payload->>'order_id','')::uuid
      AND gr.status='posted') THEN
    RAISE EXCEPTION 'Receipt does not match a posted delivery for this order' USING ERRCODE='22023'; END IF;
  IF jsonb_typeof(_payload->'lines') IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'Invoice lines must be an array' USING ERRCODE='22023'; END IF;
  IF v_number = '' THEN RAISE EXCEPTION 'Supplier invoice number is required'; END IF;

  IF COALESCE((_payload->>'allow_duplicate')::boolean, false) = false
     AND EXISTS (SELECT 1 FROM supplier_invoices si
                  WHERE si.organization_id = v_org AND si.supplier_id = v_supplier
                    AND lower(btrim(si.invoice_number)) = lower(v_number)) THEN
    RAISE EXCEPTION 'Invoice % already captured for this supplier', v_number;
  END IF;

  INSERT INTO supplier_invoices (organization_id, branch_id, supplier_id, order_id, receipt_id,
    invoice_number, invoice_date, due_date, amount, tax_amount, status, match_status, notes, created_by)
  VALUES (v_org, v_branch, v_supplier,
    NULLIF(_payload->>'order_id','')::uuid,
    NULLIF(_payload->>'receipt_id','')::uuid,
    v_number,
    COALESCE(NULLIF(_payload->>'invoice_date','')::date, CURRENT_DATE),
    NULLIF(_payload->>'due_date','')::date,
    0, 0, 'draft', 'pending', NULLIF(_payload->>'notes',''), auth.uid())
  RETURNING id INTO v_id;

  FOR ln IN SELECT * FROM jsonb_array_elements(COALESCE(_payload->'lines','[]'::jsonb)) LOOP
    i := i + 1;
    v_q := COALESCE((ln->>'quantity')::numeric, 0);
    v_p := COALESCE((ln->>'unit_price')::numeric, 0);
    IF v_q <= 0 OR v_p < 0 OR v_q > 100000000 OR v_p > 100000000
      OR COALESCE((ln->>'discount_amount')::numeric,0) < 0
      OR COALESCE((ln->>'discount_amount')::numeric,0) > v_q*v_p
      OR COALESCE((ln->>'tax_amount')::numeric,0) < 0
      OR COALESCE((ln->>'tax_amount')::numeric,0) > v_q*v_p THEN
      RAISE EXCEPTION 'Invalid invoice quantity, price, discount or tax' USING ERRCODE='22023'; END IF;
    IF NULLIF(ln->>'stock_item_id','') IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM public.stock_items si WHERE si.id=(ln->>'stock_item_id')::uuid
        AND si.organization_id=v_org) THEN
      RAISE EXCEPTION 'Invoice item belongs to another organization' USING ERRCODE='42501'; END IF;
    v_lt := round(v_q * v_p - COALESCE((ln->>'discount_amount')::numeric,0), 2);
    v_ltax := round(COALESCE((ln->>'tax_amount')::numeric, 0), 2);
    INSERT INTO supplier_invoice_lines (organization_id, supplier_invoice_id, line_number, description,
      stock_item_id, expense_account_id, department_id, quantity, unit_price, tax_amount, net_amount, total_amount)
    VALUES (v_org, v_id, i, NULLIF(ln->>'description',''),
      NULLIF(ln->>'stock_item_id','')::uuid,
      NULLIF(ln->>'expense_account_id','')::uuid,
      NULLIF(ln->>'department_id','')::uuid,
      v_q, v_p, v_ltax, v_lt, v_lt + v_ltax);
    v_net := v_net + v_lt; v_tax := v_tax + v_ltax;
  END LOOP;

  IF i = 0 THEN RAISE EXCEPTION 'At least one invoice line is required'; END IF;
  v_total := round(v_net + v_tax, 2);

  UPDATE supplier_invoices SET amount = v_total, tax_amount = round(v_tax,2) WHERE id = v_id;

  RETURN jsonb_build_object('ok', true, 'invoice_id', v_id, 'amount', v_total,
    'match', public.proc_three_way_match(v_id));
END $$;

CREATE OR REPLACE FUNCTION public.proc_three_way_match(_invoice uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_org uuid := current_org_id();
  inv record; l record; po record; pol public.procurement_matching_policies;
  v_count integer := 0; v_critical integer := 0;
  v_ordered numeric; v_accepted numeric; v_price numeric; v_dupe integer;
  v_other_invoiced numeric; v_allowed numeric; v_tol numeric;
BEGIN
  IF v_org IS NULL OR NOT (public.has_permission('procurement','invoices.manage')
    OR public.has_permission('finance','edit') OR public.has_permission('finance','approve')
    OR public.is_org_admin()) THEN
    RAISE EXCEPTION 'Not permitted to match supplier invoices' USING ERRCODE='42501'; END IF;
  SELECT * INTO inv FROM supplier_invoices WHERE id = _invoice AND organization_id = v_org;
  IF inv IS NULL OR NOT public.neo_branch_in_scope(inv.branch_id) THEN
    RAISE EXCEPTION 'Invoice not found in property scope' USING ERRCODE='42501'; END IF;
  pol := public.neo_matching_policy(v_org, inv.branch_id);

  DELETE FROM supplier_invoice_discrepancies WHERE supplier_invoice_id = _invoice AND resolved = false;

  SELECT count(*) INTO v_dupe FROM supplier_invoices si
   WHERE si.organization_id = v_org AND si.supplier_id = inv.supplier_id
     AND lower(btrim(si.invoice_number)) = lower(btrim(inv.invoice_number)) AND si.id <> inv.id;
  IF v_dupe > 0 THEN
    INSERT INTO supplier_invoice_discrepancies (organization_id, supplier_invoice_id, order_id, kind, severity, detail)
    VALUES (v_org, _invoice, inv.order_id, 'duplicate-invoice', 'critical',
            format('Invoice number %s already exists for this supplier', inv.invoice_number));
    v_count := v_count + 1; v_critical := v_critical + 1;
  END IF;

  IF inv.order_id IS NULL THEN
    INSERT INTO supplier_invoice_discrepancies (organization_id, supplier_invoice_id, kind, severity, detail)
    VALUES (v_org, _invoice, 'no-purchase-order', 'critical', 'Invoice is not linked to a purchase order');
    v_count := v_count + 1; v_critical := v_critical + 1;
  ELSE
    SELECT * INTO po FROM purchase_orders WHERE id = inv.order_id AND organization_id = v_org;
    IF po.status IN ('cancelled','voided') THEN
      INSERT INTO supplier_invoice_discrepancies (organization_id, supplier_invoice_id, order_id, kind, severity, detail)
      VALUES (v_org, _invoice, inv.order_id, 'closed-purchase-order', 'critical',
              format('Purchase order %s is %s and should not receive new invoices', po.order_number, po.status));
      v_count := v_count + 1; v_critical := v_critical + 1;
    ELSIF po.status = 'closed' THEN
      -- A completed order is the normal target for the supplier's bill: the
      -- goods have already been received. It is worth noting, never a block;
      -- over-claimed quantities are caught by the line rules below.
      INSERT INTO supplier_invoice_discrepancies (organization_id, supplier_invoice_id, order_id, kind, severity, detail)
      VALUES (v_org, _invoice, inv.order_id, 'closed-purchase-order', 'warning',
              format('Purchase order %s is already completed; billed after receiving', po.order_number));
      v_count := v_count + 1;
    END IF;

    FOR l IN SELECT il.*, si.name AS item_name FROM supplier_invoice_lines il
             LEFT JOIN stock_items si ON si.id = il.stock_item_id
             WHERE il.supplier_invoice_id = _invoice LOOP
      SELECT COALESCE(sum(pl.quantity),0), COALESCE(sum(pl.accepted_quantity),0), COALESCE(max(pl.unit_price),0)
        INTO v_ordered, v_accepted, v_price
        FROM purchase_order_lines pl
       WHERE pl.order_id = inv.order_id
         AND (pl.stock_item_id = l.stock_item_id OR (l.stock_item_id IS NULL AND lower(pl.description) = lower(l.description)));

      IF v_ordered = 0 THEN
        INSERT INTO supplier_invoice_discrepancies (organization_id, supplier_invoice_id, order_id, stock_item_id, kind, severity, detail, actual_value)
        VALUES (v_org, _invoice, inv.order_id, l.stock_item_id, 'unordered-item', 'critical',
                format('%s was invoiced but is not on the purchase order', COALESCE(l.item_name, l.description)), l.quantity);
        v_count := v_count + 1; v_critical := v_critical + 1;
        CONTINUE;
      END IF;

      SELECT COALESCE(sum(ol.quantity),0) INTO v_other_invoiced
        FROM supplier_invoice_lines ol
        JOIN supplier_invoices oi ON oi.id = ol.supplier_invoice_id
       WHERE oi.organization_id = v_org AND oi.order_id = inv.order_id AND oi.id <> _invoice
         AND COALESCE(oi.status,'') NOT IN ('cancelled','void','rejected')
         AND (ol.stock_item_id = l.stock_item_id
              OR (l.stock_item_id IS NULL AND lower(COALESCE(ol.description,'')) = lower(COALESCE(l.description,''))));

      v_allowed := CASE WHEN pol.match_mode = 'two-way' THEN v_ordered ELSE v_accepted END;
      v_allowed := v_allowed * (1 + COALESCE(pol.quantity_tolerance_pct,0)/100.0) - v_other_invoiced;

      IF l.quantity > v_allowed + 0.0001 THEN
        INSERT INTO supplier_invoice_discrepancies (organization_id, supplier_invoice_id, order_id, stock_item_id, kind, severity, detail, expected_value, actual_value, variance)
        VALUES (v_org, _invoice, inv.order_id, l.stock_item_id, 'quantity-invoiced-over-received', 'critical',
                format('%s: invoiced %s but only %s claimable', COALESCE(l.item_name, l.description), l.quantity, round(GREATEST(v_allowed,0),3)),
                GREATEST(v_allowed,0), l.quantity, l.quantity - GREATEST(v_allowed,0));
        v_count := v_count + 1; v_critical := v_critical + 1;
      ELSIF pol.match_mode = 'three-way' AND v_accepted < v_ordered THEN
        INSERT INTO supplier_invoice_discrepancies (organization_id, supplier_invoice_id, order_id, stock_item_id, kind, severity, detail, expected_value, actual_value, variance)
        VALUES (v_org, _invoice, inv.order_id, l.stock_item_id, 'quantity-short-received', 'warning',
                format('%s: ordered %s, accepted %s', COALESCE(l.item_name, l.description), v_ordered, v_accepted),
                v_ordered, v_accepted, v_ordered - v_accepted);
        v_count := v_count + 1;
      END IF;

      IF v_price > 0 AND abs(l.unit_price - v_price) > 0.009 THEN
        v_tol := GREATEST(v_price * COALESCE(pol.price_tolerance_pct,0)/100.0, COALESCE(pol.price_tolerance_amount,0));
        INSERT INTO supplier_invoice_discrepancies (organization_id, supplier_invoice_id, order_id, stock_item_id, kind, severity, detail, expected_value, actual_value, variance)
        VALUES (v_org, _invoice, inv.order_id, l.stock_item_id, 'price-variance',
                CASE WHEN l.unit_price > v_price + v_tol THEN 'critical' ELSE 'warning' END,
                format('%s: order price %s vs invoiced %s (tolerance %s)',
                       COALESCE(l.item_name, l.description), v_price, l.unit_price, round(v_tol,2)),
                v_price, l.unit_price, l.unit_price - v_price);
        v_count := v_count + 1;
        IF l.unit_price > v_price + v_tol THEN v_critical := v_critical + 1; END IF;
      END IF;
    END LOOP;
  END IF;

  UPDATE supplier_invoices
     SET match_status = CASE WHEN v_critical > 0 THEN 'held' WHEN v_count > 0 THEN 'review' ELSE 'matched' END,
         status = CASE WHEN v_critical > 0 AND status IN ('draft','received','pending') THEN 'held' ELSE status END
   WHERE id = _invoice;

  PERFORM public.neo_ap_sync_match_amounts(_invoice);

  RETURN jsonb_build_object('discrepancies', v_count, 'critical', v_critical,
    'match_status', CASE WHEN v_critical > 0 THEN 'held' WHEN v_count > 0 THEN 'review' ELSE 'matched' END);
END $function$;

CREATE OR REPLACE FUNCTION public.neo_supplier_invoice_accept(_invoice uuid, _reason text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE
  v_org uuid := current_org_id();
  inv record; pol public.procurement_matching_policies; l record;
  v_net numeric; v_tax numeric; v_lines jsonb := '[]'::jsonb; v_res jsonb; v_debit_code text;
BEGIN
  IF NOT (has_permission('finance','approve') OR is_org_admin()) THEN
    RAISE EXCEPTION 'Not permitted to accept supplier invoices';
  END IF;
  SELECT * INTO inv FROM supplier_invoices WHERE id = _invoice AND organization_id = v_org FOR UPDATE;
  IF inv IS NULL OR NOT public.neo_branch_in_scope(inv.branch_id) THEN
    RAISE EXCEPTION 'Invoice not found in property scope' USING ERRCODE='42501'; END IF;
  IF inv.status IN ('cancelled','void','rejected') THEN
    RAISE EXCEPTION 'Cancelled or rejected invoice cannot be posted' USING ERRCODE='22023'; END IF;
  IF inv.journal_id IS NOT NULL THEN
    RETURN jsonb_build_object('ok', true, 'already_posted', true, 'journal_id', inv.journal_id);
  END IF;
  IF inv.match_status = 'pending' THEN
    PERFORM public.proc_three_way_match(_invoice);
    SELECT * INTO inv FROM supplier_invoices WHERE id = _invoice;
  END IF;
  IF inv.match_status = 'held' AND COALESCE(btrim(_reason),'') = '' THEN
    RAISE EXCEPTION 'This invoice is on hold. A written override reason is required.';
  END IF;

  IF inv.order_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.purchase_orders po WHERE po.id=inv.order_id
      AND po.organization_id=v_org AND po.branch_id=inv.branch_id
      AND po.supplier_id=inv.supplier_id AND po.status NOT IN ('cancelled','voided')) THEN
    RAISE EXCEPTION 'Invoice order, property and supplier do not match' USING ERRCODE='23514'; END IF;
  IF inv.receipt_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.goods_receipts gr WHERE gr.id=inv.receipt_id
      AND gr.organization_id=v_org AND gr.branch_id=inv.branch_id
      AND gr.supplier_id=inv.supplier_id AND gr.order_id IS NOT DISTINCT FROM inv.order_id
      AND gr.status='posted') THEN
    RAISE EXCEPTION 'Invoice receipt does not match a posted delivery' USING ERRCODE='23514'; END IF;
  IF (SELECT count(*) FROM public.supplier_invoice_lines il WHERE il.supplier_invoice_id=_invoice) = 0
    OR round(inv.amount,2) IS DISTINCT FROM (
      SELECT round(COALESCE(sum(il.total_amount),0),2) FROM public.supplier_invoice_lines il
      WHERE il.supplier_invoice_id=_invoice) THEN
    RAISE EXCEPTION 'Invoice header and line amounts do not agree' USING ERRCODE='23514'; END IF;

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

  v_res := public.neo_gl_post(v_org, inv.branch_id, 'procurement', 'supplier_invoice', _invoice, 'payable',
    COALESCE(inv.invoice_date, public.neo_local_today(inv.branch_id)), public.neo_fact_currency(v_org, inv.branch_id),
    'Supplier invoice ' || inv.invoice_number, v_lines);

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
END $$;

-- A GRN cannot quietly move a delivery into a different property or supplier.
CREATE OR REPLACE FUNCTION public.neo_guard_goods_receipt_scope()
RETURNS trigger LANGUAGE plpgsql SET search_path=public AS $$
DECLARE _po public.purchase_orders%ROWTYPE;
BEGIN
  IF NEW.order_id IS NOT NULL THEN
    SELECT * INTO _po FROM public.purchase_orders WHERE id=NEW.order_id
      AND organization_id=NEW.organization_id;
    IF _po.id IS NULL OR NEW.branch_id IS DISTINCT FROM _po.branch_id
      OR NEW.supplier_id IS DISTINCT FROM _po.supplier_id THEN
      RAISE EXCEPTION 'GRN order, property and supplier must agree' USING ERRCODE='23514'; END IF;
  END IF;
  IF NEW.branch_id IS NULL OR NOT EXISTS (
    SELECT 1 FROM public.stock_locations sl WHERE sl.id=NEW.location_id
      AND sl.organization_id=NEW.organization_id AND sl.active IS TRUE
      AND (sl.branch_id=NEW.branch_id OR sl.branch_id IS NULL)) THEN
    RAISE EXCEPTION 'GRN receiving store must belong to its property' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS neo_goods_receipt_scope ON public.goods_receipts;
CREATE TRIGGER neo_goods_receipt_scope BEFORE INSERT OR UPDATE ON public.goods_receipts
  FOR EACH ROW EXECUTE FUNCTION public.neo_guard_goods_receipt_scope();

CREATE OR REPLACE FUNCTION public.neo_guard_goods_receipt_line()
RETURNS trigger LANGUAGE plpgsql SET search_path=public AS $$
DECLARE _gr public.goods_receipts%ROWTYPE; _pl public.purchase_order_lines%ROWTYPE;
  _accepted numeric;
BEGIN
  SELECT * INTO _gr FROM public.goods_receipts WHERE id=NEW.receipt_id
    AND organization_id=NEW.organization_id;
  IF _gr.id IS NULL THEN RAISE EXCEPTION 'Receipt and line organization differ' USING ERRCODE='23514'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.stock_items si WHERE si.id=NEW.stock_item_id
      AND si.organization_id=NEW.organization_id) THEN
    RAISE EXCEPTION 'Receipt item belongs to another organization' USING ERRCODE='23514'; END IF;
  IF NEW.quantity_received < 0 OR NEW.quantity_rejected < 0 OR NEW.quantity_damaged < 0
    OR COALESCE(NEW.quantity_returned,0) < 0 OR NEW.unit_price < 0
    OR NEW.quantity_rejected + NEW.quantity_damaged + COALESCE(NEW.quantity_returned,0) > NEW.quantity_received THEN
    RAISE EXCEPTION 'Invalid receipt quantities or price' USING ERRCODE='23514'; END IF;
  _accepted := NEW.quantity_received - NEW.quantity_rejected - NEW.quantity_damaged
    - COALESCE(NEW.quantity_returned,0);
  IF NEW.quantity_accepted IS NOT NULL AND NEW.quantity_accepted IS DISTINCT FROM _accepted THEN
    RAISE EXCEPTION 'Accepted quantity must equal delivered less rejected, damaged and returned'
      USING ERRCODE='23514'; END IF;
  IF _gr.order_id IS NOT NULL AND NEW.order_line_id IS NULL THEN
    RAISE EXCEPTION 'Purchase order receipt requires its order line' USING ERRCODE='23514'; END IF;
  IF NEW.order_line_id IS NOT NULL THEN
    SELECT * INTO _pl FROM public.purchase_order_lines WHERE id=NEW.order_line_id
      AND organization_id=NEW.organization_id AND order_id=_gr.order_id;
    IF _pl.id IS NULL OR _pl.stock_item_id IS DISTINCT FROM NEW.stock_item_id
      OR _pl.unit IS DISTINCT FROM NEW.unit OR _pl.unit_price IS DISTINCT FROM NEW.unit_price THEN
      RAISE EXCEPTION 'Receipt item, unit and price must match the purchase order'
        USING ERRCODE='23514'; END IF;
  END IF;
  IF NEW.location_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.stock_locations sl WHERE sl.id=NEW.location_id
      AND sl.organization_id=NEW.organization_id AND sl.active IS TRUE
      AND (sl.branch_id=_gr.branch_id OR sl.branch_id IS NULL)) THEN
    RAISE EXCEPTION 'Receipt line store must belong to its property' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS neo_goods_receipt_line_guard ON public.goods_receipt_lines;
CREATE TRIGGER neo_goods_receipt_line_guard BEFORE INSERT OR UPDATE ON public.goods_receipt_lines
  FOR EACH ROW EXECUTE FUNCTION public.neo_guard_goods_receipt_line();

REVOKE ALL ON FUNCTION public.neo_supplier_invoice_capture(jsonb),
  public.neo_supplier_invoice_accept(uuid,text), public.proc_three_way_match(uuid)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.neo_supplier_invoice_capture(jsonb),
  public.neo_supplier_invoice_accept(uuid,text), public.proc_three_way_match(uuid)
  TO authenticated;

-- Carry property currency through receipt, opening stock and reversal journals.
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
  IF r IS NULL OR (public.current_org_id() IS NOT NULL AND
    (r.organization_id IS DISTINCT FROM public.current_org_id()
      OR NOT public.neo_branch_in_scope(r.branch_id))) THEN
    RAISE EXCEPTION 'Receipt not in property scope' USING ERRCODE='42501'; END IF;
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

  SELECT po.currency INTO v_currency FROM public.purchase_orders po WHERE po.id = r.order_id;
  v_currency := COALESCE(NULLIF(v_currency,''), public.neo_fact_currency(v_org,r.branch_id));

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

CREATE OR REPLACE FUNCTION public.neo_stock_movement_accrual(_movement uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE
  m record; pol public.procurement_matching_policies; v_value numeric; v_credit text; v_label text;
BEGIN
  SELECT * INTO m FROM public.stock_movements WHERE id = _movement;
  IF m IS NULL OR (public.current_org_id() IS NOT NULL AND
    (m.organization_id IS DISTINCT FROM public.current_org_id()
      OR NOT public.neo_branch_in_scope(m.branch_id))) THEN
    RAISE EXCEPTION 'Stock movement not in property scope' USING ERRCODE='42501'; END IF;
  v_value := round(COALESCE(m.value, abs(COALESCE(m.quantity,0)) * COALESCE(m.unit_cost,0)), 2);
  IF v_value <= 0 THEN RETURN jsonb_build_object('ok', true, 'skipped','zero_value'); END IF;

  pol := public.neo_matching_policy(m.organization_id, m.branch_id);
  IF m.movement_type = 'opening' THEN
    v_credit := pol.opening_equity_account_code;
    v_label := 'Opening stock balance';
    PERFORM public.neo_finance_ensure_account(m.organization_id, v_credit, 'Opening Balance Equity', 'equity', 'Equity');
  ELSE
    v_credit := pol.grni_account_code;
    v_label := 'Direct purchase received (no purchase order)';
    PERFORM public.neo_finance_ensure_account(m.organization_id, v_credit, 'Goods Received Not Invoiced', 'liability', 'Payables');
  END IF;
  PERFORM public.neo_finance_ensure_account(m.organization_id, pol.inventory_account_code, 'Inventory', 'asset', 'Inventory');

  RETURN public.neo_gl_post(
    m.organization_id, m.branch_id, 'inventory', 'stock_movement', m.id, 'accrual',
    COALESCE(m.created_at::date, public.neo_local_today(m.branch_id)),
    public.neo_fact_currency(m.organization_id,m.branch_id), v_label,
    jsonb_build_array(
      jsonb_build_object('code', pol.inventory_account_code, 'debit', v_value, 'description', v_label),
      jsonb_build_object('code', v_credit, 'credit', v_value, 'description', v_label)
    ));
END $$;

CREATE OR REPLACE FUNCTION public.neo_stock_movement_finance_trigger()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE v_err text;
BEGIN
  IF NEW.movement_type IN ('receipt','opening')
     AND COALESCE(NEW.reference_type,'') <> 'goods_receipt'
     AND COALESCE(NEW.quantity,0) > 0 THEN
    BEGIN
      PERFORM public.neo_stock_movement_accrual(NEW.id);
    EXCEPTION WHEN OTHERS THEN
      v_err := SQLERRM;
      PERFORM public.neo_record_posting_receipt(
        NEW.organization_id, NEW.branch_id, 'inventory', NEW.id, COALESCE(NEW.reference_type,'stock movement'),
        'failed', COALESCE(NEW.value,0), public.neo_fact_currency(NEW.organization_id,NEW.branch_id),
        NULL, 'Stock intake accrual', v_err, public.neo_local_today(NEW.branch_id));
    END;
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION public.neo_grn_reverse(_receipt uuid, _reason text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE
  v_org uuid := current_org_id();
  r record; l record; pol public.procurement_matching_policies;
  v_accepted numeric; v_value numeric := 0; v_res jsonb;
BEGIN
  IF NOT (has_permission('procurement','receiving.manage') OR is_org_admin()) THEN
    RAISE EXCEPTION 'Not permitted to reverse a goods receipt';
  END IF;
  IF COALESCE(btrim(_reason),'') = '' THEN RAISE EXCEPTION 'A reason is required to reverse a receipt'; END IF;
  SELECT * INTO r FROM goods_receipts WHERE id = _receipt AND organization_id = v_org;
  IF r IS NULL OR NOT public.neo_branch_in_scope(r.branch_id) THEN
    RAISE EXCEPTION 'Receipt not in property scope' USING ERRCODE='42501'; END IF;
  IF r.status <> 'posted' THEN RAISE EXCEPTION 'Only a posted receipt can be reversed'; END IF;
  IF EXISTS (SELECT 1 FROM supplier_invoices si WHERE si.receipt_id = _receipt AND si.journal_id IS NOT NULL) THEN
    RAISE EXCEPTION 'This receipt is already invoiced. Raise a supplier credit note instead.';
  END IF;

  pol := public.neo_matching_policy(v_org, r.branch_id);

  FOR l IN SELECT * FROM goods_receipt_lines WHERE receipt_id = _receipt LOOP
    v_accepted := COALESCE(l.quantity_accepted,
      GREATEST(COALESCE(l.quantity_received,0) - COALESCE(l.quantity_rejected,0)
               - COALESCE(l.quantity_damaged,0) - COALESCE(l.quantity_returned,0), 0));
    IF v_accepted > 0 THEN
      PERFORM inventory_apply_movement(
        l.stock_item_id, COALESCE(l.location_id, r.location_id), -v_accepted, l.unit, 'reversal',
        NULLIF(l.unit_price,0), 'goods_receipt_reversal', _receipt, _reason,
        'grn-reverse:' || _receipt::text || ':' || l.id::text, l.batch_number, l.expiry_date);
      v_value := v_value + (v_accepted * COALESCE(l.unit_price,0));
    END IF;
    IF l.order_line_id IS NOT NULL THEN
      UPDATE purchase_order_lines SET
        received_quantity = GREATEST(COALESCE(received_quantity,0) - COALESCE(l.quantity_received,0), 0),
        accepted_quantity = GREATEST(COALESCE(accepted_quantity,0) - v_accepted, 0)
      WHERE id = l.order_line_id;
    END IF;
  END LOOP;

  IF round(v_value,2) > 0 THEN
    v_res := public.neo_gl_post(v_org, r.branch_id, 'procurement', 'goods_receipt', _receipt, 'accrual:reversal',
      public.neo_local_today(r.branch_id), public.neo_fact_currency(v_org,r.branch_id), 'Reversal of goods receipt ' || COALESCE(r.grn_number, _receipt::text) || ' — ' || _reason,
      jsonb_build_array(
        jsonb_build_object('code', pol.grni_account_code, 'debit', round(v_value,2), 'description','Reverse goods received not invoiced'),
        jsonb_build_object('code', pol.inventory_account_code, 'credit', round(v_value,2), 'description','Reverse stock received')
      ), NULL, r.accrual_journal_id);
  END IF;

  UPDATE goods_receipts
     SET status = 'reversed', reversed_at = now(), reversed_by = auth.uid(),
         reversal_reason = _reason, reversal_journal_id = (v_res->>'journal_id')::uuid
   WHERE id = _receipt;

  IF r.order_id IS NOT NULL THEN
    UPDATE purchase_orders po SET status = CASE
      WHEN EXISTS (SELECT 1 FROM purchase_order_lines pl WHERE pl.order_id = po.id AND COALESCE(pl.accepted_quantity,0) > 0)
        THEN 'partially-received' ELSE 'sent' END
     WHERE po.id = r.order_id AND po.status NOT IN ('closed','cancelled','voided');
  END IF;

  RETURN jsonb_build_object('ok', true, 'reversed_value', round(v_value,2), 'journal_id', v_res->>'journal_id');
END $$;

-- Apply the selected-quote rule to direct table writes as well as the LPO RPC.
CREATE OR REPLACE FUNCTION public.neo_guard_purchase_order_quote()
RETURNS trigger LANGUAGE plpgsql SET search_path=public AS $$
BEGIN
  IF NEW.request_id IS NULL OR NEW.quotation_id IS NULL OR NEW.branch_id IS NULL
    OR NOT EXISTS (SELECT 1 FROM public.purchase_requests pr
      WHERE pr.id=NEW.request_id AND pr.organization_id=NEW.organization_id
        AND pr.branch_id=NEW.branch_id AND pr.status='approved')
    OR NOT EXISTS (SELECT 1 FROM public.supplier_quotations q
      WHERE q.id=NEW.quotation_id AND q.organization_id=NEW.organization_id
        AND q.branch_id=NEW.branch_id AND q.request_id=NEW.request_id
        AND q.supplier_id=NEW.supplier_id AND q.selected IS TRUE AND q.status='selected'
        AND (q.valid_until IS NULL OR q.valid_until>=public.neo_local_today(NEW.branch_id))
        AND q.currency=NEW.currency AND q.currency=public.neo_fact_currency(NEW.organization_id,NEW.branch_id)) THEN
    RAISE EXCEPTION 'New purchase orders require an approved request and selected property-currency quotation'
      USING ERRCODE='23514'; END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS neo_purchase_order_quote_guard ON public.purchase_orders;
CREATE TRIGGER neo_purchase_order_quote_guard
  BEFORE INSERT OR UPDATE OF request_id,quotation_id,supplier_id,organization_id,branch_id,currency
  ON public.purchase_orders FOR EACH ROW EXECUTE FUNCTION public.neo_guard_purchase_order_quote();

CREATE OR REPLACE FUNCTION public.neo_guard_purchase_order_line_quote()
RETURNS trigger LANGUAGE plpgsql SET search_path=public AS $$
DECLARE _po public.purchase_orders%ROWTYPE;
BEGIN
  SELECT * INTO _po FROM public.purchase_orders WHERE id=NEW.order_id
    AND organization_id=NEW.organization_id;
  IF _po.id IS NULL THEN RAISE EXCEPTION 'Order line belongs to another organization' USING ERRCODE='23514'; END IF;
  IF _po.quotation_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.supplier_quotation_lines ql
    WHERE ql.quotation_id=_po.quotation_id AND ql.organization_id=NEW.organization_id
      AND ql.stock_item_id IS NOT DISTINCT FROM NEW.stock_item_id
      AND ql.description IS NOT DISTINCT FROM NEW.description
      AND ql.quantity=NEW.quantity AND ql.unit IS NOT DISTINCT FROM NEW.unit
      AND ql.unit_price=NEW.unit_price AND ql.tax_rate=NEW.tax_rate
      AND NEW.tax_amount=round(NEW.quantity*NEW.unit_price*NEW.tax_rate/100,2)
      AND NEW.line_total=round(NEW.quantity*NEW.unit_price,2)+NEW.tax_amount
      AND NEW.discount_amount=0) THEN
    RAISE EXCEPTION 'Purchase order line must match the selected supplier quotation'
      USING ERRCODE='23514'; END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS neo_purchase_order_line_quote_guard ON public.purchase_order_lines;
CREATE TRIGGER neo_purchase_order_line_quote_guard
  BEFORE INSERT OR UPDATE OF organization_id,order_id,stock_item_id,description,quantity,unit,
    unit_price,tax_rate,tax_amount,line_total,discount_amount
  ON public.purchase_order_lines FOR EACH ROW EXECUTE FUNCTION public.neo_guard_purchase_order_line_quote();

-- The Finance failure receipt uses the same property currency as a successful accrual.
CREATE OR REPLACE FUNCTION public.inventory_post_receipt(_receipt uuid)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE v_org uuid:=current_org_id(); r record; l record; v_total numeric:=0; v_lines integer:=0; v_accepted numeric; v_err text;
BEGIN
 IF NOT has_permission('procurement','receiving.manage') THEN RAISE EXCEPTION 'Not permitted to receive stock'; END IF;
 SELECT * INTO r FROM goods_receipts WHERE id=_receipt AND organization_id=v_org FOR UPDATE;
 IF r IS NULL THEN RAISE EXCEPTION 'Receipt not found'; END IF;
 IF r.status='posted' AND r.accrual_journal_id IS NOT NULL THEN RETURN jsonb_build_object('status','already-posted','journal_id',r.accrual_journal_id); END IF;
 IF r.status<>'posted' THEN
  FOR l IN SELECT * FROM goods_receipt_lines WHERE receipt_id=_receipt LOOP
   v_accepted:=COALESCE(l.quantity_accepted,GREATEST(COALESCE(l.quantity_received,0)-COALESCE(l.quantity_rejected,0)-COALESCE(l.quantity_damaged,0)-COALESCE(l.quantity_returned,0),0));
   IF v_accepted>0 THEN
    PERFORM inventory_apply_movement(l.stock_item_id,COALESCE(l.location_id,r.location_id),v_accepted,l.unit,'receipt',
      CASE WHEN l.unit_price>0 THEN l.unit_price/NULLIF(inventory_convert(1,l.unit,(SELECT base_unit FROM stock_items WHERE id=l.stock_item_id)),0) ELSE NULL END,
      'goods_receipt',_receipt,'Goods accepted','grn:'||_receipt::text||':'||l.id::text,l.batch_number,l.expiry_date);
    v_total:=v_total+(v_accepted*COALESCE(l.unit_price,0)); v_lines:=v_lines+1;
   END IF;
   IF l.order_line_id IS NOT NULL THEN UPDATE purchase_order_lines SET received_quantity=COALESCE(received_quantity,0)+COALESCE(l.quantity_received,0),accepted_quantity=COALESCE(accepted_quantity,0)+v_accepted,rejected_quantity=COALESCE(rejected_quantity,0)+COALESCE(l.quantity_rejected,0),returned_quantity=COALESCE(returned_quantity,0)+COALESCE(l.quantity_returned,0) WHERE id=l.order_line_id; END IF;
  END LOOP;
  UPDATE goods_receipts SET status='posted',posted_at=now(),total_value=v_total WHERE id=_receipt;
 ELSE v_total:=COALESCE(r.total_value,0); END IF;
 BEGIN
  PERFORM public.neo_grn_post_accrual(_receipt);
  UPDATE goods_receipts SET accrual_error=NULL WHERE id=_receipt;
 EXCEPTION WHEN OTHERS THEN
  v_err:=SQLERRM; UPDATE goods_receipts SET accrual_error=v_err WHERE id=_receipt;
  PERFORM public.neo_record_posting_receipt(v_org,r.branch_id,'inventory',_receipt,COALESCE(r.grn_number,_receipt::text),'failed',v_total,public.neo_fact_currency(v_org,r.branch_id),NULL,'Goods receipt accrual',v_err,public.neo_local_today(r.branch_id));
 END;
 RETURN jsonb_build_object('status',CASE WHEN v_err IS NULL THEN 'posted' ELSE 'pending-finance' END,'lines',v_lines,'value',v_total,'finance_error',v_err);
END;
$function$;
