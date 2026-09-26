CREATE OR REPLACE FUNCTION public.neo_commerce_can_reconcile()
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $$
  SELECT public.has_permission('finance','reports','view')
      OR public.has_permission('finance','payments','create')
      OR public.has_permission('finance','approve')
      OR public.has_permission('pos','orders','view')
      OR public.has_permission('restaurant','orders','view')
      OR public.is_org_admin();
$$;

REVOKE ALL ON FUNCTION public.neo_commerce_can_reconcile() FROM anon;
GRANT EXECUTE ON FUNCTION public.neo_commerce_can_reconcile() TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.neo_commerce_reconciliation(
  _branch uuid DEFAULT NULL,
  _from timestamptz DEFAULT (now() - interval '7 days'),
  _to timestamptz DEFAULT now()
)
RETURNS TABLE(
  check_key text,
  severity text,
  subject text,
  detail text,
  record_id uuid,
  reference text,
  occurred_at timestamptz
)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $$
DECLARE
  v_org uuid := public.current_org_id();
BEGIN
  IF v_org IS NULL OR NOT public.neo_commerce_can_reconcile() THEN
    RAISE EXCEPTION 'Not permitted to run the commerce reconciliation monitor'
      USING ERRCODE = '42501';
  END IF;

  IF _branch IS NOT NULL AND NOT (_branch = ANY (public.current_branch_ids())) THEN
    RAISE EXCEPTION 'Property outside your access scope' USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
  -- 1. Order without any production ticket
  SELECT 'order_without_ticket', 'error', 'Order',
         'Order has sellable lines but no production ticket was created.',
         o.id, o.order_number, o.created_at
    FROM public.pos_orders o
   WHERE o.organization_id = v_org
     AND (_branch IS NULL OR o.branch_id = _branch)
     AND o.created_at BETWEEN _from AND _to
     AND o.status NOT IN ('draft','cancelled','voided')
     AND EXISTS (SELECT 1 FROM public.pos_order_items i WHERE i.order_id = o.id)
     AND NOT EXISTS (SELECT 1 FROM public.station_tickets t WHERE t.order_id = o.id)

  UNION ALL
  -- 2. Production ticket without an order
  SELECT 'ticket_without_order', 'error', 'Production ticket',
         'Ticket exists with no parent order record.',
         t.id, t.ticket_number, COALESCE(t.received_at, t.created_at)
    FROM public.station_tickets t
   WHERE t.organization_id = v_org
     AND (_branch IS NULL OR t.branch_id = _branch)
     AND COALESCE(t.received_at, t.created_at) BETWEEN _from AND _to
     AND (t.order_id IS NULL
          OR NOT EXISTS (SELECT 1 FROM public.pos_orders o WHERE o.id = t.order_id))

  UNION ALL
  -- 3. Paid order without a receipt
  SELECT 'paid_order_without_receipt', 'error', 'Order',
         'Order is marked paid but no receipt was issued.',
         o.id, o.order_number, o.created_at
    FROM public.pos_orders o
   WHERE o.organization_id = v_org
     AND (_branch IS NULL OR o.branch_id = _branch)
     AND o.created_at BETWEEN _from AND _to
     AND o.payment_status = 'paid'
     AND NOT EXISTS (
       SELECT 1 FROM public.pos_payments p
        WHERE p.order_id = o.id AND p.status <> 'reversed'
          AND p.receipt_number IS NOT NULL)

  UNION ALL
  -- 4. Receipt without a journal
  SELECT 'receipt_without_journal', 'error', 'Receipt',
         'Payment receipt has no matching journal entry.',
         p.id, p.receipt_number, p.created_at
    FROM public.pos_payments p
   WHERE p.organization_id = v_org
     AND (_branch IS NULL OR p.branch_id = _branch)
     AND p.created_at BETWEEN _from AND _to
     AND p.status = 'completed'
     AND NOT EXISTS (
       SELECT 1 FROM public.journal_entries j
        WHERE j.organization_id = p.organization_id
          AND (j.source_document_id = p.id OR j.source_document_id = p.order_id))

  UNION ALL
  -- 5. Journal without ledger lines
  SELECT 'journal_without_lines', 'error', 'Journal',
         'Journal entry has no ledger lines.',
         j.id, j.journal_number, j.created_at
    FROM public.journal_entries j
   WHERE j.organization_id = v_org
     AND (_branch IS NULL OR j.branch_id = _branch)
     AND j.created_at BETWEEN _from AND _to
     AND NOT EXISTS (SELECT 1 FROM public.journal_entry_lines l WHERE l.journal_id = j.id)

  UNION ALL
  -- 6. Journal whose lines do not agree with its totals
  SELECT 'journal_lines_disagree', 'error', 'Journal',
         'Ledger lines do not sum to the journal debit/credit totals.',
         j.id, j.journal_number, j.created_at
    FROM public.journal_entries j
   WHERE j.organization_id = v_org
     AND (_branch IS NULL OR j.branch_id = _branch)
     AND j.created_at BETWEEN _from AND _to
     AND EXISTS (SELECT 1 FROM public.journal_entry_lines l WHERE l.journal_id = j.id)
     AND (
       COALESCE(j.total_debit,0) <> COALESCE((SELECT sum(l.debit) FROM public.journal_entry_lines l WHERE l.journal_id = j.id),0)
       OR COALESCE(j.total_credit,0) <> COALESCE((SELECT sum(l.credit) FROM public.journal_entry_lines l WHERE l.journal_id = j.id),0)
     )

  UNION ALL
  -- 7. Failed or stuck inventory posting
  SELECT 'inventory_posting_failed', 'warning', 'Inventory posting',
         COALESCE(e.payload->>'error', 'Inventory posting did not complete.'),
         e.id, e.posting_type, e.created_at
    FROM public.inventory_posting_events e
   WHERE e.organization_id = v_org
     AND (_branch IS NULL OR e.branch_id = _branch)
     AND e.created_at BETWEEN _from AND _to
     AND e.status <> 'posted'

  UNION ALL
  -- 8. Closed order with no stock movement at all
  SELECT 'closed_order_without_stock_movement', 'warning', 'Order',
         'Order is closed but no inventory consumption was recorded. Usually a missing recipe or an unstocked ingredient.',
         o.id, o.order_number, o.created_at
    FROM public.pos_orders o
   WHERE o.organization_id = v_org
     AND (_branch IS NULL OR o.branch_id = _branch)
     AND o.created_at BETWEEN _from AND _to
     AND o.status IN ('closed','completed')
     AND NOT EXISTS (
       SELECT 1 FROM public.stock_movements m
        WHERE m.organization_id = o.organization_id AND m.reference_id = o.id)

  UNION ALL
  -- 9. Duplicate stock movement for one reference and item
  SELECT 'duplicate_stock_movement', 'error', 'Stock movement',
         'More than one consumption movement exists for the same order line and item.',
         min(m.id), m.movement_type, min(m.created_at)
    FROM public.stock_movements m
   WHERE m.organization_id = v_org
     AND (_branch IS NULL OR m.branch_id = _branch)
     AND m.created_at BETWEEN _from AND _to
     AND m.idempotency_key IS NOT NULL
   GROUP BY m.idempotency_key, m.stock_item_id, m.movement_type
  HAVING count(*) > 1

  UNION ALL
  -- 10. Guest-facing status disagrees with the operational order
  SELECT 'guest_status_mismatch', 'warning', 'Delivery order',
         'Guest tracker status does not match the kitchen/POS state of the same order.',
         d.id, d.order_number, d.created_at
    FROM public.delivery_orders d
    JOIN public.pos_orders o ON o.id = d.pos_order_id
   WHERE d.organization_id = v_org
     AND (_branch IS NULL OR d.branch_id = _branch)
     AND d.created_at BETWEEN _from AND _to
     AND (
       (o.payment_status = 'paid' AND d.payment_status <> 'paid')
       OR (o.status IN ('closed','completed') AND d.order_status NOT IN ('completed','delivered','cancelled'))
     )

  UNION ALL
  -- 11. Cross-property mismatch between guest order and operational order
  SELECT 'cross_property_mismatch', 'error', 'Delivery order',
         'Guest order and its operational order belong to different properties or organisations.',
         d.id, d.order_number, d.created_at
    FROM public.delivery_orders d
    JOIN public.pos_orders o ON o.id = d.pos_order_id
   WHERE d.organization_id = v_org
     AND (_branch IS NULL OR d.branch_id = _branch)
     AND d.created_at BETWEEN _from AND _to
     AND (d.branch_id <> o.branch_id OR d.organization_id <> o.organization_id)

  UNION ALL
  -- 12. Cart that has produced more than one order
  SELECT 'cart_produced_duplicate_orders', 'error', 'Cart',
         'One cart is linked to more than one placed order.',
         c.id, c.id::text, c.created_at
    FROM public.carts c
   WHERE c.organization_id = v_org
     AND (_branch IS NULL OR c.branch_id = _branch)
     AND c.created_at BETWEEN _from AND _to
     AND (SELECT count(*) FROM public.delivery_orders d
           WHERE d.organization_id = c.organization_id
             AND d.notes IS NOT NULL
             AND d.notes LIKE '%' || c.id::text || '%') > 1

  ORDER BY 2, 1, 7 DESC;
END;
$$;

REVOKE ALL ON FUNCTION public.neo_commerce_reconciliation(uuid, timestamptz, timestamptz) FROM anon;
GRANT EXECUTE ON FUNCTION public.neo_commerce_reconciliation(uuid, timestamptz, timestamptz) TO authenticated, service_role;