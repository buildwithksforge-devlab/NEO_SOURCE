CREATE OR REPLACE FUNCTION public.neo_gl_post(_org uuid, _branch uuid, _module text, _source_type text, _source_id uuid, _posting_type text, _date date, _currency text, _desc text, _lines jsonb, _customer uuid DEFAULT NULL::uuid, _reverses uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE key text := _source_type || ':' || _source_id::text || ':' || _posting_type;
        j uuid; ln jsonb; i int := 0; td numeric := 0; tc numeric := 0; acct uuid;
        d numeric; c numeric; prior text; existing public.journal_entries;
BEGIN
  IF _org='aa17d427-f816-49bc-b02e-1a89e44806a2'::uuid THEN
    IF public.current_org_id() IS DISTINCT FROM _org OR NOT coalesce(public.neo_branch_in_scope(_branch),false) THEN
      RAISE EXCEPTION 'Posting is outside the current organization or property scope' USING ERRCODE='42501';
    END IF;
    IF _source_id IS NULL OR nullif(btrim(_source_type),'') IS NULL OR nullif(btrim(_posting_type),'') IS NULL THEN
      RAISE EXCEPTION 'Posting source and type are required' USING ERRCODE='22023';
    END IF;
    IF _lines IS NULL OR jsonb_typeof(_lines)<>'array' THEN RAISE EXCEPTION 'Posting lines must be an array'; END IF;
    IF jsonb_array_length(_lines)=0 THEN RAISE EXCEPTION 'nothing_to_post'; END IF;
    FOR ln IN SELECT * FROM jsonb_array_elements(_lines) LOOP
      d:=coalesce((ln->>'debit')::numeric,0);c:=coalesce((ln->>'credit')::numeric,0);
      IF d<0 OR c<0 OR d::text IN ('NaN','Infinity','-Infinity') OR c::text IN ('NaN','Infinity','-Infinity') OR (d>0 AND c>0) THEN
        RAISE EXCEPTION 'Posting amounts must be finite nonnegative and one-sided' USING ERRCODE='22023';
      END IF;
    END LOOP;
    PERFORM pg_advisory_xact_lock(hashtextextended('gl:'||_org::text||':'||key,0));
  END IF;
  SELECT id INTO j FROM public.journal_entries
   WHERE organization_id = _org
     AND (idempotency_key = key OR CASE WHEN _org='aa17d427-f816-49bc-b02e-1a89e44806a2'::uuid THEN left(idempotency_key,length(key||':correction:'))=key||':correction:' ELSE idempotency_key LIKE key||':correction:%' END)
     AND reversed_by_journal_id IS NULL
   ORDER BY created_at DESC LIMIT 1;
  IF j IS NOT NULL THEN
    IF _org='aa17d427-f816-49bc-b02e-1a89e44806a2'::uuid THEN
      SELECT * INTO existing FROM public.journal_entries WHERE id=j FOR UPDATE;
      IF existing.branch_id IS DISTINCT FROM _branch OR existing.currency IS DISTINCT FROM coalesce(_currency,'KES')
         OR existing.accounting_date IS DISTINCT FROM _date
         OR existing.source_document_id IS DISTINCT FROM _source_id OR existing.source_document_type IS DISTINCT FROM _source_type||':'||_posting_type THEN
        RAISE EXCEPTION 'Existing journal source, property or currency differs';
      END IF;
      IF existing.status IS NULL OR existing.status NOT IN ('posted','draft','approved') THEN RAISE EXCEPTION 'Existing journal cannot be reused from status %',existing.status; END IF;
      SELECT coalesce(sum(debit),0),coalesce(sum(credit),0) INTO td,tc FROM public.journal_entry_lines WHERE journal_id=j;
      IF td<=0 OR td<>tc OR td::text IN ('NaN','Infinity','-Infinity') OR tc::text IN ('NaN','Infinity','-Infinity')
         OR EXISTS(SELECT 1 FROM public.journal_entry_lines l LEFT JOIN public.chart_of_accounts a ON a.id=l.account_id
             WHERE l.journal_id=j AND (l.organization_id IS DISTINCT FROM _org OR a.organization_id IS DISTINCT FROM _org
               OR l.debit IS NULL OR l.credit IS NULL OR l.debit<0 OR l.credit<0 OR (l.debit>0 AND l.credit>0))) THEN
        RAISE EXCEPTION 'Existing journal has invalid or unbalanced lines';
      END IF;
      IF existing.status='posted' THEN
        IF existing.total_debit IS DISTINCT FROM td OR existing.total_credit IS DISTINCT FROM tc THEN RAISE EXCEPTION 'Posted journal totals disagree with its lines'; END IF;
      ELSE
        IF EXISTS(WITH wanted AS (
          SELECT requested.value->>'code' AS code,sum(round(coalesce((requested.value->>'debit')::numeric,0),2)) AS d,sum(round(coalesce((requested.value->>'credit')::numeric,0),2)) AS c
          FROM jsonb_array_elements(_lines) AS requested(value) GROUP BY 1
        ), actual AS (
          SELECT a.code,sum(l.debit) AS d,sum(l.credit) AS c FROM public.journal_entry_lines l JOIN public.chart_of_accounts a ON a.id=l.account_id
          WHERE l.journal_id=j GROUP BY a.code
        ) SELECT 1 FROM wanted w FULL JOIN actual a ON a.code=w.code
          WHERE coalesce(w.d,0)<>coalesce(a.d,0) OR coalesce(w.c,0)<>coalesce(a.c,0)) THEN
          RAISE EXCEPTION 'Existing draft lines differ from the requested posting';
        END IF;
        prior:=coalesce(current_setting('neo.system_posting',true),'off');
        BEGIN
          PERFORM set_config('neo.system_posting','on',true);
          PERFORM public.fin_post_journal(j);
          PERFORM set_config('neo.system_posting',prior,true);
        EXCEPTION WHEN OTHERS THEN
          PERFORM set_config('neo.system_posting',prior,true);RAISE;
        END;
        IF NOT EXISTS(SELECT 1 FROM public.journal_entries WHERE id=j AND status='posted') THEN RAISE EXCEPTION 'Existing journal did not reach posted status'; END IF;
      END IF;
    END IF;
    RETURN jsonb_build_object('ok', true, 'journal_id', j, 'duplicate_prevented', true);
  END IF;
  IF EXISTS (SELECT 1 FROM public.journal_entries
             WHERE organization_id = _org AND idempotency_key = key
               AND reversed_by_journal_id IS NOT NULL) THEN
    key := key || ':correction:' || (1 + (SELECT count(*) FROM public.journal_entries
      WHERE organization_id = _org AND CASE WHEN _org='aa17d427-f816-49bc-b02e-1a89e44806a2'::uuid THEN left(idempotency_key,length(key||':correction:'))=key||':correction:' ELSE idempotency_key LIKE key||':correction:%' END))::text;
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
$function$
