BEGIN;

-- ============================================================
-- 1. Recalculate the existing ticket when additional
--    production items are attached.
--
-- Existing preparation history must remain intact.
-- ============================================================

CREATE FUNCTION
public.neo_refresh_ticket_after_item_insert()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog,public
AS $function$
BEGIN

    IF NOT EXISTS (
        SELECT 1
        FROM public.station_tickets t
        WHERE t.id = NEW.ticket_id
          AND t.organization_id =
              NEW.organization_id
    ) THEN
        RAISE EXCEPTION
            'Production ticket identity could not be verified';
    END IF;

    PERFORM public.neo_kitchen_aggregate_ticket(
        NEW.ticket_id
    );

    RETURN NEW;

END;
$function$;

REVOKE ALL ON FUNCTION
public.neo_refresh_ticket_after_item_insert()
FROM PUBLIC,anon,authenticated;

CREATE TRIGGER trg_neo_refresh_ticket_after_item_insert

AFTER INSERT
ON public.station_ticket_items

FOR EACH ROW

EXECUTE FUNCTION
public.neo_refresh_ticket_after_item_insert();


-- ============================================================
-- 2. A bulk ticket action must not silently skip the
--    acceptance and preparation of newly added items.
--
-- Preserve existing item-level transitions.
-- ============================================================

DO $migration$
DECLARE
    d text;
    anchor text;
BEGIN

    d := pg_get_functiondef(
        'public.neo_kitchen_ticket_transition(uuid,text,text)'
        ::regprocedure
    );

    anchor := 'WHILE _cur_idx < _target_idx LOOP';

    IF (
        length(d) -
        length(replace(d,anchor,''))
    ) <> length(anchor) THEN

        RAISE EXCEPTION
            'Production ticket advancement contract differs';

    END IF;

    d := replace(
        d,
        anchor,
        $patch$

        IF _target_idx - _cur_idx > 1 THEN

            RAISE EXCEPTION
                'Ticket contains items at different preparation stages. Advance the outstanding items individually first.'
                USING ERRCODE = '23514';

        END IF;

        WHILE _cur_idx < _target_idx LOOP

$patch$
    );

    EXECUTE d;

END;
$migration$;


-- ============================================================
-- 3. Protect linked production identities.
--
-- An existing production line must not be silently
-- reassigned to another commercial order item.
-- ============================================================

CREATE FUNCTION
public.neo_guard_production_item_identity()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog,public
AS $function$
BEGIN

    IF NEW.organization_id
           IS DISTINCT FROM OLD.organization_id

       OR NEW.order_item_id
           IS DISTINCT FROM OLD.order_item_id

       OR NEW.remake_of_id
           IS DISTINCT FROM OLD.remake_of_id

    THEN

        RAISE EXCEPTION
            'Existing production item identity cannot be changed'
            USING ERRCODE = '23514';

    END IF;

    -- Controlled station reconciliation may still move a
    -- production line between tickets for the same order.

    IF NEW.ticket_id IS DISTINCT FROM OLD.ticket_id THEN

        IF NOT EXISTS (
            SELECT 1
            FROM public.station_tickets original
            JOIN public.station_tickets destination

              ON destination.organization_id =
                 original.organization_id

             AND destination.order_id =
                 original.order_id

             AND destination.branch_id
                 IS NOT DISTINCT FROM original.branch_id

            WHERE original.id = OLD.ticket_id
              AND destination.id = NEW.ticket_id

              AND original.organization_id =
                  OLD.organization_id
        ) THEN

            RAISE EXCEPTION
                'Production cannot move to a different order or property'
                USING ERRCODE = '23514';

        END IF;

    END IF;

    RETURN NEW;

END;
$function$;

REVOKE ALL ON FUNCTION
public.neo_guard_production_item_identity()
FROM PUBLIC,anon,authenticated;

CREATE TRIGGER trg_neo_guard_production_item_identity

BEFORE UPDATE OF
    organization_id,
    order_item_id,
    ticket_id,
    remake_of_id

ON public.station_ticket_items

FOR EACH ROW

EXECUTE FUNCTION
public.neo_guard_production_item_identity();

NOTIFY pgrst,'reload schema';

COMMIT;