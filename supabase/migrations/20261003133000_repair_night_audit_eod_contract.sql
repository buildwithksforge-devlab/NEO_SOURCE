-- NEØ Night Audit / EOD contract repair
-- Restores canonical per-day audit signing and rerun behaviour lost by the
-- 20260901000000 replacement, while keeping Run Audit inspection-only.

CREATE OR REPLACE FUNCTION public.neo_night_audit_run(
  _branch uuid,
  _date date DEFAULT NULL::date,
  _mode text DEFAULT 'manual'::text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  org uuid := public.current_org_id();
  d date := coalesce(_date,current_date);
  rid uuid;
  ref text;
  attempt int;
  started timestamptz := now();

  blockers int := 0;
  warnings int := 0;

  counts jsonb := '{}'::jsonb;
  snapshot jsonb := '[]'::jsonb;
  run_summary jsonb;
  digest text;
  operator text;
  err text;
  outcome text;
BEGIN
  IF org IS NULL THEN
    RAISE EXCEPTION 'No workspace context';
  END IF;

  IF NOT (
    public.has_permission('finance','eod','view')
    OR public.is_org_admin()
  ) THEN
    RAISE EXCEPTION 'Forbidden';
  END IF;

  IF _branch IS NULL OR NOT EXISTS (
    SELECT 1
    FROM public.branches b
    WHERE b.id = _branch
      AND b.organization_id = org
  ) THEN
    RAISE EXCEPTION 'Unknown property';
  END IF;

  IF NOT public.neo_branch_in_scope(_branch)
     AND NOT public.is_org_admin() THEN
    RAISE EXCEPTION 'That property is outside your access scope'
      USING ERRCODE='42501';
  END IF;

  -- Audit only belongs to an explicitly OPEN business day.
  IF NOT EXISTS (
    SELECT 1
    FROM public.business_days bd
    WHERE bd.organization_id = org
      AND bd.branch_id = _branch
      AND bd.business_date = d
      AND bd.status = 'open'
  ) THEN
    RETURN jsonb_build_object(
      'status','not_open',
      'business_date',d,
      'blocking',1,
      'warnings',0,
      'message','Open this business day before running End of Day.'
    );
  END IF;

  SELECT coalesce(p.full_name,p.email)
  INTO operator
  FROM public.profiles p
  WHERE p.id = auth.uid();

  -- One canonical run per organisation/property/business date.
  -- Rerunning refreshes that record instead of creating duplicates.
  INSERT INTO public.night_audit_runs(
    organization_id,
    branch_id,
    business_date,
    run_mode,
    created_by,
    started_at,
    operator_name,
    run_reference,
    status,
    stage,
    rerun_count
  )
  VALUES(
    org,
    _branch,
    d,
    coalesce(_mode,'manual'),
    auth.uid(),
    started,
    operator,
    public.neo_night_audit_reference(org,_branch,d),
    'running',
    'collecting',
    0
  )
  ON CONFLICT(organization_id,branch_id,business_date)
  DO UPDATE SET
    run_mode = excluded.run_mode,
    created_by = auth.uid(),
    started_at = started,
    completed_at = NULL,
    operator_name = excluded.operator_name,
    status = 'running',
    stage = 'collecting',
    blocking_count = 0,
    warning_count = 0,
    result_digest = NULL,
    signed_at = NULL,
    rerun_count = public.night_audit_runs.rerun_count + 1
  RETURNING
    id,
    run_reference,
    rerun_count + 1
  INTO rid,ref,attempt;

  INSERT INTO public.night_audit_attempts(
    run_id,
    organization_id,
    branch_id,
    business_date,
    attempt_number,
    stage,
    status,
    started_at,
    actor_id
  )
  VALUES(
    rid,org,_branch,d,attempt,'collecting','running',started,auth.uid()
  );

  BEGIN
    -- Refresh exceptions for this canonical audit.
    DELETE FROM public.night_audit_exceptions
    WHERE run_id = rid;

    -- OPEN CASHIER / TILL: blocking.
    INSERT INTO public.night_audit_exceptions(
      run_id,organization_id,branch_id,business_date,
      category,severity,reference,detail,amount
    )
    SELECT
      rid,org,_branch,d,
      'cashier-session','blocking',
      coalesce(s.shift_number,s.id::text),
      'Cashier session is still open for the audited business day.',
      s.expected_cash
    FROM public.pos_shifts s
    WHERE s.organization_id = org
      AND s.branch_id = _branch
      AND coalesce(s.status,'open') <> 'closed'
      AND s.opened_at::date <= d;

    -- CASH VARIANCE: warning.
    INSERT INTO public.night_audit_exceptions(
      run_id,organization_id,branch_id,business_date,
      category,severity,reference,detail,amount
    )
    SELECT
      rid,org,_branch,d,
      'cash-variance','warning',
      coalesce(s.shift_number,s.id::text),
      CASE
        WHEN s.variance < 0 THEN 'Cash shortage recorded on a closed cashier session.'
        ELSE 'Cash overage recorded on a closed cashier session.'
      END,
      s.variance
    FROM public.pos_shifts s
    WHERE s.organization_id = org
      AND s.branch_id = _branch
      AND s.status = 'closed'
      AND s.closed_at::date = d
      AND coalesce(s.variance,0) <> 0;

    -- UNSETTLED POS / BAR / RESTAURANT: blocking.
    INSERT INTO public.night_audit_exceptions(
      run_id,organization_id,branch_id,business_date,
      category,severity,reference,detail,amount
    )
    SELECT
      rid,org,_branch,d,
      'unsettled-bill','blocking',
      coalesce(o.order_number,o.id::text),
      'POS order is not fully settled.',
      greatest(
        coalesce(o.grand_total,0) - coalesce(o.paid_total,0),
        0
      )
    FROM public.pos_orders o
    WHERE o.organization_id = org
      AND o.branch_id = _branch
      AND o.created_at::date <= d
      AND coalesce(o.status,'draft')
          NOT IN ('cancelled','voided','charged-to-room','credit')
      AND coalesce(o.payment_status,'unpaid')
          NOT IN ('paid','settled','credit','transferred')
      AND greatest(
        coalesce(o.grand_total,0) - coalesce(o.paid_total,0),
        0
      ) > 0;

    -- OPEN FOLIOS: warning for review.
    INSERT INTO public.night_audit_exceptions(
      run_id,organization_id,branch_id,business_date,
      category,severity,reference,detail,amount
    )
    SELECT
      rid,org,_branch,d,
      'open-folio','warning',
      coalesce(f.folio_number,f.id::text),
      'Guest folio carries an outstanding balance.',
      f.balance
    FROM public.folios f
    WHERE f.organization_id = org
      AND f.branch_id = _branch
      AND f.status = 'open'
      AND coalesce(f.balance,0) <> 0;

    -- CANONICAL FINANCE EXCEPTIONS: blocking.
    INSERT INTO public.night_audit_exceptions(
      run_id,organization_id,branch_id,business_date,
      category,severity,reference,detail,amount
    )
    SELECT
      rid,org,_branch,d,
      'finance-posting','blocking',
      e.reference,
      coalesce(e.detail,e.reason,'Finance exception requires resolution.'),
      e.amount
    FROM public.neo_finance_exception_register(_branch,d,d) e;

    -- ELIGIBLE BUT UNPOSTED ITEMS: blocking.
    INSERT INTO public.night_audit_exceptions(
      run_id,organization_id,branch_id,business_date,
      category,severity,reference,detail,amount
    )
    SELECT
      rid,org,_branch,d,
      'finance-posting','blocking',
      q.reference,
      coalesce(q.required_action,'Eligible finance item has not yet been posted.'),
      q.amount
    FROM public.neo_finance_posting_queue(_branch,d,d) q
    WHERE q.eligible;

    -- PENDING CONTROLLED APPROVALS: warning.
    -- Correct identifier is approval_requests.reference, not request_number.
    INSERT INTO public.night_audit_exceptions(
      run_id,organization_id,branch_id,business_date,
      category,severity,reference,detail,amount
    )
    SELECT
      rid,org,_branch,d,
      'approval','warning',
      coalesce(nullif(a.reference,''),a.id::text),
      'Controlled transaction is still awaiting approval.',
      a.amount
    FROM public.approval_requests a
    WHERE a.organization_id = org
      AND a.branch_id = _branch
      AND a.created_at::date <= d
      AND public.neo_approval_normalize_status(a.status) = 'pending';

    -- DELIVERY CASH NOT HANDED OVER / RECONCILED: blocking.
    INSERT INTO public.night_audit_exceptions(
      run_id,organization_id,branch_id,business_date,
      category,severity,reference,detail,amount
    )
    SELECT
      rid,org,_branch,d,
      'delivery-cash','blocking',
      r.id::text,
      'Rider cash remittance has not been reconciled.',
      NULL
    FROM public.rider_cash_remittances r
    WHERE r.organization_id = org
      AND r.branch_id = _branch
      AND r.submitted_at::date <= d
      AND r.status <> 'reconciled';

    -- REFUNDS STILL FINANCIALLY UNSETTLED: blocking.
    INSERT INTO public.night_audit_exceptions(
      run_id,organization_id,branch_id,business_date,
      category,severity,reference,detail,amount
    )
    SELECT
      rid,org,_branch,d,
      'refund','blocking',
      r.id::text,
      'Refund is awaiting approval or settlement.',
      NULL
    FROM public.cash_refund_requests r
    WHERE r.organization_id = org
      AND r.branch_id = _branch
      AND r.created_at::date <= d
      AND r.status IN ('pending_approval','approved');

    SELECT
      count(*) FILTER (WHERE severity='blocking'),
      count(*) FILTER (WHERE severity='warning'),
      coalesce(
        jsonb_agg(to_jsonb(e) ORDER BY e.created_at),
        '[]'::jsonb
      )
    INTO blockers,warnings,snapshot
    FROM public.night_audit_exceptions e
    WHERE e.run_id = rid;

    SELECT
      coalesce(jsonb_object_agg(source_module,c),'{}'::jsonb)
    INTO counts
    FROM (
      SELECT source_module,count(*) c
      FROM public.canonical_transaction_states
      WHERE organization_id = org
        AND branch_id = _branch
        AND occurred_at::date = d
      GROUP BY source_module
    ) x;

    run_summary := jsonb_build_object(
      'reference',ref,
      'operator',operator,
      'started_at',started,
      'finished_at',now(),
      'source_counts',counts,
      'blocking',blockers,
      'warnings',warnings,
      'outcome',
        CASE WHEN blockers > 0 THEN 'exception' ELSE 'completed' END
    );

    digest := encode(
      digest(convert_to(run_summary::text,'UTF8'),'sha256'),
      'hex'
    );

    -- Signing means the inspection snapshot itself is immutable evidence.
    -- It does NOT mean the business day has been closed.
    UPDATE public.night_audit_runs
    SET
      blocking_count = blockers,
      warning_count = warnings,
      status = CASE WHEN blockers > 0 THEN 'exception' ELSE 'completed' END,
      stage = 'signed',
      completed_at = now(),
      source_counts = counts,
      exception_snapshot = snapshot,
      summary = run_summary,
      result_digest = digest,
      signed_at = now()
    WHERE id = rid;

    UPDATE public.night_audit_attempts
    SET
      stage = 'signed',
      status = CASE WHEN blockers > 0 THEN 'exception' ELSE 'completed' END,
      source_counts = counts,
      exception_snapshot = snapshot,
      result_digest = digest,
      completed_at = now()
    WHERE run_id = rid
      AND attempt_number = attempt;

  EXCEPTION WHEN OTHERS THEN
    err := SQLERRM;
    blockers := 1;

    UPDATE public.night_audit_runs
    SET
      blocking_count = 1,
      status = 'failed',
      stage = 'failed',
      completed_at = now(),
      summary = jsonb_build_object(
        'reference',ref,
        'failed_stage','collecting',
        'error',err
      ),
      result_digest = NULL,
      signed_at = NULL
    WHERE id = rid;

    UPDATE public.night_audit_attempts
    SET
      stage = 'failed',
      status = 'failed',
      error = err,
      completed_at = now()
    WHERE run_id = rid
      AND attempt_number = attempt;
  END;

  outcome :=
    CASE
      WHEN err IS NOT NULL THEN 'failed'
      WHEN blockers > 0 THEN 'exception'
      ELSE 'completed'
    END;

  PERFORM public.emit_domain_event(
    org,
    _branch,
    'night_audit.' || outcome,
    'finance',
    rid,
    jsonb_build_object(
      'reference',ref,
      'business_date',d,
      'attempt',attempt,
      'blocking',blockers,
      'warnings',warnings,
      'digest',digest,
      'error',err
    ),
    'night_audit:' || rid::text || ':' || attempt::text
  );

  PERFORM public.neo_canonical_transaction_set(
    _org := org,
    _branch := _branch,
    _module := 'finance',
    _source := rid,
    _reference := ref,
    _operational := outcome,
    _financial := CASE WHEN outcome='completed' THEN 'pending' ELSE 'blocked' END,
    _amount := 0,
    _currency := 'KES',
    _idempotency := 'night_audit:' || rid::text,
    _actor := auth.uid(),
    _owner := 'Finance',
    _next_action :=
      CASE
        WHEN outcome='completed' THEN 'Close the business day'
        ELSE 'Clear blocking exceptions and rerun'
      END,
    _blocker :=
      CASE
        WHEN outcome='completed' THEN NULL
        ELSE coalesce(err,blockers || ' blocking exception(s)')
      END,
    _journal := NULL,
    _receipt := NULL,
    _downstream := jsonb_build_object('night_audit.close_day',outcome),
    _metadata := jsonb_build_object(
      'entity_kind','night_audit',
      'business_date',d,
      'attempt',attempt,
      'source_counts',counts
    )
  );

  RETURN jsonb_build_object(
    'run_id',rid,
    'reference',ref,
    'business_date',d,
    'blocking',blockers,
    'warnings',warnings,
    'status',outcome,
    'stage',
      CASE WHEN err IS NOT NULL THEN 'failed' ELSE 'signed' END,
    'digest',digest,
    'error',err
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.neo_night_audit_run(uuid,date,text)
FROM PUBLIC, anon;

GRANT EXECUTE ON FUNCTION public.neo_night_audit_run(uuid,date,text)
TO authenticated;
