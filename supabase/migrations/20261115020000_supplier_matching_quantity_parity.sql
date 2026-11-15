-- Future matching and approval quantity checks. No invoice is approved during installation.
BEGIN;
DO $guard$ DECLARE expected jsonb; BEGIN
 FOR expected IN SELECT value FROM jsonb_array_elements($expected$[{"sig":"public.proc_three_way_match(uuid)","old_hash":"35e8a205f2ebdd4b711b12754b8ef9a6","hash":"30f80d91085786080761bcb8c0324e3a","body":"7a3f00848253663b94932d93c475ed51","prosecdef":true,"provolatile":"v","proconfig":["search_path=public"],"result":"jsonb"},{"sig":"public.neo_ap_match_lines(uuid)","old_hash":"032d979eef53b55ba8b9721bbdccf812","hash":"913a670bf2147d43986ab4e4f454b6ef","body":"983d5da712fb3aef618bb685a4c16aa2","prosecdef":true,"provolatile":"s","proconfig":["search_path=public"],"result":"TABLE(line_id uuid, line_number integer, description text, stock_item_id uuid, ordered_quantity numeric, accepted_quantity numeric, received_quantity numeric, other_invoiced_quantity numeric, claimable_quantity numeric, invoiced_quantity numeric, order_unit_price numeric, invoiced_unit_price numeric, quantity_variance numeric, price_variance numeric, line_total numeric, match_state text, detail text)"},{"sig":"public.neo_supplier_invoice_accept(uuid,text)","old_hash":"dc36db393c366c4b3e8fbd30c3ee1690","hash":"e23c4c22a3c48c7fbcca961b95438bac","body":"1cb2e313cbc65768dcbb947afe9e49e0","prosecdef":true,"provolatile":"v","proconfig":["search_path=public"],"result":"jsonb"}]$expected$::jsonb) LOOP
  IF NOT EXISTS(SELECT 1 FROM pg_proc p JOIN pg_roles owner ON owner.oid=p.proowner WHERE p.oid=to_regprocedure(expected->>'sig')
    AND owner.rolname NOT IN ('anon','authenticated') AND (md5(pg_get_functiondef(p.oid))=expected->>'old_hash' OR md5(regexp_replace(regexp_replace(p.prosrc,'--[^'||chr(10)||']*','','g'),'[[:space:]]','','g'))=expected->>'body')) THEN
   RAISE EXCEPTION 'Matching routine differs from reviewed installed code: %. Nothing replaced.',expected->>'sig';
  END IF;
 END LOOP;
END $guard$;
CREATE TEMP TABLE neo_supplier_matching_acl ON COMMIT DROP AS SELECT p.oid,p.proowner,coalesce(p.proacl::text,'') acl
 FROM jsonb_array_elements($acl$[{"sig":"public.proc_three_way_match(uuid)","old_hash":"35e8a205f2ebdd4b711b12754b8ef9a6","hash":"30f80d91085786080761bcb8c0324e3a","body":"7a3f00848253663b94932d93c475ed51","prosecdef":true,"provolatile":"v","proconfig":["search_path=public"],"result":"jsonb"},{"sig":"public.neo_ap_match_lines(uuid)","old_hash":"032d979eef53b55ba8b9721bbdccf812","hash":"913a670bf2147d43986ab4e4f454b6ef","body":"983d5da712fb3aef618bb685a4c16aa2","prosecdef":true,"provolatile":"s","proconfig":["search_path=public"],"result":"TABLE(line_id uuid, line_number integer, description text, stock_item_id uuid, ordered_quantity numeric, accepted_quantity numeric, received_quantity numeric, other_invoiced_quantity numeric, claimable_quantity numeric, invoiced_quantity numeric, order_unit_price numeric, invoiced_unit_price numeric, quantity_variance numeric, price_variance numeric, line_total numeric, match_state text, detail text)"},{"sig":"public.neo_supplier_invoice_accept(uuid,text)","old_hash":"dc36db393c366c4b3e8fbd30c3ee1690","hash":"e23c4c22a3c48c7fbcca961b95438bac","body":"1cb2e313cbc65768dcbb947afe9e49e0","prosecdef":true,"provolatile":"v","proconfig":["search_path=public"],"result":"jsonb"}]$acl$::jsonb) e(value) JOIN pg_proc p ON p.oid=to_regprocedure(value->>'sig');
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
  v_other_invoiced numeric; v_allowed numeric; v_tol numeric; v_current_invoiced numeric;
BEGIN
  
      -- neo_finance_invoice_matching_v1
      IF auth.uid() IS NULL
         OR public.current_org_id() IS NULL
         OR public.is_active_staff() IS NOT TRUE THEN
        RAISE EXCEPTION 'Active staff authentication required'
          USING ERRCODE = '42501';
      END IF;

      IF (
        public.has_permission('finance', 'edit') IS TRUE
        OR public.has_permission('finance', 'approve') IS TRUE
      ) IS NOT TRUE THEN
        PERFORM public.neo_assert_capability(
          'procurement', 'invoices', 'manage'
        );
      END IF;

  SELECT * INTO inv FROM supplier_invoices WHERE id = _invoice AND organization_id = v_org FOR UPDATE;
  IF inv IS NULL THEN RAISE EXCEPTION 'Invoice not found'; END IF;

      IF public.neo_branch_in_scope(inv.branch_id) IS NOT TRUE THEN
        RAISE EXCEPTION 'Invoice outside authorized property scope'
          USING ERRCODE = '42501';
      END IF;

  IF inv.amount IS NULL OR inv.amount<=0 OR inv.amount::text IN ('NaN','Infinity','-Infinity')
    OR inv.tax_amount IS NULL OR inv.tax_amount<0 OR inv.tax_amount>inv.amount OR inv.tax_amount::text IN ('NaN','Infinity','-Infinity') THEN
   RAISE EXCEPTION 'Invoice header amounts require reconciliation before matching';
  END IF;
  PERFORM 1 FROM public.supplier_invoice_lines WHERE supplier_invoice_id=_invoice FOR UPDATE;
  IF NOT EXISTS(SELECT 1 FROM public.supplier_invoice_lines WHERE supplier_invoice_id=_invoice)
    OR EXISTS(SELECT 1 FROM public.supplier_invoice_lines il WHERE il.supplier_invoice_id=_invoice AND
      (il.organization_id IS DISTINCT FROM v_org OR il.quantity IS NULL OR il.quantity<=0 OR il.unit_price IS NULL OR il.unit_price<0
       OR il.net_amount IS NULL OR il.net_amount<0 OR il.tax_amount IS NULL OR il.tax_amount<0 OR il.total_amount IS NULL OR il.total_amount<0
       OR il.quantity::text IN ('NaN','Infinity','-Infinity') OR il.unit_price::text IN ('NaN','Infinity','-Infinity')
       OR il.net_amount::text IN ('NaN','Infinity','-Infinity') OR il.tax_amount::text IN ('NaN','Infinity','-Infinity') OR il.total_amount::text IN ('NaN','Infinity','-Infinity')
       OR abs(il.net_amount+il.tax_amount-il.total_amount)>0.01 OR il.net_amount>round(il.quantity*il.unit_price,2)+0.01)) THEN
   RAISE EXCEPTION 'Invoice lines require finite consistent amounts in this workspace before matching';
  END IF;
  IF abs((SELECT sum(il.total_amount) FROM public.supplier_invoice_lines il WHERE il.supplier_invoice_id=_invoice)-inv.amount)>0.01
    OR abs((SELECT sum(il.tax_amount) FROM public.supplier_invoice_lines il WHERE il.supplier_invoice_id=_invoice)-inv.tax_amount)>0.01 THEN
   RAISE EXCEPTION 'Invoice header does not agree with its saved line totals and tax';
  END IF;
  pol := public.neo_matching_policy(v_org, inv.branch_id);
  IF pol.match_mode IS NULL OR pol.match_mode NOT IN ('two-way','three-way')
    OR EXISTS(SELECT 1 FROM unnest(ARRAY[pol.quantity_tolerance_pct,pol.price_tolerance_pct,pol.price_tolerance_amount]) value
       WHERE value<0 OR value::text IN ('NaN','Infinity','-Infinity')) THEN RAISE EXCEPTION 'Invoice matching policy requires valid finite tolerances'; END IF;

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
    SELECT * INTO po FROM purchase_orders WHERE id = inv.order_id AND organization_id = v_org FOR UPDATE;
    IF po.id IS NULL OR po.branch_id IS DISTINCT FROM inv.branch_id OR po.supplier_id IS DISTINCT FROM inv.supplier_id
      OR po.currency IS DISTINCT FROM public.neo_fact_currency(v_org,inv.branch_id) THEN RAISE EXCEPTION 'Invoice purchase order scope, supplier or currency requires review'; END IF;
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

      SELECT sum(current_line.quantity) INTO v_current_invoiced FROM public.supplier_invoice_lines current_line
       WHERE current_line.supplier_invoice_id=_invoice AND
        (current_line.stock_item_id=l.stock_item_id OR (l.stock_item_id IS NULL AND lower(coalesce(current_line.description,''))=lower(coalesce(l.description,''))));
      IF v_ordered::text IN ('NaN','Infinity','-Infinity') OR v_accepted::text IN ('NaN','Infinity','-Infinity')
        OR v_price::text IN ('NaN','Infinity','-Infinity') OR v_other_invoiced::text IN ('NaN','Infinity','-Infinity')
        OR v_ordered<0 OR v_accepted<0 OR v_price<0 OR v_other_invoiced<0 THEN RAISE EXCEPTION 'Purchase order or earlier invoice quantities need reconciliation'; END IF;
      v_allowed := CASE WHEN pol.match_mode = 'two-way' THEN v_ordered ELSE v_accepted END;
      v_allowed := v_allowed * (1 + COALESCE(pol.quantity_tolerance_pct,0)/100.0) - v_other_invoiced;

      IF v_current_invoiced > v_allowed + 0.0001 THEN
        INSERT INTO supplier_invoice_discrepancies (organization_id, supplier_invoice_id, order_id, stock_item_id, kind, severity, detail, expected_value, actual_value, variance)
        VALUES (v_org, _invoice, inv.order_id, l.stock_item_id, 'quantity-invoiced-over-received', 'critical',
                format('%s: invoiced %s but only %s claimable', COALESCE(l.item_name, l.description), v_current_invoiced, round(GREATEST(v_allowed,0),3)),
                GREATEST(v_allowed,0), v_current_invoiced, v_current_invoiced - GREATEST(v_allowed,0));
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
END $function$
;

CREATE OR REPLACE FUNCTION public.neo_ap_match_lines(_invoice uuid)
 RETURNS TABLE(line_id uuid, line_number integer, description text, stock_item_id uuid, ordered_quantity numeric, accepted_quantity numeric, received_quantity numeric, other_invoiced_quantity numeric, claimable_quantity numeric, invoiced_quantity numeric, order_unit_price numeric, invoiced_unit_price numeric, quantity_variance numeric, price_variance numeric, line_total numeric, match_state text, detail text)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE _org uuid := public.current_org_id(); inv record; pol public.procurement_matching_policies;
BEGIN
  IF auth.uid() IS NULL OR _org IS NULL OR NOT coalesce(public.is_org_admin() OR public.has_permission('finance','ap.view')
      OR public.has_permission('finance','view') OR public.can_read_general_ledger(),false) THEN
    RAISE EXCEPTION 'insufficient_privilege' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO inv FROM public.supplier_invoices WHERE id=_invoice AND organization_id=_org;
  IF inv.id IS NULL THEN RETURN; END IF;
  IF public.neo_branch_in_scope(inv.branch_id) IS NOT TRUE THEN RAISE EXCEPTION 'Invoice is outside your property scope' USING ERRCODE='42501'; END IF;
  IF EXISTS(SELECT 1 FROM public.supplier_invoice_lines il WHERE il.supplier_invoice_id=_invoice
    AND (il.organization_id IS DISTINCT FROM _org OR il.quantity IS NULL OR il.quantity<0
      OR il.quantity::text IN ('NaN','Infinity','-Infinity') OR il.unit_price IS NULL OR il.unit_price<0
      OR il.unit_price::text IN ('NaN','Infinity','-Infinity') OR il.total_amount IS NULL
      OR il.total_amount::text IN ('NaN','Infinity','-Infinity'))) THEN RAISE EXCEPTION 'Invoice report line amounts require reconciliation'; END IF;
  pol := public.neo_matching_policy(_org, inv.branch_id);
  IF pol.match_mode IS NULL OR pol.match_mode NOT IN ('two-way','three-way')
    OR EXISTS(SELECT 1 FROM unnest(ARRAY[pol.quantity_tolerance_pct,pol.price_tolerance_pct,pol.price_tolerance_amount]) value
      WHERE value<0 OR value::text IN ('NaN','Infinity','-Infinity')) THEN RAISE EXCEPTION 'Invoice report requires valid finite matching tolerances'; END IF;

  RETURN QUERY
  WITH lines AS (
    SELECT il.id, il.line_number, COALESCE(NULLIF(il.description,''), si.name, 'Item') AS description,
           il.stock_item_id, il.quantity, il.unit_price, il.total_amount
      FROM public.supplier_invoice_lines il
      LEFT JOIN public.stock_items si ON si.id = il.stock_item_id
     WHERE il.supplier_invoice_id = _invoice
  ), enriched AS (
    SELECT l.*,
      COALESCE((SELECT sum(pl.quantity) FROM public.purchase_order_lines pl
                 WHERE pl.order_id = inv.order_id
                   AND (pl.stock_item_id = l.stock_item_id
                        OR (l.stock_item_id IS NULL AND lower(COALESCE(pl.description,'')) = lower(l.description)))),0) AS ordered,
      COALESCE((SELECT sum(pl.accepted_quantity) FROM public.purchase_order_lines pl
                 WHERE pl.order_id = inv.order_id
                   AND (pl.stock_item_id = l.stock_item_id
                        OR (l.stock_item_id IS NULL AND lower(COALESCE(pl.description,'')) = lower(l.description)))),0) AS accepted,
      COALESCE((SELECT max(pl.unit_price) FROM public.purchase_order_lines pl
                 WHERE pl.order_id = inv.order_id
                   AND (pl.stock_item_id = l.stock_item_id
                        OR (l.stock_item_id IS NULL AND lower(COALESCE(pl.description,'')) = lower(l.description)))),0) AS po_price,
      COALESCE((SELECT sum(grl.quantity_received) FROM public.goods_receipt_lines grl
                 JOIN public.goods_receipts gr ON gr.id = grl.receipt_id
                WHERE gr.organization_id = _org AND gr.order_id = inv.order_id
                  AND grl.stock_item_id = l.stock_item_id),0) AS received,
      COALESCE((SELECT sum(ol.quantity) FROM public.supplier_invoice_lines ol
                 JOIN public.supplier_invoices oi ON oi.id = ol.supplier_invoice_id
                WHERE oi.organization_id = _org AND oi.order_id = inv.order_id AND oi.id <> _invoice
                  AND COALESCE(oi.status,'') NOT IN ('cancelled','void','rejected')
                  AND (ol.stock_item_id = l.stock_item_id
                       OR (l.stock_item_id IS NULL AND lower(COALESCE(ol.description,'')) = lower(l.description)))),0) AS other_invoiced
    FROM lines l
  ), allocated AS (
    SELECT e.*,LEAST(e.quantity,GREATEST((CASE WHEN pol.match_mode='two-way' THEN e.ordered ELSE e.accepted END)
       * (1+COALESCE(pol.quantity_tolerance_pct,0)/100.0)-e.other_invoiced
       -coalesce(sum(e.quantity) OVER(PARTITION BY e.stock_item_id,CASE WHEN e.stock_item_id IS NULL THEN lower(coalesce(e.description,'')) ELSE '' END
          ORDER BY e.line_number NULLS LAST,e.id ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING),0),0)) claimable
    FROM enriched e
  )
  SELECT e.id, e.line_number, e.description, e.stock_item_id,
         e.ordered, e.accepted, e.received, e.other_invoiced,
         e.claimable AS claimable,
         e.quantity, e.po_price, e.unit_price,
         e.quantity - e.claimable,
         CASE WHEN e.po_price > 0 THEN e.unit_price - e.po_price ELSE 0 END,
         COALESCE(e.total_amount, e.quantity * e.unit_price),
         CASE
           WHEN inv.order_id IS NULL THEN 'exception'
           WHEN e.ordered = 0 THEN 'exception'
           WHEN e.quantity > e.claimable + 0.0001 THEN 'exception'
           WHEN e.po_price > 0 AND e.unit_price > e.po_price
                + GREATEST(e.po_price * COALESCE(pol.price_tolerance_pct,0)/100.0, COALESCE(pol.price_tolerance_amount,0)) THEN 'exception'
           WHEN e.po_price > 0 AND abs(e.unit_price - e.po_price) > 0.009 THEN 'variance'
           WHEN pol.match_mode = 'three-way' AND e.accepted < e.ordered THEN 'variance'
           ELSE 'matched'
         END,
         CASE
           WHEN inv.order_id IS NULL THEN 'Invoice is not linked to a purchase order'
           WHEN e.ordered = 0 THEN 'Invoiced but not on the purchase order'
           WHEN e.quantity > e.claimable + 0.0001
             THEN format('Invoiced %s but only %s claimable', e.quantity, round(e.claimable,3))
           WHEN e.po_price > 0 AND abs(e.unit_price - e.po_price) > 0.009
             THEN format('Order price %s vs invoiced %s', e.po_price, e.unit_price)
           WHEN pol.match_mode = 'three-way' AND e.accepted < e.ordered
             THEN format('Ordered %s, accepted %s', e.ordered, e.accepted)
           ELSE 'Purchase order, receipt and invoice agree'
         END
    FROM allocated e
   ORDER BY e.line_number NULLS LAST, e.description;
END $function$
;

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

DO $verify$ DECLARE expected jsonb; BEGIN
 FOR expected IN SELECT value FROM jsonb_array_elements($expected$[{"sig":"public.proc_three_way_match(uuid)","old_hash":"35e8a205f2ebdd4b711b12754b8ef9a6","hash":"30f80d91085786080761bcb8c0324e3a","body":"7a3f00848253663b94932d93c475ed51","prosecdef":true,"provolatile":"v","proconfig":["search_path=public"],"result":"jsonb"},{"sig":"public.neo_ap_match_lines(uuid)","old_hash":"032d979eef53b55ba8b9721bbdccf812","hash":"913a670bf2147d43986ab4e4f454b6ef","body":"983d5da712fb3aef618bb685a4c16aa2","prosecdef":true,"provolatile":"s","proconfig":["search_path=public"],"result":"TABLE(line_id uuid, line_number integer, description text, stock_item_id uuid, ordered_quantity numeric, accepted_quantity numeric, received_quantity numeric, other_invoiced_quantity numeric, claimable_quantity numeric, invoiced_quantity numeric, order_unit_price numeric, invoiced_unit_price numeric, quantity_variance numeric, price_variance numeric, line_total numeric, match_state text, detail text)"},{"sig":"public.neo_supplier_invoice_accept(uuid,text)","old_hash":"dc36db393c366c4b3e8fbd30c3ee1690","hash":"e23c4c22a3c48c7fbcca961b95438bac","body":"1cb2e313cbc65768dcbb947afe9e49e0","prosecdef":true,"provolatile":"v","proconfig":["search_path=public"],"result":"jsonb"}]$expected$::jsonb) LOOP
  IF NOT EXISTS(SELECT 1 FROM pg_proc p JOIN neo_supplier_matching_acl saved ON saved.oid=p.oid AND saved.proowner=p.proowner AND saved.acl=coalesce(p.proacl::text,'')
    WHERE p.oid=to_regprocedure(expected->>'sig') AND p.prosecdef=(expected->>'prosecdef')::boolean
      AND p.provolatile::text=expected->>'provolatile' AND to_jsonb(p.proconfig)=expected->'proconfig'
      AND pg_get_function_result(p.oid)=expected->>'result' AND md5(regexp_replace(regexp_replace(p.prosrc,'--[^'||chr(10)||']*','','g'),'[[:space:]]','','g'))=expected->>'body') THEN
   RAISE EXCEPTION 'Matching definition or permission verification failed: %. Installation rolled back.',expected->>'sig';
  END IF;
 END LOOP;
END $verify$;
SELECT jsonb_build_object('diagnostic_version','supplier-matching-quantity-parity-v1','definitions_match',true,'routine_count',3,'permissions_unchanged',true,
 'scope','Validates future saved invoice matching, allocates claimable quantities once in AP reports and records approved invoice quantity once across repeated PO lines. Installation approves no invoice, changes no historical quantity and preserves permissions.');
COMMIT;
