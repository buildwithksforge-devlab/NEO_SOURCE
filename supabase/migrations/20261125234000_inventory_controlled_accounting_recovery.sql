BEGIN;

CREATE OR REPLACE FUNCTION
public.neo_inventory_reversed_recovery_eligible(
    _event_id uuid
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO pg_catalog, public
AS $function$
DECLARE

    e public.inventory_posting_events;

    r public.neo_inventory_finance_reversals;

    evidence jsonb;

    original_value numeric;

    original_count integer;

BEGIN

    IF auth.uid() IS NULL
       OR public.current_access_scope() IS NULL
       OR public.current_access_scope() = 'technical'
       OR NOT (
           public.is_org_admin() IS TRUE
           OR public.has_permission(
               'finance','approve'
           ) IS TRUE
       )
    THEN
        RETURN false;
    END IF;

    SELECT *
    INTO e

    FROM public.inventory_posting_events

    WHERE id = _event_id
      AND organization_id = public.current_org_id()

    FOR UPDATE;

    IF NOT FOUND THEN
        RETURN false;
    END IF;

    IF public.neo_branch_in_scope(
        e.branch_id
    ) IS NOT TRUE THEN
        RETURN false;
    END IF;

    IF e.order_item_id IS NULL
       OR e.posting_type IS DISTINCT FROM 'consumption'
       OR e.status IS DISTINCT FROM 'reversed'
       OR e.finance_journal_id IS NOT NULL
       OR e.finance_posting_status IS NULL
       OR e.finance_posting_status IN (
           'posted','zero-value','reversed'
       )
       OR e.payload->>'valuation_status'
          IS DISTINCT FROM 'verified'
       OR e.cost_snapshot IS NULL
       OR e.cost_snapshot < 0
       OR e.cost_snapshot::text IN (
           'NaN','Infinity','-Infinity'
       )
    THEN
        RETURN false;
    END IF;

    IF (
        SELECT count(*)
        FROM public.inventory_posting_events x
        WHERE x.organization_id = e.organization_id
          AND x.order_item_id = e.order_item_id
          AND x.posting_type = 'consumption'
    ) <> 1 THEN
        RETURN false;
    END IF;

    SELECT
        count(*)::integer,
        coalesce(sum(abs(m.value)),0)

    INTO
        original_count,
        original_value

    FROM public.stock_movements m

    WHERE m.organization_id = e.organization_id
      AND m.reference_type = 'pos_order_item'
      AND m.reference_id = e.order_item_id
      AND m.movement_type = 'consumption';

    IF original_count = 0
       OR original_value IS DISTINCT FROM e.cost_snapshot
    THEN
        RETURN false;
    END IF;

    IF EXISTS (

        SELECT 1

        FROM public.stock_movements m

        WHERE m.organization_id = e.organization_id
          AND m.reference_type = 'pos_order_item'
          AND m.reference_id = e.order_item_id
          AND m.movement_type = 'consumption'

          AND (

              m.quantity IS NULL
              OR m.quantity >= 0
              OR m.value IS NULL
              OR m.value > 0

              OR m.quantity::text IN (
                  'NaN','Infinity','-Infinity'
              )

              OR m.value::text IN (
                  'NaN','Infinity','-Infinity'
              )

              OR (

                  SELECT coalesce(
                      sum(x.restored_quantity),0
                  )

                  FROM public.neo_inventory_finance_reversals x

                  WHERE x.organization_id = e.organization_id
                    AND x.consumption_event_id = e.id
                    AND x.original_stock_movement_id = m.id

              ) IS DISTINCT FROM abs(m.quantity)

              OR (

                  SELECT coalesce(
                      sum(x.restored_value),0
                  )

                  FROM public.neo_inventory_finance_reversals x

                  WHERE x.organization_id = e.organization_id
                    AND x.consumption_event_id = e.id
                    AND x.original_stock_movement_id = m.id

              ) IS DISTINCT FROM abs(m.value)

          )

    ) THEN
        RETURN false;
    END IF;

    FOR r IN

        SELECT *
        FROM public.neo_inventory_finance_reversals

        WHERE organization_id = e.organization_id
          AND consumption_event_id = e.id

        ORDER BY id

        FOR UPDATE

    LOOP

        IF r.branch_id IS DISTINCT FROM e.branch_id

           OR r.status IS NULL

           OR r.status IN (
               'posted','zero-value','legacy-excluded'
           )

           OR r.reversal_journal_id IS NOT NULL

        THEN
            RETURN false;
        END IF;

        evidence :=
            public.neo_inventory_validate_restoration(

                e.id,

                r.original_stock_movement_id,

                r.restoration_stock_movement_id

            );

        IF evidence->>'status'
              IS DISTINCT FROM 'validated'

           OR (evidence->>'restored_quantity')::numeric
              IS DISTINCT FROM r.restored_quantity

           OR (evidence->>'restored_value')::numeric
              IS DISTINCT FROM r.restored_value

        THEN
            RETURN false;
        END IF;

    END LOOP;

    RETURN true;

END;
$function$;

REVOKE ALL ON FUNCTION
public.neo_inventory_reversed_recovery_eligible(uuid)
FROM PUBLIC,anon,authenticated;

-- Extend the canonical consumption finance engine.
-- Physical event status is never rewritten.

DO $migration$
DECLARE

    d text;

    anchor text :=
        'OR e.status <> ''posted''';

BEGIN

    d := pg_get_functiondef(
        'public.neo_inventory_post_consumption_finance(uuid)'
        ::regprocedure
    );

    IF position(anchor IN d) = 0 THEN

        RAISE EXCEPTION
            'Consumption engine baseline differs';

    END IF;

    d := replace(

        d,

        anchor,

$patch$

       OR (

           e.status <> 'posted'

           AND NOT (

               e.status = 'reversed'

               AND public.neo_inventory_reversed_recovery_eligible(
                   e.id
               ) IS TRUE

           )

       )

$patch$

    );

    EXECUTE d;

END;
$migration$;

CREATE OR REPLACE FUNCTION
public.neo_inventory_recover_reversed_accounting(
    _event_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO pg_catalog, public
AS $function$
DECLARE

    e public.inventory_posting_events;

    r public.neo_inventory_finance_reversals;

    original_result jsonb;

    result jsonb;

    results jsonb := '[]'::jsonb;

    restored_count integer := 0;

BEGIN

    IF public.neo_inventory_reversed_recovery_eligible(
        _event_id
    ) IS NOT TRUE THEN

        RAISE EXCEPTION
            'Consumption recovery evidence is incomplete or unauthorized';

    END IF;

    SELECT *
    INTO e

    FROM public.inventory_posting_events

    WHERE id = _event_id
      AND organization_id = public.current_org_id()

    FOR UPDATE;

    original_result :=
        public.neo_inventory_post_consumption_finance(
            e.id
        );

    IF coalesce(
        original_result->>'status',''
    ) NOT IN (
        'posted','zero-value'
    ) THEN

        RAISE EXCEPTION
            'Original COGS recognition failed';

    END IF;

    FOR r IN

        SELECT *
        FROM public.neo_inventory_finance_reversals

        WHERE organization_id = e.organization_id
          AND branch_id IS NOT DISTINCT FROM e.branch_id
          AND consumption_event_id = e.id

        ORDER BY id

    LOOP

        result :=
            public.neo_inventory_post_restoration_finance(

                e.id,

                r.original_stock_movement_id,

                r.restoration_stock_movement_id

            );

        IF coalesce(
            result->>'status',''
        ) NOT IN (
            'posted','zero-value'
        ) THEN

            RAISE EXCEPTION
                'Compensating accounting recognition failed';

        END IF;

        results := results ||
            jsonb_build_array(result);

        restored_count := restored_count + 1;

    END LOOP;

    IF restored_count = 0 THEN

        RAISE EXCEPTION
            'Restoration accounting evidence is missing';

    END IF;

    IF EXISTS (

        SELECT 1

        FROM public.neo_inventory_finance_reversals x

        WHERE x.organization_id = e.organization_id
          AND x.consumption_event_id = e.id

          AND coalesce(x.status,'') NOT IN (
              'posted','zero-value'
          )

    ) THEN

        RAISE EXCEPTION
            'Restoration accounting remains incomplete';

    END IF;

    IF (

        SELECT coalesce(
            sum(x.reversed_amount),0
        )

        FROM public.neo_inventory_finance_reversals x

        WHERE x.organization_id = e.organization_id
          AND x.consumption_event_id = e.id

    ) IS DISTINCT FROM round(e.cost_snapshot,2)

    THEN

        RAISE EXCEPTION
            'Recovered COGS and compensating values do not reconcile';

    END IF;

    RETURN jsonb_build_object(

        'status','recovered',

        'event_id',e.id,

        'original',original_result,

        'restorations_reconciled',restored_count,

        'restoration_results',results,

        'physical_stock_unchanged',true

    );

END;
$function$;

REVOKE ALL ON FUNCTION
public.neo_inventory_recover_reversed_accounting(uuid)
FROM PUBLIC,anon,authenticated;

-- Reuse the existing authorized inventory recovery RPC.

DO $migration$
DECLARE

    d text;

    anchor text :=
        'RETURN jsonb_build_object(
            ''status'',''coordinated-recovery-required'',';

BEGIN

    d := pg_get_functiondef(
        'public.neo_retry_inventory_consumption_finance(uuid)'
        ::regprocedure
    );

    IF position(anchor IN d) = 0 THEN

        RAISE EXCEPTION
            'Canonical recovery entry point differs';

    END IF;

    d := replace(

        d,

        anchor,

$patch$

        IF public.neo_inventory_reversed_recovery_eligible(
            e.id
        ) IS TRUE THEN

            RETURN
                public.neo_inventory_recover_reversed_accounting(
                    e.id
                );

        END IF;

$patch$

        || anchor

    );

    EXECUTE d;

END;
$migration$;

COMMIT;