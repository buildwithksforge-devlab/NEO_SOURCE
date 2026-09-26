CREATE OR REPLACE FUNCTION public.next_document_number(_doc_type text, _prefix text DEFAULT NULL::text, _branch uuid DEFAULT NULL::uuid)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  _org uuid := coalesce(public.current_org_id(), public.my_customer_org_id(),
                        (SELECT b.organization_id FROM public.branches b WHERE b.id = _branch));
  _year int := extract(year from now())::int;
  _pfx text := upper(coalesce(nullif(_prefix,''), left(regexp_replace(_doc_type,'[^A-Za-z]','','g'), 3)));
  _row public.number_sequences;
  _number text;
  _guard int := 0;
BEGIN
  IF _org IS NULL THEN
    RAISE EXCEPTION 'No active organization for the current user';
  END IF;

  IF _branch IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.branches WHERE id = _branch AND organization_id = _org
  ) THEN
    RAISE EXCEPTION 'Property does not belong to the active organization';
  END IF;

  LOOP
    _guard := _guard + 1;
    IF _guard > 50 THEN
      RAISE EXCEPTION 'Unable to allocate a unique % reference', _doc_type;
    END IF;

    INSERT INTO public.number_sequences (organization_id, doc_type, branch_id, prefix, year, padding, next_number)
    VALUES (_org, _doc_type, _branch, _pfx, _year, 6, 1)
    ON CONFLICT (organization_id, doc_type, coalesce(branch_id, '00000000-0000-0000-0000-000000000000'::uuid))
    DO UPDATE SET next_number = public.number_sequences.next_number + 1,
                  year = EXCLUDED.year,
                  updated_at = now()
    RETURNING * INTO _row;

    _number := _row.prefix || '-' || _row.year::text || '-' || lpad(_row.next_number::text, coalesce(_row.padding,6), '0');

    BEGIN
      INSERT INTO public.document_numbers (organization_id, branch_id, doc_type, document_number)
      VALUES (_org, _branch, _doc_type, _number);
      RETURN _number;
    EXCEPTION WHEN unique_violation THEN
      -- number already taken, loop and take the next one
    END;
  END LOOP;
END;
$fn$;

GRANT EXECUTE ON FUNCTION public.next_document_number(text,text,uuid) TO authenticated, service_role;