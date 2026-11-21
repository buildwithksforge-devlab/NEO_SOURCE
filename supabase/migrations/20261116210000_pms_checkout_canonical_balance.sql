-- Correct checkout financial arithmetic using the existing
-- canonical November 15 Finance projection.
-- No historical payments or folio lines are rewritten.
-- NOT FOR DEPLOYMENT until PostgreSQL integration verified.

BEGIN;

DO $repair$
DECLARE
  v_function regprocedure :=
    to_regprocedure('public.pms_check_out(uuid,boolean,text)');
  v_definition text;
  v_anchor text :=
    '_outstanding := round(_charges-_paid-_line_paid,2);';
  v_replacement text := $replacement$
  -- Canonical reconciliation replaces the legacy aggregation result.
  -- Preserve the existing checkout permissions, override and room release.
  DECLARE
    fin_folio record;
    fin_parts jsonb;
    fin_currency text;
    fin_charges numeric := 0;
    fin_collected numeric := 0;
    fin_count integer := 0;
  BEGIN
    FOR fin_folio IN
      SELECT f.id, f.currency
      FROM public.folios f
      WHERE f.organization_id = _org
        AND f.stay_id = _stay.id
      ORDER BY f.id
    LOOP
      fin_count := fin_count + 1;

      IF fin_currency IS NULL THEN
        fin_currency := fin_folio.currency;
      ELSIF fin_folio.currency IS DISTINCT FROM fin_currency THEN
        RAISE EXCEPTION
          'Checkout requires reconciliation of mixed-currency folios'
          USING ERRCODE = '23514';
      END IF;

      fin_parts := public.neo_folio_financial_components(
        fin_folio.id,_org
      );

      IF coalesce(fin_parts->>'found','false') <> 'true'
         OR fin_parts->>'gross_obligation' IS NULL
         OR fin_parts->>'collected' IS NULL
      THEN
        RAISE EXCEPTION
          'Checkout financial projection is incomplete'
          USING ERRCODE = '23514';
      END IF;

      fin_charges := fin_charges +
        (fin_parts->>'gross_obligation')::numeric;

      fin_collected := fin_collected +
        (fin_parts->>'collected')::numeric;
    END LOOP;

    IF fin_count <> 1 THEN
      RAISE EXCEPTION
        'Checkout requires exactly one folio until multi-folio settlement is reconciled; found %',
        fin_count
      USING ERRCODE = '23514';
    END IF;

    -- Reuse original checkout variables so every downstream
    -- settlement/override/audit decision sees the canonical amounts.
    _charges := round(fin_charges,2);
    _paid := round(fin_collected,2);
    _line_paid := 0;
    _outstanding := round(_charges-_paid,2);

    IF _charges::text IN ('NaN','Infinity','-Infinity')
       OR _paid::text IN ('NaN','Infinity','-Infinity')
       OR _outstanding::text IN ('NaN','Infinity','-Infinity')
    THEN
      RAISE EXCEPTION 'Checkout financial amounts are invalid'
        USING ERRCODE = '23514';
    END IF;
  END;
$replacement$;
BEGIN
  IF v_function IS NULL THEN
    RAISE EXCEPTION 'PMS checkout function is missing';
  END IF;

  IF to_regprocedure(
    'public.neo_folio_financial_components(uuid,uuid)'
  ) IS NULL THEN
    RAISE EXCEPTION 'Canonical Finance calculation is missing';
  END IF;

  SELECT pg_get_functiondef(v_function)
  INTO v_definition;

  IF v_definition IS NULL
    OR length(v_definition) -
       length(replace(v_definition,v_anchor,''))
       <> length(v_anchor)
    OR position(
      'FROM public.payment_allocations a'
      IN v_definition
    ) = 0
    OR position(
      'UPDATE public.stays SET status=''checked-out'''
      IN v_definition
    ) = 0
    OR position(
      'public.ops_set_room_status'
      IN v_definition
    ) = 0
  THEN
    RAISE EXCEPTION
      'Installed checkout differs from reviewed implementation; no replacement performed';
  END IF;

  IF position(
    'Canonical reconciliation replaces the legacy aggregation result'
    IN v_definition
  ) > 0 THEN
    RAISE EXCEPTION 'Canonical checkout calculation already installed';
  END IF;

  v_definition := replace(
    v_definition,
    v_anchor,
    v_replacement
  );

  EXECUTE v_definition;
END;
$repair$;

DO $verify$
DECLARE
  v_definition text;
BEGIN
  SELECT pg_get_functiondef(
    'public.pms_check_out(uuid,boolean,text)'::regprocedure
  )
  INTO v_definition;

  IF position(
    'Canonical reconciliation replaces the legacy aggregation result'
    IN v_definition
  ) = 0
  THEN
    RAISE EXCEPTION 'Canonical checkout installation verification failed';
  END IF;
END;
$verify$;

COMMIT;