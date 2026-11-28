BEGIN;

DO $migration$
DECLARE
    d text;
BEGIN

    d := pg_get_functiondef(
        'public.neo_pos_route_tickets_internal(uuid,uuid)'
        ::regprocedure
    );

    IF position(
        'neo_active_primary_ticket_guard_v1' IN d
    ) = 0

    OR position(
        'NEO_PRODUCTION_DUPLICATE_CONFLICT' IN d
    ) = 0

    OR position(
        'neo_pos_route_captured_secondary_tickets' IN d
    ) = 0

    THEN

        RAISE EXCEPTION
            'Installed canonical production safeguards differ';

    END IF;

END;
$migration$;

COMMIT;