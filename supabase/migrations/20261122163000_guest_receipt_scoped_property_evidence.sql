-- Add payment evidence to the property-scoped projection used by Guest PDFs.
DO $migration$
DECLARE
  definition text := replace(pg_get_functiondef('public.neo_guest_folio_projection(uuid,uuid)'::regprocedure), chr(13)||chr(10), chr(10));
  old_document constant text := $old$'id', p.id,
               'receipt_number', p.receipt_number,$old$;
  new_document constant text := $new$'id', p.id,
               'branch_id', coalesce(p.branch_id, _branch),
               'status', p.status,
               'receipt_number', p.receipt_number,$new$;
  old_row constant text := $old$SELECT pm.id, pm.receipt_number, pm.amount, pm.currency, pm.method, pm.paid_at, pm.folio_id$old$;
  new_row constant text := $new$SELECT pm.id, pm.receipt_number, pm.amount, pm.currency, pm.method, pm.paid_at, pm.folio_id,
               pm.branch_id, pm.status$new$;
  legacy_row constant text := $old$FROM public.payments p
      WHERE p.organization_id = _org AND p.customer_id = _cust$old$;
  legacy_status constant text := $old$AND coalesce(p.status,'completed') NOT IN ('void','voided','failed')$old$;
BEGIN
  IF strpos(definition, new_document)>0 OR (strpos(definition, '''branch_id'', p.branch_id')>0
    AND strpos(definition, '''status'', p.status')>0
    AND strpos(definition, 'coalesce(pm.branch_id, _branch) AS branch_id')>0) THEN RETURN; END IF;
  IF (length(definition)-length(replace(definition, old_document, '')))<>length(old_document)
    OR strpos(definition, 'fo.customer_id = _cust AND fo.branch_id = _branch')=0 THEN
    RAISE EXCEPTION 'Review the property-scoped guest folio projection before adding receipt evidence';
  END IF;
  IF (length(definition)-length(replace(definition, old_row, '')))=length(old_row)
    AND strpos(definition, 'pm.branch_id IS NULL OR pm.branch_id = _branch')>0
    AND strpos(definition, 'pm.customer_id = _cust')>0 THEN
    definition := replace(definition, old_row, new_row);
  ELSIF (length(definition)-length(replace(definition, legacy_row, '')))=length(legacy_row)
    AND (length(definition)-length(replace(definition, legacy_status, '')))=length(legacy_status)
    AND strpos(definition, 'p.branch_id IS NULL OR p.branch_id = _branch')>0 THEN
    definition := replace(definition, legacy_status, $new$AND p.status IN ('confirmed', 'posted', 'completed')$new$);
  ELSE
    RAISE EXCEPTION 'Review the installed guest payment selection before adding receipt evidence';
  END IF;
  EXECUTE replace(definition, old_document, new_document);
END
$migration$;
