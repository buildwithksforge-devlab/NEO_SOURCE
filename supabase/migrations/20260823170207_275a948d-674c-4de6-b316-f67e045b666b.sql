CREATE OR REPLACE FUNCTION public.fin_post_journal(_journal uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE j public.journal_entries; p public.accounting_periods; d numeric; c numeric; bad int;
BEGIN
  SELECT * INTO j FROM public.journal_entries WHERE id = _journal;
  IF j.id IS NULL THEN RAISE EXCEPTION 'Journal not found'; END IF;
  IF j.organization_id <> current_org_id() THEN RAISE EXCEPTION 'Not permitted'; END IF;
  IF NOT (public.neo_system_posting() OR has_permission('finance','approve') OR is_org_admin()) THEN
    RAISE EXCEPTION 'You do not have permission to post journals';
  END IF;
  IF j.status = 'posted' THEN RETURN jsonb_build_object('ok', true, 'already_posted', true, 'journal_id', j.id); END IF;
  IF j.status NOT IN ('draft','approved') THEN RAISE EXCEPTION 'Journal cannot be posted from status %', j.status; END IF;

  SELECT COALESCE(sum(debit),0), COALESCE(sum(credit),0) INTO d, c
    FROM public.journal_entry_lines WHERE journal_id = j.id;
  IF d = 0 AND c = 0 THEN RAISE EXCEPTION 'Journal has no lines'; END IF;
  IF d <> c THEN RAISE EXCEPTION 'Journal is not balanced (debit % vs credit %)', d, c; END IF;

  SELECT count(*) INTO bad FROM public.journal_entry_lines l
    JOIN public.chart_of_accounts a ON a.id = l.account_id
    WHERE l.journal_id = j.id AND (a.active = false OR a.postable = false OR a.is_header = true);
  IF bad > 0 THEN RAISE EXCEPTION 'Journal references inactive or non-postable accounts'; END IF;

  SELECT * INTO p FROM public.fin_period_for(j.organization_id, j.accounting_date);
  IF p.id IS NULL THEN RAISE EXCEPTION 'No accounting period covers %', j.accounting_date; END IF;
  IF p.status NOT IN ('open') AND NOT (p.status = 'soft_closed' AND j.journal_type = 'adjustment') THEN
    RAISE EXCEPTION 'Accounting period % is %', p.name, p.status;
  END IF;

  IF j.source_document_id IS NOT NULL AND EXISTS (
      SELECT 1 FROM public.journal_entries x
      WHERE x.organization_id = j.organization_id AND x.id <> j.id
        AND x.source_document_type = j.source_document_type
        AND x.source_document_id = j.source_document_id
        AND x.status = 'posted' AND x.journal_type <> 'reversal') THEN
    RAISE EXCEPTION 'This source document has already been posted';
  END IF;

  UPDATE public.journal_entries
    SET status='posted', total_debit=d, total_credit=c, period_id=p.id,
        posted_by=auth.uid(), posted_at=now()
    WHERE id = j.id;

  RETURN jsonb_build_object('ok', true, 'journal_id', j.id, 'total', d, 'period', p.name);
END $function$;

CREATE OR REPLACE FUNCTION public.neo_gl_post(_org uuid, _branch uuid, _module text, _source_type text, _source_id uuid, _posting_type text, _date date, _currency text, _desc text, _lines jsonb, _customer uuid DEFAULT NULL::uuid, _reverses uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE key text := _source_type || ':' || _source_id::text || ':' || _posting_type;
        j uuid; ln jsonb; i int := 0; td numeric := 0; tc numeric := 0; acct uuid;
        d numeric; c numeric; prior text;
BEGIN
  SELECT id INTO j FROM public.journal_entries
   WHERE organization_id = _org AND idempotency_key = key;
  IF j IS NOT NULL THEN
    RETURN jsonb_build_object('ok', true, 'journal_id', j, 'duplicate_prevented', true);
  END IF;

  INSERT INTO public.journal_entries
    (organization_id, branch_id, journal_number, journal_type, accounting_date,
     period_id, source_module, source_document_type, source_document_id,
     idempotency_key, description, currency, status, created_by, reverses_journal_id)
  VALUES (_org, _branch, public.next_document_number('journal','JV',_branch),
          CASE WHEN _reverses IS NULL THEN 'automatic' ELSE 'reversal' END, _date,
          public.neo_gl_period(_org, _date), _module,
          _source_type || ':' || _posting_type, _source_id, key, _desc,
          coalesce(_currency,'KES'), 'draft', auth.uid(), _reverses)
  RETURNING id INTO j;

  FOR ln IN SELECT * FROM jsonb_array_elements(_lines) LOOP
    d := round(coalesce((ln->>'debit')::numeric, 0), 2);
    c := round(coalesce((ln->>'credit')::numeric, 0), 2);
    CONTINUE WHEN d = 0 AND c = 0;
    acct := public.neo_gl_acct(_org, ln->>'code');
    IF acct IS NULL THEN
      RAISE EXCEPTION 'chart_of_accounts is missing postable account %', ln->>'code';
    END IF;
    i := i + 1;
    INSERT INTO public.journal_entry_lines
      (organization_id, journal_id, line_number, account_id, description, debit, credit,
       branch_id, customer_id)
    VALUES (_org, j, i, acct, coalesce(ln->>'description', _desc), d, c, _branch, _customer);
    td := td + d; tc := tc + c;
  END LOOP;

  IF i = 0 THEN RAISE EXCEPTION 'nothing_to_post'; END IF;
  IF round(td,2) <> round(tc,2) THEN
    RAISE EXCEPTION 'Journal does not balance: debits % vs credits %', td, tc;
  END IF;

  UPDATE public.journal_entries
     SET total_debit = round(td,2), total_credit = round(tc,2)
   WHERE id = j;

  -- Automatic module postings are system postings: the operational authority was
  -- already verified upstream, so the caller does not need manual journal rights.
  prior := coalesce(current_setting('neo.system_posting', true), 'off');
  PERFORM set_config('neo.system_posting', 'on', true);
  PERFORM public.fin_post_journal(j);
  PERFORM set_config('neo.system_posting', prior, true);
  RETURN jsonb_build_object('ok', true, 'journal_id', j, 'duplicate_prevented', false);
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.fin_post_journal(uuid) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.neo_gl_post(uuid,uuid,text,text,uuid,text,date,text,text,jsonb,uuid,uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fin_post_journal(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.neo_gl_post(uuid,uuid,text,text,uuid,text,date,text,text,jsonb,uuid,uuid) TO authenticated;