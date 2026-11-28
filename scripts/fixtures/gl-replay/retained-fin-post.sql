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

  IF j.journal_type <> 'reversal' AND j.source_document_id IS NOT NULL AND EXISTS (
      SELECT 1 FROM public.journal_entries x
      WHERE x.organization_id = j.organization_id AND x.id <> j.id
        AND x.source_document_type = j.source_document_type
        AND x.source_document_id = j.source_document_id
        AND x.status = 'posted' AND x.journal_type <> 'reversal'
        AND x.reversed_by_journal_id IS NULL) THEN
    RAISE EXCEPTION 'This source document has already been posted';
  END IF;

  UPDATE public.journal_entries
    SET status='posted', total_debit=d, total_credit=c, period_id=p.id,
        posted_by=auth.uid(), posted_at=now()
    WHERE id = j.id;

  RETURN jsonb_build_object('ok', true, 'journal_id', j.id, 'total', d, 'period', p.name);
END $function$
