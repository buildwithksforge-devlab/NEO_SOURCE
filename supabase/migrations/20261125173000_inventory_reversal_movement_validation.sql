-- NEØ financial reversal movement validation.
-- Verify actual physical restoration against original consumption.
-- Internal validation only. No historical data modifications.

BEGIN;

CREATE OR REPLACE FUNCTION public.neo_inventory_validate_restoration(
    _event_id uuid,
    _original_movement_id uuid,
    _restoration_movement_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE

    e public.inventory_posting_events;
    m public.stock_movements;
    r public.stock_movements;

    v_expected_value numeric;
    v_previous_quantity numeric;
    v_previous_value numeric;

BEGIN

    -- Serialize financial reversal decisions for the consumption event.

    SELECT *
      INTO e
      FROM public.inventory_posting_events
     WHERE id = _event_id
       AND organization_id = public.current_org_id()
     FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Original consumption event unavailable'
            USING ERRCODE = '42501';
    END IF;

    IF public.neo_branch_in_scope(e.branch_id) IS NOT TRUE THEN
        RAISE EXCEPTION 'Restoration outside authorised property'
            USING ERRCODE = '42501';
    END IF;

    IF e.posting_type IS DISTINCT FROM 'consumption' THEN
        RAISE EXCEPTION 'Original event is not consumption'
            USING ERRCODE = '23514';
    END IF;

    IF _original_movement_id IS NULL
       OR _restoration_movement_id IS NULL
       OR _original_movement_id = _restoration_movement_id
    THEN
        RAISE EXCEPTION 'Invalid restoration movement identity'
            USING ERRCODE = '23514';
    END IF;

    SELECT *
      INTO m
      FROM public.stock_movements
     WHERE id = _original_movement_id
       AND organization_id = e.organization_id
     FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Original stock movement unavailable'
            USING ERRCODE = '23514';
    END IF;

    SELECT *
      INTO r
      FROM public.stock_movements
     WHERE id = _restoration_movement_id
       AND organization_id = e.organization_id
     FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Restoration stock movement unavailable'
            USING ERRCODE = '23514';
    END IF;

    IF m.movement_type IS DISTINCT FROM 'consumption'
       OR r.movement_type IS DISTINCT FROM 'reversal'
       OR m.reference_type IS DISTINCT FROM 'pos_order_item'
       OR r.reference_type IS DISTINCT FROM 'pos_order_item'
       OR m.reference_id IS DISTINCT FROM e.order_item_id
       OR r.reference_id IS DISTINCT FROM e.order_item_id
       OR m.stock_item_id IS DISTINCT FROM r.stock_item_id
       OR m.location_id IS DISTINCT FROM r.location_id
       OR m.unit IS DISTINCT FROM r.unit
    THEN
        RAISE EXCEPTION 'Restoration movement identity mismatch'
            USING ERRCODE = '23514';
    END IF;

    -- Require the movement-specific reversal identity.

    IF r.idempotency_key IS DISTINCT FROM (
        'reverse:'
        || e.order_item_id::text
        || ':'
        || m.id::text
    ) THEN
        RAISE EXCEPTION 'Restoration idempotency identity mismatch'
            USING ERRCODE = '23514';
    END IF;

    IF NOT EXISTS (
        SELECT 1
        FROM public.stock_locations sl
        WHERE sl.id = m.location_id
          AND sl.organization_id = e.organization_id
          AND sl.branch_id IS NOT DISTINCT FROM e.branch_id
          AND public.neo_branch_in_scope(sl.branch_id) IS TRUE
    ) THEN
        RAISE EXCEPTION 'Restoration stock location scope mismatch'
            USING ERRCODE = '42501';
    END IF;

    -- An opened bottle is not recoverable sealed inventory.

    IF EXISTS (
        SELECT 1
        FROM public.stock_container_events ce
        WHERE ce.organization_id = e.organization_id
          AND ce.stock_movement_id = m.id
          AND ce.event_type = 'open'
    ) THEN
        RAISE EXCEPTION 'Opened container cannot be restored as sealed stock'
            USING ERRCODE = '23514';
    END IF;

    -- Reject missing, negative or non-finite restoration evidence.

    IF m.quantity IS NULL
       OR r.quantity IS NULL
       OR m.value IS NULL
       OR r.value IS NULL
       OR m.quantity >= 0
       OR r.quantity <= 0
       OR m.value > 0
       OR r.value < 0
       OR m.quantity::text IN ('NaN','Infinity','-Infinity')
       OR r.quantity::text IN ('NaN','Infinity','-Infinity')
       OR m.value::text IN ('NaN','Infinity','-Infinity')
       OR r.value::text IN ('NaN','Infinity','-Infinity')
    THEN
        RAISE EXCEPTION 'Invalid physical restoration evidence'
            USING ERRCODE = '23514';
    END IF;

    -- Include previous restorations, even if financial posting failed.
    -- A failed journal does not undo a physical restoration.

    SELECT
        COALESCE(sum(restored_quantity),0),
        COALESCE(sum(restored_value),0)
      INTO
        v_previous_quantity,
        v_previous_value
      FROM public.neo_inventory_finance_reversals
     WHERE organization_id = e.organization_id
       AND original_stock_movement_id = m.id
       AND restoration_stock_movement_id <> r.id;

    IF v_previous_quantity + r.quantity > abs(m.quantity) THEN

        RAISE EXCEPTION 'Cumulative restoration exceeds consumed quantity'
            USING ERRCODE = '23514';

    END IF;

    IF v_previous_value + r.value > abs(m.value) THEN

        RAISE EXCEPTION 'Cumulative restoration exceeds consumed value'
            USING ERRCODE = '23514';

    END IF;

    v_expected_value :=
        abs(m.value) * r.quantity / abs(m.quantity);

    IF abs(r.value - v_expected_value) > 0.00000001 THEN

        RAISE EXCEPTION 'Restoration value differs from original consumption cost'
            USING ERRCODE = '23514';

    END IF;

    RETURN jsonb_build_object(
        'status','validated',
        'organization_id',e.organization_id,
        'branch_id',e.branch_id,
        'consumption_event_id',e.id,
        'original_stock_movement_id',m.id,
        'restoration_stock_movement_id',r.id,
        'original_consumed_quantity',abs(m.quantity),
        'original_consumed_value',abs(m.value),
        'restored_quantity',r.quantity,
        'restored_value',r.value,
        'original_finance_status',e.finance_posting_status,
        'original_journal_id',e.finance_journal_id
    );

END;
$function$;

REVOKE ALL ON FUNCTION
    public.neo_inventory_validate_restoration(uuid,uuid,uuid)
FROM PUBLIC, anon, authenticated;

COMMIT;