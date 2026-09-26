-- ============ 1. LPO extensions ============
ALTER TABLE public.purchase_orders
  ADD COLUMN IF NOT EXISTS department_id uuid REFERENCES public.departments(id),
  ADD COLUMN IF NOT EXISTS payment_terms text,
  ADD COLUMN IF NOT EXISTS delivery_address text,
  ADD COLUMN IF NOT EXISTS discount_amount numeric NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS prepared_by uuid,
  ADD COLUMN IF NOT EXISTS checked_by uuid,
  ADD COLUMN IF NOT EXISTS checked_at timestamptz,
  ADD COLUMN IF NOT EXISTS version integer NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS revision_of uuid REFERENCES public.purchase_orders(id),
  ADD COLUMN IF NOT EXISTS superseded_by uuid REFERENCES public.purchase_orders(id),
  ADD COLUMN IF NOT EXISTS revision_reason text,
  ADD COLUMN IF NOT EXISTS cancelled_by uuid,
  ADD COLUMN IF NOT EXISTS cancelled_at timestamptz,
  ADD COLUMN IF NOT EXISTS cancel_reason text,
  ADD COLUMN IF NOT EXISTS voided_by uuid,
  ADD COLUMN IF NOT EXISTS voided_at timestamptz,
  ADD COLUMN IF NOT EXISTS void_reason text,
  ADD COLUMN IF NOT EXISTS closed_by uuid,
  ADD COLUMN IF NOT EXISTS close_reason text,
  ADD COLUMN IF NOT EXISTS invoiced_amount numeric NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS paid_amount numeric NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS attachments jsonb NOT NULL DEFAULT '[]'::jsonb;

CREATE UNIQUE INDEX IF NOT EXISTS purchase_orders_number_unique
  ON public.purchase_orders (organization_id, order_number);

ALTER TABLE public.purchase_order_lines
  ADD COLUMN IF NOT EXISTS category_id uuid REFERENCES public.stock_categories(id),
  ADD COLUMN IF NOT EXISTS tax_rate numeric NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS tax_amount numeric NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS discount_amount numeric NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS accepted_quantity numeric NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS rejected_quantity numeric NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS returned_quantity numeric NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS invoiced_quantity numeric NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS cancelled_quantity numeric NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS close_reason text;

-- ============ 2. GRN extensions ============
ALTER TABLE public.goods_receipts
  ADD COLUMN IF NOT EXISTS inspected_by uuid,
  ADD COLUMN IF NOT EXISTS inspected_at timestamptz,
  ADD COLUMN IF NOT EXISTS delivery_date date,
  ADD COLUMN IF NOT EXISTS discrepancy_notes text,
  ADD COLUMN IF NOT EXISTS attachments jsonb NOT NULL DEFAULT '[]'::jsonb;

CREATE UNIQUE INDEX IF NOT EXISTS goods_receipts_number_unique
  ON public.goods_receipts (organization_id, grn_number);

ALTER TABLE public.goods_receipt_lines
  ADD COLUMN IF NOT EXISTS quantity_previously_received numeric NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS quantity_accepted numeric,
  ADD COLUMN IF NOT EXISTS quantity_rejected numeric NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS quantity_returned numeric NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS manufacture_date date,
  ADD COLUMN IF NOT EXISTS location_id uuid REFERENCES public.stock_locations(id),
  ADD COLUMN IF NOT EXISTS rejection_reason text,
  ADD COLUMN IF NOT EXISTS inspection_notes text;

-- ============ 3. RFQ / quotations ============
CREATE TABLE IF NOT EXISTS public.rfqs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL DEFAULT current_org_id(),
  branch_id uuid REFERENCES public.branches(id),
  request_id uuid REFERENCES public.purchase_requests(id),
  rfq_number text NOT NULL,
  title text,
  status text NOT NULL DEFAULT 'draft',
  issued_at timestamptz,
  closes_at timestamptz,
  notes text,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS rfqs_number_unique ON public.rfqs (organization_id, rfq_number);

CREATE TABLE IF NOT EXISTS public.rfq_suppliers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL DEFAULT current_org_id(),
  rfq_id uuid NOT NULL REFERENCES public.rfqs(id) ON DELETE CASCADE,
  supplier_id uuid NOT NULL REFERENCES public.suppliers(id),
  invited_at timestamptz NOT NULL DEFAULT now(),
  responded_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (rfq_id, supplier_id)
);

ALTER TABLE public.supplier_quotations
  ADD COLUMN IF NOT EXISTS branch_id uuid REFERENCES public.branches(id),
  ADD COLUMN IF NOT EXISTS rfq_id uuid REFERENCES public.rfqs(id),
  ADD COLUMN IF NOT EXISTS currency text NOT NULL DEFAULT 'KES',
  ADD COLUMN IF NOT EXISTS selected boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS selected_by uuid,
  ADD COLUMN IF NOT EXISTS selected_at timestamptz,
  ADD COLUMN IF NOT EXISTS selection_reason text;

CREATE TABLE IF NOT EXISTS public.supplier_quotation_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL DEFAULT current_org_id(),
  quotation_id uuid NOT NULL REFERENCES public.supplier_quotations(id) ON DELETE CASCADE,
  stock_item_id uuid REFERENCES public.stock_items(id),
  description text,
  quantity numeric NOT NULL DEFAULT 0,
  unit text,
  unit_price numeric NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.supplier_quotation_lines
  ADD COLUMN IF NOT EXISTS request_line_id uuid REFERENCES public.purchase_request_lines(id),
  ADD COLUMN IF NOT EXISTS tax_rate numeric NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS lead_time_days integer,
  ADD COLUMN IF NOT EXISTS notes text;

-- ============ 4. Three-way match discrepancies ============
CREATE TABLE IF NOT EXISTS public.supplier_invoice_discrepancies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL DEFAULT current_org_id(),
  supplier_invoice_id uuid NOT NULL REFERENCES public.supplier_invoices(id) ON DELETE CASCADE,
  order_id uuid REFERENCES public.purchase_orders(id),
  receipt_id uuid REFERENCES public.goods_receipts(id),
  stock_item_id uuid REFERENCES public.stock_items(id),
  kind text NOT NULL,
  severity text NOT NULL DEFAULT 'warning',
  detail text NOT NULL,
  expected_value numeric,
  actual_value numeric,
  variance numeric,
  resolved boolean NOT NULL DEFAULT false,
  resolved_by uuid,
  resolved_at timestamptz,
  resolution_reason text,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- ============ 5. Complimentary / special pricing register ============
CREATE TABLE IF NOT EXISTS public.complimentary_register (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL DEFAULT current_org_id(),
  branch_id uuid REFERENCES public.branches(id),
  department_id uuid REFERENCES public.departments(id),
  pricing_type text NOT NULL DEFAULT 'complimentary',
  category text NOT NULL DEFAULT 'meal',
  beneficiary_type text NOT NULL DEFAULT 'guest',
  beneficiary_name text NOT NULL,
  customer_id uuid REFERENCES public.customers(id),
  employee_id uuid REFERENCES public.employees(id),
  reference_type text,
  reference_id uuid,
  item_description text NOT NULL,
  quantity numeric NOT NULL DEFAULT 1,
  normal_selling_price numeric NOT NULL DEFAULT 0,
  actual_cost numeric NOT NULL DEFAULT 0,
  amount_charged numeric NOT NULL DEFAULT 0,
  reason text NOT NULL,
  requested_by uuid,
  approved_by uuid,
  approved_at timestamptz,
  status text NOT NULL DEFAULT 'pending',
  notes text,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.pos_order_items
  ADD COLUMN IF NOT EXISTS pricing_type text NOT NULL DEFAULT 'normal',
  ADD COLUMN IF NOT EXISTS normal_selling_price numeric,
  ADD COLUMN IF NOT EXISTS calculated_cost numeric,
  ADD COLUMN IF NOT EXISTS pricing_reason text,
  ADD COLUMN IF NOT EXISTS pricing_approved_by uuid,
  ADD COLUMN IF NOT EXISTS pricing_approved_at timestamptz,
  ADD COLUMN IF NOT EXISTS complimentary_id uuid REFERENCES public.complimentary_register(id);

-- ============ 6. Accounting sync log (QuickBooks) ============
CREATE TABLE IF NOT EXISTS public.accounting_sync_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL DEFAULT current_org_id(),
  branch_id uuid REFERENCES public.branches(id),
  provider_code text NOT NULL DEFAULT 'quickbooks',
  entity_type text NOT NULL,
  local_record_id uuid,
  local_reference text,
  external_reference text,
  status text NOT NULL DEFAULT 'pending',
  direction text NOT NULL DEFAULT 'push',
  attempt integer NOT NULL DEFAULT 1,
  error text,
  payload_digest text,
  synced_at timestamptz,
  performed_by uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS accounting_sync_unique_success
  ON public.accounting_sync_log (organization_id, provider_code, entity_type, local_record_id)
  WHERE status = 'synced';

-- ============ GRANTS + RLS ============
DO $$
DECLARE t text; perm text[];
BEGIN
  FOREACH t IN ARRAY ARRAY['rfqs','rfq_suppliers','supplier_quotation_lines','supplier_invoice_discrepancies','complimentary_register','accounting_sync_log'] LOOP
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON public.%I TO authenticated', t);
    EXECUTE format('GRANT ALL ON public.%I TO service_role', t);
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', t||'_select', t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', t||'_write', t);
    EXECUTE format('CREATE POLICY %I ON public.%I FOR SELECT TO authenticated USING (organization_id = current_org_id())', t||'_select', t);
  END LOOP;
END $$;

CREATE POLICY rfqs_write ON public.rfqs FOR ALL TO authenticated
  USING (organization_id = current_org_id() AND has_permission('procurement','orders.manage'))
  WITH CHECK (organization_id = current_org_id() AND has_permission('procurement','orders.manage'));
CREATE POLICY rfq_suppliers_write ON public.rfq_suppliers FOR ALL TO authenticated
  USING (organization_id = current_org_id() AND has_permission('procurement','orders.manage'))
  WITH CHECK (organization_id = current_org_id() AND has_permission('procurement','orders.manage'));
CREATE POLICY supplier_quotation_lines_write ON public.supplier_quotation_lines FOR ALL TO authenticated
  USING (organization_id = current_org_id() AND has_permission('procurement','orders.manage'))
  WITH CHECK (organization_id = current_org_id() AND has_permission('procurement','orders.manage'));
CREATE POLICY supplier_invoice_discrepancies_write ON public.supplier_invoice_discrepancies FOR ALL TO authenticated
  USING (organization_id = current_org_id() AND has_permission('finance','edit'))
  WITH CHECK (organization_id = current_org_id() AND has_permission('finance','edit'));
CREATE POLICY complimentary_register_write ON public.complimentary_register FOR ALL TO authenticated
  USING (organization_id = current_org_id() AND has_permission('restaurant','edit'))
  WITH CHECK (organization_id = current_org_id() AND has_permission('restaurant','edit'));
CREATE POLICY complimentary_register_approve ON public.complimentary_register FOR UPDATE TO authenticated
  USING (organization_id = current_org_id() AND has_permission('restaurant','approve'))
  WITH CHECK (organization_id = current_org_id() AND has_permission('restaurant','approve'));
CREATE POLICY accounting_sync_log_write ON public.accounting_sync_log FOR ALL TO authenticated
  USING (organization_id = current_org_id() AND has_permission('finance','edit'))
  WITH CHECK (organization_id = current_org_id() AND has_permission('finance','edit'));

-- ============ 7. No permanent deletion of transactional records ============
CREATE OR REPLACE FUNCTION public.proc_block_delete()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  RAISE EXCEPTION 'Transactional records cannot be deleted. Use cancellation, void, reversal, return or a credit note instead.';
END $$;
REVOKE ALL ON FUNCTION public.proc_block_delete() FROM public, anon;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['purchase_requests','purchase_orders','purchase_order_lines','goods_receipts','goods_receipt_lines','supplier_invoices','supplier_invoice_lines','supplier_payments','stock_movements','package_revenue_allocations','complimentary_register','accounting_sync_log'] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS %I ON public.%I', 'no_delete_'||t, t);
    EXECUTE format('CREATE TRIGGER %I BEFORE DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.proc_block_delete()', 'no_delete_'||t, t);
  END LOOP;
END $$;

-- ============ 8. Accepted-quantity receiving ============
CREATE OR REPLACE FUNCTION public.inventory_post_receipt(_receipt uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_org uuid := current_org_id();
  r record; l record;
  v_total numeric := 0; v_lines integer := 0; v_accepted numeric;
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

  RETURN jsonb_build_object('status','posted','lines',v_lines,'value',v_total,'accepted_value',v_total);
END $$;
REVOKE ALL ON FUNCTION public.inventory_post_receipt(uuid) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.inventory_post_receipt(uuid) TO authenticated;

-- ============ 9. Controlled LPO lifecycle actions ============
CREATE OR REPLACE FUNCTION public.proc_lpo_action(_order uuid, _action text, _reason text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_org uuid := current_org_id(); po record; v_prev jsonb;
BEGIN
  IF _reason IS NULL OR length(btrim(_reason)) < 5 THEN RAISE EXCEPTION 'A reason is required'; END IF;
  SELECT * INTO po FROM purchase_orders WHERE id = _order AND organization_id = v_org;
  IF po IS NULL THEN RAISE EXCEPTION 'Purchase order not found'; END IF;
  IF po.status IN ('voided','cancelled','closed') THEN RAISE EXCEPTION 'Order is already %', po.status; END IF;

  IF _action IN ('cancel','void','close') AND NOT has_permission('procurement','override') THEN
    RAISE EXCEPTION 'Not permitted to % a purchase order', _action;
  END IF;
  IF _action = 'approve' AND NOT has_permission('procurement','approve') THEN
    RAISE EXCEPTION 'Not permitted to approve purchase orders';
  END IF;
  IF _action = 'approve' AND po.created_by = auth.uid() THEN
    RAISE EXCEPTION 'Segregation of duties: the preparer of an order cannot approve it';
  END IF;

  v_prev := to_jsonb(po);

  IF _action = 'approve' THEN
    UPDATE purchase_orders SET status='approved', approved_by=auth.uid(), approved_at=now() WHERE id=_order;
  ELSIF _action = 'check' THEN
    UPDATE purchase_orders SET checked_by=auth.uid(), checked_at=now() WHERE id=_order;
  ELSIF _action = 'send' THEN
    UPDATE purchase_orders SET status='sent', sent_at=now() WHERE id=_order;
  ELSIF _action = 'cancel' THEN
    UPDATE purchase_orders SET status='cancelled', cancelled_by=auth.uid(), cancelled_at=now(), cancel_reason=_reason WHERE id=_order;
  ELSIF _action = 'void' THEN
    UPDATE purchase_orders SET status='voided', voided_by=auth.uid(), voided_at=now(), void_reason=_reason WHERE id=_order;
  ELSIF _action = 'close' THEN
    UPDATE purchase_order_lines SET
      cancelled_quantity = GREATEST(quantity - COALESCE(accepted_quantity,0), 0),
      close_reason = _reason
      WHERE order_id = _order AND COALESCE(accepted_quantity,0) < quantity;
    UPDATE purchase_orders SET status='closed', closed_by=auth.uid(), closed_at=now(), close_reason=_reason WHERE id=_order;
  ELSE
    RAISE EXCEPTION 'Unknown action %', _action;
  END IF;

  INSERT INTO audit_logs (organization_id, user_id, action, module, record_id, previous_value, new_value, reason, branch_id)
  VALUES (v_org, auth.uid(), 'procurement.lpo.'||_action, 'procurement', _order, v_prev,
          (SELECT to_jsonb(x) FROM purchase_orders x WHERE x.id=_order), _reason, po.branch_id);

  RETURN jsonb_build_object('status','ok','action',_action);
END $$;
REVOKE ALL ON FUNCTION public.proc_lpo_action(uuid,text,text) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.proc_lpo_action(uuid,text,text) TO authenticated;

-- ============ 10. Three-way matching ============
CREATE OR REPLACE FUNCTION public.proc_three_way_match(_invoice uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_org uuid := current_org_id();
  inv record; l record; v_count integer := 0; v_critical integer := 0;
  v_ordered numeric; v_accepted numeric; v_price numeric; v_dupe integer;
BEGIN
  SELECT * INTO inv FROM supplier_invoices WHERE id = _invoice AND organization_id = v_org;
  IF inv IS NULL THEN RAISE EXCEPTION 'Invoice not found'; END IF;

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

      IF l.quantity > v_accepted THEN
        INSERT INTO supplier_invoice_discrepancies (organization_id, supplier_invoice_id, order_id, stock_item_id, kind, severity, detail, expected_value, actual_value, variance)
        VALUES (v_org, _invoice, inv.order_id, l.stock_item_id, 'quantity-invoiced-over-received', 'critical',
                format('%s: invoiced %s but only %s accepted', COALESCE(l.item_name, l.description), l.quantity, v_accepted),
                v_accepted, l.quantity, l.quantity - v_accepted);
        v_count := v_count + 1; v_critical := v_critical + 1;
      END IF;

      IF v_accepted < v_ordered THEN
        INSERT INTO supplier_invoice_discrepancies (organization_id, supplier_invoice_id, order_id, stock_item_id, kind, severity, detail, expected_value, actual_value, variance)
        VALUES (v_org, _invoice, inv.order_id, l.stock_item_id, 'outstanding-delivery', 'warning',
                format('%s: ordered %s, accepted %s', COALESCE(l.item_name, l.description), v_ordered, v_accepted),
                v_ordered, v_accepted, v_ordered - v_accepted);
        v_count := v_count + 1;
      END IF;

      IF v_price > 0 AND abs(l.unit_price - v_price) > 0.009 THEN
        INSERT INTO supplier_invoice_discrepancies (organization_id, supplier_invoice_id, order_id, stock_item_id, kind, severity, detail, expected_value, actual_value, variance)
        VALUES (v_org, _invoice, inv.order_id, l.stock_item_id,
                'price-variance', CASE WHEN l.unit_price > v_price THEN 'critical' ELSE 'warning' END,
                format('%s: order price %s vs invoiced %s', COALESCE(l.item_name, l.description), v_price, l.unit_price),
                v_price, l.unit_price, l.unit_price - v_price);
        v_count := v_count + 1;
        IF l.unit_price > v_price THEN v_critical := v_critical + 1; END IF;
      END IF;
    END LOOP;
  END IF;

  UPDATE supplier_invoices
     SET match_status = CASE WHEN v_critical > 0 THEN 'held' WHEN v_count > 0 THEN 'review' ELSE 'matched' END,
         status = CASE WHEN v_critical > 0 AND status IN ('draft','received','pending') THEN 'held' ELSE status END
   WHERE id = _invoice;

  RETURN jsonb_build_object('discrepancies', v_count, 'critical', v_critical,
    'match_status', CASE WHEN v_critical > 0 THEN 'held' WHEN v_count > 0 THEN 'review' ELSE 'matched' END);
END $$;
REVOKE ALL ON FUNCTION public.proc_three_way_match(uuid) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.proc_three_way_match(uuid) TO authenticated;

-- ============ 11. Document trail ============
CREATE OR REPLACE FUNCTION public.proc_document_trail(_order uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE v_org uuid := current_org_id(); po record;
BEGIN
  SELECT * INTO po FROM purchase_orders WHERE id = _order AND organization_id = v_org;
  IF po IS NULL THEN RAISE EXCEPTION 'Purchase order not found'; END IF;

  RETURN jsonb_build_object(
    'order', to_jsonb(po),
    'supplier', (SELECT to_jsonb(s) FROM suppliers s WHERE s.id = po.supplier_id),
    'lines', (SELECT COALESCE(jsonb_agg(to_jsonb(pl) || jsonb_build_object('item_name',(SELECT name FROM stock_items WHERE id=pl.stock_item_id)) ORDER BY pl.created_at),'[]'::jsonb) FROM purchase_order_lines pl WHERE pl.order_id=_order),
    'request', (SELECT to_jsonb(pr) FROM purchase_requests pr WHERE pr.id = po.request_id),
    'request_lines', (SELECT COALESCE(jsonb_agg(to_jsonb(rl)),'[]'::jsonb) FROM purchase_request_lines rl WHERE rl.request_id = po.request_id),
    'approvals', (SELECT COALESCE(jsonb_agg(to_jsonb(aa) ORDER BY aa.created_at),'[]'::jsonb) FROM approval_actions aa WHERE aa.request_id = po.approval_request_id),
    'quotations', (SELECT COALESCE(jsonb_agg(to_jsonb(q)),'[]'::jsonb) FROM supplier_quotations q WHERE q.request_id = po.request_id),
    'revisions', (SELECT COALESCE(jsonb_agg(to_jsonb(v) ORDER BY v.version),'[]'::jsonb) FROM purchase_orders v WHERE v.revision_of = _order OR v.id = po.revision_of),
    'receipts', (SELECT COALESCE(jsonb_agg(to_jsonb(g) || jsonb_build_object('lines',(SELECT COALESCE(jsonb_agg(to_jsonb(gl) || jsonb_build_object('item_name',(SELECT name FROM stock_items WHERE id=gl.stock_item_id))),'[]'::jsonb) FROM goods_receipt_lines gl WHERE gl.receipt_id=g.id)) ORDER BY g.received_at),'[]'::jsonb) FROM goods_receipts g WHERE g.order_id=_order),
    'invoices', (SELECT COALESCE(jsonb_agg(to_jsonb(i) || jsonb_build_object('discrepancies',(SELECT COALESCE(jsonb_agg(to_jsonb(d)),'[]'::jsonb) FROM supplier_invoice_discrepancies d WHERE d.supplier_invoice_id=i.id))),'[]'::jsonb) FROM supplier_invoices i WHERE i.order_id=_order),
    'payments', (SELECT COALESCE(jsonb_agg(to_jsonb(p)),'[]'::jsonb) FROM supplier_payments p WHERE p.supplier_invoice_id IN (SELECT id FROM supplier_invoices WHERE order_id=_order)),
    'credit_notes', (SELECT COALESCE(jsonb_agg(to_jsonb(c)),'[]'::jsonb) FROM credit_notes c WHERE c.organization_id=v_org AND c.reference_id = _order),
    'audit', (SELECT COALESCE(jsonb_agg(to_jsonb(a) ORDER BY a.created_at DESC),'[]'::jsonb) FROM audit_logs a WHERE a.organization_id=v_org AND (a.record_id=_order OR a.record_id=po.request_id OR a.record_id IN (SELECT id FROM goods_receipts WHERE order_id=_order) OR a.record_id IN (SELECT id FROM supplier_invoices WHERE order_id=_order)))
  );
END $$;
REVOKE ALL ON FUNCTION public.proc_document_trail(uuid) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.proc_document_trail(uuid) TO authenticated;