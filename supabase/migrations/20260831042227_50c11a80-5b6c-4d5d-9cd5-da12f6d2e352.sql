-- 1. Recognise a guest payment (till, folio settlement, POS bill payment).
CREATE OR REPLACE FUNCTION public.neo_payment_post(_payment uuid, _silent boolean DEFAULT false)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE p public.payments; org uuid; cur text; cash_code text; cash_name text;
        occurred date; ref text; res jsonb; jid uuid; msg text; amt numeric;
BEGIN
  SELECT * INTO p FROM public.payments WHERE id = _payment;
  IF p.id IS NULL THEN RETURN jsonb_build_object('ok', false, 'reason', 'not_found'); END IF;
  org := p.organization_id;

  IF NOT _silent AND NOT (public.is_org_admin() OR public.has_permission('finance','edit')
                          OR public.has_permission('finance','approve')) THEN
    RAISE EXCEPTION 'insufficient_privilege' USING ERRCODE = '42501';
  END IF;

  IF coalesce(p.status,'') IN ('void','voided','cancelled','failed','reversed') THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_eligible',
      'detail', 'A voided, cancelled or failed payment is not recognised in Finance.');
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended('payment:' || _payment::text, 0));

  IF p.posted_journal_id IS NOT NULL
     OR EXISTS (SELECT 1 FROM public.finance_posting_receipts
                 WHERE organization_id = org AND idempotency_key = 'payment:' || _payment::text
                   AND status = 'posted') THEN
    RETURN jsonb_build_object('ok', true, 'reason', 'already_posted',
      'journal_id', p.posted_journal_id, 'module', 'payment', 'source_id', _payment);
  END IF;

  amt := round(coalesce(p.amount,0), 2);
  IF amt <= 0 THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_eligible',
      'detail', 'A payment with no amount cannot be recognised.');
  END IF;

  cur := coalesce(nullif(p.currency,''), public.neo_fact_currency(org, p.branch_id));
  occurred := coalesce((p.paid_at)::date, (p.created_at)::date, CURRENT_DATE);
  ref := coalesce(nullif(p.receipt_number,''), _payment::text);

  SELECT c.code, c.name INTO cash_code, cash_name FROM (VALUES
      ('mpesa','1030','M-Pesa Clearing'),
      ('mobile','1030','M-Pesa Clearing'),
      ('mobile_money','1030','M-Pesa Clearing'),
      ('card','1040','Card Clearing'),
      ('bank','1020','Bank Accounts'),
      ('transfer','1020','Bank Accounts'),
      ('eft','1020','Bank Accounts')
    ) AS c(method, code, name)
   WHERE c.method = lower(coalesce(p.method,'cash'));
  cash_code := coalesce(cash_code, '1010');
  cash_name := coalesce(cash_name, 'Cash on Hand');

  BEGIN
    PERFORM public.neo_finance_ensure_account(org, cash_code, cash_name, 'asset', 'Cash and Bank');
    PERFORM public.neo_finance_ensure_account(org, '1110', 'Guest Ledger', 'asset', 'Receivables');

    res := public.neo_gl_post(
      org, p.branch_id, 'payments', 'guest_payment', _payment, 'settlement',
      occurred, cur,
      'Guest payment ' || ref,
      jsonb_build_array(
        jsonb_build_object('code', cash_code, 'debit', amt,
                           'description', 'Payment received (' || coalesce(p.method,'cash') || ')'),
        jsonb_build_object('code', '1110', 'credit', amt,
                           'description', 'Guest ledger settled')
      ), p.customer_id);
    jid := nullif(res->>'journal_id','')::uuid;
  EXCEPTION WHEN OTHERS THEN
    msg := SQLERRM;
    PERFORM public.neo_record_posting_receipt(org, p.branch_id, 'payment', _payment, ref, 'failed',
      amt, cur, NULL, NULL, msg, occurred);
    PERFORM public.neo_financial_state_set(org, p.branch_id, 'payment', _payment, ref,
      p.status, 'failed', 'The payment could not be recognised in Finance.',
      amt, cur, occurred, NULL, NULL, msg, auth.uid(), NULL);
    IF _silent THEN RETURN jsonb_build_object('ok', false, 'reason', 'failed', 'detail', msg); END IF;
    RAISE;
  END;

  IF jid IS NOT NULL THEN
    UPDATE public.payments SET posted_journal_id = jid, updated_at = now() WHERE id = _payment;
  END IF;

  PERFORM public.neo_record_posting_receipt(org, p.branch_id, 'payment', _payment, ref,
    CASE WHEN jid IS NOT NULL THEN 'posted' ELSE 'blocked' END,
    amt, cur, NULL, res->>'detail', NULL, occurred);

  PERFORM public.neo_financial_state_set(org, p.branch_id, 'payment', _payment, ref,
    p.status, CASE WHEN jid IS NOT NULL THEN 'posted' ELSE 'blocked' END,
    'A guest payment moves cash in and reduces the guest ledger on the day it is received.',
    amt, cur, occurred, jid, NULL, NULL, auth.uid(), NULL);

  RETURN coalesce(res, '{}'::jsonb) || jsonb_build_object('module', 'payment', 'source_id', _payment);
END $function$;

REVOKE ALL ON FUNCTION public.neo_payment_post(uuid, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.neo_payment_post(uuid, boolean) TO authenticated;

-- 2. Deposits and guest payments join the canonical posting queue.
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
    UNION ALL
    -- Front office: a pre-arrival deposit is guest money held as a liability.
    SELECT 'deposit', dp.id, coalesce(r.confirmation_number, dp.id::text), dp.status,
           coalesce(dp.amount,0), coalesce((dp.received_at)::date, (dp.created_at AT TIME ZONE tz)::date),
           (coalesce(dp.status,'held') NOT IN ('refunded','cancelled','void')
             AND coalesce(dp.amount,0) > 0),
           'A pre-arrival deposit is recognised as cash in and a guest deposit liability on the day it is received.',
           CASE WHEN coalesce(dp.status,'held') IN ('refunded','cancelled','void')
                  THEN 'This deposit was refunded or cancelled — no further posting is required.'
                WHEN coalesce(dp.amount,0) <= 0
                  THEN 'Record the deposit amount before it can be recognised.'
                ELSE 'Post the deposit to Finance.' END,
           '/finance/deposits'
      FROM public.reservation_deposits dp
      LEFT JOIN public.reservations r ON r.id = dp.reservation_id
     WHERE dp.organization_id = org AND (_branch IS NULL OR dp.branch_id = _branch)
       AND coalesce((dp.received_at)::date, (dp.created_at AT TIME ZONE tz)::date) BETWEEN f AND t
    UNION ALL
    -- Cashier: a guest payment settles the guest ledger and moves cash.
    SELECT 'payment', pm.id, coalesce(pm.receipt_number, pm.id::text), pm.status,
           coalesce(pm.amount,0), coalesce((pm.paid_at)::date, (pm.created_at AT TIME ZONE tz)::date),
           (coalesce(pm.status,'paid') NOT IN ('void','voided','cancelled','failed','reversed')
             AND coalesce(pm.amount,0) > 0 AND pm.posted_journal_id IS NULL),
           'A guest payment taken at the till, on a folio or against a point-of-sale bill moves cash in and reduces the guest ledger.',
           CASE WHEN coalesce(pm.status,'paid') IN ('void','voided','cancelled','failed','reversed')
                  THEN 'This payment was voided or failed — no posting is required.'
                WHEN coalesce(pm.amount,0) <= 0
                  THEN 'Record the amount received before the payment can be recognised.'
                ELSE 'Post the payment to Finance.' END,
           '/finance/queue'
      FROM public.payments pm
     WHERE pm.organization_id = org AND (_branch IS NULL OR pm.branch_id = _branch)
       AND coalesce((pm.paid_at)::date, (pm.created_at AT TIME ZONE tz)::date) BETWEEN f AND t
       AND pm.posted_journal_id IS NULL
  )
  SELECT q.m, q.id, q.ref, q.st, coalesce(q.amt,0), cur, q.d, q.ok,
         coalesce(rc.status, 'unposted'), q.rule, q.act, q.drill, rc.last_error
    FROM q LEFT JOIN receipts rc ON rc.idempotency_key = q.m || ':' || q.id::text
   WHERE coalesce(rc.status,'unposted') <> 'posted'
   ORDER BY q.ok DESC, q.d DESC
   LIMIT 500;
END $function$;

-- 3. Retrying from the queue reaches the two new families.
CREATE OR REPLACE FUNCTION public.neo_finance_post_family(_module text, _source uuid, _silent boolean DEFAULT false)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
  IF _module = 'deposit' THEN
    RETURN public.neo_deposit_post(_source, _silent);
  ELSIF _module = 'payment' THEN
    RETURN public.neo_payment_post(_source, _silent);
  END IF;
  RETURN public.neo_finance_post_source(_module, _source, _silent);
END $function$;

REVOKE ALL ON FUNCTION public.neo_finance_post_family(text, uuid, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.neo_finance_post_family(text, uuid, boolean) TO authenticated;