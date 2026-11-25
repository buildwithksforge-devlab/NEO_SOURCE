-- NEØ inventory financial reversal evidence.
-- Preserve original consumption journals.
-- Track recoverable stock reversals independently.
-- No historical operational data modified.

BEGIN;

CREATE TABLE public.neo_inventory_finance_reversals (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),

    organization_id uuid NOT NULL,
    branch_id uuid,

    consumption_event_id uuid NOT NULL
        REFERENCES public.inventory_posting_events(id),

    original_stock_movement_id uuid NOT NULL
        REFERENCES public.stock_movements(id),

    restoration_stock_movement_id uuid NOT NULL
        REFERENCES public.stock_movements(id),

    original_journal_id uuid
        REFERENCES public.journal_entries(id),

    reversal_journal_id uuid
        REFERENCES public.journal_entries(id),

    restored_quantity numeric NOT NULL,
    restored_value numeric NOT NULL,

    accounting_date date NOT NULL,

    status text NOT NULL DEFAULT 'pending',

    attempt_count integer NOT NULL DEFAULT 0,

    posting_error text,

    created_at timestamptz NOT NULL DEFAULT now(),
    posted_at timestamptz,

    CONSTRAINT neo_inventory_reversal_movement_unique
        UNIQUE (
            organization_id,
            restoration_stock_movement_id
        ),

    CONSTRAINT neo_inventory_reversal_quantity_valid
        CHECK (
            restored_quantity > 0
            AND restored_quantity::text
                NOT IN ('NaN','Infinity','-Infinity')
        ),

    CONSTRAINT neo_inventory_reversal_value_valid
        CHECK (
            restored_value >= 0
            AND restored_value::text
                NOT IN ('NaN','Infinity','-Infinity')
        ),

    CONSTRAINT neo_inventory_reversal_status_valid
        CHECK (
            status IN (
                'pending',
                'posted',
                'zero-value',
                'failed',
                'unverified',
                'legacy-excluded'
            )
        ),

    CONSTRAINT neo_inventory_reversal_attempt_valid
        CHECK (attempt_count >= 0),

    CONSTRAINT neo_inventory_reversal_distinct_movements
        CHECK (
            original_stock_movement_id <>
            restoration_stock_movement_id
        ),

    CONSTRAINT neo_inventory_reversal_journal_required
        CHECK (
            status <> 'posted'
            OR (
                original_journal_id IS NOT NULL
                AND reversal_journal_id IS NOT NULL
                AND original_journal_id <> reversal_journal_id
                AND posted_at IS NOT NULL
            )
        )
);

CREATE INDEX neo_inventory_reversal_event_idx
ON public.neo_inventory_finance_reversals (
    organization_id,
    consumption_event_id
);

CREATE INDEX neo_inventory_reversal_original_movement_idx
ON public.neo_inventory_finance_reversals (
    organization_id,
    original_stock_movement_id
);

CREATE INDEX neo_inventory_reversal_pending_idx
ON public.neo_inventory_finance_reversals (
    organization_id,
    branch_id,
    status
)
WHERE status IN (
    'pending',
    'failed',
    'unverified'
);

ALTER TABLE public.neo_inventory_finance_reversals
    ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE
    public.neo_inventory_finance_reversals
FROM PUBLIC, anon, authenticated;

COMMENT ON TABLE
    public.neo_inventory_finance_reversals
IS
    'Internal evidence linking recoverable physical stock restoration to compensating financial journals.';

COMMENT ON COLUMN
    public.neo_inventory_finance_reversals.restored_value
IS
    'Actual restoration value, subject to original consumption evidence and cumulative reversal validation.';

COMMIT;