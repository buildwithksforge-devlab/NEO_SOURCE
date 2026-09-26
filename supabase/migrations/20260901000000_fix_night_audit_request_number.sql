-- Fix: public.neo_night_audit_run referenced a.request_number on public.approval_requests,
-- a column that does not exist on that table (it has `reference`, added in
-- 20260811114844_c45d8dc9-a432-4230-b308-a348cc9d9293.sql). This raised
-- "column a.request_number does not exist" every time the approval-pending
-- check ran, aborting the whole night audit transaction and blocking
-- public.neo_close_business_day (End-of-Day close) for every property.
-- Fix is additive: re-create the function using the correct column, keep
-- the same signature/grants, and change nothing else about persisted
-- stages (business_days / night_audit_runs / night_audit_exceptions) or
-- the idempotency guard already in neo_close_business_day.

CREATE OR REPLACE FUNCTION public.neo_night_audit_run(
  _branch uuid,
  _date date DEFAULT NULL,
  _mode text DEFAULT 'manual'
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_org uuid := public.current_org_id();
  v_date date := COALESCE(_date, current_date);
  v_run uuid;
  v_blocking integer := 0;
  v_warning integer := 0;
  v_pos_revenue numeric := 0;
  v_pos_paid numeric := 0;
  v_rooms_revenue numeric := 0;
  v_collections numeric := 0;
  v_outstanding numeric := 0;
BEGIN
  IF v_org IS NULL THEN RAISE EXCEPTION 'No workspace context'; END IF;
  IF NOT (public.has_permission('finance','eod','view') OR public.is_org_admin()) THEN
    RAISE EXCEPTION 'Forbidden';
  END IF;
  IF _branch IS NULL OR NOT EXISTS (
    SELECT 1 FROM public.branches b WHERE b.id = _branch AND b.organization_id = v_org
  ) THEN
    RAISE EXCEPTION 'Unknown property';
  END IF;

  INSERT INTO public.night_audit_runs (organization_id, branch_id, business_date, run_mode, created_by)
  VALUES (v_org, _branch, v_date, COALESCE(_mode,'manual'), auth.uid())
  RETURNING id INTO v_run;

  -- Cashier sessions still open for the audited day: blocking.
  INSERT INTO public.night_audit_exceptions
    (run_id, organization_id, branch_id, business_date, category, severity, reference, detail, amount)
  SELECT v_run, v_org, _branch, v_date, 'cashier-session', 'blocking',
         COALESCE(s.shift_number, s.id::text),
         'Cashier session is still open for the audited business day.',
         s.expected_cash
  FROM public.pos_shifts s
  WHERE s.organization_id = v_org AND s.branch_id = _branch
    AND s.status = 'open' AND s.opened_at::date <= v_date;

  -- Cash variances (shortage or overage) on closed sessions.
  INSERT INTO public.night_audit_exceptions
    (run_id, organization_id, branch_id, business_date, category, severity, reference, detail, amount)
  SELECT v_run, v_org, _branch, v_date, 'cash-variance', 'warning',
         COALESCE(s.shift_number, s.id::text),
         CASE WHEN s.variance < 0 THEN 'Cash shortage recorded on a closed cashier session.'
              ELSE 'Cash overage recorded on a closed cashier session.' END,
         s.variance
  FROM public.pos_shifts s
  WHERE s.organization_id = v_org AND s.branch_id = _branch
    AND s.status <> 'open' AND s.closed_at::date = v_date
    AND COALESCE(s.variance,0) <> 0;

  -- Restaurant / bar bills that finished service without settlement.
  INSERT INTO public.night_audit_exceptions
    (run_id, organization_id, branch_id, business_date, category, severity, reference, detail, amount)
  SELECT v_run, v_org, _branch, v_date, 'unsettled-bill', 'warning',
         o.order_number,
         'Bill is not fully settled.',
         GREATEST(COALESCE(o.grand_total,0) - COALESCE(o.paid_total,0), 0)
  FROM public.pos_orders o
  WHERE o.organization_id = v_org AND o.branch_id = _branch
    AND o.created_at::date = v_date
    AND COALESCE(o.payment_status,'unpaid') NOT IN ('paid','settled','credit','transferred')
    AND COALESCE(o.grand_total,0) - COALESCE(o.paid_total,0) > 0;

  -- Guest folios carrying a balance.
  INSERT INTO public.night_audit_exceptions
    (run_id, organization_id, branch_id, business_date, category, severity, reference, detail, amount)
  SELECT v_run, v_org, _branch, v_date, 'open-folio', 'warning',
         f.folio_number,
         'Guest folio carries an outstanding balance.',
         f.balance
  FROM public.folios f
  WHERE f.organization_id = v_org AND f.branch_id = _branch
    AND f.status = 'open' AND COALESCE(f.balance,0) <> 0;

  -- Finance handoffs that failed to post: blocking.
  INSERT INTO public.night_audit_exceptions
    (run_id, organization_id, branch_id, business_date, category, severity, reference, detail, amount)
  SELECT v_run, v_org, _branch, v_date, 'finance-posting', 'blocking',
         r.reference,
         COALESCE(NULLIF(r.error_detail,''), 'Finance posting failed and has not been resolved.'),
         r.amount
  FROM public.finance_posting_receipts r
  WHERE r.organization_id = v_org AND r.branch_id = _branch
    AND r.occurred_on = v_date AND r.status = 'failed';

  -- Controlled transactions still awaiting a valid approval.
  -- FIX: public.approval_requests has no `request_number` column; the
  -- human-readable identifier on that table is `reference`.
  INSERT INTO public.night_audit_exceptions
    (run_id, organization_id, branch_id, business_date, category, severity, reference, detail, amount)
  SELECT v_run, v_org, _branch, v_date, 'approval', 'warning',
         COALESCE(NULLIF(a.reference, ''), a.id::text),
         'Controlled transaction is still awaiting approval.',
         a.amount
  FROM public.approval_requests a
  WHERE a.organization_id = v_org AND a.branch_id = _branch
    AND a.created_at::date <= v_date
    AND public.neo_approval_normalize_status(a.status) = 'pending';

  SELECT COALESCE(SUM(o.grand_total),0), COALESCE(SUM(o.paid_total),0)
    INTO v_pos_revenue, v_pos_paid
  FROM public.pos_orders o
  WHERE o.organization_id = v_org AND o.branch_id = _branch AND o.created_at::date = v_date;

  SELECT COALESCE(SUM(l.total_amount),0) INTO v_rooms_revenue
  FROM public.folio_lines l
  WHERE l.organization_id = v_org AND l.branch_id = _branch
    AND l.posted_at::date = v_date AND l.category = 'room';

  SELECT COALESCE(SUM(f.balance),0) INTO v_outstanding
  FROM public.folios f
  WHERE f.organization_id = v_org AND f.branch_id = _branch AND f.status = 'open';

  v_collections := v_pos_paid;

  -- Revenue must reconcile to collections plus authorised outstanding balances.
  IF ROUND(v_pos_revenue - v_pos_paid, 2) <> 0 THEN
    INSERT INTO public.night_audit_exceptions
      (run_id, organization_id, branch_id, business_date, category, severity, reference, detail, amount)
    VALUES (v_run, v_org, _branch, v_date, 'revenue-reconciliation', 'warning', 'Revenue vs collections',
            'Recorded revenue does not equal collections; the difference must sit in authorised outstanding balances.',
            ROUND(v_pos_revenue - v_pos_paid, 2));
  END IF;

  SELECT
    COUNT(*) FILTER (WHERE severity = 'blocking'),
    COUNT(*) FILTER (WHERE severity = 'warning')
  INTO v_blocking, v_warning
  FROM public.night_audit_exceptions WHERE run_id = v_run;

  UPDATE public.night_audit_runs SET
    blocking_count = v_blocking,
    warning_count = v_warning,
    status = CASE WHEN v_blocking > 0 THEN 'exception' ELSE 'completed' END,
    completed_at = now(),
    summary = jsonb_build_object(
      'pos_revenue', v_pos_revenue,
      'pos_collections', v_pos_paid,
      'rooms_revenue', v_rooms_revenue,
      'collections', v_collections,
      'outstanding_balances', v_outstanding
    )
  WHERE id = v_run;

  RETURN jsonb_build_object(
    'run_id', v_run, 'business_date', v_date,
    'blocking', v_blocking, 'warnings', v_warning,
    'status', CASE WHEN v_blocking > 0 THEN 'exception' ELSE 'completed' END
  );
END $$;

REVOKE ALL ON FUNCTION public.neo_night_audit_run(uuid,date,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.neo_night_audit_run(uuid,date,text) TO authenticated, service_role;
