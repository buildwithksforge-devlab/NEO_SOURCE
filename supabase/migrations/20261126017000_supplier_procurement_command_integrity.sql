BEGIN;

DO $migration$

DECLARE

    d text;

    anchor text;

    replacement text;

BEGIN

    -- =============================================
    -- 1. LPO AUTHORISATION BEFORE REPLAY
    -- =============================================

    d := pg_get_functiondef(
      'public.neo_procurement_order_from_request(uuid,uuid,date,uuid,uuid)'
      ::regprocedure
    );

    anchor := $old$
  IF _org IS NULL THEN RAISE EXCEPTION 'no_organisation' USING ERRCODE='42501'; END IF;
$old$;

    anchor := btrim(anchor,E'\n\r');

    replacement := $new$
  IF _org IS NULL
    OR auth.uid() IS NULL
    OR NOT coalesce(
      public.has_permission('procurement','lpos.create')
      OR public.is_org_admin(),
      false
    )
  THEN
    RAISE EXCEPTION 'insufficient_privilege'
      USING ERRCODE='42501';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM public.purchase_requests r
    WHERE r.id = _request
      AND r.organization_id = _org
      AND public.neo_branch_in_scope(r.branch_id) IS TRUE
  ) THEN
    RAISE EXCEPTION 'request_not_found_or_out_of_scope'
      USING ERRCODE='42501';
  END IF;

  IF _attempt IS NULL THEN
    RAISE EXCEPTION 'attempt_key_required'
      USING ERRCODE='22023';
  END IF;

  PERFORM pg_advisory_xact_lock(
    hashtextextended(
      _org::text || ':order.create:' || _attempt::text,
      0
    )
  );
$new$;

    IF strpos(d,anchor) = 0 THEN
      RAISE EXCEPTION 'LPO permission anchor missing';
    END IF;

    d := replace(d,anchor,replacement);

    anchor := $old$
  IF _prior IS NOT NULL THEN RETURN _prior || jsonb_build_object('replayed', true); END IF;
$old$;

    anchor := btrim(anchor,E'\n\r');

    replacement := $new$
  IF _prior IS NOT NULL THEN

    IF NOT EXISTS (

      SELECT 1

      FROM public.procurement_attempts a

      JOIN public.purchase_orders p

        ON p.id = a.record_id

        AND p.organization_id = _org

      WHERE a.organization_id = _org

        AND a.action = 'order.create'

        AND a.attempt_key = _attempt

        AND p.request_id = _request

        AND p.supplier_id = _supplier

        AND p.expected_date IS NOT DISTINCT FROM _expected

        AND p.deliver_to_location_id IS NOT DISTINCT FROM _location

        AND public.neo_branch_in_scope(p.branch_id) IS TRUE

    ) THEN

      RAISE EXCEPTION 'order_attempt_payload_mismatch'
        USING ERRCODE='22023';

    END IF;

    RETURN _prior || jsonb_build_object('replayed',true);

  END IF;
$new$;

    IF strpos(d,anchor) = 0 THEN
      RAISE EXCEPTION 'LPO replay anchor missing';
    END IF;

    d := replace(d,anchor,replacement);

    anchor := $old$
  _number := public.next_document_number('purchase_order', 'LPO', _r.branch_id);
$old$;

    anchor := btrim(anchor,E'\n\r');

    replacement := $new$
  IF EXISTS (

    SELECT 1

    FROM public.supplier_quotation_lines ql

    WHERE ql.quotation_id = _quote

      AND ql.organization_id = _org

    GROUP BY ql.request_line_id

    HAVING count(*) <> 1

  ) THEN

    RAISE EXCEPTION 'duplicate_selected_quotation_lines'
      USING ERRCODE='22023';

  END IF;

  IF EXISTS (

    SELECT 1

    FROM public.supplier_quotation_lines ql

    WHERE ql.quotation_id = _quote

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

        OR ql.tax_rate NOT BETWEEN 0 AND 100

      )

  ) THEN

    RAISE EXCEPTION 'invalid_selected_quotation_values'
      USING ERRCODE='22023';

  END IF;

  IF NOT EXISTS (

    SELECT 1

    FROM public.suppliers s

    WHERE s.id = _supplier

      AND s.organization_id = _org

      AND s.active IS TRUE

      AND public.neo_record_operationally_enabled(
        to_jsonb(s)
      ) IS TRUE

  ) THEN

    RAISE EXCEPTION 'supplier_not_operationally_available'
      USING ERRCODE='22023';

  END IF;

  _number := public.next_document_number(
    'purchase_order','LPO',_r.branch_id
  );
$new$;

    IF strpos(d,anchor) = 0 THEN
      RAISE EXCEPTION 'LPO quotation validation anchor missing';
    END IF;

    d := replace(d,anchor,replacement);

    EXECUTE d;


    -- =============================================
    -- 2. RFQ CONCURRENT SUBMISSION PROTECTION
    -- =============================================

    d := pg_get_functiondef(
      'public.neo_procurement_create_rfq(uuid,uuid[],date,uuid,text,text)'
      ::regprocedure
    );

    anchor := $old$
  SELECT result INTO _prior FROM public.procurement_attempts WHERE organization_id = _org
    AND action = 'rfq.create' AND attempt_key = _attempt;
$old$;

    anchor := btrim(anchor,E'\n\r');

    replacement := $new$
  IF auth.uid() IS NULL THEN

    RAISE EXCEPTION 'authentication_required'
      USING ERRCODE='42501';

  END IF;

  IF _suppliers IS NULL

    OR cardinality(_suppliers) = 0

    OR array_position(_suppliers,NULL::uuid) IS NOT NULL

    OR cardinality(_suppliers) <> (

      SELECT count(DISTINCT s)

      FROM unnest(_suppliers) s

    )

  THEN

    RAISE EXCEPTION 'invalid_supplier_invitation_list'
      USING ERRCODE='22023';

  END IF;

  PERFORM pg_advisory_xact_lock(

    hashtextextended(

      _org::text || ':rfq.create:' || _attempt::text,

      0

    )

  );

  SELECT result INTO _prior
  FROM public.procurement_attempts

  WHERE organization_id = _org

    AND action = 'rfq.create'

    AND attempt_key = _attempt;
$new$;

    IF strpos(d,anchor) = 0 THEN
      RAISE EXCEPTION 'RFQ attempt anchor missing';
    END IF;

    d := replace(d,anchor,replacement);

    EXECUTE d;


    -- =============================================
    -- 3. SUPPLIER QUOTATION REPLAY PAYLOAD VALIDATION
    -- =============================================

    d := pg_get_functiondef(
      'public.neo_partner_supplier_quote_submit(uuid,uuid,uuid,jsonb,text,uuid)'
      ::regprocedure
    );

    anchor := $old$
    RETURN _prior || jsonb_build_object('replayed', true);
$old$;

    anchor := btrim(anchor,E'\n\r');

    replacement := $new$
    IF jsonb_typeof(_lines) IS DISTINCT FROM 'array' THEN

      RAISE EXCEPTION 'quote_lines_required'
        USING ERRCODE='22023';

    END IF;

    IF NOT EXISTS (

      SELECT 1

      FROM public.supplier_quotations q

      WHERE q.id = (_prior->>'quotation_id')::uuid

        AND q.organization_id = _org

        AND q.branch_id = _branch

        AND q.rfq_id = _rfq

        AND q.supplier_id = _rel.supplier_id

        AND q.notes IS NOT DISTINCT FROM
          NULLIF(trim(_notes),'')

        AND (

          SELECT count(*)

          FROM public.supplier_quotation_lines l

          WHERE l.quotation_id = q.id

            AND l.organization_id = _org

        ) = jsonb_array_length(_lines)

        AND (

          SELECT count(
            DISTINCT x->>'request_line_id'
          )

          FROM jsonb_array_elements(_lines) x

        ) = jsonb_array_length(_lines)

        AND NOT EXISTS (

          SELECT 1

          FROM jsonb_array_elements(_lines) x

          WHERE NOT EXISTS (

            SELECT 1

            FROM public.supplier_quotation_lines l

            WHERE l.quotation_id = q.id

              AND l.organization_id = _org

              AND l.request_line_id =
                (x->>'request_line_id')::uuid

              AND l.unit_price =
                (x->>'unit_price')::numeric

              AND l.tax_rate =
                coalesce(
                  (x->>'tax_rate')::numeric,0
                )

              AND l.lead_time_days IS NOT DISTINCT FROM
                nullif(
                  x->>'lead_time_days',''
                )::integer

              AND l.notes IS NOT DISTINCT FROM
                nullif(trim(x->>'notes'),'')

          )

        )

    ) THEN

      RAISE EXCEPTION 'quotation_retry_payload_mismatch'
        USING ERRCODE='22023';

    END IF;

    RETURN _prior || jsonb_build_object('replayed',true);
$new$;

    IF strpos(d,anchor) = 0 THEN
      RAISE EXCEPTION 'Supplier quotation replay anchor missing';
    END IF;

    d := replace(d,anchor,replacement);

    EXECUTE d;

END;

$migration$;

NOTIFY pgrst,'reload schema';

COMMIT;