BEGIN;

DO $migration$
DECLARE
    d text;
    anchor text;
    replacement text;
BEGIN

    -- =============================================
    -- RFQ PROPERTY-SCOPED NUMBERING
    -- =============================================

    d := pg_get_functiondef(
      'public.neo_procurement_create_rfq(uuid,uuid[],date,uuid,text,text)'
      ::regprocedure
    );

    anchor := $old$
  _number := public.next_document_number('rfq');
$old$;

    anchor := btrim(anchor,E'\n\r');

    replacement := $new$
  _number := public.next_document_number(
    'rfq',
    'RFQ',
    _r.branch_id
  );

  IF _number IS NULL OR length(btrim(_number)) = 0 THEN
    RAISE EXCEPTION 'rfq_number_generation_failed';
  END IF;
$new$;

    IF strpos(d,anchor) = 0 THEN
      RAISE EXCEPTION 'RFQ numbering anchor missing';
    END IF;

    d := replace(d,anchor,replacement);

    EXECUTE d;


    -- =============================================
    -- PROCUREMENT COMPETING QUOTATION ELIGIBILITY
    -- =============================================

    d := pg_get_functiondef(
      'public.neo_procurement_recommend_supplier_quote(uuid,uuid,text,boolean)'
      ::regprocedure
    );

    anchor := $old$
  SELECT count(DISTINCT supplier_id) INTO _count FROM public.supplier_quotations
    WHERE request_id = _request AND organization_id = _org AND status IN ('received', 'selected')
      AND (valid_until IS NULL OR valid_until >= public.neo_local_today(_request_row.branch_id))
      AND currency = public.neo_fact_currency(_org, _request_row.branch_id);
$old$;

    anchor := btrim(anchor,E'\n\r');

    replacement := $new$
  SELECT count(DISTINCT q.supplier_id)
    INTO _count

  FROM public.supplier_quotations q

  JOIN public.suppliers s
    ON s.id = q.supplier_id
    AND s.organization_id = _org

  WHERE q.request_id = _request

    AND q.organization_id = _org

    AND q.branch_id = _request_row.branch_id

    AND q.status IN ('received','selected')

    AND s.active IS TRUE

    AND public.neo_record_operationally_enabled(
        to_jsonb(s)
    ) IS TRUE

    AND q.total_amount IS NOT NULL

    AND q.total_amount >= 0

    AND q.total_amount::text NOT IN (
        'NaN','Infinity','-Infinity'
    )

    AND (
      q.valid_until IS NULL
      OR q.valid_until >= public.neo_local_today(
        _request_row.branch_id
      )
    )

    AND q.currency = public.neo_fact_currency(
      _org,
      _request_row.branch_id
    )

    AND (
      q.rfq_id IS NULL
      OR EXISTS (
        SELECT 1
        FROM public.rfq_suppliers i
        WHERE i.rfq_id = q.rfq_id
          AND i.supplier_id = q.supplier_id
          AND i.organization_id = _org
      )
    )

    AND NOT EXISTS (
      SELECT 1
      FROM public.purchase_request_lines l
      WHERE l.request_id = _request
        AND l.organization_id = _org
        AND (
          SELECT count(*)
          FROM public.supplier_quotation_lines ql
          WHERE ql.quotation_id = q.id
            AND ql.organization_id = _org
            AND ql.request_line_id = l.id
            AND ql.quantity = l.quantity
            AND ql.unit IS NOT DISTINCT FROM l.unit
            AND ql.stock_item_id IS NOT DISTINCT FROM l.stock_item_id
            AND ql.unit_price IS NOT NULL
            AND ql.unit_price >= 0
            AND ql.unit_price::text NOT IN (
              'NaN','Infinity','-Infinity'
            )
            AND ql.tax_rate BETWEEN 0 AND 100
        ) <> 1
    );
$new$;

    IF strpos(d,anchor) = 0 THEN
      RAISE EXCEPTION 'Competing quotation count anchor missing';
    END IF;

    d := replace(d,anchor,replacement);

    EXECUTE d;


    -- =============================================
    -- SUPPLIER RFQ RESPONSE ELIGIBILITY INDICATORS
    -- =============================================

    d := pg_get_functiondef(
      'public.neo_partner_supplier_rfqs(uuid,uuid)'
      ::regprocedure
    );

    anchor := $old$
    SELECT f.id, f.rfq_number, f.title, f.notes, f.issued_at, f.closes_at,
$old$;

    anchor := btrim(anchor,E'\n\r');

    replacement := $new$
    SELECT f.id, f.rfq_number, f.title, f.notes, f.issued_at, f.closes_at,

      invited.dispatch_state,

      CASE

        WHEN f.closes_at IS NOT NULL
          AND now() > f.closes_at
        THEN 'closed'

        WHEN NOT EXISTS (
          SELECT 1
          FROM public.purchase_requests pr
          WHERE pr.id = f.request_id
            AND pr.organization_id = _org
            AND pr.status = 'approved'
        )
        THEN 'request-unavailable'

        WHEN EXISTS (
          SELECT 1
          FROM public.purchase_orders po
          WHERE po.request_id = f.request_id
            AND po.organization_id = _org
            AND po.status NOT IN ('cancelled','voided')
        )
        THEN 'ordered'

        WHEN EXISTS (
          SELECT 1
          FROM public.supplier_quotations sq
          WHERE sq.rfq_id = f.id
            AND sq.organization_id = _org
            AND sq.supplier_id = _rel.supplier_id
            AND sq.selected IS TRUE
        )
        THEN 'selected'

        ELSE 'accepting-quotations'

      END AS response_state,
$new$;

    IF strpos(d,anchor) = 0 THEN
      RAISE EXCEPTION 'Supplier RFQ response-state anchor missing';
    END IF;

    d := replace(d,anchor,replacement);

    EXECUTE d;

END;
$migration$;

NOTIFY pgrst,'reload schema';

COMMIT;