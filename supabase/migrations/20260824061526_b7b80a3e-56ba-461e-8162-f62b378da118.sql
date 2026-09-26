CREATE OR REPLACE FUNCTION public.fin_reverse_journal(_journal uuid, _reason text)
 RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE j public.journal_entries; nid uuid; num text;
BEGIN
  SELECT * INTO j FROM public.journal_entries WHERE id = _journal;
  IF j.id IS NULL OR j.organization_id <> current_org_id() THEN RAISE EXCEPTION 'Journal not found'; END IF;
  IF NOT (has_permission('finance','approve') OR is_org_admin()) THEN RAISE EXCEPTION 'Not permitted'; END IF;
  IF j.status <> 'posted' THEN RAISE EXCEPTION 'Only posted journals can be reversed'; END IF;
  IF j.reversed_by_journal_id IS NOT NULL
     OR EXISTS (SELECT 1 FROM public.journal_entries x WHERE x.reverses_journal_id = j.id) THEN
    RAISE EXCEPTION 'This journal has already been reversed';
  END IF;
  IF coalesce(trim(_reason),'') = '' THEN RAISE EXCEPTION 'A reason is required'; END IF;

  num := public.next_document_number('journal');
  INSERT INTO public.journal_entries (organization_id, branch_id, journal_number, journal_type, accounting_date,
    source_module, source_document_type, source_document_id, document_number, description, currency,
    reverses_journal_id, created_by, status)
  VALUES (j.organization_id, j.branch_id, num, 'reversal', CURRENT_DATE,
    j.source_module, j.source_document_type, j.source_document_id, j.document_number,
    'Reversal of ' || j.journal_number || ' — ' || _reason, j.currency, j.id, auth.uid(), 'draft')
  RETURNING id INTO nid;

  INSERT INTO public.journal_entry_lines (organization_id, journal_id, line_number, account_id, description,
    debit, credit, branch_id, department_id, cost_centre, revenue_centre, customer_id, corporate_account_id,
    supplier_id, folio_id, event_booking_id, payment_method, tax_code_id)
  SELECT organization_id, nid, line_number, account_id, 'Reversal: ' || description,
    credit, debit, branch_id, department_id, cost_centre, revenue_centre, customer_id, corporate_account_id,
    supplier_id, folio_id, event_booking_id, payment_method, tax_code_id
  FROM public.journal_entry_lines WHERE journal_id = j.id;

  PERFORM public.fin_post_journal(nid);
  -- The original stays posted so the reversal pair nets to zero in reports.
  UPDATE public.journal_entries SET reversed_by_journal_id = nid, updated_at = now() WHERE id = j.id;
  RETURN jsonb_build_object('ok', true, 'reversal_journal_id', nid, 'journal_number', num);
END $function$;

UPDATE public.journal_entries j
   SET status = 'posted', updated_at = now()
 WHERE j.status = 'reversed'
   AND EXISTS (SELECT 1 FROM public.journal_entries r
                WHERE r.reverses_journal_id = j.id AND r.status = 'posted');