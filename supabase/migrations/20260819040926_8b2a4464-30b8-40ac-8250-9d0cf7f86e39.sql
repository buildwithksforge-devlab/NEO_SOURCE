-- Group 1 / Stage 3: identifier service hardening (additive, non-destructive)

-- 1. Registry of every issued document reference (never reused, incl. voided)
CREATE TABLE IF NOT EXISTS public.issued_document_numbers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  branch_id uuid REFERENCES public.branches(id) ON DELETE SET NULL,
  doc_type text NOT NULL,
  document_number text NOT NULL,
  year integer NOT NULL DEFAULT date_part('year', now())::int,
  source text NOT NULL DEFAULT 'generated',
  status text NOT NULL DEFAULT 'issued',
  record_id uuid,
  issued_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS issued_document_numbers_unique
  ON public.issued_document_numbers (organization_id, doc_type, document_number);
CREATE INDEX IF NOT EXISTS issued_document_numbers_org_idx
  ON public.issued_document_numbers (organization_id, doc_type, created_at DESC);

GRANT SELECT, INSERT, UPDATE ON public.issued_document_numbers TO authenticated;
GRANT ALL ON public.issued_document_numbers TO service_role;
ALTER TABLE public.issued_document_numbers ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "issued numbers tenant read" ON public.issued_document_numbers;
CREATE POLICY "issued numbers tenant read" ON public.issued_document_numbers
  FOR SELECT TO authenticated USING (organization_id = public.current_org_id());
DROP POLICY IF EXISTS "issued numbers tenant insert" ON public.issued_document_numbers;
CREATE POLICY "issued numbers tenant insert" ON public.issued_document_numbers
  FOR INSERT TO authenticated WITH CHECK (organization_id = public.current_org_id());
DROP POLICY IF EXISTS "issued numbers tenant update" ON public.issued_document_numbers;
CREATE POLICY "issued numbers tenant update" ON public.issued_document_numbers
  FOR UPDATE TO authenticated
  USING (organization_id = public.current_org_id())
  WITH CHECK (organization_id = public.current_org_id());

-- 2. Remove the legacy org+doc_type uniqueness that blocks branch-scoped sequences.
--    The branch-aware unique index number_sequences_org_doc_branch_idx already
--    guarantees correctness and stays in place.
ALTER TABLE public.number_sequences
  DROP CONSTRAINT IF EXISTS number_sequences_organization_id_doc_type_key;
DROP INDEX IF EXISTS public.number_sequences_org_doctype_idx;

-- 3. Atomic, organization-scoped, branch-optional generator with registry logging.
CREATE OR REPLACE FUNCTION public.next_document_number(_doc_type text, _prefix text DEFAULT NULL::text, _branch uuid DEFAULT NULL::uuid)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  _org uuid := public.current_org_id();
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

    -- Single atomic statement: upsert + increment under the unique index.
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

    -- Registry insert is the collision guard: imported/voided numbers are never reused.
    BEGIN
      INSERT INTO public.issued_document_numbers
        (organization_id, branch_id, doc_type, document_number, year, source, status, issued_by)
      VALUES (_org, _branch, _doc_type, _number, _year, 'generated', 'issued', auth.uid());
      RETURN _number;
    EXCEPTION WHEN unique_violation THEN
      -- number already taken (e.g. imported legacy reference): skip and advance
      CONTINUE;
    END;
  END LOOP;
END;
$function$;

-- 4. Legacy single-argument overload delegates to the hardened service.
CREATE OR REPLACE FUNCTION public.next_document_number(_doc_type text)
RETURNS text
LANGUAGE sql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$ SELECT public.next_document_number(_doc_type, NULL::text, NULL::uuid) $function$;

-- 5. Imported references are recorded without disturbing sequences.
CREATE OR REPLACE FUNCTION public.register_imported_document_number(
  _doc_type text, _number text, _branch uuid DEFAULT NULL::uuid, _record uuid DEFAULT NULL::uuid)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE _org uuid := public.current_org_id();
BEGIN
  IF _org IS NULL THEN RAISE EXCEPTION 'No active organization for the current user'; END IF;
  IF _number IS NULL OR btrim(_number) = '' THEN RETURN false; END IF;
  INSERT INTO public.issued_document_numbers
    (organization_id, branch_id, doc_type, document_number, source, status, record_id, issued_by)
  VALUES (_org, _branch, _doc_type, btrim(_number), 'imported', 'issued', _record, auth.uid())
  ON CONFLICT (organization_id, doc_type, document_number) DO NOTHING;
  RETURN true;
END;
$function$;

-- 6. Voiding marks the reference permanently consumed.
CREATE OR REPLACE FUNCTION public.void_document_number(_doc_type text, _number text, _reason text DEFAULT NULL::text)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE _org uuid := public.current_org_id();
BEGIN
  IF _org IS NULL THEN RAISE EXCEPTION 'No active organization for the current user'; END IF;
  UPDATE public.issued_document_numbers
     SET status = 'void', updated_at = now()
   WHERE organization_id = _org AND doc_type = _doc_type AND document_number = _number;
  RETURN FOUND;
END;
$function$;

-- 7. Duplicate detection report (read-only, organization scoped).
CREATE OR REPLACE FUNCTION public.duplicate_document_numbers()
RETURNS TABLE(doc_type text, document_number text, occurrences bigint)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  SELECT doc_type, document_number, count(*)
  FROM public.issued_document_numbers
  WHERE organization_id = public.current_org_id()
  GROUP BY 1,2
  HAVING count(*) > 1
$function$;

REVOKE ALL ON FUNCTION public.next_document_number(text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.next_document_number(text, text, uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.register_imported_document_number(text, text, uuid, uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.void_document_number(text, text, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.duplicate_document_numbers() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.next_document_number(text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.next_document_number(text, text, uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.register_imported_document_number(text, text, uuid, uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.void_document_number(text, text, text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.duplicate_document_numbers() TO authenticated, service_role;