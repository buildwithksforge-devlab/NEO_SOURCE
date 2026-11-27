BEGIN;

-- ============================================================
-- 1. Protect pending POS cancellations during production.
-- ============================================================

DO $migration$
DECLARE
    d text;
    anchor text;
BEGIN

    d := pg_get_functiondef(
        'public.neo_kitchen_item_transition(uuid,text,text)'
        ::regprocedure
    );

    anchor := $anchor$
  UPDATE public.station_ticket_items SET
    status = _to,
$anchor$;

    IF (
        length(d) -
        length(replace(d,anchor,''))
    ) <> length(anchor) THEN

        RAISE EXCEPTION
            'Production item transition source differs';

    END IF;

    d := replace(
        d,
        anchor,
        $patch$

    -- Existing production permissions and station scope
    -- checks have already been performed.

    IF _ti.order_item_id IS NOT NULL THEN

        IF EXISTS (
            SELECT 1
            FROM public.pos_void_requests v
            WHERE v.organization_id = _org
              AND v.order_id = _t.order_id
              AND v.order_item_id = _ti.order_item_id
              AND v.status = 'pending'
        )

        AND _to IN (
            'accepted',
            'preparing',
            'ready',
            'collected',
            'served',
            'completed',
            'remaking'
        )

        THEN
            RAISE EXCEPTION
                'Item cancellation is awaiting approval'
                USING ERRCODE = '23514';
        END IF;

        -- A production transition must not independently
        -- cancel an active commercial order item.

        IF _to = 'cancelled'

        AND EXISTS (
            SELECT 1
            FROM public.pos_order_items oi
            WHERE oi.id = _ti.order_item_id
              AND oi.organization_id = _org
              AND oi.order_id = _t.order_id
              AND oi.status NOT IN ('cancelled','voided')
        )

        THEN
            RAISE EXCEPTION
                'Use the approved POS cancellation workflow'
                USING ERRCODE = '23514';
        END IF;

    END IF;

  UPDATE public.station_ticket_items SET
    status = _to,

$patch$
    );

    EXECUTE d;

END;
$migration$;


-- ============================================================
-- 2. Record the actual preparation state when a manager
--    decides a cancellation, rather than relying solely on
--    the original request snapshot.
-- ============================================================

DO $migration$
DECLARE
    d text;
    anchor text;
BEGIN

    d := pg_get_functiondef(
        'public.neo_pos_void_decide(uuid,boolean,text)'
        ::regprocedure
    );

    anchor := $anchor$
 IF _approve THEN
$anchor$;

    IF (
        length(d) -
        length(replace(d,anchor,''))
    ) <> length(anchor) THEN

        RAISE EXCEPTION
            'POS void decision source differs';

    END IF;

    d := replace(
        d,
        anchor,
        $patch$

 IF _approve THEN

    -- Require a documented decision when production
    -- has advanced beyond initial dispatch.

    IF (
        i.status IN (
            'preparing',
            'ready',
            'served',
            'cancel-pending'
        )

        OR EXISTS (
            SELECT 1
            FROM public.station_ticket_items sti
            JOIN public.station_tickets t
              ON t.id = sti.ticket_id
             AND t.organization_id = sti.organization_id
            WHERE sti.organization_id = org
              AND sti.order_item_id = i.id
              AND t.order_id = o.id
              AND (
                  sti.started_at IS NOT NULL
                  OR sti.ready_at IS NOT NULL
                  OR sti.collected_at IS NOT NULL
                  OR sti.served_at IS NOT NULL
                  OR sti.status IN (
                      'preparing',
                      'ready',
                      'collected',
                      'served',
                      'completed',
                      'remaking'
                  )
              )
        )
    )

    AND length(btrim(coalesce(_note,''))) < 10

    THEN
        RAISE EXCEPTION
            'Document the preparation and stock disposition before approving this cancellation';
    END IF;

$patch$
    );

    -- Extend the existing audit event without replacing it.

    anchor :=
        'jsonb_build_object(''order_id'',o.id,''item_id'',i.id)';

    IF (
        length(d) -
        length(replace(d,anchor,''))
    ) <> length(anchor) THEN

        RAISE EXCEPTION
            'POS void audit source differs';

    END IF;

    d := replace(
        d,
        anchor,
        $patch$
        jsonb_build_object(
            'order_id',o.id,
            'item_id',i.id,
            'requested_preparation_status',r.preparation_status,
            'decision_preparation_status',i.status,
            'decision_note',nullif(btrim(_note),''),
            'production_evidence',(
                SELECT coalesce(
                    jsonb_agg(
                        jsonb_build_object(
                            'ticket_item_id',sti.id,
                            'station_id',t.station_id,
                            'status',sti.status,
                            'accepted_at',sti.accepted_at,
                            'started_at',sti.started_at,
                            'ready_at',sti.ready_at,
                            'collected_at',sti.collected_at,
                            'served_at',sti.served_at
                        )
                        ORDER BY sti.id
                    ),
                    '[]'::jsonb
                )
                FROM public.station_ticket_items sti
                JOIN public.station_tickets t
                  ON t.id = sti.ticket_id
                 AND t.organization_id = sti.organization_id
                WHERE sti.organization_id = org
                  AND sti.order_item_id = i.id
                  AND t.order_id = o.id
            )
        )
$patch$
    );

    EXECUTE d;

END;
$migration$;

NOTIFY pgrst,'reload schema';

COMMIT;