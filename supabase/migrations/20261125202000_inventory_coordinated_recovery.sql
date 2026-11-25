BEGIN;

CREATE FUNCTION public.neo_inventory_recovery_position(
    _event_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'pg_catalog','public'
AS $function$
DECLARE
    e public.inventory_posting_events;
    v_reversals jsonb;
    v_count integer;
BEGIN

    IF auth.uid() IS NULL
       OR public.current_org_id() IS NULL
       OR NOT (
           public.is_org_admin() IS TRUE
           OR public.has_permission(
               'finance','approve'
           ) IS TRUE
       )
    THEN
        RAISE EXCEPTION 'Financial approval permission required'
            USING ERRCODE = '42501';
    END IF;

    SELECT *
    INTO e
    FROM public.inventory_posting_events
    WHERE id = _event_id
      AND organization_id = public.current_org_id();

    IF NOT FOUND
       OR public.neo_branch_in_scope(e.branch_id)
           IS NOT TRUE
    THEN
        RAISE EXCEPTION 'Inventory event unavailable'
            USING ERRCODE = '42501';
    END IF;

    SELECT
        count(*)::integer,
        coalesce(
            jsonb_agg(
                jsonb_build_object(
                    'reversal_id',r.id,
                    'original_movement_id',
                        r.original_stock_movement_id,
                    'restoration_movement_id',
                        r.restoration_stock_movement_id
                )
            ),
            '[]'::jsonb
        )
    INTO v_count,v_reversals
    FROM public.neo_inventory_finance_reversals r
    WHERE r.organization_id = e.organization_id
      AND r.branch_id IS NOT DISTINCT FROM e.branch_id
      AND r.consumption_event_id = e.id;

    RETURN jsonb_build_object(
        'event_id',e.id,
        'branch_id',e.branch_id,
        'physical_status',e.status,
        'finance_status',e.finance_posting_status,
        'original_journal_id',e.finance_journal_id,
        'cost_snapshot',e.cost_snapshot,
        'restoration_count',v_count,
        'restorations',v_reversals
    );

END;
$function$;

REVOKE ALL ON FUNCTION
public.neo_inventory_recovery_position(uuid)
FROM PUBLIC,anon,authenticated;


CREATE OR REPLACE FUNCTION
public.neo_retry_inventory_consumption_finance(
    _event_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog','public'
AS $function$
DECLARE
    e public.inventory_posting_events;
    r public.neo_inventory_finance_reversals;
    v_original jsonb;
    v_result jsonb;
    v_results jsonb := '[]'::jsonb;
    v_position jsonb;
    v_count integer := 0;
BEGIN

    v_position :=
        public.neo_inventory_recovery_position(_event_id);

    SELECT *
    INTO e
    FROM public.inventory_posting_events
    WHERE id = _event_id
      AND organization_id = public.current_org_id()
    FOR UPDATE;

    IF NOT FOUND
       OR public.neo_branch_in_scope(e.branch_id)
           IS NOT TRUE
    THEN
        RAISE EXCEPTION 'Inventory event unavailable'
            USING ERRCODE = '42501';
    END IF;

    IF e.finance_posting_status IS NULL THEN
        RETURN jsonb_build_object(
            'status','legacy-excluded'
        );
    END IF;

    IF e.status = 'reversed'
       AND e.finance_journal_id IS NULL
       AND e.finance_posting_status IS DISTINCT FROM 'zero-value'
    THEN
        RETURN jsonb_build_object(
            'status','coordinated-recovery-required',
            'position',v_position,
            'detail',
                'Original valuation and physical restoration evidence require reconciliation before recognition.'
        );
    END IF;

    IF e.status <> 'reversed' THEN

        v_original :=
            public.neo_inventory_post_consumption_finance(
                e.id
            );

    ELSE

        v_original := jsonb_build_object(
            'status','existing-original-journal',
            'journal_id',e.finance_journal_id
        );

    END IF;

    SELECT *
    INTO e
    FROM public.inventory_posting_events
    WHERE id = _event_id;

    IF e.finance_journal_id IS NULL
       AND NOT (
           e.cost_snapshot >= 0 AND round(e.cost_snapshot,2) = 0
           AND e.payload->>'valuation_status' = 'verified'
           AND e.finance_posting_status IN (
               'zero-value'
           )
       ) IS TRUE
    THEN

        RETURN jsonb_build_object(
            'status','original-finance-unresolved',
            'original',v_original
        );

    END IF;

    FOR r IN
        SELECT *
        FROM public.neo_inventory_finance_reversals
        WHERE organization_id = e.organization_id
          AND branch_id IS NOT DISTINCT FROM e.branch_id
          AND consumption_event_id = e.id
        ORDER BY id
    LOOP

        v_result :=
            public.neo_inventory_post_restoration_finance(
                r.consumption_event_id,
                r.original_stock_movement_id,
                r.restoration_stock_movement_id
            );

        v_results := v_results || jsonb_build_array(
            jsonb_build_object(
                'reversal_id',r.id,
                'result',v_result
            )
        );

        v_count := v_count + 1;

    END LOOP;

    RETURN jsonb_build_object(
        'status','recovery-attempted',
        'original',v_original,
        'restorations_attempted',v_count,
        'restoration_results',v_results,
        'requires_reconciliation',true
    );

END;
$function$;

REVOKE ALL ON FUNCTION
public.neo_retry_inventory_consumption_finance(uuid)
FROM PUBLIC,anon,authenticated;

GRANT EXECUTE ON FUNCTION
public.neo_retry_inventory_consumption_finance(uuid)
TO authenticated;

COMMIT;