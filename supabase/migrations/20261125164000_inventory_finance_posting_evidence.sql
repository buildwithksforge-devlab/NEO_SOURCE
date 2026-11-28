-- NEØ inventory financial posting evidence.
-- Physical stock consumption and financial posting
-- are tracked independently.
-- No historical transactions are posted or recalculated.

BEGIN;

ALTER TABLE public.inventory_posting_events
    ADD COLUMN finance_posting_status text,
    ADD COLUMN finance_journal_id uuid
        REFERENCES public.journal_entries(id),
    ADD COLUMN finance_posted_at timestamptz,
    ADD COLUMN finance_posting_error text,
    ADD COLUMN finance_attempt_count integer NOT NULL DEFAULT 0;

ALTER TABLE public.inventory_posting_events
    ADD CONSTRAINT neo_inventory_finance_status_valid
    CHECK (
        finance_posting_status IS NULL
        OR finance_posting_status IN (
            'pending',
            'posted',
            'zero-value',
            'unverified',
            'failed',
            'reversed'
        )
    );

ALTER TABLE public.inventory_posting_events
    ADD CONSTRAINT neo_inventory_finance_attempt_valid
    CHECK (finance_attempt_count >= 0);

ALTER TABLE public.inventory_posting_events
    ADD CONSTRAINT neo_inventory_finance_journal_required
    CHECK (
        finance_posting_status IS DISTINCT FROM 'posted'
        OR (
            finance_journal_id IS NOT NULL
            AND finance_posted_at IS NOT NULL
        )
    );

CREATE INDEX neo_inventory_finance_pending_idx
ON public.inventory_posting_events (
    organization_id,
    branch_id,
    finance_posting_status
)
WHERE finance_posting_status IN (
    'pending',
    'failed',
    'unverified'
);

COMMENT ON COLUMN
    public.inventory_posting_events.finance_posting_status
IS
    'Independent financial posting state. NULL identifies legacy or unevaluated events, not pending automatic backfill.';

COMMENT ON COLUMN
    public.inventory_posting_events.finance_journal_id
IS
    'Original journal recognising verified inventory consumption cost.';

COMMENT ON COLUMN
    public.inventory_posting_events.finance_posting_error
IS
    'Latest financial reconciliation exception. Physical stock consumption remains independently recorded.';

COMMIT;