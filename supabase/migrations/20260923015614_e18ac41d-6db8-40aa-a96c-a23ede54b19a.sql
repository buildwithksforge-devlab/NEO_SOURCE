CREATE OR REPLACE FUNCTION public.neo_commerce_reconciliation(
  _branch uuid DEFAULT NULL::uuid,
  _from timestamp with time zone DEFAULT (now() - '7 days'::interval),
  _to timestamp with time zone DEFAULT now())
 RETURNS TABLE(check_key text, severity text, subject text, detail text, record_id uuid, reference text, occurred_at timestamp with time zone)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
  SELECT 'journal_without_lines', 'error', 'Journal',
         'Journal entry has no ledger lines.',
         j.id, j.journal_number, j.created_at
    FROM public.journal_entries j
   WHERE j.organization_id = v_org
     AND (_branch IS NULL OR j.branch_id = _branch)
     AND j.created_at BETWEEN _from AND _to
     AND NOT EXISTS (SELECT 1 FROM public.journal_entry_lines l WHERE l.journal_id = j.id)

  UNION ALL
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
  SELECT 'inventory_posting_failed', 'warning', 'Inventory posting',
         COALESCE(e.payload->>'error', e.payload->>'reason', 'Inventory posting did not complete.'),
         e.id, e.posting_type, e.created_at
    FROM public.inventory_posting_events e
   WHERE e.organization_id = v_org
     AND (_branch IS NULL OR e.branch_id = _branch)
     AND e.created_at BETWEEN _from AND _to
     AND e.status <> 'posted'

  UNION ALL
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
  SELECT * FROM (
    SELECT 'duplicate_stock_movement'::text, 'error'::text, 'Stock movement'::text,
           'More than one consumption movement exists for the same order line and item.'::text,
           (array_agg(m.id ORDER BY m.created_at))[1] AS record_id,
           m.movement_type::text,
           min(m.created_at) AS occurred_at
      FROM public.stock_movements m
     WHERE m.organization_id = v_org
       AND (_branch IS NULL OR m.branch_id = _branch)
       AND m.created_at BETWEEN _from AND _to
       AND m.idempotency_key IS NOT NULL
     GROUP BY m.idempotency_key, m.stock_item_id, m.movement_type
    HAVING count(*) > 1
  ) dup

  UNION ALL
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
  SELECT * FROM (
    SELECT 'cart_produced_duplicate_orders'::text, 'error'::text, 'Cart'::text,
           'One cart is linked to more than one placed order.'::text,
           (array_agg(d.id ORDER BY d.created_at))[1] AS record_id,
           min(d.order_number)::text,
           min(d.created_at) AS occurred_at
      FROM public.delivery_orders d
     WHERE d.organization_id = v_org
       AND (_branch IS NULL OR d.branch_id = _branch)
       AND d.created_at BETWEEN _from AND _to
       AND d.cart_id IS NOT NULL
     GROUP BY d.cart_id
    HAVING count(*) > 1
  ) dupcart

  ORDER BY 2, 1, 7 DESC;
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.neo_commerce_reconciliation(uuid, timestamptz, timestamptz) FROM anon;
GRANT EXECUTE ON FUNCTION public.neo_commerce_reconciliation(uuid, timestamptz, timestamptz) TO authenticated;