CREATE OR REPLACE FUNCTION public.neo_laundry_posting_invariant()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
BEGIN
  IF NEW.posting_status = 'posted' AND (NEW.folio_line_id IS NULL OR NEW.folio_id IS NULL)
     AND NOT EXISTS (SELECT 1 FROM public.finance_posting_receipts r
                      WHERE r.source_module = 'laundry' AND r.source_id = NEW.id
                        AND r.status = 'posted' AND r.journal_id IS NOT NULL) THEN
    RAISE EXCEPTION 'Laundry order cannot be marked posted without a folio charge line or a posted ledger journal';
  END IF;
  RETURN NEW;
END $function$
