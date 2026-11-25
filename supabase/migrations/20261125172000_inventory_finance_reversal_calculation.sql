-- NEØ cumulative inventory reversal valuation.
-- Prevent over-reversal and cumulative rounding differences.
-- No historical operational records modified.

BEGIN;

CREATE OR REPLACE FUNCTION public.neo_inventory_reversal_allocation(
    _original_value numeric,
    _original_posted_amount numeric,
    _previous_restored_value numeric,
    _previous_reversed_amount numeric,
    _restored_value numeric
)
RETURNS jsonb
LANGUAGE plpgsql
IMMUTABLE
SET search_path TO 'pg_catalog'
AS $function$
DECLARE
    v_total_restored numeric;
    v_target_reversal numeric;
    v_new_reversal numeric;
BEGIN

    IF EXISTS (
        SELECT 1
        FROM unnest(ARRAY[
            _original_value,
            _original_posted_amount,
            _previous_restored_value,
            _previous_reversed_amount,
            _restored_value
        ]) AS n(value)
        WHERE n.value IS NULL
           OR n.value < 0
           OR n.value::text IN (
               'NaN','Infinity','-Infinity'
           )
    ) THEN
        RAISE EXCEPTION
            'Invalid inventory reversal monetary evidence'
            USING ERRCODE = '22023';
    END IF;

    IF _original_posted_amount <>
       round(_original_value,2)
    THEN
        RAISE EXCEPTION
            'Original journal amount disagrees with consumption value'
            USING ERRCODE = '23514';
    END IF;

    IF _previous_restored_value > _original_value
       OR _previous_reversed_amount > _original_posted_amount
    THEN
        RAISE EXCEPTION
            'Historical reversal exceeds original consumption'
            USING ERRCODE = '23514';
    END IF;

    IF _previous_reversed_amount <>
       least(
           _original_posted_amount,
           round(_previous_restored_value,2)
       )
    THEN
        RAISE EXCEPTION
            'Previous reversal amounts do not reconcile'
            USING ERRCODE = '23514';
    END IF;

    v_total_restored :=
        _previous_restored_value + _restored_value;

    IF v_total_restored > _original_value THEN
        RAISE EXCEPTION
            'Restoration exceeds original consumption value'
            USING ERRCODE = '23514';
    END IF;

    v_target_reversal :=
        least(
            _original_posted_amount,
            round(v_total_restored,2)
        );

    v_new_reversal :=
        v_target_reversal - _previous_reversed_amount;

    IF v_new_reversal < 0 THEN
        RAISE EXCEPTION
            'Cumulative reversal value is inconsistent'
            USING ERRCODE = '23514';
    END IF;

    RETURN jsonb_build_object(
        'reversal_amount',v_new_reversal,
        'cumulative_restored_value',v_total_restored,
        'cumulative_reversed_amount',v_target_reversal,
        'remaining_consumption_value',
            _original_value - v_total_restored,
        'remaining_posted_amount',
            _original_posted_amount - v_target_reversal
    );

END;
$function$;

REVOKE ALL ON FUNCTION
    public.neo_inventory_reversal_allocation(
        numeric,numeric,numeric,numeric,numeric
    )
FROM PUBLIC, anon, authenticated;

COMMIT;