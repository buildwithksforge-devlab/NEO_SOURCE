DO $$
DECLARE
  actor uuid := 'f6e1e07f-3664-4608-bbd7-a3ef2e0c4bfc';  -- organisation owner
  org uuid; j record; res jsonb; rid uuid;
BEGIN
  PERFORM set_config('request.jwt.claims',
    json_build_object('sub', actor, 'role', 'authenticated')::text, true);
  SELECT organization_id INTO org FROM public.profiles WHERE id = actor;
  IF org IS NULL THEN RAISE EXCEPTION 'remediation actor has no organisation'; END IF;
  IF public.current_org_id() IS DISTINCT FROM org THEN
    RAISE EXCEPTION 'identity did not resolve for remediation actor';
  END IF;

  FOR j IN
    SELECT je.id, je.branch_id, je.journal_number, je.accounting_date,
           CASE WHEN je.journal_number = 'JV-ZSN-2026-000015' THEN '4050' ELSE '4010' END AS rev_code,
           CASE WHEN je.journal_number = 'JV-ZSN-2026-000015' THEN 288.00 ELSE 2240.00 END AS amt
      FROM public.journal_entries je
     WHERE je.organization_id = org
       AND je.journal_number IN ('JV-ZSN-2026-000002','JV-ZSN-2026-000004',
                                 'JV-ZSN-2026-000005','JV-ZSN-2026-000017',
                                 'JV-ZSN-2026-000015')
  LOOP
    res := public.neo_gl_post(
      org, j.branch_id, 'finance', 'correction', j.id, 'ar_grossup_correction',
      j.accounting_date, 'KES',
      'Correction of ' || j.journal_number || ' — guest ledger and revenue were grossed up by the tax amount',
      jsonb_build_array(
        jsonb_build_object('code', j.rev_code, 'debit', j.amt, 'description', 'Reverse overstated revenue'),
        jsonb_build_object('code', '1060', 'credit', j.amt, 'description', 'Reverse overstated guest ledger')),
      NULL, NULL);
    RAISE NOTICE 'grossup % -> %', j.journal_number, res;
  END LOOP;

  FOR j IN
    SELECT je.id, je.branch_id, je.journal_number, je.accounting_date,
           CASE WHEN je.journal_number = 'JV-ZSN-2026-000019' THEN '4030' ELSE '4020' END AS rev_code,
           CASE je.journal_number WHEN 'JV-ZSN-2026-000001' THEN 2150.00
                                  WHEN 'JV-ZSN-2026-000014' THEN 300.00
                                  ELSE 500.00 END AS amt
      FROM public.journal_entries je
     WHERE je.organization_id = org
       AND je.journal_number IN ('JV-ZSN-2026-000001','JV-ZSN-2026-000014','JV-ZSN-2026-000019')
  LOOP
    res := public.neo_gl_post(
      org, j.branch_id, 'finance', 'correction', j.id, 'revenue_reclass',
      j.accounting_date, 'KES',
      'Reclassification of ' || j.journal_number || ' from 4090 Other Revenue to the operating revenue account',
      jsonb_build_array(
        jsonb_build_object('code', '4090', 'debit', j.amt, 'description', 'Out of Other Revenue'),
        jsonb_build_object('code', j.rev_code, 'credit', j.amt, 'description', 'To operating revenue')),
      NULL, NULL);
    RAISE NOTICE 'reclass % -> %', j.journal_number, res;
  END LOOP;

  FOR rid IN
    SELECT id FROM public.finance_posting_receipts
     WHERE organization_id = org AND status IN ('failed','blocked')
       AND coalesce(amount,0) > 0
     ORDER BY created_at
  LOOP
    res := public.neo_posting_receipt_action(rid, 'retry',
      'Historical remediation on behalf of the organisation owner — reposting under corrected tax logic');
    RAISE NOTICE 'retry % -> %', rid, res;
  END LOOP;

  FOR rid IN
    SELECT id FROM public.finance_posting_receipts
     WHERE organization_id = org AND status IN ('failed','blocked')
       AND coalesce(amount,0) = 0
  LOOP
    PERFORM public.neo_posting_receipt_action(rid, 'resolve',
      'Laundry order has no counted or priced items — nothing is chargeable. Price the order to reopen it.');
  END LOOP;

  FOR rid IN
    SELECT r.id FROM public.finance_posting_receipts r
     WHERE r.organization_id = org AND r.status IN ('failed','blocked')
       AND EXISTS (SELECT 1 FROM public.journal_entries je
                    WHERE je.organization_id = org AND je.source_document_id = r.source_id
                      AND je.status = 'posted')
  LOOP
    PERFORM public.neo_posting_receipt_action(rid, 'resolve',
      'Already recognised in the ledger through the canonical posting for this record — duplicate receipt closed.');
  END LOOP;
END $$;