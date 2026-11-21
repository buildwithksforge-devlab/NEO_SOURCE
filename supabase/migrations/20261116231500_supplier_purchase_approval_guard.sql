-- STAGED ONLY: require an approved purchase lifecycle for future order-linked invoice matching.
-- No invoice, payable, stock or historical accounting row is changed by installation.
BEGIN;
DO $guard$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_proc p JOIN pg_roles r ON r.oid=p.proowner
   WHERE p.oid=to_regprocedure('public.proc_three_way_match(uuid)') AND r.rolname NOT IN ('anon','authenticated')
   AND md5(regexp_replace(regexp_replace(p.prosrc,'--[^'||chr(10)||']*','','g'),'[[:space:]]','','g')) IN ('7a3f00848253663b94932d93c475ed51','d61412ceddb00ff4221deb8e4d5136c1')) THEN
   RAISE EXCEPTION 'Supplier matcher differs from reviewed source; nothing replaced';
 END IF;
END $guard$;
CREATE TEMP TABLE neo_supplier_order_guard_acl ON COMMIT DROP AS SELECT proowner,coalesce(proacl::text,'') AS acl
 FROM pg_proc WHERE oid='public.proc_three_way_match(uuid)'::regprocedure;
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
    -- An override reason may resolve a matching variance, never authorize a draft purchase.
    IF po.status IS NULL OR po.status NOT IN (
      'approved','pending-delivery','sent','partially-received','partially_received',
      'received','fully-received','fully_received','completed','closed',
      'partially-invoiced','partially_invoiced','invoiced','fully-invoiced','paid') THEN
      RAISE EXCEPTION 'Purchase order must be approved before its supplier invoice can be matched or accepted (current status: %)', coalesce(po.status,'missing') USING ERRCODE='23514';
    END IF;
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
DO $verify$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_proc p CROSS JOIN neo_supplier_order_guard_acl old
   WHERE p.oid='public.proc_three_way_match(uuid)'::regprocedure AND p.proowner=old.proowner AND coalesce(p.proacl::text,'')=old.acl) THEN
   RAISE EXCEPTION 'Supplier matcher owner or grants changed';
 END IF;
END $verify$;
COMMIT;
