CREATE OR REPLACE FUNCTION public.neo_receipt_resolve_journal()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE evidence jsonb;
BEGIN
  -- A POS room transfer is backed by its folio journal, not another POS revenue posting.
  IF NEW.source_module IN ('pos','pos_order') AND lower(coalesce(NEW.status,''))='posted'
     AND EXISTS(SELECT 1 FROM public.pos_orders o WHERE o.id=NEW.source_id
       AND o.organization_id=NEW.organization_id AND o.branch_id IS NOT DISTINCT FROM NEW.branch_id
       AND o.folio_id IS NOT NULL) THEN
    evidence:=public.neo_pos_room_charge_evidence(NEW.organization_id,NEW.branch_id,NEW.source_id,
      NEW.folio_line_id,NEW.journal_id);
    IF evidence->>'ok'='true' AND NEW.amount=(evidence->>'amount')::numeric
       AND NEW.currency=evidence->>'currency' THEN
      NEW.folio_line_id:=(evidence->>'folio_line_id')::uuid;
      NEW.journal_id:=(evidence->>'journal_id')::uuid;
      NEW.last_error:=NULL;
    ELSE
      NEW.status:='blocked';
      NEW.last_error:='Room charge evidence: '||coalesce(evidence->>'reason','receipt_amount_or_currency_mismatch');
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.journal_id IS NULL AND lower(coalesce(NEW.status,'')) = 'posted' THEN
    SELECT j.id INTO NEW.journal_id
      FROM public.journal_entries j
     WHERE j.organization_id = NEW.organization_id
       AND j.source_document_id = NEW.source_id
       AND j.status = 'posted'
       AND abs(coalesce(j.total_debit,0) - coalesce(j.total_credit,0)) < 0.01
     ORDER BY j.posted_at DESC NULLS LAST, j.created_at DESC
     LIMIT 1;
  END IF;
  RETURN NEW;
END $function$
