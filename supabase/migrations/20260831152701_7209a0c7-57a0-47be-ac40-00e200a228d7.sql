ALTER TABLE public.night_audit_runs DROP CONSTRAINT IF EXISTS night_audit_runs_status_chk;
ALTER TABLE public.night_audit_runs ADD CONSTRAINT night_audit_runs_status_chk
  CHECK (status = ANY (ARRAY['running'::text,'collecting'::text,'posting'::text,'completed'::text,'exception'::text,'failed'::text]));

CREATE OR REPLACE FUNCTION public.neo_finance_canonical_mark_posted(_org uuid, _source uuid, _journal uuid, _receipt uuid)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
  UPDATE public.canonical_transaction_states s
     SET financial_state = 'posted',
         journal_id = COALESCE(_journal, s.journal_id),
         receipt_id = COALESCE(_receipt, s.receipt_id),
         blocking_reason = NULL,
         next_action = 'Posted to the general ledger.',
         updated_at = now(),
         version = s.version + 1
   WHERE s.organization_id = _org
     AND s.source_id = _source
     AND s.financial_state NOT IN ('posted','reversed','not-applicable');
$$;

CREATE OR REPLACE FUNCTION public.neo_journal_canonical_sync()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
  IF NEW.status = 'posted'
     AND NEW.source_document_id IS NOT NULL
     AND COALESCE(NEW.total_debit,0) = COALESCE(NEW.total_credit,0)
     AND COALESCE(NEW.total_debit,0) <> 0 THEN
    PERFORM public.neo_finance_canonical_mark_posted(NEW.organization_id, NEW.source_document_id, NEW.id, NULL);
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_journal_canonical_sync ON public.journal_entries;
CREATE TRIGGER trg_journal_canonical_sync
AFTER INSERT OR UPDATE OF status ON public.journal_entries
FOR EACH ROW EXECUTE FUNCTION public.neo_journal_canonical_sync();

CREATE OR REPLACE FUNCTION public.neo_receipt_canonical_sync()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
  IF NEW.status = 'posted' AND NEW.source_id IS NOT NULL THEN
    PERFORM public.neo_finance_canonical_mark_posted(NEW.organization_id, NEW.source_id, NEW.journal_id, NEW.id);
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_receipt_canonical_sync ON public.finance_posting_receipts;
CREATE TRIGGER trg_receipt_canonical_sync
AFTER INSERT OR UPDATE OF status ON public.finance_posting_receipts
FOR EACH ROW EXECUTE FUNCTION public.neo_receipt_canonical_sync();

UPDATE public.canonical_transaction_states s
   SET financial_state = 'posted',
       journal_id = COALESCE(s.journal_id, j.id),
       blocking_reason = NULL,
       next_action = 'Posted to the general ledger.',
       updated_at = now(),
       version = s.version + 1
  FROM public.journal_entries j
 WHERE j.organization_id = s.organization_id
   AND j.source_document_id = s.source_id
   AND j.status = 'posted'
   AND COALESCE(j.total_debit,0) = COALESCE(j.total_credit,0)
   AND COALESCE(j.total_debit,0) <> 0
   AND s.financial_state NOT IN ('posted','reversed','not-applicable');

UPDATE public.canonical_transaction_states s
   SET financial_state = 'posted',
       receipt_id = COALESCE(s.receipt_id, r.id),
       journal_id = COALESCE(s.journal_id, r.journal_id),
       blocking_reason = NULL,
       next_action = 'Posted to the general ledger.',
       updated_at = now(),
       version = s.version + 1
  FROM public.finance_posting_receipts r
 WHERE r.organization_id = s.organization_id
   AND r.source_id = s.source_id
   AND r.status = 'posted'
   AND s.financial_state NOT IN ('posted','reversed','not-applicable');