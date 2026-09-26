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
        AND x.status = 'posted' AND x.journal_type <> 'reversal') THEN
    RAISE EXCEPTION 'This source document has already been posted';
  END IF;

  UPDATE public.journal_entries
    SET status='posted', total_debit=d, total_credit=c, period_id=p.id,
        posted_by=auth.uid(), posted_at=now()
    WHERE id = j.id;

  RETURN jsonb_build_object('ok', true, 'journal_id', j.id, 'total', d, 'period', p.name);
END $function$;

DO $$
DECLARE
  owner_uid uuid := 'f6e1e07f-3664-4608-bbd7-a3ef2e0c4bfc';
  ln uuid; res jsonb; jid uuid;
BEGIN
  PERFORM set_config('request.jwt.claims',
    json_build_object('sub', owner_uid::text, 'role', 'authenticated')::text, true);

  -- 1. Empty laundry orders are cancelled, never completed
  UPDATE public.guest_laundry_orders
     SET status = 'cancelled',
         special_instructions = coalesce(special_instructions || ' | ', '')
           || 'Cancelled during data clean-up: no order number and no priced items.',
         updated_at = now()
   WHERE laundry_number IS NULL AND coalesce(total,0) = 0
     AND status <> 'cancelled';

  -- 2. Stray test payment on a draft POS order is voided
  PERFORM set_config('neo.payment_maintenance', 'on', true);
  UPDATE public.pos_payments p
     SET status = 'reversed', updated_at = now()
    FROM public.pos_orders o
   WHERE p.order_id = o.id AND o.order_number = 'POS-20260824-ODJ8F'
     AND o.status = 'draft' AND p.status = 'confirmed';
  UPDATE public.pos_orders
     SET payment_status = 'unpaid', updated_at = now()
   WHERE order_number = 'POS-20260824-ODJ8F' AND status = 'draft';
  PERFORM set_config('neo.payment_maintenance', 'off', true);

  -- 3. Reverse the three scratch folio charges and their journals
  FOR ln IN
    SELECT id FROM public.folio_lines
     WHERE description = '.,' AND status = 'posted' AND net_amount = 16240.00
  LOOP
    PERFORM set_config('neo.system_posting', 'on', true);
    PERFORM public.folio_reverse_line(ln, 'Reversal of a test charge captured during system testing.');
    PERFORM set_config('neo.system_posting', 'off', true);

    FOR jid IN
      SELECT j.id FROM public.journal_entries j
       WHERE j.source_document_id = ln AND j.status = 'posted'
         AND NOT EXISTS (SELECT 1 FROM public.journal_entries r WHERE r.reverses_journal_id = j.id)
    LOOP
      res := public.fin_reverse_journal(jid, 'Reversal of a test charge captured during system testing.');
    END LOOP;

    UPDATE public.finance_posting_receipts
       SET status = 'superseded',
           detail = 'Test charge reversed during data clean-up — no longer recognised as revenue.',
           updated_at = now()
     WHERE source_id = ln;
  END LOOP;
END $$;