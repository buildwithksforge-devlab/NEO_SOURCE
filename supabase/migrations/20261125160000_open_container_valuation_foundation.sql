-- NEØ open-container monetary valuation foundation.
-- Additive schema only.
-- No historical inventory values are overwritten.

BEGIN;

ALTER TABLE public.stock_open_containers
    ADD COLUMN open_inventory_value numeric,
    ADD COLUMN valuation_volume_ml numeric;

ALTER TABLE public.stock_container_events
    ADD COLUMN inventory_value_delta numeric,
    ADD COLUMN open_inventory_value_after numeric;

ALTER TABLE public.stock_open_containers
    ADD CONSTRAINT neo_open_inventory_value_valid
    CHECK (
        open_inventory_value IS NULL
        OR (
            open_inventory_value >= 0
            AND open_inventory_value::text
                NOT IN ('NaN','Infinity','-Infinity')
        )
    );

ALTER TABLE public.stock_open_containers
    ADD CONSTRAINT neo_open_valuation_volume_valid
    CHECK (
        valuation_volume_ml IS NULL
        OR (
            valuation_volume_ml >= 0
            AND valuation_volume_ml::text
                NOT IN ('NaN','Infinity','-Infinity')
        )
    );

ALTER TABLE public.stock_container_events
    ADD CONSTRAINT neo_container_event_value_finite
    CHECK (
        inventory_value_delta IS NULL
        OR inventory_value_delta::text
            NOT IN ('NaN','Infinity','-Infinity')
    );

ALTER TABLE public.stock_container_events
    ADD CONSTRAINT neo_container_event_remaining_value_valid
    CHECK (
        open_inventory_value_after IS NULL
        OR (
            open_inventory_value_after >= 0
            AND open_inventory_value_after::text
                NOT IN ('NaN','Infinity','-Infinity')
        )
    );

COMMENT ON COLUMN public.stock_open_containers.open_inventory_value IS
    'Remaining historical monetary value of open inventory. NULL means valuation is not established.';

COMMENT ON COLUMN public.stock_open_containers.valuation_volume_ml IS
    'Volume covered by the recorded monetary valuation. Must reconcile with physical volume before valuation is used.';

COMMENT ON COLUMN public.stock_container_events.inventory_value_delta IS
    'Signed monetary change: positive for opening, negative for consumption. NULL means unverified valuation.';

COMMENT ON COLUMN public.stock_container_events.open_inventory_value_after IS
    'Remaining monetary value after this event. NULL means unverified valuation.';

COMMIT;