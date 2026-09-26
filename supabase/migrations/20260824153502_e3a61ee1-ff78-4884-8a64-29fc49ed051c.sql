-- ============================================================
-- NEØ Finance Department — final structure, controls & night audit
-- ============================================================

-- 1. Reporting structure -------------------------------------------------
UPDATE public.role_catalogue
SET reports_to_key = 'operations-manager',
    reports_to_role_keys = ARRAY['operations-manager','owner'],
    updated_at = now()
WHERE role_key = 'finance-manager';

UPDATE public.role_catalogue
SET reports_to_key = 'finance-manager',
    reports_to_role_keys = ARRAY['finance-manager'],
    updated_at = now()
WHERE role_key IN ('accountant','cashier');

-- 2. Capability catalogue ------------------------------------------------
INSERT INTO public.permissions (module, feature, action, label) VALUES
  ('finance','collections','view','View pending collections'),
  ('finance','collections','create','Record a collection'),
  ('finance','collections','edit','Update a collection'),
  ('finance','collections','verify_bill','Verify a bill before settlement'),
  ('finance','collections','collect_payment','Collect or confirm payment'),
  ('finance','collections','settle_bill','Financially settle a bill'),
  ('finance','collections','issue_receipt','Issue a receipt'),
  ('finance','collections','reprint_receipt','Reprint a receipt'),
  ('finance','collections','query_bill','Query a bill'),
  ('finance','collections','return_bill','Return a bill to its department'),
  ('finance','till','view','View own till'),
  ('finance','till','create','Open own till'),
  ('finance','till','edit','Record till movements'),
  ('finance','till','declare_cash','Declare counted cash'),
  ('finance','till','close','Close own cashier session'),
  ('finance','sessions','view','View cashier sessions'),
  ('finance','sessions','create','Record session oversight'),
  ('finance','sessions','edit','Annotate cashier sessions'),
  ('finance','sessions','export','Export cashier sessions'),
  ('finance','sessions','review','Review a cashier session'),
  ('finance','eod','view','View End-of-Day and night audit results'),
  ('finance','eod','create','Run the night audit'),
  ('finance','eod','edit','Investigate night audit exceptions'),
  ('finance','eod','export','Export End-of-Day results'),
  ('finance','eod','close_business_day','Close the hotel business day'),
  ('administration','approvals','view','View approval configuration'),
  ('administration','approvals','edit','Maintain approval configuration'),
  ('administration','approvals','configure','Configure approval limits and escalation')
ON CONFLICT (module, feature, action) DO NOTHING;

-- 3. Configurable approval limits ---------------------------------------
ALTER TABLE public.approval_rules
  ADD COLUMN IF NOT EXISTS max_percent numeric,
  ADD COLUMN IF NOT EXISTS escalate_above_limit boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS label text;

DROP POLICY IF EXISTS "approval_rules admin write" ON public.approval_rules;
DROP POLICY IF EXISTS "approval_rules admin update" ON public.approval_rules;
DROP POLICY IF EXISTS "approval_rules admin delete" ON public.approval_rules;

CREATE POLICY "approval_rules configure insert" ON public.approval_rules FOR INSERT TO authenticated
  WITH CHECK (organization_id = public.current_org_id()
    AND (public.is_org_admin() OR public.has_permission('administration','approvals','configure')));
CREATE POLICY "approval_rules configure update" ON public.approval_rules FOR UPDATE TO authenticated
  USING (organization_id = public.current_org_id()
    AND (public.is_org_admin() OR public.has_permission('administration','approvals','configure')))
  WITH CHECK (organization_id = public.current_org_id()
    AND (public.is_org_admin() OR public.has_permission('administration','approvals','configure')));
CREATE POLICY "approval_rules configure delete" ON public.approval_rules FOR DELETE TO authenticated
  USING (organization_id = public.current_org_id()
    AND (public.is_org_admin() OR public.has_permission('administration','approvals','configure')));

INSERT INTO public.approval_types (organization_id, key, name, levels, active)
SELECT o.id, t.key, t.name, 1, true
FROM public.organizations o
CROSS JOIN (VALUES
  ('write-off','Write-off approval'),
  ('bill-adjustment','Bill adjustment'),
  ('procurement-approval','Procurement approval'),
  ('stock-write-off','Stock write-off'),
  ('event-pricing-exception','Event pricing exception'),
  ('payment-reversal','Payment reversal'),
  ('cash-variance','Cash variance review'),
  ('till-reopen','Till reopening')
) AS t(key, name)
ON CONFLICT (organization_id, key) DO NOTHING;

-- Approval routing: lowest authorised level, otherwise escalation.
CREATE OR REPLACE FUNCTION public.neo_approval_route(
  _type text,
  _amount numeric DEFAULT NULL,
  _percent numeric DEFAULT NULL,
  _branch uuid DEFAULT NULL,
  _department uuid DEFAULT NULL,
  _requester uuid DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_org uuid := public.current_org_id();
  v_requester uuid := COALESCE(_requester, auth.uid());
  v_rule record;
  v_first_level integer;
  v_escalated boolean := false;
BEGIN
  IF v_org IS NULL THEN
    RETURN jsonb_build_object('status','unconfigured','message','No workspace context');
  END IF;

  FOR v_rule IN
    SELECT * FROM public.approval_rules r
    WHERE r.organization_id = v_org
      AND r.active
      AND r.approval_type = _type
      AND (r.branch_id IS NULL OR _branch IS NULL OR r.branch_id = _branch)
      AND (r.department_id IS NULL OR _department IS NULL OR r.department_id = _department)
    ORDER BY r.level, r.max_amount NULLS LAST, r.max_percent NULLS LAST
  LOOP
    IF v_first_level IS NULL THEN v_first_level := v_rule.level; END IF;

    -- A rule that cannot cover the request is skipped; the request escalates.
    IF (v_rule.max_amount IS NOT NULL AND _amount IS NOT NULL AND _amount > v_rule.max_amount)
       OR (v_rule.max_percent IS NOT NULL AND _percent IS NOT NULL AND _percent > v_rule.max_percent) THEN
      v_escalated := true;
      CONTINUE;
    END IF;

    -- Never route a request back to its own requester.
    IF v_rule.approver_user_id IS NOT NULL
       AND v_requester IS NOT NULL
       AND v_rule.approver_user_id = v_requester
       AND NOT v_rule.allow_self_approval THEN
      v_escalated := true;
      CONTINUE;
    END IF;

    RETURN jsonb_build_object(
      'status', CASE WHEN v_escalated THEN 'escalated' ELSE 'ok' END,
      'rule_id', v_rule.id,
      'level', v_rule.level,
      'approver_role_id', v_rule.approver_role_id,
      'approver_user_id', v_rule.approver_user_id,
      'required_approvers', v_rule.required_approvers,
      'max_amount', v_rule.max_amount,
      'max_percent', v_rule.max_percent,
      'message', CASE WHEN v_escalated
        THEN 'Approval limit exceeded — escalated to next authorised approver.'
        ELSE 'Routed to the configured approver.' END
    );
  END LOOP;

  IF v_first_level IS NULL THEN
    RETURN jsonb_build_object('status','unconfigured','message',
      'No approval authority is configured for this request type. An administrator must configure it.');
  END IF;

  RETURN jsonb_build_object('status','exhausted','message',
    'Approval limit exceeded and no higher authorised approver is configured.');
END $$;

REVOKE ALL ON FUNCTION public.neo_approval_route(text,numeric,numeric,uuid,uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.neo_approval_route(text,numeric,numeric,uuid,uuid,uuid) TO authenticated, service_role;

-- 4. Business day & automated night audit -------------------------------
CREATE TABLE IF NOT EXISTS public.business_days (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  branch_id uuid NOT NULL REFERENCES public.branches(id) ON DELETE CASCADE,
  business_date date NOT NULL,
  status text NOT NULL DEFAULT 'open',
  opened_at timestamptz NOT NULL DEFAULT now(),
  opened_by uuid,
  closed_at timestamptz,
  closed_by uuid,
  close_mode text,
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT business_days_status_chk CHECK (status IN ('open','closed')),
  CONSTRAINT business_days_unique UNIQUE (organization_id, branch_id, business_date)
);

GRANT SELECT ON public.business_days TO authenticated;
GRANT ALL ON public.business_days TO service_role;
ALTER TABLE public.business_days ENABLE ROW LEVEL SECURITY;
CREATE POLICY "business_days tenant read" ON public.business_days FOR SELECT TO authenticated
  USING (organization_id = public.current_org_id()
    AND (public.has_permission('finance','eod','view') OR public.is_org_admin()));

CREATE TABLE IF NOT EXISTS public.night_audit_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  branch_id uuid NOT NULL REFERENCES public.branches(id) ON DELETE CASCADE,
  business_date date NOT NULL,
  status text NOT NULL DEFAULT 'completed',
  blocking_count integer NOT NULL DEFAULT 0,
  warning_count integer NOT NULL DEFAULT 0,
  summary jsonb NOT NULL DEFAULT '{}'::jsonb,
  run_mode text NOT NULL DEFAULT 'manual',
  started_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT night_audit_runs_status_chk CHECK (status IN ('completed','exception'))
);

GRANT SELECT ON public.night_audit_runs TO authenticated;
GRANT ALL ON public.night_audit_runs TO service_role;
ALTER TABLE public.night_audit_runs ENABLE ROW LEVEL SECURITY;
CREATE POLICY "night_audit_runs tenant read" ON public.night_audit_runs FOR SELECT TO authenticated
  USING (organization_id = public.current_org_id()
    AND (public.has_permission('finance','eod','view') OR public.is_org_admin()));

CREATE TABLE IF NOT EXISTS public.night_audit_exceptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id uuid NOT NULL REFERENCES public.night_audit_runs(id) ON DELETE CASCADE,
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  branch_id uuid NOT NULL REFERENCES public.branches(id) ON DELETE CASCADE,
  business_date date NOT NULL,
  category text NOT NULL,
  severity text NOT NULL DEFAULT 'warning',
  reference text,
  detail text NOT NULL DEFAULT '',
  amount numeric,
  resolved_at timestamptz,
  resolved_by uuid,
  resolution_note text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT night_audit_exceptions_severity_chk CHECK (severity IN ('blocking','warning'))
);

GRANT SELECT ON public.night_audit_exceptions TO authenticated;
GRANT ALL ON public.night_audit_exceptions TO service_role;
ALTER TABLE public.night_audit_exceptions ENABLE ROW LEVEL SECURITY;
CREATE POLICY "night_audit_exceptions tenant read" ON public.night_audit_exceptions FOR SELECT TO authenticated
  USING (organization_id = public.current_org_id()
    AND (public.has_permission('finance','eod','view') OR public.is_org_admin()));

CREATE INDEX IF NOT EXISTS night_audit_exceptions_run_idx ON public.night_audit_exceptions (run_id);
CREATE INDEX IF NOT EXISTS night_audit_runs_scope_idx ON public.night_audit_runs (organization_id, branch_id, business_date DESC);

CREATE OR REPLACE FUNCTION public.business_days_touch() RETURNS trigger
LANGUAGE plpgsql SET search_path = public AS $$
BEGIN NEW.updated_at := now(); RETURN NEW; END $$;

DROP TRIGGER IF EXISTS business_days_touch ON public.business_days;
CREATE TRIGGER business_days_touch BEFORE UPDATE ON public.business_days
  FOR EACH ROW EXECUTE FUNCTION public.business_days_touch();

-- The audit only reports. It never adjusts a figure to make a day balance.
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
  INSERT INTO public.night_audit_exceptions
    (run_id, organization_id, branch_id, business_date, category, severity, reference, detail, amount)
  SELECT v_run, v_org, _branch, v_date, 'approval', 'warning',
         COALESCE(a.request_number, a.id::text),
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

CREATE OR REPLACE FUNCTION public.neo_close_business_day(
  _branch uuid,
  _date date DEFAULT NULL,
  _note text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_org uuid := public.current_org_id();
  v_date date := COALESCE(_date, current_date);
  v_audit jsonb;
  v_blocking integer;
  v_day uuid;
BEGIN
  IF v_org IS NULL THEN RAISE EXCEPTION 'No workspace context'; END IF;
  IF NOT public.has_permission('finance','eod','close_business_day') THEN
    RAISE EXCEPTION 'Closing the business day requires the finance.eod.close_business_day permission';
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.business_days d
    WHERE d.organization_id = v_org AND d.branch_id = _branch
      AND d.business_date = v_date AND d.status = 'closed'
  ) THEN
    RETURN jsonb_build_object('status','already_closed','business_date', v_date);
  END IF;

  v_audit := public.neo_night_audit_run(_branch, v_date, 'close');
  v_blocking := COALESCE((v_audit->>'blocking')::int, 0);

  IF v_blocking > 0 THEN
    RETURN jsonb_build_object('status','exception','business_date', v_date,
      'blocking', v_blocking, 'audit', v_audit,
      'message','END-OF-DAY EXCEPTION — Finance must investigate. Figures are never adjusted to force a balance.');
  END IF;

  INSERT INTO public.business_days (organization_id, branch_id, business_date, status, closed_at, closed_by, close_mode, notes)
  VALUES (v_org, _branch, v_date, 'closed', now(), auth.uid(), 'manual', _note)
  ON CONFLICT (organization_id, branch_id, business_date)
  DO UPDATE SET status='closed', closed_at=now(), closed_by=auth.uid(), close_mode='manual', notes=COALESCE(EXCLUDED.notes, public.business_days.notes)
  RETURNING id INTO v_day;

  INSERT INTO public.business_days (organization_id, branch_id, business_date, status, opened_at, opened_by)
  VALUES (v_org, _branch, v_date + 1, 'open', now(), auth.uid())
  ON CONFLICT (organization_id, branch_id, business_date) DO NOTHING;

  INSERT INTO public.audit_logs (organization_id, user_id, action, module, record_id, new_value)
  VALUES (v_org, auth.uid(), 'finance.business_day_closed', 'finance', v_day::text,
          jsonb_build_object('branch_id', _branch, 'business_date', v_date, 'audit', v_audit));

  RETURN jsonb_build_object('status','closed','business_date', v_date, 'audit', v_audit,
    'next_business_date', v_date + 1);
END $$;

REVOKE ALL ON FUNCTION public.neo_close_business_day(uuid,date,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.neo_close_business_day(uuid,date,text) TO authenticated, service_role;

-- 5. Pending Collections -------------------------------------------------
CREATE OR REPLACE FUNCTION public.neo_pending_collections(_branch uuid DEFAULT NULL)
RETURNS TABLE (
  source text,
  source_id uuid,
  reference text,
  customer text,
  department text,
  gross numeric,
  adjustments numeric,
  deposit numeric,
  balance numeric,
  payment_status text,
  approval_status text,
  occurred_at timestamptz
)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_org uuid := public.current_org_id();
BEGIN
  IF v_org IS NULL THEN RETURN; END IF;
  IF NOT (public.has_permission('finance','collections','view') OR public.is_org_admin()) THEN
    RAISE EXCEPTION 'Forbidden';
  END IF;

  RETURN QUERY
  SELECT 'front-office'::text, f.id, f.folio_number,
         COALESCE(c.full_name, 'Guest'), 'Front Office'::text,
         COALESCE(f.total_charges,0), COALESCE(f.total_discounts,0), COALESCE(f.total_payments,0),
         COALESCE(f.balance,0), COALESCE(f.status,'open'), 'n/a'::text, f.opened_at
  FROM public.folios f
  LEFT JOIN public.customers c ON c.id = f.customer_id
  WHERE f.organization_id = v_org
    AND (_branch IS NULL OR f.branch_id = _branch)
    AND f.branch_id = ANY (public.current_branch_ids())
    AND f.status = 'open' AND COALESCE(f.balance,0) > 0

  UNION ALL
  SELECT 'restaurant'::text, o.id, o.order_number,
         COALESCE(c.full_name, o.guest_name, 'Walk-in'), 'Food & Beverage'::text,
         COALESCE(o.grand_total,0), COALESCE(o.discount_total,0), COALESCE(o.paid_total,0),
         GREATEST(COALESCE(o.grand_total,0) - COALESCE(o.paid_total,0), 0),
         COALESCE(o.payment_status,'unpaid'), 'n/a'::text, o.created_at
  FROM public.pos_orders o
  LEFT JOIN public.customers c ON c.id = o.customer_id
  WHERE o.organization_id = v_org
    AND (_branch IS NULL OR o.branch_id = _branch)
    AND o.branch_id = ANY (public.current_branch_ids())
    AND COALESCE(o.status,'') NOT IN ('cancelled','void')
    AND COALESCE(o.payment_status,'unpaid') NOT IN ('paid','settled','transferred')
    AND COALESCE(o.grand_total,0) - COALESCE(o.paid_total,0) > 0

  UNION ALL
  SELECT 'events'::text, e.id, e.event_reference,
         COALESCE(c.full_name, e.primary_contact, e.event_name), 'Sales, Events & Banqueting'::text,
         COALESCE(e.total_amount,0), 0::numeric, COALESCE(e.deposit_paid,0) + COALESCE(e.paid_amount,0),
         GREATEST(COALESCE(e.total_amount,0) - COALESCE(e.paid_amount,0), 0),
         COALESCE(e.payment_status,'unpaid'), COALESCE(e.status,'enquiry'), e.created_at
  FROM public.event_bookings e
  LEFT JOIN public.customers c ON c.id = e.customer_id
  WHERE e.organization_id = v_org
    AND (_branch IS NULL OR e.branch_id = _branch)
    AND e.branch_id = ANY (public.current_branch_ids())
    AND COALESCE(e.status,'') NOT IN ('cancelled','lost')
    AND COALESCE(e.total_amount,0) - COALESCE(e.paid_amount,0) > 0

  UNION ALL
  SELECT 'delivery'::text, d.id, d.order_number,
         COALESCE(d.contact_name, 'Delivery customer'), 'Delivery'::text,
         COALESCE(d.grand_total,0), COALESCE(d.discount_total,0), 0::numeric,
         COALESCE(d.grand_total,0), COALESCE(d.payment_status,'unpaid'),
         COALESCE(d.order_status,'placed'), d.created_at
  FROM public.delivery_orders d
  WHERE d.organization_id = v_org
    AND (_branch IS NULL OR d.branch_id = _branch)
    AND d.branch_id = ANY (public.current_branch_ids())
    AND COALESCE(d.payment_status,'unpaid') NOT IN ('paid','settled','refunded')
    AND COALESCE(d.order_status,'') NOT IN ('cancelled','rejected')
  ORDER BY 12 DESC;
END $$;

REVOKE ALL ON FUNCTION public.neo_pending_collections(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.neo_pending_collections(uuid) TO authenticated, service_role;

-- 6. Role templates ------------------------------------------------------
-- Cashier (self scope): view/create/edit on the settlement capabilities.
INSERT INTO public.role_feature_templates (role_key, module, feature, action)
SELECT 'cashier', 'finance', f.feature, a.action
FROM (VALUES ('collections'),('till')) AS f(feature)
CROSS JOIN (VALUES ('view'),('create'),('edit')) AS a(action)
ON CONFLICT (role_key, module, feature, action) DO NOTHING;

-- Accountant (team scope): reconciliation oversight and End-of-Day results.
INSERT INTO public.role_feature_templates (role_key, module, feature, action)
SELECT 'accountant', 'finance', f.feature, a.action
FROM (VALUES ('eod'),('sessions')) AS f(feature)
CROSS JOIN (VALUES ('view'),('create'),('edit'),('export')) AS a(action)
ON CONFLICT (role_key, module, feature, action) DO NOTHING;
