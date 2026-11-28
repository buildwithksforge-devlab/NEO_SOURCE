BEGIN;

DO $migration$
DECLARE
    d text;
    anchor text;
    replacement text;
BEGIN

    -- ============================================
    -- RFQ CREATION
    -- ============================================

    d := pg_get_functiondef(
        'public.neo_procurement_create_rfq(uuid,uuid[],date,uuid,text,text)'
        ::regprocedure
    );

    anchor := $old$
  IF _prior IS NOT NULL THEN RETURN _prior || jsonb_build_object('replayed', true); END IF;
$old$;

    anchor := btrim(anchor,E'\n\r');

    replacement := $new$
  IF _prior IS NOT NULL THEN
    IF NOT EXISTS (
      SELECT 1
      FROM public.rfqs f
      WHERE f.id = (_prior->>'id')::uuid
        AND f.organization_id = _org
        AND f.request_id = _request
        AND public.neo_branch_in_scope(f.branch_id) IS TRUE
    ) THEN
      RAISE EXCEPTION 'rfq_attempt_outside_authorized_scope'
        USING ERRCODE='42501';
    END IF;

    IF EXISTS (
      SELECT supplier_id
      FROM public.rfq_suppliers
      WHERE rfq_id = (_prior->>'id')::uuid
        AND organization_id = _org
      EXCEPT
      SELECT unnest(_suppliers)
    ) OR EXISTS (
      SELECT unnest(_suppliers)
      EXCEPT
      SELECT supplier_id
      FROM public.rfq_suppliers
      WHERE rfq_id = (_prior->>'id')::uuid
        AND organization_id = _org
    ) THEN
      RAISE EXCEPTION 'rfq_attempt_supplier_mismatch'
        USING ERRCODE='22023';
    END IF;

    RETURN _prior || jsonb_build_object('replayed', true);
  END IF;
$new$;

    IF strpos(d,anchor) = 0 THEN
      RAISE EXCEPTION 'RFQ replay anchor missing';
    END IF;

    d := replace(d,anchor,replacement);

    anchor := $old$
WHERE organization_id = _org AND id = ANY(_suppliers)) THEN
$old$;

    anchor := btrim(anchor,E'\n\r');

    replacement := $new$
WHERE organization_id = _org
  AND id = ANY(_suppliers)
  AND active IS TRUE
  AND public.neo_record_operationally_enabled(
      to_jsonb(suppliers)
  ) IS TRUE) THEN
$new$;

    IF strpos(d,anchor) = 0 THEN
      RAISE EXCEPTION 'RFQ supplier eligibility anchor missing';
    END IF;

    d := replace(d,anchor,replacement);

    anchor := $old$
  _number := public.next_document_number('rfq');
$old$;

    anchor := btrim(anchor,E'\n\r');

    replacement := $new$
  IF EXISTS (
    SELECT 1
    FROM public.purchase_request_lines l
    WHERE l.request_id = _request
      AND l.organization_id = _org
      AND (
        l.quantity IS NULL
        OR l.quantity <= 0
        OR l.quantity::text IN (
          'NaN','Infinity','-Infinity'
        )
        OR NULLIF(btrim(l.unit),'') IS NULL
      )
  ) THEN
    RAISE EXCEPTION 'invalid_purchase_request_line_quantity_or_unit'
      USING ERRCODE='22023';
  END IF;

  _number := public.next_document_number('rfq');
$new$;

    IF strpos(d,anchor) = 0 THEN
      RAISE EXCEPTION 'RFQ document numbering anchor missing';
    END IF;

    d := replace(d,anchor,replacement);

    EXECUTE d;

    -- ============================================
    -- SUPPLIER QUOTATION REPLAY
    -- ============================================

    d := pg_get_functiondef(
      'public.neo_partner_supplier_quote_submit(uuid,uuid,uuid,jsonb,text,uuid)'
      ::regprocedure
    );

    anchor := $old$
    RETURN _prior || jsonb_build_object('replayed', true);
$old$;

    anchor := btrim(anchor,E'\n\r');

    replacement := $new$
    IF NOT EXISTS (
      SELECT 1
      FROM public.supplier_quotations q
      WHERE q.id = (_prior->>'quotation_id')::uuid
        AND q.organization_id = _org
        AND q.supplier_id = _rel.supplier_id
        AND q.branch_id = _branch
        AND q.rfq_id = _rfq
    ) THEN
      RAISE EXCEPTION 'quotation_attempt_outside_supplier_scope'
        USING ERRCODE='42501';
    END IF;

    RETURN _prior || jsonb_build_object('replayed', true);
$new$;

    IF strpos(d,anchor) = 0 THEN
      RAISE EXCEPTION 'Supplier quotation replay anchor missing';
    END IF;

    d := replace(d,anchor,replacement);

    anchor := $old$
IF _price < 0 OR _price > 100000000 OR _tax < 0 OR _tax > 100
$old$;

    anchor := btrim(anchor,E'\n\r');

    replacement := $new$
IF _price IS NULL
  OR _price::text IN ('NaN','Infinity','-Infinity')
  OR _tax::text IN ('NaN','Infinity','-Infinity')
  OR _price < 0 OR _price > 100000000
  OR _tax < 0 OR _tax > 100
$new$;

    IF strpos(d,anchor) = 0 THEN
      RAISE EXCEPTION 'Supplier quotation price anchor missing';
    END IF;

    d := replace(d,anchor,replacement);

    EXECUTE d;

    -- ============================================
    -- OFFLINE SUPPLIER QUOTATION CAPTURE
    -- ============================================

    d := pg_get_functiondef(
      'public.neo_procurement_record_supplier_quote(uuid,uuid,jsonb,text,date)'
      ::regprocedure
    );

    IF strpos(d,anchor) = 0 THEN
      RAISE EXCEPTION 'Offline quotation price anchor missing';
    END IF;

    d := replace(d,anchor,replacement);

    EXECUTE d;

    -- ============================================
    -- SUPPLIER RECOMMENDATION
    -- ============================================

    d := pg_get_functiondef(
      'public.neo_procurement_recommend_supplier_quote(uuid,uuid,text,boolean)'
      ::regprocedure
    );

    anchor := $old$
  IF _q.id IS NULL OR _q.status NOT IN ('received', 'selected') OR _q.total_amount < 0
$old$;

    anchor := btrim(anchor,E'\n\r');

    replacement := $new$
  IF _q.id IS NULL
    OR _q.branch_id IS DISTINCT FROM _request_row.branch_id
    OR _q.total_amount IS NULL
    OR _q.total_amount::text IN (
      'NaN','Infinity','-Infinity'
    )
    OR NOT EXISTS (
      SELECT 1
      FROM public.suppliers s
      WHERE s.id = _q.supplier_id
        AND s.organization_id = _org
        AND s.active IS TRUE
        AND public.neo_record_operationally_enabled(
          to_jsonb(s)
        ) IS TRUE
    )
    OR _q.status NOT IN ('received', 'selected')
    OR _q.total_amount < 0
$new$;

    IF strpos(d,anchor) = 0 THEN
      RAISE EXCEPTION 'Supplier recommendation anchor missing';
    END IF;

    d := replace(d,anchor,replacement);

    EXECUTE d;

END;
$migration$;

NOTIFY pgrst,'reload schema';

COMMIT;