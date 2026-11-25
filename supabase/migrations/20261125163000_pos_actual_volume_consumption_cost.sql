-- NEØ POS actual measured-volume consumption costing.
-- Depends on actual movement and open-container valuation migrations.
-- No historical operational records modified.

BEGIN;

CREATE FUNCTION pg_temp.neo_pos_volume_cost_patch(
    _source text,
    _old text,
    _new text
)
RETURNS text
LANGUAGE plpgsql
AS $$
BEGIN
    IF _source IS NULL
       OR length(_old) = 0
       OR length(_source) - length(replace(_source,_old,''))
          <> length(_old)
    THEN
        RAISE EXCEPTION
            'POS volume cost source anchor changed: %',
            left(_old,100);
    END IF;

    RETURN replace(_source,_old,_new);
END;
$$;

DO $patch$
DECLARE
    d text;
BEGIN
    d := pg_get_functiondef(
        'public.inventory_consume_order_item_core(uuid)'
        ::regprocedure
    );

    -- Require the preceding actual-movement-cost migration.

    IF position(
        'v_cost := v_cost + v_actual_value' IN d
    ) = 0 THEN
        RAISE EXCEPTION
            'Actual movement valuation prerequisite missing';
    END IF;

    d := pg_temp.neo_pos_volume_cost_patch(
        d,
        $old$v_actual_value numeric;$old$,
        $new$v_actual_value numeric;
  v_volume_result jsonb;
  v_volume_cost numeric;
  v_unverified_volume_lines integer := 0;$new$
    );

    d := pg_temp.neo_pos_volume_cost_patch(
        d,
        $old$PERFORM public.inventory_consume_volume(
        v_comp.item_id,$old$,
        $new$v_volume_result := public.inventory_consume_volume(
        v_comp.item_id,$new$
    );

    d := pg_temp.neo_pos_volume_cost_patch(
        d,
        $old$v_cost :=
        v_cost
        + (v_ml / v_stock.container_volume_ml)
          * COALESCE(v_stock.average_cost, 0);$old$,

        $new$IF v_volume_result IS NULL
         OR (
             v_volume_result->>'status'
             IN ('poured','already-recorded')
         ) IS NOT TRUE
      THEN
          RAISE EXCEPTION
              'Measured consumption returned invalid evidence'
              USING ERRCODE = '23514';
      END IF;

      IF NOT (v_volume_result ? 'consumed_value') THEN
          RAISE EXCEPTION
              'Measured consumption valuation evidence missing'
              USING ERRCODE = '23514';
      END IF;

      v_volume_cost :=
          (v_volume_result->>'consumed_value')::numeric;

      IF v_volume_cost IS NULL THEN

          v_unverified_volume_lines :=
              v_unverified_volume_lines + 1;

      ELSE

          IF v_volume_cost < 0
             OR v_volume_cost::text
                IN ('NaN','Infinity','-Infinity')
          THEN
              RAISE EXCEPTION
                  'Invalid measured consumption monetary value'
                  USING ERRCODE = '23514';
          END IF;

          v_cost := v_cost + v_volume_cost;

      END IF;$new$
    );

    d := pg_temp.neo_pos_volume_cost_patch(
        d,
        $old$'costing', 'weighted-average',$old$,
        $new$'costing', 'actual-movement-and-container-value',
      'valuation_status',
        CASE
          WHEN v_unverified_volume_lines > 0
          THEN 'unverified'
          ELSE 'verified'
        END,
      'unverified_volume_lines', v_unverified_volume_lines,
      'verified_partial_cost', v_cost,$new$
    );

    d := pg_temp.neo_pos_volume_cost_patch(
        d,
        $old$'cost',v_cost,$old$,
        $new$'cost',
      CASE
        WHEN v_unverified_volume_lines > 0 THEN NULL
        ELSE v_cost
      END,
    'valuation_status',
      CASE
        WHEN v_unverified_volume_lines > 0
        THEN 'unverified'
        ELSE 'verified'
      END,
    'verified_partial_cost',v_cost,
    'unverified_volume_lines',v_unverified_volume_lines,$new$
    );

    EXECUTE d;
END;
$patch$;

COMMIT;