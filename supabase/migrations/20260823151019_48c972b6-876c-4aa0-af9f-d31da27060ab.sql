-- Every automatic finance posting (POS revenue, folio charges and payments)
-- was failing: the poster stamped journal_type 'system', which the
-- journal_entries check constraint does not allow. The correct value for
-- machine-generated entries is 'automatic'.
CREATE OR REPLACE FUNCTION public.neo_gl_post(
  _org uuid, _branch uuid, _module text, _source_type text, _source_id uuid,
  _posting_type text, _date date, _desc text, _lines jsonb,
  _currency text DEFAULT 'KES', _customer uuid DEFAULT NULL, _reverses uuid DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE key text := _source_type || ':' || _source_id::text || ':' || _posting_type;
        j uuid; ln jsonb; i int := 0; td numeric := 0; tc numeric := 0; acct uuid;
        d numeric; c numeric;
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

  PERFORM public.fin_post_journal(j);
  RETURN jsonb_build_object('ok', true, 'journal_id', j, 'duplicate_prevented', false);
END;
$function$;

REVOKE ALL ON FUNCTION public.neo_gl_post(uuid, uuid, text, text, uuid, text, date, text, jsonb, text, uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.neo_gl_post(uuid, uuid, text, text, uuid, text, date, text, jsonb, text, uuid, uuid) TO authenticated, service_role;