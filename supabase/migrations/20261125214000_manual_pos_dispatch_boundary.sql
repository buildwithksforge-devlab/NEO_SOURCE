BEGIN;

-- ============================================================
-- 1. Establish explicit dispatch context inside the existing
--    authenticated and authorized manual dispatch function.
-- ============================================================

DO $migration$
DECLARE
    d text;
    anchor text;
BEGIN

    d := pg_get_functiondef(
        'public.neo_pos_send_to_kitchen(uuid,uuid)'
        ::regprocedure
    );

    anchor := $anchor$
        _res := public.neo_pos_route_tickets_internal(
            _order,_org
        );
$anchor$;

    IF (
        length(d) -
        length(replace(d,anchor,''))
    ) <> length(anchor) THEN
        RAISE EXCEPTION
            'Manual dispatch wrapper source differs';
    END IF;

    d := replace(
        d,
        anchor,
        $patch$

        PERFORM set_config(
            'neo.explicit_dispatch_order',
            _order::text,
            true
        );

        _res := public.neo_pos_route_tickets_internal(
            _order,_org
        );

        PERFORM set_config(
            'neo.explicit_dispatch_order',
            '',
            true
        );

$patch$
    );

    EXECUTE d;

END;
$migration$;


-- ============================================================
-- 2. Protect waiter-created drafts at the canonical routing
--    boundary, including automatic repair and recovery.
--
--    Guest and delivery routing remains unchanged.
-- ============================================================

DO $migration$
DECLARE
    d text;
    anchor text;
BEGIN

    d := pg_get_functiondef(
        'public.neo_pos_route_tickets_internal(uuid,uuid)'
        ::regprocedure
    );

    anchor :=
        'AND oi.held = false AND coalesce(oi.status,''draft'') NOT IN (''cancelled'',''voided'')';

    IF (
        length(d) -
        length(replace(d,anchor,''))
    ) <> length(anchor) THEN

        RAISE EXCEPTION
            'Canonical routing eligibility differs';

    END IF;

    d := replace(
        d,
        anchor,
        $patch$

        AND oi.held = false

        AND coalesce(oi.status,'draft')
            NOT IN ('cancelled','voided')

        AND (
            coalesce(_o.order_source,'waiter-pos')
                <> 'waiter-pos'

            OR coalesce(oi.status,'draft')
                NOT IN ('draft','new','held')

            OR current_setting(
                'neo.explicit_dispatch_order',true
            ) = _order::text
        )

$patch$
    );

    EXECUTE d;

END;
$migration$;


-- ============================================================
-- 3. Prevent the historical item-insertion trigger from
--    automatically sending waiter-created draft additions.
--
--    Preserve the original trigger function and its remaining
--    behaviour for other order sources.
-- ============================================================

DO $migration$
DECLARE
    d text;
    anchor text;
BEGIN

    IF to_regprocedure(
        'public.neo_pos_autoroute_item()'
    ) IS NULL THEN
        RAISE EXCEPTION
            'Expected automatic item routing function missing';
    END IF;

    d := pg_get_functiondef(
        'public.neo_pos_autoroute_item()'
        ::regprocedure
    );

    anchor := $anchor$
    IF pg_trigger_depth() > 1 THEN

        RETURN NEW;

    END IF;
$anchor$;

    IF (
        length(d) -
        length(replace(d,anchor,''))
    ) <> length(anchor) THEN

        RAISE EXCEPTION
            'Automatic item routing source differs';

    END IF;

    d := replace(
        d,
        anchor,
        $patch$

        IF pg_trigger_depth() > 1 THEN
            RETURN NEW;
        END IF;

        IF coalesce(NEW.status,'draft')
               IN ('draft','new','held')

           AND EXISTS (
               SELECT 1
               FROM public.pos_orders o
               WHERE o.id = NEW.order_id
                 AND o.organization_id =
                     NEW.organization_id
                 AND coalesce(
                     o.order_source,'waiter-pos'
                 ) = 'waiter-pos'
           )

           AND current_setting(
               'neo.explicit_dispatch_order',true
           ) IS DISTINCT FROM NEW.order_id::text

        THEN
            RETURN NEW;
        END IF;

$patch$
    );

    EXECUTE d;

END;
$migration$;


-- ============================================================
-- 4. Prevent recovery candidates from being raised merely
--    because a waiter has added an unsent draft item.
-- ============================================================

DO $migration$
DECLARE
    d text;
    anchor text;
BEGIN

    d := pg_get_functiondef(
        'public.neo_pos_route_missing_tickets(uuid,integer)'
        ::regprocedure
    );

    anchor := $anchor$
                AND COALESCE(
                    oi.status,
                    'draft'
                ) NOT IN (
                    'cancelled',
                    'voided'
                )
$anchor$;

    IF (
        length(d) -
        length(replace(d,anchor,''))
    ) <> length(anchor) THEN

        RAISE EXCEPTION
            'Supervisor recovery source differs';

    END IF;

    d := replace(
        d,
        anchor,
        $patch$

        AND oi.organization_id = _org

        AND coalesce(oi.status,'draft')
            NOT IN ('cancelled','voided')

        AND (
            coalesce(o.order_source,'waiter-pos')
                <> 'waiter-pos'

            OR (
                oi.sent_at IS NOT NULL

                AND coalesce(oi.status,'draft')
                    NOT IN ('draft','new','held')
            )
        )

$patch$
    );

    EXECUTE d;

END;
$migration$;

NOTIFY pgrst,'reload schema';

COMMIT;