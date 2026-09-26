-- ============================================================
-- 1. Statement lines can now name the payment they settle.
-- ============================================================
ALTER TABLE public.bank_statement_entries
  ADD COLUMN IF NOT EXISTS matched_attempt_id uuid,
  ADD COLUMN IF NOT EXISTS matched_payment_id uuid,
  ADD COLUMN IF NOT EXISTS matched_at timestamptz,
  ADD COLUMN IF NOT EXISTS matched_by uuid;

-- The same line imported twice is the same line: a statement can be re-uploaded
-- without doubling the bank.
CREATE UNIQUE INDEX IF NOT EXISTS bank_statement_entries_natural_key
  ON public.bank_statement_entries (bank_account_id, value_date, amount, coalesce(external_reference, ''), coalesce(description, ''));

CREATE INDEX IF NOT EXISTS bank_statement_entries_open_idx
  ON public.bank_statement_entries (organization_id, status, value_date DESC);

CREATE INDEX IF NOT EXISTS payment_attempts_bank_idx
  ON public.payment_attempts (organization_id, method, state, verified_at);

-- ============================================================
-- 2. Import statement lines (idempotent).
-- ============================================================
CREATE OR REPLACE FUNCTION public.neo_bank_statement_import(_account uuid, _rows jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE org uuid; acct public.bank_accounts; imported int := 0; skipped int := 0; r jsonb; inserted uuid;
BEGIN
  org := public.current_org_id();
  IF org IS NULL THEN RETURN jsonb_build_object('ok', false, 'reason', 'no_organisation'); END IF;
  IF NOT (public.has_permission('finance','banking','manage') OR public.has_permission('finance','edit')) THEN
    RAISE EXCEPTION 'Not permitted to import bank statements' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO acct FROM public.bank_accounts WHERE id = _account AND organization_id = org;
  IF acct.id IS NULL THEN RETURN jsonb_build_object('ok', false, 'reason', 'account_not_found'); END IF;
  IF jsonb_typeof(_rows) <> 'array' THEN RETURN jsonb_build_object('ok', false, 'reason', 'rows_not_a_list'); END IF;

  FOR r IN SELECT * FROM jsonb_array_elements(_rows) LOOP
    IF coalesce((r->>'amount')::numeric, 0) = 0 OR (r->>'value_date') IS NULL THEN
      skipped := skipped + 1; CONTINUE;
    END IF;
    INSERT INTO public.bank_statement_entries
      (organization_id, bank_account_id, value_date, description, external_reference,
       amount, direction, fees, status, imported_by)
    VALUES (org, _account, (r->>'value_date')::date, nullif(r->>'description',''),
       nullif(r->>'reference',''), (r->>'amount')::numeric,
       CASE WHEN (r->>'amount')::numeric < 0 THEN 'debit' ELSE 'credit' END,
       coalesce((r->>'fees')::numeric, 0), 'unmatched', auth.uid())
    ON CONFLICT DO NOTHING
    RETURNING id INTO inserted;
    IF inserted IS NULL THEN skipped := skipped + 1; ELSE imported := imported + 1; END IF;
    inserted := NULL;
  END LOOP;

  INSERT INTO public.audit_logs (organization_id, action, module, record_id, new_value, reason)
  VALUES (org, 'bank.statement.import', 'finance', _account::text,
          jsonb_build_object('imported', imported, 'skipped', skipped), 'Bank statement import');

  RETURN jsonb_build_object('ok', true, 'imported', imported, 'skipped', skipped);
END; $$;

-- ============================================================
-- 3. Transfers awaiting bank confirmation, with candidate lines.
-- ============================================================
CREATE OR REPLACE FUNCTION public.neo_bank_transfer_queue(_branch uuid DEFAULT NULL, _from date DEFAULT NULL, _to date DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER STABLE SET search_path TO 'public' AS $$
DECLARE org uuid; f date; t date; pending jsonb; open_lines jsonb;
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

  SELECT coalesce(jsonb_agg(x ORDER BY x->>'requested_at' DESC), '[]'::jsonb) INTO pending
  FROM (
    SELECT jsonb_build_object(
      'attempt_id', a.id, 'amount', a.amount, 'currency', a.currency,
      'reference', a.reference, 'module', a.source_module, 'branch_id', a.branch_id,
      'requested_at', a.requested_at, 'state', a.state, 'state_detail', a.state_detail,
      'candidates', (
        SELECT coalesce(jsonb_agg(jsonb_build_object(
                 'entry_id', e.id, 'value_date', e.value_date, 'amount', e.amount,
                 'reference', e.external_reference, 'description', e.description,
                 'exact_reference', (e.external_reference IS NOT NULL AND a.reference IS NOT NULL
                                     AND lower(trim(e.external_reference)) = lower(trim(a.reference)))
               ) ORDER BY e.value_date DESC), '[]'::jsonb)
        FROM public.bank_statement_entries e
        WHERE e.organization_id = org AND e.status = 'unmatched' AND e.direction = 'credit'
          AND abs(e.amount - a.amount) < 0.01
          AND e.value_date BETWEEN (a.requested_at::date - 7) AND (a.requested_at::date + 14)
      )) AS x
    FROM public.payment_attempts a
    WHERE a.organization_id = org
      AND a.method = 'bank-transfer'
      AND a.state IN ('confirmed','pending','requested')
      AND a.verified_at IS NULL
      AND a.requested_at::date BETWEEN f AND t
      AND (_branch IS NULL OR a.branch_id = _branch)
  ) s;

  SELECT coalesce(jsonb_agg(jsonb_build_object(
           'entry_id', e.id, 'bank_account_id', e.bank_account_id, 'value_date', e.value_date,
           'amount', e.amount, 'direction', e.direction,
           'reference', e.external_reference, 'description', e.description
         ) ORDER BY e.value_date DESC), '[]'::jsonb) INTO open_lines
  FROM public.bank_statement_entries e
  WHERE e.organization_id = org AND e.status = 'unmatched' AND e.value_date BETWEEN f AND t;

  RETURN jsonb_build_object('ok', true, 'awaiting', pending, 'open_lines', open_lines,
    'from', f, 'to', t,
    'accounts', (SELECT count(*) FROM public.bank_accounts WHERE organization_id = org AND active));
END; $$;

-- ============================================================
-- 4. Match, auto-match and unmatch.
-- ============================================================
CREATE OR REPLACE FUNCTION public.neo_bank_match_transfer(_attempt uuid, _entry uuid, _note text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE org uuid; a public.payment_attempts; e public.bank_statement_entries;
BEGIN
  org := public.current_org_id();
  IF org IS NULL THEN RETURN jsonb_build_object('ok', false, 'reason', 'no_organisation'); END IF;
  IF NOT (public.has_permission('finance','banking','manage') OR public.has_permission('finance','edit')) THEN
    RAISE EXCEPTION 'Not permitted to reconcile bank transfers' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO a FROM public.payment_attempts WHERE id = _attempt AND organization_id = org;
  IF a.id IS NULL THEN RETURN jsonb_build_object('ok', false, 'reason', 'payment_not_found'); END IF;
  SELECT * INTO e FROM public.bank_statement_entries WHERE id = _entry AND organization_id = org;
  IF e.id IS NULL THEN RETURN jsonb_build_object('ok', false, 'reason', 'statement_line_not_found'); END IF;
  IF e.status = 'matched' THEN RETURN jsonb_build_object('ok', false, 'reason', 'line_already_matched'); END IF;
  IF a.verified_at IS NOT NULL THEN RETURN jsonb_build_object('ok', false, 'reason', 'already_verified'); END IF;
  IF abs(e.amount - a.amount) >= 0.01 THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'amount_mismatch',
      'detail', 'The bank line and the payment are not the same amount.');
  END IF;

  UPDATE public.payment_attempts
     SET state = 'confirmed', verified_by = auth.uid(), verified_at = now(),
         verification_note = coalesce(_note, 'Matched to bank statement line'),
         state_detail = 'Confirmed against the bank statement.',
         provider_reference = coalesce(a.provider_reference, e.external_reference),
         confirmed_at = coalesce(a.confirmed_at, now())
   WHERE id = a.id;

  UPDATE public.bank_statement_entries
     SET status = 'matched', matched_attempt_id = a.id, matched_payment_id = a.payment_id,
         matched_at = now(), matched_by = auth.uid()
   WHERE id = e.id;

  INSERT INTO public.audit_logs (organization_id, action, module, record_id, new_value, reason)
  VALUES (org, 'bank.transfer.matched', 'finance', a.id::text,
          jsonb_build_object('entry_id', e.id, 'amount', a.amount, 'reference', e.external_reference),
          coalesce(_note, 'Bank transfer verified'));

  RETURN jsonb_build_object('ok', true, 'attempt_id', a.id, 'entry_id', e.id, 'state', 'confirmed');
END; $$;

CREATE OR REPLACE FUNCTION public.neo_bank_auto_match(_branch uuid DEFAULT NULL, _commit boolean DEFAULT false)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE org uuid; pair record; matched int := 0; proposals jsonb := '[]'::jsonb; res jsonb;
BEGIN
  org := public.current_org_id();
  IF org IS NULL THEN RETURN jsonb_build_object('ok', false, 'reason', 'no_organisation'); END IF;
  IF NOT (public.has_permission('finance','banking','manage') OR public.has_permission('finance','edit')) THEN
    RAISE EXCEPTION 'Not permitted to reconcile bank transfers' USING ERRCODE = '42501';
  END IF;

  FOR pair IN
    SELECT a.id AS attempt_id, e.id AS entry_id, a.amount, e.external_reference
      FROM public.payment_attempts a
      JOIN public.bank_statement_entries e
        ON e.organization_id = a.organization_id
       AND e.status = 'unmatched'
       AND e.direction = 'credit'
       AND abs(e.amount - a.amount) < 0.01
       AND a.reference IS NOT NULL AND e.external_reference IS NOT NULL
       AND lower(trim(e.external_reference)) = lower(trim(a.reference))
     WHERE a.organization_id = org AND a.method = 'bank-transfer' AND a.verified_at IS NULL
       AND (_branch IS NULL OR a.branch_id = _branch)
  LOOP
    -- Only an unambiguous single pairing is ever applied automatically.
    IF (SELECT count(*) FROM public.bank_statement_entries e2
         WHERE e2.organization_id = org AND e2.status = 'unmatched'
           AND lower(trim(coalesce(e2.external_reference,''))) = lower(trim(coalesce(pair.external_reference,''))) ) > 1 THEN
      CONTINUE;
    END IF;
    proposals := proposals || jsonb_build_object('attempt_id', pair.attempt_id, 'entry_id', pair.entry_id, 'amount', pair.amount);
    IF _commit THEN
      res := public.neo_bank_match_transfer(pair.attempt_id, pair.entry_id, 'Matched automatically on an exact reference and amount');
      IF coalesce((res->>'ok')::boolean, false) THEN matched := matched + 1; END IF;
    END IF;
  END LOOP;

  RETURN jsonb_build_object('ok', true, 'committed', _commit, 'matched', matched,
    'proposals', proposals, 'proposal_count', jsonb_array_length(proposals));
END; $$;

CREATE OR REPLACE FUNCTION public.neo_bank_unmatch_transfer(_entry uuid, _reason text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE org uuid; e public.bank_statement_entries;
BEGIN
  org := public.current_org_id();
  IF org IS NULL THEN RETURN jsonb_build_object('ok', false, 'reason', 'no_organisation'); END IF;
  IF NOT (public.has_permission('finance','banking','manage') OR public.has_permission('finance','edit')) THEN
    RAISE EXCEPTION 'Not permitted to reconcile bank transfers' USING ERRCODE = '42501';
  END IF;
  IF coalesce(trim(_reason),'') = '' THEN RETURN jsonb_build_object('ok', false, 'reason', 'reason_required'); END IF;

  SELECT * INTO e FROM public.bank_statement_entries WHERE id = _entry AND organization_id = org;
  IF e.id IS NULL THEN RETURN jsonb_build_object('ok', false, 'reason', 'statement_line_not_found'); END IF;
  IF e.status <> 'matched' THEN RETURN jsonb_build_object('ok', false, 'reason', 'line_not_matched'); END IF;

  UPDATE public.payment_attempts
     SET verified_by = NULL, verified_at = NULL,
         verification_note = 'Bank match withdrawn: ' || _reason,
         state_detail = 'Recorded from a transfer reference; not yet seen on the bank statement.'
   WHERE id = e.matched_attempt_id AND organization_id = org;

  UPDATE public.bank_statement_entries
     SET status = 'unmatched', matched_attempt_id = NULL, matched_payment_id = NULL,
         matched_at = NULL, matched_by = NULL
   WHERE id = e.id;

  INSERT INTO public.audit_logs (organization_id, action, module, record_id, previous_value, reason)
  VALUES (org, 'bank.transfer.unmatched', 'finance', e.id::text,
          jsonb_build_object('attempt_id', e.matched_attempt_id), _reason);

  RETURN jsonb_build_object('ok', true, 'entry_id', e.id);
END; $$;

-- ============================================================
-- 5. Card terminal / QR: mark a request as sent to the processor.
-- ============================================================
CREATE OR REPLACE FUNCTION public.neo_payment_intent_mark_sent(_intent uuid, _provider_reference text DEFAULT NULL, _detail text DEFAULT NULL, _failed boolean DEFAULT false)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE org uuid; a public.payment_attempts;
BEGIN
  org := public.current_org_id();
  IF org IS NULL THEN RETURN jsonb_build_object('ok', false, 'reason', 'no_organisation'); END IF;
  IF NOT (public.has_permission('pos','payments','process')
          OR public.has_permission('finance','collections','record_payment')
          OR public.has_permission('finance','edit')) THEN
    RAISE EXCEPTION 'Not permitted to take payments' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO a FROM public.payment_attempts
   WHERE payment_table = 'payment_intents' AND payment_id = _intent AND organization_id = org;
  IF a.id IS NULL THEN RETURN jsonb_build_object('ok', false, 'reason', 'intent_not_found'); END IF;
  IF a.state NOT IN ('requested','pending') THEN
    RETURN jsonb_build_object('ok', true, 'state', a.state, 'detail', 'Already answered.');
  END IF;

  UPDATE public.payment_attempts
     SET state = CASE WHEN _failed THEN 'failed' ELSE 'pending' END,
         state_detail = coalesce(_detail, CASE WHEN _failed
            THEN 'The processor could not be reached.'
            ELSE 'Sent to the processor; waiting for the customer to complete it.' END),
         provider_reference = coalesce(nullif(_provider_reference,''), a.provider_reference)
   WHERE id = a.id;

  INSERT INTO public.payment_attempt_events (attempt_id, organization_id, state, detail, payload, created_by)
  VALUES (a.id, org, CASE WHEN _failed THEN 'failed' ELSE 'pending' END, _detail,
          jsonb_build_object('provider_reference', _provider_reference), auth.uid());

  RETURN jsonb_build_object('ok', true, 'state', CASE WHEN _failed THEN 'failed' ELSE 'pending' END);
END; $$;

REVOKE EXECUTE ON FUNCTION public.neo_bank_statement_import(uuid, jsonb) FROM public, anon;
REVOKE EXECUTE ON FUNCTION public.neo_bank_transfer_queue(uuid, date, date) FROM public, anon;
REVOKE EXECUTE ON FUNCTION public.neo_bank_match_transfer(uuid, uuid, text) FROM public, anon;
REVOKE EXECUTE ON FUNCTION public.neo_bank_auto_match(uuid, boolean) FROM public, anon;
REVOKE EXECUTE ON FUNCTION public.neo_bank_unmatch_transfer(uuid, text) FROM public, anon;
REVOKE EXECUTE ON FUNCTION public.neo_payment_intent_mark_sent(uuid, text, text, boolean) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.neo_bank_statement_import(uuid, jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.neo_bank_transfer_queue(uuid, date, date) TO authenticated;
GRANT EXECUTE ON FUNCTION public.neo_bank_match_transfer(uuid, uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.neo_bank_auto_match(uuid, boolean) TO authenticated;
GRANT EXECUTE ON FUNCTION public.neo_bank_unmatch_transfer(uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.neo_payment_intent_mark_sent(uuid, text, text, boolean) TO authenticated;