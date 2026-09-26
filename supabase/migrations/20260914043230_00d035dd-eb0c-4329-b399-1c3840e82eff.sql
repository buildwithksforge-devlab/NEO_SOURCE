-- Settlement account review and controlled reclassification.
-- History is never rewritten: a wrongly classified receipt is corrected by a
-- new, dated, balanced adjustment journal that carries a written reason.

CREATE OR REPLACE FUNCTION public.neo_gl_settlement_review(
  _branch uuid DEFAULT NULL::uuid,
  _from date DEFAULT NULL::date,
  _to date DEFAULT NULL::date)
RETURNS TABLE(
  journal_id uuid, journal_number text, line_id uuid, accounting_date date,
  branch_id uuid, description text, method text, amount numeric, side text,
  current_code text, current_account text, expected_code text, expected_account text,
  expected_account_id uuid, already_reclassified boolean)
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $$
  WITH scope AS (
    SELECT public.current_org_id() AS org, public.current_access_scope() AS acc
  ),
  lines AS (
    SELECT j.id AS journal_id, j.journal_number, l.id AS line_id, j.accounting_date,
           j.branch_id, j.description, j.organization_id,
           lower(coalesce(l.payment_method, p.method, '')) AS method,
           greatest(l.debit, l.credit) AS amount,
           CASE WHEN l.debit > 0 THEN 'debit' ELSE 'credit' END AS side,
           a.code AS current_code, a.name AS current_account
      FROM public.journal_entries j
      JOIN public.journal_entry_lines l ON l.journal_id = j.id
      JOIN public.chart_of_accounts a ON a.id = l.account_id
      LEFT JOIN public.payments p ON p.id = j.source_document_id
      CROSS JOIN scope s
     WHERE j.organization_id = s.org
       AND (s.acc = 'all' OR j.branch_id IS NULL OR j.branch_id = ANY (public.current_branch_ids()))
       AND j.status = 'posted'
       AND j.journal_type <> 'reversal'
       AND j.reversed_by_journal_id IS NULL
       AND (l.debit > 0 OR l.credit > 0)
       AND coalesce(l.payment_method, p.method) IS NOT NULL
       AND a.code IN ('1000','1010','1020','1030','1040')
  ),
  expected AS (
    SELECT x.*, public.neo_gl_settlement_code_for(x.organization_id, x.method) AS expected_code
      FROM lines x
     WHERE x.method <> ''
  )
  SELECT e.journal_id, e.journal_number, e.line_id, e.accounting_date, e.branch_id,
         e.description, e.method, e.amount, e.side,
         e.current_code, e.current_account, e.expected_code, ea.name, ea.id,
         EXISTS (
           SELECT 1 FROM public.journal_entries r
            WHERE r.organization_id = e.organization_id
              AND r.status = 'posted'
              AND r.idempotency_key = 'settlement-reclass:' || e.line_id::text
         )
    FROM expected e
    JOIN public.chart_of_accounts ea
      ON ea.organization_id = e.organization_id AND ea.code = e.expected_code
     AND ea.active AND coalesce(ea.postable, true)
   WHERE e.expected_code IS DISTINCT FROM e.current_code
     AND (_branch IS NULL OR e.branch_id = _branch)
     AND (_from IS NULL OR e.accounting_date >= _from)
     AND (_to IS NULL OR e.accounting_date <= _to)
   ORDER BY e.accounting_date DESC, e.journal_number DESC
   LIMIT 500;
$$;

REVOKE ALL ON FUNCTION public.neo_gl_settlement_review(uuid, date, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.neo_gl_settlement_review(uuid, date, date) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.neo_gl_reclassify_settlement(
  _line uuid, _reason text, _date date DEFAULT NULL::date)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  l public.journal_entry_lines;
  j public.journal_entries;
  v_method text;
  v_expected text;
  v_expected_account uuid;
  v_current_code text;
  v_key text;
  v_num text;
  v_new uuid;
  v_date date;
BEGIN
  IF coalesce(trim(_reason), '') = '' THEN
    RAISE EXCEPTION 'A written reason is required before a receipt can be reclassified';
  END IF;

  SELECT * INTO l FROM public.journal_entry_lines WHERE id = _line;
  IF l.id IS NULL THEN RAISE EXCEPTION 'Journal line not found'; END IF;
  SELECT * INTO j FROM public.journal_entries WHERE id = l.journal_id;
  IF j.id IS NULL OR j.organization_id <> public.current_org_id() THEN
    RAISE EXCEPTION 'Journal line not found';
  END IF;
  IF NOT (public.has_permission('finance','approve') OR public.is_org_admin_for(j.organization_id)) THEN
    RAISE EXCEPTION 'You do not have permission to reclassify a settlement account';
  END IF;
  IF j.status <> 'posted' OR j.reversed_by_journal_id IS NOT NULL THEN
    RAISE EXCEPTION 'Only a posted, unreversed entry can be reclassified';
  END IF;

  SELECT lower(coalesce(l.payment_method, p.method, '')) INTO v_method
    FROM public.journal_entries e
    LEFT JOIN public.payments p ON p.id = e.source_document_id
   WHERE e.id = j.id;
  IF coalesce(v_method, '') = '' THEN
    RAISE EXCEPTION 'This entry does not record how the money was taken, so it cannot be reclassified automatically';
  END IF;

  SELECT a.code INTO v_current_code FROM public.chart_of_accounts a WHERE a.id = l.account_id;
  v_expected := public.neo_gl_settlement_code_for(j.organization_id, v_method);
  IF v_expected IS NULL OR v_expected = v_current_code THEN
    RAISE EXCEPTION 'This receipt is already in the account its payment method points to';
  END IF;

  SELECT a.id INTO v_expected_account FROM public.chart_of_accounts a
   WHERE a.organization_id = j.organization_id AND a.code = v_expected
     AND a.active AND coalesce(a.postable, true)
   LIMIT 1;
  IF v_expected_account IS NULL THEN
    RAISE EXCEPTION 'The property has no active account % to move this receipt into', v_expected;
  END IF;

  v_key := 'settlement-reclass:' || l.id::text;
  IF EXISTS (SELECT 1 FROM public.journal_entries x
              WHERE x.organization_id = j.organization_id AND x.idempotency_key = v_key) THEN
    RETURN jsonb_build_object('ok', true, 'already_reclassified', true);
  END IF;

  v_date := coalesce(_date, CURRENT_DATE);
  v_num := public.next_document_number('journal');

  INSERT INTO public.journal_entries (organization_id, branch_id, journal_number, journal_type,
    accounting_date, source_module, source_document_type, document_number, idempotency_key,
    description, currency, created_by, status)
  VALUES (j.organization_id, j.branch_id, v_num, 'adjustment', v_date, 'finance',
    'settlement_reclass', v_num, v_key,
    'Settlement reclassification of ' || j.journal_number || ' (' || v_method || ') — ' || trim(_reason),
    j.currency, auth.uid(), 'draft')
  RETURNING id INTO v_new;

  -- Move the amount: put it on the correct account on the original side,
  -- and take it off the account it was wrongly recorded in.
  INSERT INTO public.journal_entry_lines (organization_id, journal_id, line_number, account_id,
    description, debit, credit, branch_id, department_id, cost_centre, revenue_centre,
    customer_id, corporate_account_id, supplier_id, folio_id, event_booking_id, payment_method)
  VALUES
    (j.organization_id, v_new, 1, v_expected_account,
     'Reclassified from ' || coalesce(v_current_code,'?') || ': ' || l.description,
     l.debit, l.credit, l.branch_id, l.department_id, l.cost_centre, l.revenue_centre,
     l.customer_id, l.corporate_account_id, l.supplier_id, l.folio_id, l.event_booking_id, v_method),
    (j.organization_id, v_new, 2, l.account_id,
     'Reclassified to ' || v_expected || ': ' || l.description,
     l.credit, l.debit, l.branch_id, l.department_id, l.cost_centre, l.revenue_centre,
     l.customer_id, l.corporate_account_id, l.supplier_id, l.folio_id, l.event_booking_id, v_method);

  PERFORM public.fin_post_journal(v_new);

  INSERT INTO public.audit_logs (organization_id, branch_id, user_id, user_name, action, module,
    record_id, previous_value, new_value, reason)
  VALUES (j.organization_id, j.branch_id, auth.uid(),
    coalesce((SELECT full_name FROM public.profiles WHERE id = auth.uid()), 'system'),
    'settlement.reclassified', 'finance', j.journal_number,
    jsonb_build_object('account_code', v_current_code, 'line_id', l.id),
    jsonb_build_object('account_code', v_expected, 'journal_number', v_num, 'method', v_method),
    trim(_reason));

  RETURN jsonb_build_object('ok', true, 'journal_id', v_new, 'journal_number', v_num,
    'from_code', v_current_code, 'to_code', v_expected);
END
$$;

REVOKE ALL ON FUNCTION public.neo_gl_reclassify_settlement(uuid, text, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.neo_gl_reclassify_settlement(uuid, text, date) TO authenticated, service_role;