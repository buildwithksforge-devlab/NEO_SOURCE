BEGIN;

-- Preserve the established POS recovery architecture.
-- Do not recreate existing failure storage or replace
-- established recovery and supervisor investigation contracts.

DO $compatibility$
DECLARE
    v_missing text;
BEGIN

    IF to_regclass(
        'public.neo_pos_handoff_failures'
    ) IS NULL THEN
        RAISE EXCEPTION
            'Existing POS recovery foundation is missing';
    END IF;

    SELECT string_agg(required.column_name, ', ')
    INTO v_missing
    FROM unnest(ARRAY[
        'id',
        'organization_id',
        'branch_id',
        'order_id',
        'source',
        'status',
        'failure_reason',
        'attempts',
        'first_failed_at',
        'last_failed_at',
        'resolved_at',
        'updated_at',
        'reviewed_by',
        'reviewed_at',
        'review_note'
    ]) AS required(column_name)
    WHERE NOT EXISTS (
        SELECT 1
        FROM information_schema.columns c
        WHERE c.table_schema = 'public'
          AND c.table_name = 'neo_pos_handoff_failures'
          AND c.column_name = required.column_name
    );

    IF v_missing IS NOT NULL THEN
        RAISE EXCEPTION
            'POS recovery columns missing: %',v_missing;
    END IF;

    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint c
        WHERE c.conrelid =
            'public.neo_pos_handoff_failures'::regclass
          AND c.contype = 'u'
          AND pg_get_constraintdef(c.oid) =
              'UNIQUE (organization_id, order_id)'
    ) THEN
        RAISE EXCEPTION
            'Existing POS recovery identity differs';
    END IF;

    IF to_regclass(
        'public.neo_pos_handoff_review_history'
    ) IS NULL THEN
        RAISE EXCEPTION
            'Existing supervisor review history missing';
    END IF;

    IF md5(pg_get_functiondef(
        'public.neo_pos_handoff_recovery_queue(uuid,integer)'
        ::regprocedure
    )) <> '6f438baf87b0b1fa54c977c77e72846c' THEN

        RAISE EXCEPTION
            'Existing recovery queue source drift';

    END IF;

    IF md5(pg_get_functiondef(
        'public.neo_pos_review_failed_handoff(uuid,text)'
        ::regprocedure
    )) <> '39fa8ca1c1f463ca35eaecf93f157b27' THEN

        RAISE EXCEPTION
            'Existing supervisor review source drift';

    END IF;

    IF md5(pg_get_functiondef(
        'public.neo_pos_handoff_full_investigation(uuid)'
        ::regprocedure
    )) <> 'dc9c7bf852bcb3f65c30a2923c026b98' THEN

        RAISE EXCEPTION
            'Existing investigation source drift';

    END IF;

END;
$compatibility$;


CREATE OR REPLACE FUNCTION
public.neo_can_review_pos_handoff()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'pg_catalog','public'
AS $function$

    SELECT auth.uid() IS NOT NULL
       AND public.current_org_id() IS NOT NULL
       AND (
           public.is_org_admin() IS TRUE
           OR public.has_permission(
               'restaurant','orders.manage'
           ) IS TRUE
       );

$function$;

REVOKE ALL ON FUNCTION
public.neo_can_review_pos_handoff()
FROM PUBLIC,anon,authenticated;


-- Extend manual dispatch to capture failures in the
-- established organisation/order recovery register.

DO $migration$
DECLARE
    d text;

    anchor text :=
        '_res := public.neo_pos_route_tickets_internal(_order, _org);';

BEGIN

    d := pg_get_functiondef(
        'public.neo_pos_send_to_kitchen(uuid,uuid)'
        ::regprocedure
    );

    IF md5(d) <>
       '896812e2b9b6c0c3fa9363baa5a7ddc9'
    THEN

        RAISE EXCEPTION
            'Existing POS dispatch source drift';

    END IF;

    IF (
        length(d)-length(replace(d,anchor,''))
    ) / length(anchor) <> 1 THEN

        RAISE EXCEPTION
            'POS dispatch integration anchor missing';

    END IF;

    d := replace(
        d,
        'IF NOT public.neo_branch_in_scope(_o.branch_id) THEN',
        'IF public.neo_branch_in_scope(_o.branch_id) IS NOT TRUE THEN'
    );

    d := replace(
        d,
        'IF NOT (_supervisor',
        'IF (_supervisor'
    );

    d := replace(
        d,
        'AND public.has_permission(''pos'',''orders.create''))) THEN',
        'AND public.has_permission(''pos'',''orders.create''))) IS NOT TRUE THEN'
    );

    d := replace(
        d,
        anchor,
        $patch$

    BEGIN

        _res := public.neo_pos_route_tickets_internal(
            _order,_org
        );

        IF (_res->>'ok')::boolean IS NOT TRUE THEN
            RAISE EXCEPTION
                'Production routing did not confirm success';
        END IF;

    EXCEPTION WHEN OTHERS THEN

        INSERT INTO public.neo_pos_handoff_failures (
            organization_id,
            branch_id,
            order_id,
            source,
            status,
            failure_reason,
            attempts,
            first_failed_at,
            last_failed_at,
            updated_at
        )
        VALUES (
            _org,
            _o.branch_id,
            _order,
            'manual-dispatch',
            'pending',
            left(SQLERRM,2000),
            1,
            now(),
            now(),
            now()
        )

        ON CONFLICT (organization_id,order_id)
        DO UPDATE SET

            status = 'review_required',

            failure_reason =
                EXCLUDED.failure_reason,

            attempts =
                neo_pos_handoff_failures.attempts + 1,

            last_failed_at = now(),

            updated_at = now(),

            resolved_at = NULL

        WHERE neo_pos_handoff_failures.branch_id =
              EXCLUDED.branch_id;

        RETURN jsonb_build_object(
            'ok',false,
            'status','handoff_failed',
            'order_id',_order,
            'attempt',_attempt,
            'message',
                CASE
                    WHEN SQLERRM LIKE 'routing_unresolved:%'
                      OR SQLERRM LIKE 'store_unmapped:%'
                    THEN left(SQLERRM,500)
                    ELSE
                        'Production handoff failed. Supervisor review required.'
                END
        );

    END;

    -- Routing success is not equivalent to complete
    -- station-by-station reconciliation.

    UPDATE public.neo_pos_handoff_failures
       SET status = 'review_required',
           updated_at = now()
     WHERE organization_id = _org
       AND branch_id = _o.branch_id
       AND order_id = _order
       AND status IN ('pending','retrying');

$patch$
    );

    EXECUTE d;

END;
$migration$;

COMMIT;