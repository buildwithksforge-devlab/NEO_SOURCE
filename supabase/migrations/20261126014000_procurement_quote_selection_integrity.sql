BEGIN;

DO $migration$
DECLARE
    d text;
    anchor text;
    replacement text;
BEGIN

    d := pg_get_functiondef(
      'public.neo_procurement_recommend_supplier_quote(uuid,uuid,text,boolean)'
      ::regprocedure
    );

    anchor := $old$
  IF _q.rfq_id IS NOT NULL AND NOT EXISTS
$old$;

    anchor := btrim(anchor,E'\n\r');

    replacement := $new$

  -- The recommended quotation must still match
  -- the approved commercial request.

  IF NOT EXISTS (
      SELECT 1
      FROM public.purchase_request_lines l
      WHERE l.organization_id = _org
        AND l.request_id = _request
  ) THEN

      RAISE EXCEPTION 'purchase_request_has_no_lines'
        USING ERRCODE='22023';

  END IF;

  IF EXISTS (
      SELECT 1
      FROM public.purchase_request_lines l
      WHERE l.organization_id = _org
        AND l.request_id = _request
        AND (
          SELECT count(*)
          FROM public.supplier_quotation_lines ql
          WHERE ql.organization_id = _org
            AND ql.quotation_id = _quotation
            AND ql.request_line_id = l.id
            AND ql.quantity = l.quantity
            AND ql.unit IS NOT DISTINCT FROM l.unit
            AND ql.stock_item_id IS NOT DISTINCT FROM l.stock_item_id
        ) <> 1
  ) THEN

      RAISE EXCEPTION 'quotation_lines_do_not_match_purchase_request'
        USING ERRCODE='22023';

  END IF;

  IF EXISTS (
      SELECT 1
      FROM public.supplier_quotation_lines ql
      WHERE ql.quotation_id = _quotation
        AND (
          ql.organization_id IS DISTINCT FROM _org
          OR ql.quantity IS NULL
          OR ql.quantity <= 0
          OR ql.quantity::text IN (
            'NaN','Infinity','-Infinity'
          )
          OR ql.unit_price IS NULL
          OR ql.unit_price < 0
          OR ql.unit_price::text IN (
            'NaN','Infinity','-Infinity'
          )
          OR ql.tax_rate IS NULL
          OR ql.tax_rate < 0
          OR ql.tax_rate > 100
          OR ql.tax_rate::text IN (
            'NaN','Infinity','-Infinity'
          )
          OR NOT EXISTS (
            SELECT 1
            FROM public.purchase_request_lines l
            WHERE l.id = ql.request_line_id
              AND l.request_id = _request
              AND l.organization_id = _org
          )
        )
  ) THEN

      RAISE EXCEPTION 'quotation_contains_invalid_lines'
        USING ERRCODE='22023';

  END IF;

  IF EXISTS (
      SELECT 1
      FROM public.supplier_quotation_lines ql
      WHERE ql.organization_id = _org
        AND ql.quotation_id = _quotation
      GROUP BY ql.request_line_id
      HAVING count(*) <> 1
  ) THEN

      RAISE EXCEPTION 'quotation_duplicate_request_lines'
        USING ERRCODE='22023';

  END IF;

  IF _q.total_amount IS DISTINCT FROM (
      SELECT coalesce(
        sum(
          round(ql.quantity * ql.unit_price,2)
          +
          round(
            ql.quantity * ql.unit_price * ql.tax_rate / 100,
            2
          )
        ),
        0
      )
      FROM public.supplier_quotation_lines ql
      WHERE ql.organization_id = _org
        AND ql.quotation_id = _quotation
  ) THEN

      RAISE EXCEPTION 'quotation_total_does_not_reconcile'
        USING ERRCODE='22023';

  END IF;

  IF _q.rfq_id IS NOT NULL AND NOT EXISTS
$new$;

    IF strpos(d,anchor) = 0 THEN
      RAISE EXCEPTION 'Quotation recommendation anchor missing';
    END IF;

    d := replace(d,anchor,replacement);

    EXECUTE d;

END;
$migration$;

NOTIFY pgrst,'reload schema';

COMMIT;