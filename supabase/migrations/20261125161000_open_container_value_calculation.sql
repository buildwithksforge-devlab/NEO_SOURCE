-- NEØ deterministic open-container valuation.
-- Calculation only: no operational records modified.

BEGIN;

CREATE OR REPLACE FUNCTION public.neo_open_container_value_allocation(
    _available_ml numeric,
    _available_value numeric,
    _consume_ml numeric
)
RETURNS jsonb
LANGUAGE plpgsql
IMMUTABLE
SET search_path TO 'pg_catalog'
AS $function$
DECLARE
    v_consumed_value numeric;
    v_remaining_value numeric;
    v_remaining_ml numeric;
BEGIN
    IF _available_ml IS NULL
       OR _consume_ml IS NULL
       OR _available_ml::text IN ('NaN','Infinity','-Infinity')
       OR _consume_ml::text IN ('NaN','Infinity','-Infinity')
       OR _available_ml <= 0
       OR _consume_ml <= 0
       OR _consume_ml > _available_ml
    THEN
        RAISE EXCEPTION 'Invalid open-container volume allocation'
            USING ERRCODE = '22023';
    END IF;

    IF _available_value IS NOT NULL
       AND (
           _available_value < 0
           OR _available_value::text
              IN ('NaN','Infinity','-Infinity')
       )
    THEN
        RAISE EXCEPTION 'Invalid open-container monetary valuation'
            USING ERRCODE = '22023';
    END IF;

    v_remaining_ml := _available_ml - _consume_ml;

    -- Historical inventory with unknown cost must never
    -- silently become zero-cost consumption.

    IF _available_value IS NULL THEN
        RETURN jsonb_build_object(
            'valuation_status', 'unverified',
            'consumed_value', NULL,
            'remaining_value',
                CASE
                    WHEN v_remaining_ml = 0 THEN 0::numeric
                    ELSE NULL::numeric
                END,
            'remaining_ml', v_remaining_ml
        );
    END IF;

    -- Exhausting the pool consumes its entire remaining value.
    -- This prevents residual rounding differences.

    IF v_remaining_ml = 0 THEN
        v_consumed_value := _available_value;
        v_remaining_value := 0;
    ELSE
        v_consumed_value := round(
            _available_value * _consume_ml / _available_ml,
            8
        );

        v_consumed_value := least(
            _available_value,
            v_consumed_value
        );

        v_remaining_value :=
            _available_value - v_consumed_value;
    END IF;

    RETURN jsonb_build_object(
        'valuation_status', 'verified',
        'consumed_value', v_consumed_value,
        'remaining_value', v_remaining_value,
        'remaining_ml', v_remaining_ml
    );
END;
$function$;

REVOKE ALL ON FUNCTION
    public.neo_open_container_value_allocation(
        numeric,numeric,numeric
    )
FROM PUBLIC;

COMMIT;