-- NEØ inventory compensating journal engine.
-- Supports recoverable stock restoration without reversing
-- the entire original consumption journal.
-- Internal execution only.
-- No historical financial backfill.

BEGIN;

ALTER TABLE public.neo_inventory_finance_reversals
    ADD COLUMN reversed_amount numeric;

ALTER TABLE public.neo_inventory_finance_reversals
    ADD CONSTRAINT neo_inventory_reversed_amount_valid
    CHECK (
        reversed_amount IS NULL
        OR (
            reversed_amount >= 0
            AND reversed_amount::text NOT IN (
                'NaN','Infinity','-Infinity'
            )
        )
    );

CREATE OR REPLACE FUNCTION
    public.neo_inventory_post_restoration_finance(
        _event_id uuid,
        _original_movement_id uuid,
        _restoration_movement_id uuid
    )
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public'
AS $function$
DECLARE

    e public.inventory_posting_events;
    r public.neo_inventory_finance_reversals;

    v_movement jsonb;
    v_original jsonb;
    v_allocation jsonb;
    v_result jsonb;

    v_previous_value numeric;
    v_previous_amount numeric;

    v_amount numeric;
    v_journal uuid;

    v_inventory_account uuid;
    v_cogs_account uuid;

    v_error text;
    v_sqlstate text;

BEGIN

    SELECT *
      INTO e
      FROM public.inventory_posting_events
     WHERE id = _event_id
       AND organization_id = public.current_org_id()
     FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Consumption event unavailable'
            USING ERRCODE = '42501';
    END IF;

    IF public.neo_branch_in_scope(e.branch_id)
        IS NOT TRUE
    THEN
        RAISE EXCEPTION 'Restoration outside authorised property'
            USING ERRCODE = '42501';
    END IF;

    v_movement :=
        public.neo_inventory_validate_restoration(
            _event_id,
            _original_movement_id,
            _restoration_movement_id
        );

    -- Capture durable restoration evidence.

    INSERT INTO public.neo_inventory_finance_reversals (
        organization_id,
        branch_id,
        consumption_event_id,
        original_stock_movement_id,
        restoration_stock_movement_id,
        restored_quantity,
        restored_value,
        accounting_date,
        status
    )
    SELECT
        e.organization_id,
        e.branch_id,
        e.id,
        _original_movement_id,
        _restoration_movement_id,
        (v_movement->>'restored_quantity')::numeric,
        (v_movement->>'restored_value')::numeric,
        (m.created_at AT TIME ZONE public.neo_fact_timezone(e.organization_id,e.branch_id))::date,
        'pending'
    FROM public.stock_movements m
    WHERE m.id = _restoration_movement_id
      AND m.organization_id = e.organization_id

    ON CONFLICT (
        organization_id,
        restoration_stock_movement_id
    ) DO NOTHING;

    SELECT *
      INTO r
      FROM public.neo_inventory_finance_reversals
     WHERE organization_id = e.organization_id
       AND restoration_stock_movement_id =
           _restoration_movement_id
     FOR UPDATE;

    IF NOT FOUND
       OR r.consumption_event_id IS DISTINCT FROM e.id
       OR r.branch_id IS DISTINCT FROM e.branch_id
       OR r.original_stock_movement_id
          IS DISTINCT FROM _original_movement_id
       OR r.restored_quantity IS DISTINCT FROM
          (v_movement->>'restored_quantity')::numeric
       OR r.restored_value IS DISTINCT FROM
          (v_movement->>'restored_value')::numeric
    THEN
        RAISE EXCEPTION 'Restoration financial identity conflict'
            USING ERRCODE = '23514';
    END IF;

    IF r.status IN (
        'posted','zero-value','legacy-excluded'
    ) THEN

        RETURN jsonb_build_object(
            'status',r.status,
            'reversal_id',r.id,
            'journal_id',r.reversal_journal_id,
            'duplicate_prevented',true
        );

    END IF;

    UPDATE public.neo_inventory_finance_reversals
       SET attempt_count = attempt_count + 1
     WHERE id = r.id;

    -- Historical consumption must not create retrospective
    -- financial reversals.

    IF e.finance_posting_status IS NULL THEN

        UPDATE public.neo_inventory_finance_reversals
           SET status = 'legacy-excluded',
               posting_error =
                   'Original consumption predates financial integration'
         WHERE id = r.id;

        RETURN jsonb_build_object(
            'status','legacy-excluded',
            'reversal_id',r.id
        );

    END IF;

    -- A restoration cannot reverse a cost that has not
    -- yet been recognised in the general ledger.

    IF e.finance_posting_status NOT IN (
        'posted','zero-value'
    ) THEN

        UPDATE public.neo_inventory_finance_reversals
           SET status = 'unverified',
               posting_error =
                   'Original financial consumption is unresolved'
         WHERE id = r.id;

        RETURN jsonb_build_object(
            'status','unverified',
            'reversal_id',r.id
        );

    END IF;

    BEGIN

        IF e.finance_posting_status = 'zero-value' THEN

            IF e.cost_snapshot IS NULL
               OR e.cost_snapshot < 0
               OR e.cost_snapshot::text IN (
                   'NaN','Infinity','-Infinity'
               )
               OR round(e.cost_snapshot,2) <> 0
               OR (e.payload->>'valuation_status')
                   IS DISTINCT FROM 'verified'
            THEN
                RAISE EXCEPTION
                    'Invalid zero-value consumption evidence';
            END IF;

        ELSE

            v_original :=
                public.neo_inventory_validate_cogs_journal(
                    e.id
                );

        END IF;

        -- Include every successfully processed restoration
        -- for this consumption event.

        SELECT
            COALESCE(sum(restored_value),0),
            COALESCE(sum(reversed_amount),0)
          INTO
            v_previous_value,
            v_previous_amount
          FROM public.neo_inventory_finance_reversals
         WHERE organization_id = e.organization_id
           AND consumption_event_id = e.id
           AND id <> r.id
           AND status IN ('posted','zero-value');

        v_allocation :=
            public.neo_inventory_reversal_allocation(
                e.cost_snapshot,
                CASE
                    WHEN e.finance_posting_status = 'zero-value'
                    THEN 0::numeric
                    ELSE (v_original->>'posted_amount')::numeric
                END,
                v_previous_value,
                v_previous_amount,
                r.restored_value
            );

        v_amount :=
            (v_allocation->>'reversal_amount')::numeric;

        IF v_amount = 0 THEN

            UPDATE public.neo_inventory_finance_reversals
               SET status = 'zero-value',
                   original_journal_id = e.finance_journal_id,
                   reversed_amount = 0,
                   posting_error = NULL
             WHERE id = r.id;

            RETURN jsonb_build_object(
                'status','zero-value',
                'reversal_id',r.id,
                'amount',0
            );

        END IF;

        v_inventory_account :=
            (v_original->>'inventory_account_id')::uuid;

        v_cogs_account :=
            (v_original->>'cogs_account_id')::uuid;

        -- Independent compensating journal.
        -- Do not mark the entire original journal reversed.

        v_result := public.neo_gl_post(
            e.organization_id,
            e.branch_id,
            'inventory',
            'inventory_finance_reversal',
            r.id,
            'restoration_cogs',
            r.accounting_date,
            v_original->>'currency',
            'Recoverable inventory restoration',
            jsonb_build_array(
                jsonb_build_object(
                    'code',
                        v_original->>'inventory_account_code',
                    'debit',v_amount,
                    'credit',0,
                    'description','Inventory asset restored'
                ),
                jsonb_build_object(
                    'code',
                        v_original->>'cogs_account_code',
                    'debit',0,
                    'credit',v_amount,
                    'description','Consumption cost recovered'
                )
            ),
            NULL,
            NULL
        );

        v_journal :=
            (v_result->>'journal_id')::uuid;

        IF v_journal IS NULL
           OR NOT EXISTS (
               SELECT 1
               FROM public.journal_entries j
               WHERE j.id = v_journal
                 AND j.organization_id = e.organization_id
                 AND j.branch_id
                     IS NOT DISTINCT FROM e.branch_id
                 AND j.source_module = 'inventory'
                 AND j.source_document_id = r.id
                 AND j.source_document_type =
                     'inventory_finance_reversal:restoration_cogs'
                 AND j.status = 'posted'
                 AND j.reversed_by_journal_id IS NULL
                 AND j.reverses_journal_id IS NULL
                 AND j.currency = v_original->>'currency'
                 AND j.accounting_date = r.accounting_date
                 AND j.total_debit = v_amount
                 AND j.total_credit = v_amount
           )
        THEN
            RAISE EXCEPTION
                'Compensating journal identity invalid';
        END IF;

        -- Validate actual persisted account IDs and amounts.

        IF (
            SELECT count(*)
            FROM public.journal_entry_lines
            WHERE journal_id = v_journal
        ) <> 2

        OR NOT EXISTS (
            SELECT 1
            FROM public.journal_entry_lines l
            WHERE l.journal_id = v_journal
              AND l.organization_id = e.organization_id
              AND l.branch_id
                  IS NOT DISTINCT FROM e.branch_id
              AND l.account_id = v_inventory_account
              AND l.debit = v_amount
              AND l.credit = 0
        )

        OR NOT EXISTS (
            SELECT 1
            FROM public.journal_entry_lines l
            WHERE l.journal_id = v_journal
              AND l.organization_id = e.organization_id
              AND l.branch_id
                  IS NOT DISTINCT FROM e.branch_id
              AND l.account_id = v_cogs_account
              AND l.debit = 0
              AND l.credit = v_amount
        )
        THEN
            RAISE EXCEPTION
                'Compensating journal lines do not reconcile';
        END IF;

        UPDATE public.neo_inventory_finance_reversals
           SET status = 'posted',
               original_journal_id = e.finance_journal_id,
               reversal_journal_id = v_journal,
               reversed_amount = v_amount,
               posted_at = now(),
               posting_error = NULL
         WHERE id = r.id;

        RETURN jsonb_build_object(
            'status','posted',
            'reversal_id',r.id,
            'original_journal_id',e.finance_journal_id,
            'journal_id',v_journal,
            'amount',v_amount,
            'remaining_posted_amount',
                v_allocation->'remaining_posted_amount'
        );

    EXCEPTION WHEN OTHERS THEN

        GET STACKED DIAGNOSTICS
            v_error = MESSAGE_TEXT,
            v_sqlstate = RETURNED_SQLSTATE;

        UPDATE public.neo_inventory_finance_reversals
           SET status = 'failed',
               posting_error =
                   left(v_sqlstate || ': ' || v_error,1000)
         WHERE id = r.id;

        RETURN jsonb_build_object(
            'status','failed',
            'reversal_id',r.id,
            'sqlstate',v_sqlstate
        );

    END;

END;
$function$;

REVOKE ALL ON FUNCTION
    public.neo_inventory_post_restoration_finance(
        uuid,uuid,uuid
    )
FROM PUBLIC, anon, authenticated;

COMMIT;