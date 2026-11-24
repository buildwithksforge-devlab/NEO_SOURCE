-- Add the owning property and saved status to the customer-owned payment projection.
-- Preserve the installed routine's owner, signature and grants; refuse unknown bodies.
DO $migration$
DECLARE
  definition text := pg_get_functiondef('public.neo_guest_folio_projection(uuid)'::regprocedure);
  old_fragment constant text := $old$
               'id', p.id,
               'receipt_number', p.receipt_number,
$old$;
  new_fragment constant text := $new$
               'id', p.id,
               'branch_id', p.branch_id,
               'status', p.status,
               'receipt_number', p.receipt_number,
$new$;
BEGIN
  IF strpos(definition, new_fragment) > 0 THEN RETURN; END IF;
  IF strpos(definition, old_fragment) = 0
     OR (length(definition) - length(replace(definition, old_fragment, ''))) <> length(old_fragment) THEN
    RAISE EXCEPTION 'Review installed guest folio projection before adding receipt property evidence';
  END IF;
  EXECUTE replace(definition, old_fragment, new_fragment);
END
$migration$;
