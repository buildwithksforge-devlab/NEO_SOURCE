-- NEØ inventory consumption financial posting engine.
-- Internal function only.
-- No historical financial backfill.
-- Automatic operational invocation is enabled separately.

BEGIN;

CREATE OR REPLACE FUNCTION public.neo_inventory_post_consumption_finance(
    _event_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
    e public.inventory_posting_events;
    p public.procurement_matching_policies;
    v_result jsonb;
    v_journal uuid;
    v_amount numeric;
    v_date date;
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
        RAISE EXCEPTION 'Inventory posting event unavailable'
            USING ERRCODE = '42501';
    END IF;

    IF public.neo_branch_in_scope(e.branch_id) IS NOT TRUE THEN
        RAISE EXCEPTION 'Inventory posting outside authorised property'
            USING ERRCODE = '42501';
    END IF;

    -- Legacy events are excluded from automatic financial posting.

    IF e.finance_posting_status IS NULL THEN
        RETURN jsonb_build_object(
            'status','legacy-excluded',
            'event_id',e.id
        );
    END IF;

    IF e.posting_type <> 'consumption'
       OR e.status <> 'posted'
    THEN
        RETURN jsonb_build_object(
            'status','ineligible',
            'event_id',e.id
        );
    END IF;

    -- Repeated attempts must not duplicate journals.

    IF e.finance_posting_status IN (
        'posted','zero-value','reversed'
    ) THEN
        RETURN jsonb_build_object(
            'status',e.finance_posting_status,
            'event_id',e.id,
            'journal_id',e.finance_journal_id,
            'duplicate_prevented',true
        );
    END IF;

    UPDATE public.inventory_posting_events
       SET finance_attempt_count = finance_attempt_count + 1
     WHERE id = e.id;

    -- Do not post incomplete or estimated consumption values.

    IF (e.payload->>'valuation_status')
        IS DISTINCT FROM 'verified'
       OR e.cost_snapshot IS NULL
    THEN

        UPDATE public.inventory_posting_events
           SET finance_posting_status = 'unverified',
               finance_posting_error =
                   'Consumption valuation requires reconciliation'
         WHERE id = e.id;

        RETURN jsonb_build_object(
            'status','unverified',
            'event_id',e.id
        );

    END IF;

    IF e.cost_snapshot < 0
       OR e.cost_snapshot::text IN (
           'NaN','Infinity','-Infinity'
       )
    THEN

        UPDATE public.inventory_posting_events
           SET finance_posting_status = 'failed',
               finance_posting_error =
                   'Invalid consumption monetary value'
         WHERE id = e.id;

        RETURN jsonb_build_object(
            'status','failed',
            'event_id',e.id
        );

    END IF;

    v_amount := round(e.cost_snapshot,2);

    -- Verified zero-value consumption requires no monetary journal.

    IF v_amount = 0 THEN

        UPDATE public.inventory_posting_events
           SET finance_posting_status = 'zero-value',
               finance_posting_error = NULL
         WHERE id = e.id;

        RETURN jsonb_build_object(
            'status','zero-value',
            'event_id',e.id
        );

    END IF;

    -- Preserve the original consumption accounting date.
    -- Retries must not silently move costs into another period.

    v_date :=
        (e.created_at AT TIME ZONE public.neo_fact_timezone(e.organization_id,e.branch_id))::date;

    BEGIN

        p := public.neo_matching_policy(
            e.organization_id,
            e.branch_id
        );

        IF nullif(btrim(p.inventory_account_code),'') IS NULL
           OR nullif(btrim(p.cost_of_sales_account_code),'') IS NULL
           OR p.inventory_account_code =
              p.cost_of_sales_account_code
        THEN
            RAISE EXCEPTION
                'Invalid inventory accounting configuration';
        END IF;

        v_result := public.neo_gl_post(
            e.organization_id,
            e.branch_id,
            'inventory',
            'inventory_posting_event',
            e.id,
            'consumption_cogs',
            v_date,
            public.neo_fact_currency(e.organization_id,e.branch_id),
            'Inventory consumption cost',
            jsonb_build_array(
                jsonb_build_object(
                    'code',p.cost_of_sales_account_code,
                    'debit',v_amount,
                    'credit',0,
                    'description','Actual inventory consumption'
                ),
                jsonb_build_object(
                    'code',p.inventory_account_code,
                    'debit',0,
                    'credit',v_amount,
                    'description','Inventory asset consumed'
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
                  AND j.branch_id IS NOT DISTINCT FROM e.branch_id
                  AND j.status = 'posted'
                  AND j.source_document_id = e.id
                  AND j.source_document_type =
                      'inventory_posting_event:consumption_cogs'
                  AND j.total_debit = v_amount
                  AND j.total_credit = v_amount
           )
        THEN
            RAISE EXCEPTION
                'Consumption journal evidence invalid';
        END IF;

        UPDATE public.inventory_posting_events
           SET finance_posting_status = 'posted',
               finance_journal_id = v_journal,
               finance_posted_at = now(),
               finance_posting_error = NULL
         WHERE id = e.id;

        RETURN jsonb_build_object(
            'status','posted',
            'event_id',e.id,
            'journal_id',v_journal,
            'amount',v_amount
        );

    EXCEPTION WHEN OTHERS THEN

        GET STACKED DIAGNOSTICS
            v_error = MESSAGE_TEXT,
            v_sqlstate = RETURNED_SQLSTATE;

        UPDATE public.inventory_posting_events
           SET finance_posting_status = 'failed',
               finance_posting_error =
                   left(v_sqlstate || ': ' || v_error,1000)
         WHERE id = e.id;

        RETURN jsonb_build_object(
            'status','failed',
            'event_id',e.id,
            'sqlstate',v_sqlstate
        );

    END;

END;
$function$;

-- Prevent direct invocation by ordinary application clients.

REVOKE ALL ON FUNCTION
    public.neo_inventory_post_consumption_finance(uuid)
FROM PUBLIC, anon, authenticated;

COMMIT;