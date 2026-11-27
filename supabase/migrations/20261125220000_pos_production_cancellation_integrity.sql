BEGIN;

-- ============================================================
-- 1. Prevent false order dispatch advancement.
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
        'UPDATE public.pos_orders';

    IF (
        length(d) -
        length(replace(d,anchor,''))
    ) <> length(anchor) THEN
        RAISE EXCEPTION
            'Canonical order advancement source differs';
    END IF;

    d := replace(
        d,
        anchor,
        $patch$

    IF _created = 0 AND _reused = 0 THEN

        RETURN jsonb_build_object(
            'ok',true,
            'order_id',_order,
            'tickets_created',_tickets,
            'items_created',_created,
            'items_reused',_reused,
            'unassigned_station',_unassigned
        );

    END IF;

    UPDATE public.pos_orders

$patch$
    );

    EXECUTE d;

END;
$migration$;


-- ============================================================
-- 2. Synchronize approved POS voids to every associated
--    production station without deleting historical tickets.
-- ============================================================

CREATE OR REPLACE FUNCTION
public.neo_propagate_pos_void_to_production()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog,public
AS $function$
DECLARE
    v_ticket uuid;
    v_line record;
BEGIN

    IF NEW.status IS NOT DISTINCT FROM OLD.status
       OR NEW.status <> 'voided'
    THEN
        RETURN NEW;
    END IF;

    FOR v_line IN

        SELECT
            sti.id,
            sti.ticket_id,
            sti.status

        FROM public.station_ticket_items sti

        JOIN public.station_tickets t
          ON t.id = sti.ticket_id
         AND t.organization_id = sti.organization_id

        WHERE sti.organization_id =
              NEW.organization_id

          AND sti.order_item_id = NEW.id
          AND t.order_id = NEW.order_id

          AND sti.status NOT IN (
              'cancelled',
              'completed',
              'served'
          )

        ORDER BY sti.id

        FOR UPDATE OF sti

    LOOP

        UPDATE public.station_ticket_items
           SET status = 'cancelled',
               cancelled_at = coalesce(
                   cancelled_at,
                   now()
               ),
               production_note = concat_ws(
                   E'\n',
                   nullif(production_note,''),
                   'Linked POS item voided'
               )

         WHERE id = v_line.id
           AND organization_id =
               NEW.organization_id;

        INSERT INTO
        public.station_ticket_status_history (
            organization_id,
            ticket_id,
            ticket_item_id,
            from_status,
            to_status,
            reason,
            changed_by
        )
        VALUES (
            NEW.organization_id,
            v_line.ticket_id,
            v_line.id,
            v_line.status,
            'cancelled',
            'Linked POS item voided',
            auth.uid()
        );

    END LOOP;

    FOR v_ticket IN

        SELECT DISTINCT sti.ticket_id

        FROM public.station_ticket_items sti

        JOIN public.station_tickets t
          ON t.id = sti.ticket_id
         AND t.organization_id = sti.organization_id

        WHERE sti.organization_id =
              NEW.organization_id

          AND sti.order_item_id = NEW.id
          AND t.order_id = NEW.order_id

        ORDER BY sti.ticket_id

    LOOP

        PERFORM public.neo_kitchen_aggregate_ticket(
            v_ticket
        );

    END LOOP;

    RETURN NEW;

END;
$function$;

REVOKE ALL ON FUNCTION
public.neo_propagate_pos_void_to_production()
FROM PUBLIC,anon,authenticated;

DROP TRIGGER IF EXISTS
trg_neo_propagate_pos_void_to_production
ON public.pos_order_items;

CREATE TRIGGER
trg_neo_propagate_pos_void_to_production

AFTER UPDATE OF status
ON public.pos_order_items

FOR EACH ROW

WHEN (
    OLD.status IS DISTINCT FROM NEW.status
    AND NEW.status = 'voided'
)

EXECUTE FUNCTION
public.neo_propagate_pos_void_to_production();


-- ============================================================
-- 3. Protect production item changes at the table boundary.
--
--    Applies to ordinary queues, dedicated displays and
--    other workflows that update station ticket items.
-- ============================================================

CREATE OR REPLACE FUNCTION
public.neo_guard_production_item_lifecycle()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog,public
AS $function$
DECLARE
    v_pos_status text;
    v_order uuid;
BEGIN

    IF NEW.status IS NOT DISTINCT FROM OLD.status
       OR NEW.order_item_id IS NULL
    THEN
        RETURN NEW;
    END IF;

    SELECT
        oi.status,
        oi.order_id

    INTO
        v_pos_status,
        v_order

    FROM public.pos_order_items oi

    JOIN public.station_tickets t
      ON t.id = NEW.ticket_id
     AND t.order_id = oi.order_id
     AND t.organization_id = oi.organization_id

    WHERE oi.id = NEW.order_item_id
      AND oi.organization_id =
          NEW.organization_id;

    IF NOT FOUND THEN
        RAISE EXCEPTION
            'Production item source could not be verified';
    END IF;

    IF NEW.status IN (
        'accepted',
        'preparing',
        'ready',
        'collected',
        'served',
        'completed',
        'remaking'
    ) THEN

        IF v_pos_status IN (
            'voided',
            'cancelled'
        ) THEN

            RAISE EXCEPTION
                'Cancelled POS items cannot advance in production'
                USING ERRCODE = '23514';

        END IF;

        IF EXISTS (
            SELECT 1
            FROM public.pos_void_requests r
            WHERE r.organization_id =
                  NEW.organization_id
              AND r.order_id = v_order
              AND r.order_item_id =
                  NEW.order_item_id
              AND r.status = 'pending'
        ) THEN

            RAISE EXCEPTION
                'Cancellation approval is pending'
                USING ERRCODE = '23514';

        END IF;

    END IF;

    RETURN NEW;

END;
$function$;

REVOKE ALL ON FUNCTION
public.neo_guard_production_item_lifecycle()
FROM PUBLIC,anon,authenticated;

DROP TRIGGER IF EXISTS
trg_neo_guard_production_item_lifecycle
ON public.station_ticket_items;

CREATE TRIGGER
trg_neo_guard_production_item_lifecycle

BEFORE UPDATE OF status
ON public.station_ticket_items

FOR EACH ROW

EXECUTE FUNCTION
public.neo_guard_production_item_lifecycle();

NOTIFY pgrst,'reload schema';

COMMIT;