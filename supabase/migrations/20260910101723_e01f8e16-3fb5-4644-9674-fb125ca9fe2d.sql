CREATE OR REPLACE FUNCTION public.neo_bank_reconciliation_overview(_branch uuid DEFAULT NULL, _from date DEFAULT NULL, _to date DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER STABLE SET search_path TO 'public' AS $$
DECLARE org uuid; f date; t date; accounts jsonb; issues jsonb := '[]'::jsonb; totals jsonb; r record;
BEGIN
  org := public.current_org_id();
  IF org IS NULL THEN RETURN jsonb_build_object('ok', false, 'reason', 'no_organisation'); END IF;
  IF NOT (public.has_permission('finance','banking','manage')
          OR public.has_permission('finance','view')
          OR public.has_permission('finance','edit')) THEN
    RAISE EXCEPTION 'Not permitted to view bank reconciliation' USING ERRCODE = '42501';
  END IF;
  f := coalesce(_from, (now() - interval '90 days')::date);
  t := coalesce(_to, now()::date);

  -- Per account: what the bank says, and how much of it NEO can explain.
  SELECT coalesce(jsonb_agg(x ORDER BY x->>'name'), '[]'::jsonb) INTO accounts
  FROM (
    SELECT jsonb_build_object(
      'account_id', b.id,
      'name', b.name,
      'bank_name', b.bank_name,
      'currency', b.currency,
      'lines', count(e.id),
      'money_in', coalesce(sum(CASE WHEN e.amount > 0 THEN e.amount ELSE 0 END), 0),
      'money_out', coalesce(sum(CASE WHEN e.amount < 0 THEN -e.amount ELSE 0 END), 0),
      'matched_lines', count(e.id) FILTER (WHERE e.status = 'matched'),
      'matched_amount', coalesce(sum(e.amount) FILTER (WHERE e.status = 'matched'), 0),
      'open_lines', count(e.id) FILTER (WHERE e.status <> 'matched'),
      'open_amount', coalesce(sum(e.amount) FILTER (WHERE e.status <> 'matched'), 0)
    ) AS x
    FROM public.bank_accounts b
    LEFT JOIN public.bank_statement_entries e
      ON e.bank_account_id = b.id AND e.organization_id = org AND e.value_date BETWEEN f AND t
    WHERE b.organization_id = org AND b.active
    GROUP BY b.id, b.name, b.bank_name, b.currency
  ) s;

  -- 1. A payment recorded at the till that the bank has not shown in a week.
  FOR r IN
    SELECT a.id, a.amount, a.reference, a.requested_at, a.source_module
    FROM public.payment_attempts a
    WHERE a.organization_id = org AND a.method = 'bank-transfer'
      AND a.verified_at IS NULL AND a.state IN ('confirmed','pending','requested')
      AND a.requested_at::date BETWEEN f AND t
      AND a.requested_at < now() - interval '7 days'
      AND (_branch IS NULL OR a.branch_id = _branch)
    ORDER BY a.requested_at LIMIT 100
  LOOP
    issues := issues || jsonb_build_object(
      'kind', 'awaiting_bank',
      'severity', 'high',
      'title', 'Recorded but not seen on the bank',
      'detail', 'Taken ' || to_char(r.requested_at, 'DD Mon') || ' with reference ' || coalesce(r.reference, 'none') || '.',
      'amount', r.amount, 'reference', r.reference, 'attempt_id', r.id, 'occurred_at', r.requested_at);
  END LOOP;

  -- 2. Money in the bank that no payment claims.
  FOR r IN
    SELECT e.id, e.amount, e.external_reference AS reference, e.value_date, e.description
    FROM public.bank_statement_entries e
    WHERE e.organization_id = org AND e.status = 'unmatched' AND e.direction = 'credit'
      AND e.value_date BETWEEN f AND t
      AND e.value_date < (now() - interval '7 days')::date
    ORDER BY e.value_date LIMIT 100
  LOOP
    issues := issues || jsonb_build_object(
      'kind', 'unclaimed_receipt',
      'severity', 'high',
      'title', 'Money in the bank with no payment recorded',
      'detail', coalesce(r.description, 'No description') || ' on ' || to_char(r.value_date, 'DD Mon') || '.',
      'amount', r.amount, 'reference', r.reference, 'entry_id', r.id, 'occurred_at', r.value_date);
  END LOOP;

  -- 3. Same reference, different amount: the likeliest short or over payment.
  FOR r IN
    SELECT a.id AS attempt_id, e.id AS entry_id, a.amount AS expected, e.amount AS actual,
           a.reference, e.value_date
    FROM public.payment_attempts a
    JOIN public.bank_statement_entries e
      ON e.organization_id = org AND e.status = 'unmatched'
     AND a.reference IS NOT NULL AND e.external_reference IS NOT NULL
     AND lower(trim(e.external_reference)) = lower(trim(a.reference))
    WHERE a.organization_id = org AND a.method = 'bank-transfer' AND a.verified_at IS NULL
      AND abs(e.amount - a.amount) >= 0.01
      AND a.requested_at::date BETWEEN f AND t
      AND (_branch IS NULL OR a.branch_id = _branch)
    LIMIT 100
  LOOP
    issues := issues || jsonb_build_object(
      'kind', 'amount_disagrees',
      'severity', 'high',
      'title', 'Reference matches but the amount does not',
      'detail', 'Recorded ' || r.expected::text || ', bank shows ' || r.actual::text || '.',
      'amount', r.actual - r.expected, 'reference', r.reference,
      'attempt_id', r.attempt_id, 'entry_id', r.entry_id, 'occurred_at', r.value_date);
  END LOOP;

  -- 4. The same reference twice on the statement.
  FOR r IN
    SELECT e.external_reference AS reference, count(*) AS times, sum(e.amount) AS amount,
           max(e.value_date) AS value_date
    FROM public.bank_statement_entries e
    WHERE e.organization_id = org AND e.external_reference IS NOT NULL
      AND e.value_date BETWEEN f AND t
    GROUP BY e.external_reference
    HAVING count(*) > 1
    ORDER BY count(*) DESC LIMIT 50
  LOOP
    issues := issues || jsonb_build_object(
      'kind', 'repeated_reference',
      'severity', 'medium',
      'title', 'The same reference appears more than once',
      'detail', r.reference || ' appears ' || r.times::text || ' times.',
      'amount', r.amount, 'reference', r.reference, 'occurred_at', r.value_date);
  END LOOP;

  SELECT jsonb_build_object(
    'awaiting_count', count(*) FILTER (WHERE a.verified_at IS NULL),
    'awaiting_amount', coalesce(sum(a.amount) FILTER (WHERE a.verified_at IS NULL), 0),
    'verified_count', count(*) FILTER (WHERE a.verified_at IS NOT NULL),
    'verified_amount', coalesce(sum(a.amount) FILTER (WHERE a.verified_at IS NOT NULL), 0)
  ) INTO totals
  FROM public.payment_attempts a
  WHERE a.organization_id = org AND a.method = 'bank-transfer'
    AND a.state IN ('confirmed','pending','requested')
    AND a.requested_at::date BETWEEN f AND t
    AND (_branch IS NULL OR a.branch_id = _branch);

  RETURN jsonb_build_object('ok', true, 'from', f, 'to', t,
    'accounts', accounts, 'transfers', totals,
    'issues', issues, 'issue_count', jsonb_array_length(issues));
END; $$;

REVOKE EXECUTE ON FUNCTION public.neo_bank_reconciliation_overview(uuid, date, date) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.neo_bank_reconciliation_overview(uuid, date, date) TO authenticated;