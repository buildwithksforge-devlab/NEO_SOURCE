CREATE OR REPLACE FUNCTION public.neo_assert_capability(_module text, _feature text, _action text)
RETURNS void
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
  IF NOT public.has_permission(_module, _feature, _action) THEN
    RAISE EXCEPTION 'You do not have permission to perform this action (% / % / %)', _module, _feature, _action
      USING ERRCODE = '42501';
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.neo_assert_capability(text, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.neo_assert_capability(text, text, text) TO authenticated, service_role;

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
  PERFORM public.neo_assert_capability('procurement','invoices','manage');
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

CREATE OR REPLACE FUNCTION public.neo_stores_shortage_to_pr(_requisition uuid, _notes text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  _req internal_requisitions%ROWTYPE;
  _pr_id uuid;
  _number text;
  _total numeric := 0;
  _lines integer := 0;
BEGIN
  PERFORM public.neo_assert_capability('stores','requisitions','create');
  SELECT * INTO _req FROM internal_requisitions WHERE id = _requisition;
  IF _req.id IS NULL THEN
    RAISE EXCEPTION 'Requisition not found';
  END IF;
  IF _req.organization_id IS DISTINCT FROM current_org_id() THEN
    RAISE EXCEPTION 'Requisition belongs to another organisation';
  END IF;

  IF _req.purchase_request_id IS NOT NULL THEN
    SELECT request_number INTO _number FROM purchase_requests WHERE id = _req.purchase_request_id;
    RETURN jsonb_build_object('purchase_request_id', _req.purchase_request_id,
                              'request_number', _number, 'created', false);
  END IF;

  CREATE TEMP TABLE _shortage ON COMMIT DROP AS
  SELECT l.stock_item_id,
         COALESCE(NULLIF(l.description, ''), si.name, 'Item') AS description,
         COALESCE(NULLIF(l.unit, ''), si.base_unit, 'unit') AS unit,
         GREATEST(COALESCE(l.quantity_approved, l.quantity_requested) - COALESCE(l.quantity_issued, 0), 0) AS quantity,
         COALESCE(NULLIF(si.last_cost, 0), si.average_cost, 0) AS unit_price
  FROM internal_requisition_lines l
  LEFT JOIN stock_items si ON si.id = l.stock_item_id
  WHERE l.requisition_id = _requisition;

  DELETE FROM _shortage WHERE quantity <= 0;
  SELECT count(*), COALESCE(sum(quantity * unit_price), 0) INTO _lines, _total FROM _shortage;

  IF _lines = 0 THEN
    RAISE EXCEPTION 'Nothing is outstanding on this requisition, so there is no shortage to purchase';
  END IF;

  _number := next_document_number('purchase-request');

  INSERT INTO purchase_requests (organization_id, branch_id, department_id, request_number, title,
                                 justification, source, source_reference, status, priority,
                                 estimated_total, requested_by)
  VALUES (_req.organization_id, _req.branch_id, _req.department_id, _number,
          'Stores replenishment — ' || COALESCE(_req.request_number, 'requisition'),
          COALESCE(NULLIF(_notes, ''), 'Shortage routed from Stores'),
          'stores-shortage', _req.request_number, 'submitted',
          COALESCE(_req.priority, 'normal'), _total, auth.uid())
  RETURNING id INTO _pr_id;

  INSERT INTO purchase_request_lines (organization_id, request_id, stock_item_id, description,
                                      quantity, unit, estimated_unit_price)
  SELECT _req.organization_id, _pr_id, stock_item_id, description, quantity, unit, unit_price
  FROM _shortage;

  UPDATE internal_requisitions
     SET purchase_request_id = _pr_id,
         shortage_notes = COALESCE(NULLIF(_notes, ''), shortage_notes)
   WHERE id = _requisition;

  RETURN jsonb_build_object('purchase_request_id', _pr_id, 'request_number', _number,
                            'lines', _lines, 'estimated_total', _total, 'created', true);
END;
$function$;

CREATE OR REPLACE FUNCTION public.neo_cash_transfer_send(_amount numeric, _to_shift uuid DEFAULT NULL::uuid, _destination text DEFAULT 'till'::text, _notes text DEFAULT ''::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  _org uuid := public.current_org_id();
  _from public.pos_shifts; _to public.pos_shifts; _id uuid; _number text; _expected numeric;
BEGIN
  PERFORM public.neo_assert_capability('finance','till','edit');
  IF _amount IS NULL OR _amount <= 0 THEN RAISE EXCEPTION 'Transfer amount must be greater than zero'; END IF;

  SELECT * INTO _from FROM public.pos_shifts
   WHERE organization_id=_org AND cashier_id=auth.uid() AND status='open'
   ORDER BY opened_at DESC LIMIT 1 FOR UPDATE;
  IF _from.id IS NULL THEN RAISE EXCEPTION 'You do not hold an open till to send cash from'; END IF;

  _expected := public.cash_shift_expected(_from.id);
  IF _amount > COALESCE(_expected,0) + 0.009 THEN
    RAISE EXCEPTION 'You cannot send more than the cash your till currently holds';
  END IF;

  IF _destination = 'till' THEN
    IF _to_shift IS NULL THEN RAISE EXCEPTION 'Choose the till receiving the cash'; END IF;
    SELECT * INTO _to FROM public.pos_shifts WHERE id=_to_shift AND organization_id=_org;
    IF _to.id IS NULL OR _to.status <> 'open' THEN RAISE EXCEPTION 'The receiving till is not open'; END IF;
    IF _to.id = _from.id THEN RAISE EXCEPTION 'A till cannot transfer cash to itself'; END IF;
  END IF;

  _number := 'CT-' || to_char(now(),'YYMMDD') || '-' || upper(substr(replace(gen_random_uuid()::text,'-',''),1,5));

  INSERT INTO public.cash_transfers (organization_id, branch_id, transfer_number, from_shift_id,
    to_destination, to_shift_id, to_cashier_id, amount, sent_by, sent_at, status, notes)
  VALUES (_org, _from.branch_id, _number, _from.id, _destination, _to.id, _to.cashier_id, _amount,
    auth.uid(), now(), 'in_transit', COALESCE(_notes,''))
  RETURNING id INTO _id;

  PERFORM public.cash_record_movement(_from.id, 'drop', _amount,
    'Cash transfer ' || _number || COALESCE(' — ' || NULLIF(_notes,''), ''), _number);

  INSERT INTO public.audit_logs (organization_id, user_id, user_name, action, module, record_id, new_value)
  VALUES (_org, auth.uid(), '', 'finance.cash.transfer.send', 'finance', _id::text,
    jsonb_build_object('transfer_number',_number,'amount',_amount,'from_shift',_from.id,
      'to_shift',_to.id,'destination',_destination));

  RETURN jsonb_build_object('status','in_transit','transfer_id',_id,'transfer_number',_number,
    'amount',_amount,'to_shift_id',_to.id);
END; $function$;

CREATE OR REPLACE FUNCTION public.neo_cash_transfer_cancel(_transfer uuid, _reason text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE _org uuid := public.current_org_id(); _t public.cash_transfers; _from public.pos_shifts;
BEGIN
  PERFORM public.neo_assert_capability('finance','till','edit');
  IF COALESCE(trim(_reason),'') = '' THEN RAISE EXCEPTION 'A reason is required to cancel a transfer'; END IF;
  SELECT * INTO _t FROM public.cash_transfers WHERE id=_transfer AND organization_id=_org FOR UPDATE;
  IF _t.id IS NULL THEN RAISE EXCEPTION 'Transfer not found'; END IF;
  IF _t.status <> 'in_transit' THEN RAISE EXCEPTION 'Transfer is % and cannot be cancelled', _t.status; END IF;
  IF _t.sent_by <> auth.uid() AND NOT public.is_org_admin() THEN
    RAISE EXCEPTION 'Only the sending cashier can cancel this transfer' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO _from FROM public.pos_shifts WHERE id=_t.from_shift_id AND organization_id=_org;
  IF _from.id IS NOT NULL AND _from.status = 'open' THEN
    PERFORM public.cash_record_movement(_from.id, 'float_top_up', _t.amount,
      'Cash transfer ' || _t.transfer_number || ' cancelled — ' || _reason, _t.transfer_number);
  END IF;

  UPDATE public.cash_transfers SET status='cancelled', cancelled_reason=_reason, updated_at=now()
   WHERE id=_t.id;

  INSERT INTO public.audit_logs (organization_id, user_id, user_name, action, module, record_id, new_value, reason)
  VALUES (_org, auth.uid(), '', 'finance.cash.transfer.cancel', 'finance', _t.id::text,
    jsonb_build_object('transfer_number',_t.transfer_number,'amount',_t.amount), _reason);

  RETURN jsonb_build_object('status','cancelled','transfer_id',_t.id);
END; $function$;

CREATE OR REPLACE FUNCTION public.neo_cash_refund_settle(_refund uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  _org uuid := public.current_org_id(); _r public.cash_refund_requests;
  _s public.pos_shifts; _f public.folios; _pay uuid; _receipt text;
BEGIN
  PERFORM public.neo_assert_capability('finance','payments','refund_payment');
  SELECT * INTO _r FROM public.cash_refund_requests WHERE id=_refund AND organization_id=_org FOR UPDATE;
  IF _r.id IS NULL THEN RAISE EXCEPTION 'Refund not found'; END IF;
  IF _r.status = 'settled' THEN
    RETURN jsonb_build_object('status','settled','refund_id',_r.id,
      'refund_receipt_number',_r.refund_receipt_number,'payment_id',_r.refund_payment_id);
  END IF;
  IF _r.status <> 'approved' THEN RAISE EXCEPTION 'Refund is % and cannot be paid out', _r.status; END IF;

  SELECT * INTO _s FROM public.pos_shifts
   WHERE organization_id=_org AND cashier_id=auth.uid() AND status='open'
   ORDER BY opened_at DESC LIMIT 1 FOR UPDATE;
  IF _s.id IS NULL THEN RAISE EXCEPTION 'Open your till before paying out a cash refund'; END IF;

  _receipt := public.next_document_number('receipt');

  INSERT INTO public.payments (organization_id, branch_id, receipt_number, folio_id, amount, currency,
    method, external_reference, status, received_by, notes, shift_id, source_module, source_record_id,
    idempotency_key)
  VALUES (_org, _r.branch_id, _receipt, _r.folio_id, -1 * _r.amount, _r.currency, 'cash',
    _r.original_receipt_number, 'confirmed', auth.uid(),
    'Refund of receipt ' || COALESCE(_r.original_receipt_number,'—') || ' — ' || _r.reason,
    _s.id, 'cash_refund', _r.id, 'cash-refund:' || _r.id::text)
  RETURNING id INTO _pay;

  IF _r.folio_id IS NOT NULL THEN
    SELECT * INTO _f FROM public.folios WHERE id=_r.folio_id AND organization_id=_org FOR UPDATE;
    IF _f.id IS NOT NULL THEN
      UPDATE public.folios SET total_payments = COALESCE(total_payments,0) - _r.amount,
        balance = COALESCE(balance,0) + _r.amount, updated_at = now() WHERE id=_f.id;
    END IF;
  END IF;

  IF _r.pos_payment_id IS NOT NULL THEN
    UPDATE public.pos_payments SET status='refunded', updated_at=now() WHERE id=_r.pos_payment_id;
  END IF;

  PERFORM public.cash_record_movement(_s.id, 'refund', _r.amount,
    'Cash refund of receipt ' || COALESCE(_r.original_receipt_number,'—') || ' — ' || _r.reason, _receipt);

  UPDATE public.cash_refund_requests
     SET status='settled', settled_by=auth.uid(), settled_at=now(), refund_payment_id=_pay,
         refund_receipt_number=_receipt, shift_id=_s.id, updated_at=now()
   WHERE id=_r.id;

  INSERT INTO public.audit_logs (organization_id, user_id, user_name, action, module, record_id, new_value, reason)
  VALUES (_org, auth.uid(), '', 'finance.cash.refund.settle', 'finance', _pay::text,
    jsonb_build_object('refund_id',_r.id,'amount',_r.amount,'shift_id',_s.id,
      'original_receipt',_r.original_receipt_number,'refund_receipt',_receipt), _r.reason);

  RETURN jsonb_build_object('status','settled','refund_id',_r.id,'payment_id',_pay,
    'refund_receipt_number',_receipt,'amount',_r.amount);
END; $function$;