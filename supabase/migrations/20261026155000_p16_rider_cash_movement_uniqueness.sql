-- =========================================================
-- NEO P1.6 - RIDER CASH MOVEMENT UNIQUENESS
-- LOCAL DRAFT - NOT DEPLOYED
-- =========================================================

DO $$
DECLARE
    v_missing text;
    v_duplicate_count bigint;
BEGIN

    -- Require the actual cash-movement columns.
    SELECT string_agg(required_column, ', ')
    INTO v_missing
    FROM (
        VALUES
            ('organization_id'),
            ('movement_type'),
            ('reference')
    ) AS required(required_column)
    WHERE NOT EXISTS (
        SELECT 1
        FROM information_schema.columns c
        WHERE c.table_schema = 'public'
          AND c.table_name = 'cash_movements'
          AND c.column_name = required.required_column
    );

    IF v_missing IS NOT NULL THEN
        RAISE EXCEPTION
            'P1.6 cannot proceed: cash_movements missing columns: %',
            v_missing;
    END IF;

    -- Do not conceal or delete historical duplicates.
    EXECUTE $query$
        SELECT count(*)
        FROM (
            SELECT organization_id, reference
            FROM public.cash_movements
            WHERE movement_type = 'rider-cash'
              AND reference IS NOT NULL
            GROUP BY organization_id, reference
            HAVING count(*) > 1
        ) duplicates
    $query$
    INTO v_duplicate_count;

    IF v_duplicate_count > 0 THEN
        RAISE EXCEPTION
            'P1.6 blocked: % duplicate rider-cash reference groups require reconciliation',
            v_duplicate_count;
    END IF;

END;
$$;

-- One rider remittance reference must not create
-- multiple cash movements in the same organization.
--
-- This deliberately applies only to rider-cash movements.
--
-- IMPORTANT:
-- A reference must uniquely identify ONE rider remittance.
-- Confirm that the current reconciliation function uses
-- the remittance reference before deploying.

CREATE UNIQUE INDEX IF NOT EXISTS
    neo_rider_cash_movement_reference_uq
ON public.cash_movements (
    organization_id,
    reference
)
WHERE movement_type = 'rider-cash'
  AND reference IS NOT NULL;
