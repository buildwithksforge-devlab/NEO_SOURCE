-- Reuse the installed customer-owned order projection and preserve its grants.
DO $migration$
DECLARE
  definition text := pg_get_functiondef('public.neo_guest_order_tracking(uuid,text)'::regprocedure);
  before_receipt constant text := $before$
  SELECT * INTO _pay FROM public.pos_payments
   WHERE order_id = _d.pos_order_id AND status IN ('paid','completed','captured')
   ORDER BY created_at DESC LIMIT 1;
$before$;
  after_receipt constant text := $after$
  -- neo_guest_delivery_receipt_v1
  SELECT receipt.receipt_number, receipt.paid_at
    INTO _pay.receipt_number, _pay.paid_at
    FROM (
      SELECT p.receipt_number, p.paid_at, p.created_at, p.id, 0 AS priority
        FROM public.payments p
       WHERE p.organization_id = _d.organization_id
         AND p.branch_id IS NOT DISTINCT FROM _d.branch_id
         AND p.customer_id = _d.customer_id
         AND p.source_module = 'delivery'
         AND p.source_record_id = _d.id
         AND p.status IN ('confirmed','completed','paid','succeeded','captured')
      UNION ALL
      SELECT p.receipt_number, p.paid_at, p.created_at, p.id, 1 AS priority
        FROM public.pos_payments p
       WHERE p.organization_id = _d.organization_id
         AND p.branch_id IS NOT DISTINCT FROM _d.branch_id
         AND p.order_id = _d.pos_order_id
         AND p.status IN ('confirmed','completed','paid','succeeded','captured')
    ) AS receipt
   WHERE _d.payment_status IN ('paid','settled','completed')
     AND nullif(btrim(receipt.receipt_number), '') IS NOT NULL
   ORDER BY receipt.priority, coalesce(receipt.paid_at, receipt.created_at) DESC NULLS LAST, receipt.id
   LIMIT 1;
$after$;
BEGIN
  IF strpos(definition, after_receipt) > 0 THEN
    RETURN;
  END IF;
  IF strpos(definition, before_receipt) = 0
     OR strpos(definition, 'AND customer_id = _cust') = 0
     OR (length(definition) - length(replace(definition, before_receipt, ''))) <> length(before_receipt) THEN
    RAISE EXCEPTION 'The installed Guest order tracking definition needs review before the receipt update';
  END IF;
  EXECUTE replace(definition, before_receipt, after_receipt);
END
$migration$;
