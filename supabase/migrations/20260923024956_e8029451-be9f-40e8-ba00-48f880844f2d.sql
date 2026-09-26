CREATE OR REPLACE FUNCTION public.neo_till_reconciliation(_branch uuid, _date date DEFAULT CURRENT_DATE)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_org uuid := public.current_org_id();
  v_from timestamptz;
  v_to timestamptz;
  v_orders jsonb;
  v_payments jsonb;
  v_shifts jsonb;
  v_rider jsonb;
  v_journals jsonb;
  v_stock jsonb;
  v_checks jsonb;
  v_delivery jsonb;
  v_unbilled_delivery integer;
  v_unbilled_value numeric;
  v_cash_taken numeric;
  v_cash_counted numeric;
  v_paid_orders numeric;
  v_payments_total numeric;
  v_receipts integer;
  v_payment_rows integer;
  v_journal_credit numeric;
  v_unjournalled integer;
  v_unstocked integer;
BEGIN
  IF v_org IS NULL OR NOT public.neo_commerce_can_reconcile() THEN
    RAISE EXCEPTION 'Not permitted to run the till reconciliation report' USING ERRCODE = '42501';
  END IF;
  IF _branch IS NULL OR NOT (_branch = ANY (public.current_branch_ids())) THEN
    RAISE EXCEPTION 'Property outside your access scope' USING ERRCODE = '42501';
  END IF;

  v_from := _date::timestamptz;
  v_to := (_date + 1)::timestamptz;

  SELECT jsonb_build_object(
           'count', count(*),
           'gross', COALESCE(sum(o.grand_total), 0),
           'paid', COALESCE(sum(o.paid_total), 0),
           'tax', COALESCE(sum(o.tax_total), 0),
           'service_charge', COALESCE(sum(o.service_charge_total), 0),
           'discount', COALESCE(sum(o.discount_total), 0),
           'by_source', COALESCE((
             SELECT jsonb_agg(x ORDER BY x->>'source')
               FROM (
                 SELECT jsonb_build_object(
                          'source', COALESCE(s.order_source, 'pos'),
                          'count', count(*),
                          'gross', COALESCE(sum(s.grand_total), 0))
                   FROM public.pos_orders s
                  WHERE s.organization_id = v_org AND s.branch_id = _branch
                    AND s.created_at >= v_from AND s.created_at < v_to
                    AND s.status NOT IN ('draft','cancelled','voided')
                  GROUP BY COALESCE(s.order_source, 'pos')
               ) t(x)), '[]'::jsonb))
    INTO v_orders
    FROM public.pos_orders o
   WHERE o.organization_id = v_org AND o.branch_id = _branch
     AND o.created_at >= v_from AND o.created_at < v_to
     AND o.status NOT IN ('draft','cancelled','voided');

  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'method', m.method, 'count', m.cnt, 'amount', m.amount) ORDER BY m.method), '[]'::jsonb),
         COALESCE(sum(m.amount), 0), COALESCE(sum(m.cnt), 0)
    INTO v_payments, v_payments_total, v_payment_rows
    FROM (
      SELECT COALESCE(p.method,'unknown') AS method, count(*) AS cnt, COALESCE(sum(p.amount),0) AS amount
        FROM public.pos_payments p
       WHERE p.organization_id = v_org AND p.branch_id = _branch
         AND p.created_at >= v_from AND p.created_at < v_to
         AND p.status = 'confirmed'
       GROUP BY COALESCE(p.method,'unknown')
    ) m;

  SELECT COALESCE(sum(p.amount), 0),
         count(*) FILTER (WHERE p.receipt_number IS NOT NULL)
    INTO v_cash_taken, v_receipts
    FROM public.pos_payments p
   WHERE p.organization_id = v_org AND p.branch_id = _branch
     AND p.created_at >= v_from AND p.created_at < v_to
     AND p.status = 'confirmed'
     AND p.method = 'cash';

  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'id', s.id,
           'shift_number', s.shift_number,
           'status', s.status,
           'opened_at', s.opened_at,
           'closed_at', s.closed_at,
           'opening_float', s.opening_float,
           'expected_cash', s.expected_cash,
           'counted_cash', s.counted_cash,
           'variance', s.variance,
           'variance_reason', s.variance_reason,
           'cashier', COALESCE(pr.full_name, '—')) ORDER BY s.opened_at), '[]'::jsonb),
         COALESCE(sum(s.counted_cash), 0)
    INTO v_shifts, v_cash_counted
    FROM public.pos_shifts s
    LEFT JOIN public.profiles pr ON pr.id = s.cashier_id
   WHERE s.organization_id = v_org AND s.branch_id = _branch
     AND s.opened_at >= v_from AND s.opened_at < v_to;

  SELECT jsonb_build_object(
           'count', count(*),
           'expected', COALESCE(sum(c.expected_amount), 0),
           'collected', COALESCE(sum(c.collected_amount), 0),
           'outstanding', COALESCE(sum(c.collected_amount) FILTER (WHERE c.status = 'collected'), 0))
    INTO v_rider
    FROM public.rider_cash_collections c
   WHERE c.organization_id = v_org AND c.branch_id = _branch
     AND c.created_at >= v_from AND c.created_at < v_to;

  -- Delivery orders that have been delivered and paid but never turned into an
  -- invoice. Their delivery fee is real money the rider collected, so it must
  -- be visible here rather than quietly missing from the day's revenue.
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'id', d.id,
           'order_number', d.order_number,
           'subtotal', COALESCE(d.subtotal, 0),
           'delivery_fee', COALESCE(d.delivery_fee, 0),
           'grand_total', COALESCE(d.grand_total, 0),
           'payment_method', d.payment_method) ORDER BY d.order_number), '[]'::jsonb),
         count(*), COALESCE(sum(d.grand_total), 0)
    INTO v_delivery, v_unbilled_delivery, v_unbilled_value
    FROM public.delivery_orders d
   WHERE d.organization_id = v_org AND d.branch_id = _branch
     AND d.created_at >= v_from AND d.created_at < v_to
     AND d.order_status NOT IN ('cancelled','rejected','failed')
     AND lower(COALESCE(d.payment_status,'')) IN ('paid','settled','captured','completed')
     AND NOT EXISTS (
       SELECT 1 FROM public.invoices i
        WHERE i.organization_id = d.organization_id
          AND i.notes LIKE '%delivery-order:' || d.id::text || '%');

  SELECT jsonb_build_object(
           'count', count(*),
           'posted', count(*) FILTER (WHERE j.status = 'posted'),
           'total_debit', COALESCE(sum(j.total_debit), 0),
           'total_credit', COALESCE(sum(j.total_credit), 0)),
         COALESCE(sum(j.total_credit) FILTER (WHERE j.status = 'posted'), 0)
    INTO v_journals, v_journal_credit
    FROM public.journal_entries j
   WHERE j.organization_id = v_org AND j.branch_id = _branch
     AND j.accounting_date = _date;

  SELECT jsonb_build_object(
           'movements', count(*),
           'value', COALESCE(sum(abs(m.value)), 0))
    INTO v_stock
    FROM public.stock_movements m
   WHERE m.organization_id = v_org AND m.branch_id = _branch
     AND m.created_at >= v_from AND m.created_at < v_to
     AND m.movement_type IN ('consumption','sale','issue');

  SELECT count(*) INTO v_unjournalled
    FROM public.pos_payments p
   WHERE p.organization_id = v_org AND p.branch_id = _branch
     AND p.created_at >= v_from AND p.created_at < v_to
     AND p.status = 'confirmed'
     AND NOT EXISTS (SELECT 1 FROM public.journal_entries j
                      WHERE j.organization_id = p.organization_id
                        AND (j.source_document_id = p.id OR j.source_document_id = p.order_id));

  SELECT count(*) INTO v_unstocked
    FROM public.pos_orders o
   WHERE o.organization_id = v_org AND o.branch_id = _branch
     AND o.created_at >= v_from AND o.created_at < v_to
     AND o.status IN ('closed','completed')
     AND NOT EXISTS (SELECT 1 FROM public.stock_movements m
                      WHERE m.organization_id = o.organization_id AND m.reference_id = o.id);

  SELECT COALESCE(sum(o.paid_total), 0) INTO v_paid_orders
    FROM public.pos_orders o
   WHERE o.organization_id = v_org AND o.branch_id = _branch
     AND o.created_at >= v_from AND o.created_at < v_to
     AND o.status NOT IN ('draft','cancelled','voided');

  v_checks := jsonb_build_array(
    jsonb_build_object('key','orders_vs_payments','label','Amounts settled on orders match payments recorded',
      'left', v_paid_orders, 'right', v_payments_total, 'difference', v_paid_orders - v_payments_total,
      'ok', abs(v_paid_orders - v_payments_total) < 0.01),
    jsonb_build_object('key','payments_vs_receipts','label','Every completed payment carries a receipt',
      'left', v_payment_rows, 'right', v_receipts, 'difference', v_payment_rows - v_receipts,
      'ok', v_payment_rows = v_receipts),
    jsonb_build_object('key','payments_vs_journals','label','Every payment reached the ledger',
      'left', v_payment_rows, 'right', v_payment_rows - v_unjournalled, 'difference', v_unjournalled,
      'ok', v_unjournalled = 0),
    jsonb_build_object('key','delivery_billed','label','Delivered, paid delivery orders reached the ledger',
      'left', v_unbilled_delivery, 'right', 0, 'difference', v_unbilled_delivery,
      'ok', v_unbilled_delivery = 0),
    jsonb_build_object('key','cash_vs_counted','label','Cash taken matches cash counted in the till',
      'left', v_cash_taken, 'right', v_cash_counted, 'difference', v_cash_taken - v_cash_counted,
      'ok', abs(v_cash_taken - v_cash_counted) < 0.01),
    jsonb_build_object('key','sales_vs_stock','label','Closed orders consumed stock',
      'left', v_unstocked, 'right', 0, 'difference', v_unstocked, 'ok', v_unstocked = 0),
    jsonb_build_object('key','journal_balanced','label','Posted journals balance',
      'left', (v_journals->>'total_debit')::numeric, 'right', (v_journals->>'total_credit')::numeric,
      'difference', (v_journals->>'total_debit')::numeric - (v_journals->>'total_credit')::numeric,
      'ok', abs((v_journals->>'total_debit')::numeric - (v_journals->>'total_credit')::numeric) < 0.01)
  );

  RETURN jsonb_build_object(
    'branch_id', _branch,
    'date', _date,
    'orders', COALESCE(v_orders, '{}'::jsonb),
    'payments', jsonb_build_object('methods', v_payments, 'total', v_payments_total,
                                   'count', v_payment_rows, 'receipts', v_receipts, 'cash', v_cash_taken),
    'shifts', v_shifts,
    'rider_cash', v_rider,
    'unbilled_delivery', jsonb_build_object('count', COALESCE(v_unbilled_delivery,0),
                                            'value', COALESCE(v_unbilled_value,0),
                                            'orders', COALESCE(v_delivery,'[]'::jsonb)),
    'journals', v_journals,
    'stock', v_stock,
    'checks', v_checks,
    'generated_at', now());
END;
$function$;