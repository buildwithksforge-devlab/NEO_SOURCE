CREATE OR REPLACE FUNCTION public.proc_document_trail(_order uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
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
    -- Credit notes are raised against customer invoices and carry no link to a
    -- purchase order, so the supplier trail has none to show. The previous
    -- definition referenced a non-existent column and failed the whole trail.
    'credit_notes', '[]'::jsonb,
    'audit', (SELECT COALESCE(jsonb_agg(to_jsonb(a) ORDER BY a.created_at DESC),'[]'::jsonb) FROM audit_logs a WHERE a.organization_id=v_org AND (a.record_id = _order::text OR a.record_id = po.request_id::text OR a.record_id IN (SELECT id::text FROM goods_receipts WHERE order_id=_order) OR a.record_id IN (SELECT id::text FROM supplier_invoices WHERE order_id=_order)))
  );
END $function$;