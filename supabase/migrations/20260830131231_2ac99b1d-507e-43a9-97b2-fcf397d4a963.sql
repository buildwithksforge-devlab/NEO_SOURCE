-- ============ 1. account helper ============
CREATE OR REPLACE FUNCTION public.neo_finance_ensure_account(_org uuid, _code text, _name text, _category text, _group text)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE a uuid;
BEGIN
  SELECT id INTO a FROM public.chart_of_accounts WHERE organization_id = _org AND code = _code;
  IF a IS NULL THEN
    INSERT INTO public.chart_of_accounts (organization_id, code, name, category, account_group, is_header, postable)
    VALUES (_org, _code, _name, _category, _group, false, true)
    RETURNING id INTO a;
  END IF;
  RETURN a;
END $$;

-- ============ 2. matching policy ============
CREATE TABLE IF NOT EXISTS public.procurement_matching_policies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL DEFAULT public.current_org_id(),
  branch_id uuid REFERENCES public.branches(id) ON DELETE CASCADE,
  match_mode text NOT NULL DEFAULT 'three-way' CHECK (match_mode IN ('two-way','three-way')),
  price_tolerance_pct numeric NOT NULL DEFAULT 2,
  price_tolerance_amount numeric NOT NULL DEFAULT 0,
  quantity_tolerance_pct numeric NOT NULL DEFAULT 0,
  inventory_account_code text NOT NULL DEFAULT '1070',
  grni_account_code text NOT NULL DEFAULT '2015',
  payable_account_code text NOT NULL DEFAULT '2010',
  tax_input_account_code text NOT NULL DEFAULT '1085',
  opening_equity_account_code text NOT NULL DEFAULT '3020',
  expense_account_code text NOT NULL DEFAULT '6090',
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.procurement_matching_policies TO authenticated;
GRANT ALL ON public.procurement_matching_policies TO service_role;
ALTER TABLE public.procurement_matching_policies ENABLE ROW LEVEL SECURITY;

CREATE UNIQUE INDEX IF NOT EXISTS procurement_matching_policies_scope_idx
  ON public.procurement_matching_policies (organization_id, branch_id) NULLS NOT DISTINCT;

DROP POLICY IF EXISTS "matching policy readable in org" ON public.procurement_matching_policies;
CREATE POLICY "matching policy readable in org" ON public.procurement_matching_policies
  FOR SELECT TO authenticated
  USING (organization_id = public.current_org_id());

DROP POLICY IF EXISTS "matching policy managed by finance" ON public.procurement_matching_policies;
CREATE POLICY "matching policy managed by finance" ON public.procurement_matching_policies
  FOR ALL TO authenticated
  USING (organization_id = public.current_org_id()
         AND (public.has_permission('finance','edit') OR public.is_org_admin_for(organization_id)))
  WITH CHECK (organization_id = public.current_org_id()
         AND (public.has_permission('finance','edit') OR public.is_org_admin_for(organization_id)));

DROP TRIGGER IF EXISTS procurement_matching_policies_touch ON public.procurement_matching_policies;
CREATE TRIGGER procurement_matching_policies_touch
  BEFORE UPDATE ON public.procurement_matching_policies
  FOR EACH ROW EXECUTE FUNCTION public.fin_touch_updated_at();

CREATE OR REPLACE FUNCTION public.neo_matching_policy(_org uuid, _branch uuid)
RETURNS public.procurement_matching_policies
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE p public.procurement_matching_policies;
BEGIN
  SELECT * INTO p FROM public.procurement_matching_policies
   WHERE organization_id = _org AND branch_id = _branch;
  IF p.id IS NULL THEN
    SELECT * INTO p FROM public.procurement_matching_policies
     WHERE organization_id = _org AND branch_id IS NULL;
  END IF;
  IF p.id IS NULL THEN
    p.organization_id := _org;
    p.branch_id := NULL;
    p.match_mode := 'three-way';
    p.price_tolerance_pct := 2;
    p.price_tolerance_amount := 0;
    p.quantity_tolerance_pct := 0;
    p.inventory_account_code := '1070';
    p.grni_account_code := '2015';
    p.payable_account_code := '2010';
    p.tax_input_account_code := '1085';
    p.opening_equity_account_code := '3020';
    p.expense_account_code := '6090';
  END IF;
  RETURN p;
END $$;

-- ============ 3. receipt <-> finance trace columns ============
ALTER TABLE public.goods_receipts
  ADD COLUMN IF NOT EXISTS accrual_journal_id uuid,
  ADD COLUMN IF NOT EXISTS accrued_value numeric,
  ADD COLUMN IF NOT EXISTS accrual_error text,
  ADD COLUMN IF NOT EXISTS reversal_journal_id uuid,
  ADD COLUMN IF NOT EXISTS reversed_at timestamptz,
  ADD COLUMN IF NOT EXISTS reversed_by uuid,
  ADD COLUMN IF NOT EXISTS reversal_reason text;

-- ============ 4. GRN accrual: Dr Inventory / Cr GRNI ============
CREATE OR REPLACE FUNCTION public.neo_grn_post_accrual(_receipt uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE
  v_org uuid;
  r record; pol public.procurement_matching_policies;
  v_value numeric := 0; v_currency text; v_res jsonb;
BEGIN
  SELECT * INTO r FROM public.goods_receipts WHERE id = _receipt;
  IF r IS NULL THEN RAISE EXCEPTION 'Receipt not found'; END IF;
  v_org := r.organization_id;
  pol := public.neo_matching_policy(v_org, r.branch_id);

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

  UPDATE public.goods_receipts
     SET accrual_journal_id = (v_res->>'journal_id')::uuid,
         accrued_value = round(v_value,2),
         accrual_error = NULL
   WHERE id = _receipt;

  RETURN v_res;
END $$;

-- ============ 5. call the accrual from the canonical receipt posting ============
CREATE OR REPLACE FUNCTION public.inventory_post_receipt(_receipt uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_org uuid := current_org_id();
  r record; l record;
  v_total numeric := 0; v_lines integer := 0; v_accepted numeric;
  v_err text;
BEGIN
  IF NOT has_permission('procurement','receiving.manage') THEN RAISE EXCEPTION 'Not permitted to receive stock'; END IF;
  SELECT * INTO r FROM goods_receipts WHERE id = _receipt AND organization_id = v_org;
  IF r IS NULL THEN RAISE EXCEPTION 'Receipt not found'; END IF;
  IF r.status = 'posted' THEN RETURN jsonb_build_object('status','already-posted'); END IF;

  FOR l IN SELECT * FROM goods_receipt_lines WHERE receipt_id = _receipt LOOP
    v_accepted := COALESCE(l.quantity_accepted,
      GREATEST(COALESCE(l.quantity_received,0) - COALESCE(l.quantity_rejected,0) - COALESCE(l.quantity_damaged,0) - COALESCE(l.quantity_returned,0), 0));

    IF v_accepted > 0 THEN
      PERFORM inventory_apply_movement(
        l.stock_item_id, COALESCE(l.location_id, r.location_id), v_accepted, l.unit, 'receipt',
        CASE WHEN l.unit_price > 0 THEN l.unit_price / NULLIF(inventory_convert(1, l.unit, (SELECT base_unit FROM stock_items WHERE id = l.stock_item_id)), 0) ELSE NULL END,
        'goods_receipt', _receipt, 'Goods accepted', 'grn:' || _receipt::text || ':' || l.id::text,
        l.batch_number, l.expiry_date
      );
      v_total := v_total + (v_accepted * COALESCE(l.unit_price,0));
      v_lines := v_lines + 1;
    END IF;

    IF l.order_line_id IS NOT NULL THEN
      UPDATE purchase_order_lines SET
        received_quantity = COALESCE(received_quantity,0) + COALESCE(l.quantity_received, 0),
        accepted_quantity = COALESCE(accepted_quantity,0) + v_accepted,
        rejected_quantity = COALESCE(rejected_quantity,0) + COALESCE(l.quantity_rejected,0),
        returned_quantity = COALESCE(returned_quantity,0) + COALESCE(l.quantity_returned,0)
      WHERE id = l.order_line_id;
    END IF;

    UPDATE supplier_items
       SET previous_price = unit_price, unit_price = l.unit_price, last_quoted_at = now()
     WHERE supplier_id = r.supplier_id AND stock_item_id = l.stock_item_id AND l.unit_price > 0;
  END LOOP;

  UPDATE goods_receipts SET status = 'posted', posted_at = now(), total_value = v_total WHERE id = _receipt;

  -- The LPO is never deleted or hidden; only its status advances. It stays open
  -- until everything is accepted or an authorised user closes the balance.
  IF r.order_id IS NOT NULL THEN
    UPDATE purchase_orders po SET status = CASE
      WHEN NOT EXISTS (
        SELECT 1 FROM purchase_order_lines pl
         WHERE pl.order_id = po.id
           AND COALESCE(pl.accepted_quantity,0) + COALESCE(pl.cancelled_quantity,0) < pl.quantity
      ) THEN 'fully-received'
      ELSE 'partially-received' END
    WHERE po.id = r.order_id AND po.status NOT IN ('closed','cancelled','voided');
  END IF;

  -- Stock value never rises without an accounting explanation: Dr Inventory /
  -- Cr Goods Received Not Invoiced. A posting failure is recorded rather than
  -- silently swallowed, so Finance can see and repair the gap.
  BEGIN
    PERFORM public.neo_grn_post_accrual(_receipt);
  EXCEPTION WHEN OTHERS THEN
    v_err := SQLERRM;
    UPDATE goods_receipts SET accrual_error = v_err WHERE id = _receipt;
    PERFORM public.neo_record_posting_receipt(
      v_org, r.branch_id, 'procurement', _receipt, COALESCE(r.grn_number, _receipt::text),
      'failed', v_total, 'KES', NULL, 'Goods receipt accrual', v_err, CURRENT_DATE);
  END;

  RETURN jsonb_build_object('status','posted','lines',v_lines,'value',v_total,'accepted_value',v_total);
END $function$;

-- ============ 6. non-PO receipts and opening balances ============
CREATE OR REPLACE FUNCTION public.neo_stock_movement_accrual(_movement uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE
  m record; pol public.procurement_matching_policies; v_value numeric; v_credit text; v_label text;
BEGIN
  SELECT * INTO m FROM public.stock_movements WHERE id = _movement;
  IF m IS NULL THEN RETURN jsonb_build_object('ok', false, 'reason','not_found'); END IF;
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
    COALESCE(m.created_at::date, CURRENT_DATE), 'KES', v_label,
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
        'failed', COALESCE(NEW.value,0), 'KES', NULL, 'Stock intake accrual', v_err, CURRENT_DATE);
    END;
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS neo_stock_movement_finance ON public.stock_movements;
CREATE TRIGGER neo_stock_movement_finance
  AFTER INSERT ON public.stock_movements
  FOR EACH ROW EXECUTE FUNCTION public.neo_stock_movement_finance_trigger();

-- ============ 7. policy-aware three-way matching ============
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
  SELECT * INTO inv FROM supplier_invoices WHERE id = _invoice AND organization_id = v_org;
  IF inv IS NULL THEN RAISE EXCEPTION 'Invoice not found'; END IF;
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
    IF po.status IN ('cancelled','voided','closed') THEN
      INSERT INTO supplier_invoice_discrepancies (organization_id, supplier_invoice_id, order_id, kind, severity, detail)
      VALUES (v_org, _invoice, inv.order_id, 'closed-purchase-order', 'critical',
              format('Purchase order %s is %s and should not receive new invoices', po.order_number, po.status));
      v_count := v_count + 1; v_critical := v_critical + 1;
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

      -- One invoice may cover several receipts, and several invoices may share a
      -- purchase order: only the quantity not already invoiced is claimable.
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
                format('%s: invoiced %s but only %s claimable (%s accepted, %s already invoiced)',
                       COALESCE(l.item_name, l.description), l.quantity, round(v_allowed,3), v_accepted, v_other_invoiced),
                v_allowed, l.quantity, l.quantity - v_allowed);
        v_count := v_count + 1; v_critical := v_critical + 1;
      END IF;

      IF pol.match_mode = 'three-way' AND v_accepted < v_ordered THEN
        INSERT INTO supplier_invoice_discrepancies (organization_id, supplier_invoice_id, order_id, stock_item_id, kind, severity, detail, expected_value, actual_value, variance)
        VALUES (v_org, _invoice, inv.order_id, l.stock_item_id, 'outstanding-delivery', 'warning',
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

  RETURN jsonb_build_object('discrepancies', v_count, 'critical', v_critical,
    'match_status', CASE WHEN v_critical > 0 THEN 'held' WHEN v_count > 0 THEN 'review' ELSE 'matched' END);
END $function$;

-- ============ 8. supplier invoice capture ============
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
  IF v_supplier IS NULL THEN RAISE EXCEPTION 'Supplier is required'; END IF;
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

-- ============ 9. invoice acceptance: Dr GRNI / Dr VAT / Cr AP ============
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
  SELECT * INTO inv FROM supplier_invoices WHERE id = _invoice AND organization_id = v_org;
  IF inv IS NULL THEN RAISE EXCEPTION 'Invoice not found'; END IF;
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
    COALESCE(inv.invoice_date, CURRENT_DATE), 'KES',
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

-- ============ 10. goods receipt reversal ============
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
  IF r IS NULL THEN RAISE EXCEPTION 'Receipt not found'; END IF;
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
      CURRENT_DATE, 'KES', 'Reversal of goods receipt ' || COALESCE(r.grn_number, _receipt::text) || ' — ' || _reason,
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

-- ============ 11. execution grants ============
REVOKE ALL ON FUNCTION public.neo_finance_ensure_account(uuid, text, text, text, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.neo_matching_policy(uuid, uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.neo_grn_post_accrual(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.neo_stock_movement_accrual(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.neo_supplier_invoice_capture(jsonb) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.neo_supplier_invoice_accept(uuid, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.neo_grn_reverse(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.neo_matching_policy(uuid, uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.neo_grn_post_accrual(uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.neo_supplier_invoice_capture(jsonb) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.neo_supplier_invoice_accept(uuid, text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.neo_grn_reverse(uuid, text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.neo_finance_ensure_account(uuid, text, text, text, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.neo_stock_movement_accrual(uuid) TO service_role;