CREATE OR REPLACE FUNCTION public.neo_pos_folio_journal_receipts()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE f public.folio_lines; evidence jsonb;
BEGIN
 IF NEW.status<>'posted' OR NEW.source_document_type<>'folio_charge:revenue'
  OR NEW.reversed_by_journal_id IS NOT NULL THEN RETURN NEW; END IF;
 SELECT * INTO f FROM public.folio_lines WHERE id=NEW.source_document_id
  AND organization_id=NEW.organization_id AND branch_id IS NOT DISTINCT FROM NEW.branch_id
  AND source_module='pos' AND source_record_uuid IS NOT NULL;
 IF f.id IS NULL THEN RETURN NEW; END IF;
 evidence:=public.neo_pos_room_charge_evidence(NEW.organization_id,NEW.branch_id,f.source_record_uuid,f.id,NEW.id);
 IF evidence->>'ok' IS DISTINCT FROM 'true' THEN RETURN NEW; END IF;
 UPDATE public.finance_posting_receipts r SET folio_line_id=f.id,journal_id=NEW.id,
  status='posted',last_error=NULL
 WHERE r.organization_id=NEW.organization_id AND r.branch_id IS NOT DISTINCT FROM NEW.branch_id
  AND r.source_module IN ('pos','pos_order') AND r.source_id=f.source_record_uuid
  AND r.posting_type='room_charge' AND r.status IN ('posted','blocked')
  AND r.amount=(evidence->>'amount')::numeric
  AND (r.folio_line_id IS DISTINCT FROM f.id OR r.journal_id IS DISTINCT FROM NEW.id OR r.status<>'posted');
 RETURN NEW;
END $function$
