-- 1) Allow an explicit organisation when allocating a document number.
CREATE OR REPLACE FUNCTION public.next_document_number(_doc_type text, _prefix text DEFAULT NULL::text, _branch uuid DEFAULT NULL::uuid, _org_override uuid DEFAULT NULL::uuid)
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  _org uuid := coalesce(_org_override, public.current_org_id(), public.my_customer_org_id(),
                        (SELECT b.organization_id FROM public.branches b WHERE b.id = _branch));
  _year int := extract(year from now())::int;
  _pfx text := upper(coalesce(nullif(_prefix,''), left(regexp_replace(_doc_type,'[^A-Za-z]','','g'), 3)));
  _code text;
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
    DO UPDATE SET
      next_number = CASE WHEN public.number_sequences.year = _year
                         THEN public.number_sequences.next_number + 1 ELSE 1 END,
      year = _year,
      updated_at = now()
    RETURNING * INTO _row;

    _code := NULL;
    IF _row.branch_id IS NOT NULL THEN
      SELECT upper(nullif(btrim(code), '')) INTO _code FROM public.branches WHERE id = _row.branch_id;
    END IF;

    _number := _row.prefix
      || CASE WHEN _code IS NULL THEN '' ELSE '-' || _code END
      || '-' || _row.year::text
      || '-' || lpad(_row.next_number::text, greatest(_row.padding, 4), '0');

    BEGIN
      INSERT INTO public.issued_document_numbers
        (organization_id, branch_id, doc_type, document_number, year, source, status, issued_by)
      VALUES (_org, _branch, _doc_type, _number, _year, 'generated', 'issued', auth.uid());
      RETURN _number;
    EXCEPTION WHEN unique_violation THEN
      CONTINUE;
    END;
  END LOOP;
END;
$function$;

REVOKE ALL ON FUNCTION public.next_document_number(text, text, uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.next_document_number(text, text, uuid, uuid) TO authenticated, service_role;

-- 2) Point the two guest checkout routines at the property's organisation.
DO $do$
DECLARE
  _fn text;
  _src text;
  _new text;
BEGIN
  FOREACH _fn IN ARRAY ARRAY['delivery_place_order','neo_guest_place_room_service'] LOOP
    SELECT pg_get_functiondef(p.oid) INTO _src
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = _fn;

    IF _src IS NULL OR position('public.next_document_number(''delivery_order'')' in _src) = 0 THEN
      RAISE EXCEPTION 'Expected numbering call not found in %', _fn;
    END IF;

    _new := replace(_src,
      'public.next_document_number(''delivery_order'')',
      'public.next_document_number(''delivery_order'', NULL, NULL, _c.organization_id)');

    EXECUTE _new;
  END LOOP;
END
$do$;