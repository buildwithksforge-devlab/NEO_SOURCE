BEGIN;

CREATE FUNCTION public.neo_pos_canonical_routing_evidence(
    _organization uuid,
    _branch uuid,
    _order uuid
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'pg_catalog','public'
AS $function$
DECLARE
    v_items jsonb;
    v_total integer;
    v_missing integer;
    v_mismatch integer;
    v_candidates integer;
BEGIN

    IF public.current_org_id()
           IS DISTINCT FROM _organization
       OR public.neo_can_review_pos_handoff()
           IS NOT TRUE
       OR public.neo_branch_in_scope(_branch)
           IS NOT TRUE
    THEN
        RAISE EXCEPTION 'Routing evidence outside authorised scope'
            USING ERRCODE = '42501';
    END IF;

    IF NOT EXISTS (
        SELECT 1
        FROM public.pos_orders o
        WHERE o.id = _order
          AND o.organization_id = _organization
          AND o.branch_id IS NOT DISTINCT FROM _branch
    ) THEN
        RAISE EXCEPTION 'Order unavailable'
            USING ERRCODE = '42501';
    END IF;

    WITH resolved AS MATERIALIZED (

        SELECT
            i.id AS order_item_id,
            i.item_name,
            i.station_id AS persisted_station_id,

            public.neo_kitchen_route_order_item(
                i.id
            ) AS resolution

        FROM public.pos_order_items i

        WHERE i.organization_id = _organization
          AND i.order_id = _order
          AND i.held IS FALSE
          AND coalesce(i.status,'draft')
              NOT IN ('cancelled','voided')

    ),
    evidence AS (

        SELECT
            r.*,

            nullif(
                r.resolution->>'station_id',''
            )::uuid AS engine_station_id,

            (
                SELECT count(*)
                FROM public.station_ticket_items sti
                JOIN public.station_tickets t
                  ON t.id = sti.ticket_id
                 AND t.organization_id = _organization

                WHERE sti.organization_id = _organization
                  AND sti.order_item_id = r.order_item_id
                  AND sti.remake_of_id IS NULL
                  AND t.order_id = _order
                  AND t.branch_id IS NOT DISTINCT FROM _branch
                  AND t.station_id = nullif(
                      r.resolution->>'station_id',''
                  )::uuid
                  AND coalesce(t.status,'')
                      NOT IN ('cancelled','voided')
                  AND coalesce(sti.status,'')
                      NOT IN ('cancelled','voided')

            ) AS primary_ticket_links,

            (
                SELECT count(*)
                FROM public.station_ticket_items sti
                JOIN public.station_tickets t
                  ON t.id = sti.ticket_id
                 AND t.organization_id = _organization

                WHERE sti.organization_id = _organization
                  AND sti.order_item_id = r.order_item_id
                  AND sti.remake_of_id IS NULL
                  AND t.order_id = _order
                  AND t.branch_id IS NOT DISTINCT FROM _branch
                  AND t.station_id IS DISTINCT FROM nullif(
                      r.resolution->>'station_id',''
                  )::uuid
                  AND coalesce(t.status,'')
                      NOT IN ('cancelled','voided')
                  AND coalesce(sti.status,'')
                      NOT IN ('cancelled','voided')

            ) AS unexpected_station_links

        FROM resolved r

    ),
    classified AS (

        SELECT
            e.*,

            CASE
                WHEN engine_station_id IS NULL
                    THEN 'station-unresolved'

                WHEN primary_ticket_links = 0
                    THEN 'missing-primary'

                WHEN primary_ticket_links > 1
                    THEN 'conflicting-primary'

                WHEN persisted_station_id
                     IS DISTINCT FROM engine_station_id
                    THEN 'persisted-routing-mismatch'

                WHEN unexpected_station_links > 0
                    THEN 'additional-station-review-required'

                ELSE 'canonical-primary-confirmed'
            END AS routing_status

        FROM evidence e

    )

    SELECT
        count(*)::integer,

        count(*) FILTER (
            WHERE routing_status IN (
                'station-unresolved',
                'missing-primary'
            )
        )::integer,

        count(*) FILTER (
            WHERE routing_status IN (
                'conflicting-primary',
                'persisted-routing-mismatch',
                'additional-station-review-required'
            )
        )::integer,

        coalesce(
            jsonb_agg(to_jsonb(classified)),
            '[]'::jsonb
        )

    INTO
        v_total,
        v_missing,
        v_mismatch,
        v_items

    FROM classified;

    v_candidates := coalesce(
        (
            public.neo_pos_secondary_station_evidence(
                _organization,
                _branch,
                _order
            )->>'candidate_rule_count'
        )::integer,
        0
    );

    RETURN jsonb_build_object(
        'total_items',v_total,
        'missing_primary_items',v_missing,
        'conflicting_primary_items',v_mismatch,
        'secondary_candidate_count',v_candidates,
        'primary_verified',
            v_total > 0
            AND v_missing = 0
            AND v_mismatch = 0,
        'routing_verified',
            v_total > 0
            AND v_missing = 0
            AND v_mismatch = 0
            AND v_candidates = 0,
        'items',v_items
    );

END;
$function$;

REVOKE ALL ON FUNCTION
public.neo_pos_canonical_routing_evidence(uuid,uuid,uuid)
FROM PUBLIC,anon,authenticated;



DO $integration$
DECLARE
    d text;
    anchor text :=
        '''routing_verified'',' || chr(10) ||
        '            FALSE,';

BEGIN

    d := pg_get_functiondef(
        'public.neo_pos_handoff_full_investigation(uuid)'
        ::regprocedure
    );

    IF md5(d) <>
       'dc9c7bf852bcb3f65c30a2923c026b98'
    THEN
        RAISE EXCEPTION
            'Existing investigation source drift';
    END IF;

    IF (
        length(d)-length(replace(d,anchor,''))
    ) / length(anchor) <> 1 THEN

        RAISE EXCEPTION
            'Canonical evidence integration anchor missing';

    END IF;

    d := replace(
        d,
        anchor,
        $replacement$
        'canonical_routing_evidence',
            public.neo_pos_canonical_routing_evidence(
                (v_investigation->>'organization_id')::uuid,
                (v_investigation->>'branch_id')::uuid,
                (v_investigation->>'order_id')::uuid
            ),

        'routing_verified',
            FALSE,
$replacement$
    );

    EXECUTE d;

END;
$integration$;

COMMIT;