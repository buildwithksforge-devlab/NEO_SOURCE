CREATE OR REPLACE FUNCTION public.neo_finance_posting_queue(_branch uuid DEFAULT NULL::uuid, _from date DEFAULT NULL::date, _to date DEFAULT NULL::date)
 RETURNS TABLE(source_module text, source_id uuid, reference text, source_status text, amount numeric, currency text, occurred_on date, eligible boolean, posting_status text, rule text, required_action text, drill_to text, last_error text)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE org uuid := public.current_org_id(); tz text; t date; f date; cur text;
BEGIN
  IF org IS NULL OR NOT (public.is_org_admin() OR public.has_permission('finance','view')) THEN
    RAISE EXCEPTION 'insufficient_privilege' USING ERRCODE = '42501';
  END IF;
  tz := public.neo_fact_timezone(org, _branch);
  cur := public.neo_fact_currency(org, _branch);
  t := coalesce(_to, (now() AT TIME ZONE tz)::date);
  f := coalesce(_from, t - 29);

  RETURN QUERY
  WITH receipts AS (
    SELECT r.idempotency_key, r.status, r.last_error FROM public.finance_posting_receipts r
     WHERE r.organization_id = org
  ), q AS (
    SELECT 'pos'::text AS m, o.id, o.order_number AS ref, o.status AS st,
           o.grand_total AS amt, (o.created_at AT TIME ZONE tz)::date AS d,
           (o.status IN ('closed','paid','settled','completed') AND o.folio_post_status IS DISTINCT FROM 'posted'
             AND (o.folio_id IS NOT NULL
                  OR o.corporate_account_id IS NOT NULL
                  OR public.neo_pos_settlement_evidence(o.id))
             AND coalesce((public.neo_source_integrity('pos', o.id)->>'ok')::boolean, false)) AS ok,
           ('A point-of-sale order is revenue once it is finalised and settled. A settled cash, card or mobile-money sale '
            || 'posts straight to Finance; an order charged to a room posts through the guest folio.')::text AS rule,
           CASE WHEN o.status NOT IN ('closed','paid','settled','completed')
                  THEN 'Finalise the order in Point of Sale (close, settle or mark paid).'
                WHEN o.folio_id IS NULL AND o.corporate_account_id IS NULL
                     AND NOT public.neo_pos_settlement_evidence(o.id)
                  THEN 'Record the payment against this order, or charge it to a guest folio.'
                WHEN NOT coalesce((public.neo_source_integrity('pos', o.id)->>'ok')::boolean, false)
                  THEN 'Posting blocked — source integrity mismatch. '
                       || coalesce((SELECT string_agg(i->>'detail',' ')
                                      FROM jsonb_array_elements(public.neo_source_integrity('pos', o.id)->'issues') i), '')
                ELSE 'Post to Finance.' END::text AS act,
           '/pos/orders'::text AS drill
      FROM public.pos_orders o
     WHERE o.organization_id = org AND (_branch IS NULL OR o.branch_id = _branch)
       AND (o.created_at AT TIME ZONE tz)::date BETWEEN f AND t
       AND o.status NOT IN ('void','voided','cancelled')
       AND o.folio_post_status IS DISTINCT FROM 'posted'
    UNION ALL
    SELECT 'laundry', l.id, coalesce(l.laundry_number, l.id::text), l.status, l.total,
           (l.created_at AT TIME ZONE tz)::date,
           (l.status IN ('delivered','completed','closed') AND l.posting_status IS DISTINCT FROM 'posted'
             AND (l.folio_id IS NOT NULL OR l.reservation_id IS NOT NULL)),
           'A guest laundry order is revenue once it is delivered or completed and reaches an open folio.',
           CASE WHEN l.status NOT IN ('delivered','completed','closed')
                  THEN 'Complete the laundry order and return the items to the guest.'
                WHEN l.folio_id IS NULL AND l.reservation_id IS NULL
                  THEN 'Link the order to a reservation or folio so the charge has an account.'
                ELSE 'Post to Finance.' END,
           '/laundry'
      FROM public.guest_laundry_orders l
     WHERE l.organization_id = org AND (_branch IS NULL OR l.branch_id = _branch)
       AND (l.created_at AT TIME ZONE tz)::date BETWEEN f AND t
       AND l.status NOT IN ('cancelled')
       AND l.posting_status IS DISTINCT FROM 'posted'
    UNION ALL
    SELECT 'events', e.id, coalesce(e.event_reference, e.id::text), e.status, e.total_amount, e.event_date,
           (e.status IN ('confirmed','completed')
             AND coalesce(e.billing_status,'not_billed') = 'finalised'
             AND EXISTS (
              SELECT 1 FROM public.event_billing_items b
               WHERE b.booking_id = e.id AND b.folio_id IS NOT NULL
                 AND coalesce(b.is_complimentary,false) = false)),
           'An event becomes revenue when the booking is confirmed or completed, its bill is finalised, and its billing items sit on an event folio.',
           CASE WHEN e.status NOT IN ('confirmed','completed')
                  THEN 'Confirm the event booking before it can be recognised.'
                WHEN NOT EXISTS (SELECT 1 FROM public.event_billing_items b WHERE b.booking_id = e.id)
                  THEN 'Build the event bill from the banquet event order.'
                WHEN coalesce(e.billing_status,'not_billed') <> 'finalised'
                  THEN 'Finalise the event bill in Event Billing.'
                ELSE 'Attach the billing items to an open event folio, then post to Finance.' END,
           '/events/bookings'
      FROM public.event_bookings e
     WHERE e.organization_id = org AND (_branch IS NULL OR e.branch_id = _branch)
       AND e.event_date BETWEEN f AND t
       AND e.status NOT IN ('cancelled','lost')
    UNION ALL
    SELECT 'delivery', d.id, d.order_number, d.order_status, d.grand_total,
           (d.created_at AT TIME ZONE tz)::date,
           (d.order_status = 'delivered'),
           'A delivery order is revenue once the rider confirms delivery.',
           CASE WHEN d.order_status <> 'delivered'
                  THEN 'Complete the dispatch and confirm delivery with the recipient PIN.'
                ELSE 'Post to Finance.' END,
           '/delivery'
      FROM public.delivery_orders d
     WHERE d.organization_id = org AND (_branch IS NULL OR d.branch_id = _branch)
       AND (d.created_at AT TIME ZONE tz)::date BETWEEN f AND t
       AND d.order_status NOT IN ('cancelled','rejected','failed')
    UNION ALL
    -- Stores: a goods receipt recognises inventory and the goods-received liability.
    SELECT 'inventory', g.id, coalesce(g.grn_number, g.id::text), g.status, coalesce(g.total_value,0),
           coalesce(g.delivery_date, (g.received_at AT TIME ZONE tz)::date, (g.created_at AT TIME ZONE tz)::date),
           (g.status IN ('received','accepted','completed','closed')
             AND g.accrual_journal_id IS NULL AND g.reversed_at IS NULL),
           'A goods receipt recognises stock on hand and a goods-received-not-invoiced liability on the day the goods are accepted.',
           CASE WHEN g.reversed_at IS NOT NULL THEN 'This receipt was reversed — no further posting is required.'
                WHEN g.status NOT IN ('received','accepted','completed','closed')
                  THEN 'Complete and accept the receipt in Stores before it can be recognised.'
                WHEN g.accrual_error IS NOT NULL
                  THEN 'Correct the accrual error, then retry the stock posting.'
                ELSE 'Post the stock accrual to Finance.' END,
           '/inventory/receiving'
      FROM public.goods_receipts g
     WHERE g.organization_id = org AND (_branch IS NULL OR g.branch_id = _branch)
       AND coalesce(g.delivery_date, (g.received_at AT TIME ZONE tz)::date, (g.created_at AT TIME ZONE tz)::date) BETWEEN f AND t
       AND g.status NOT IN ('cancelled','void')
    UNION ALL
    -- Payables: a supplier invoice becomes a liability once Finance accepts and matches it.
    SELECT 'supplier_invoice', v.id, coalesce(v.invoice_number, v.id::text), v.status,
           coalesce(v.amount,0), coalesce(v.invoice_date, (v.created_at AT TIME ZONE tz)::date),
           (v.approved_at IS NOT NULL AND v.journal_id IS NULL
             AND coalesce(v.match_status,'unmatched') IN ('matched','accepted','approved')),
           'A supplier invoice becomes a payable once Finance has captured it and it has passed matching against the purchase order and receipt.',
           CASE WHEN coalesce(v.match_status,'unmatched') NOT IN ('matched','accepted','approved')
                  THEN 'Resolve the match variance in Payables before the invoice can become a payable.'
                WHEN v.approved_at IS NULL THEN 'Approve the invoice in Payables.'
                ELSE 'Post the payable to Finance.' END,
           '/finance/payables'
      FROM public.supplier_invoices v
     WHERE v.organization_id = org AND (_branch IS NULL OR v.branch_id = _branch)
       AND coalesce(v.invoice_date, (v.created_at AT TIME ZONE tz)::date) BETWEEN f AND t
       AND v.status NOT IN ('cancelled','void','rejected')
       AND v.journal_id IS NULL
    UNION ALL
    -- Payables: an approved supplier payment settles the liability and moves cash.
    SELECT 'supplier_payment', sp.id, coalesce(sp.payment_number, sp.id::text), sp.status,
           coalesce(sp.amount,0), coalesce(sp.paid_on, (sp.created_at AT TIME ZONE tz)::date),
           (sp.status IN ('paid','completed','settled') AND sp.journal_id IS NULL),
           'A supplier payment clears the payable and reduces cash on the day it is paid.',
           CASE WHEN sp.status NOT IN ('paid','completed','settled')
                  THEN 'Complete the payment run and mark the payment as paid.'
                ELSE 'Post the payment to Finance.' END,
           '/finance/payables'
      FROM public.supplier_payments sp
     WHERE sp.organization_id = org AND (_branch IS NULL OR sp.branch_id = _branch)
       AND coalesce(sp.paid_on, (sp.created_at AT TIME ZONE tz)::date) BETWEEN f AND t
       AND sp.status NOT IN ('cancelled','void','failed')
       AND sp.journal_id IS NULL
  )
  SELECT q.m, q.id, q.ref, q.st, coalesce(q.amt,0), cur, q.d, q.ok,
         coalesce(rc.status, 'unposted'), q.rule, q.act, q.drill, rc.last_error
    FROM q LEFT JOIN receipts rc ON rc.idempotency_key = q.m || ':' || q.id::text
   WHERE coalesce(rc.status,'unposted') <> 'posted'
   ORDER BY q.ok DESC, q.d DESC
   LIMIT 500;
END $function$;