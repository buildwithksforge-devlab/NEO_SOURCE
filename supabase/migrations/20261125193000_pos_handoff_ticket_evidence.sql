BEGIN;

CREATE OR REPLACE FUNCTION public.neo_pos_handoff_ticket_evidence(
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
    v_verified integer;
    v_missing integer;
    v_conflicting integer;
    v_tickets integer;
BEGIN

    IF public.current_org_id()
           IS DISTINCT FROM _organization
       OR public.neo_can_review_pos_handoff()
           IS NOT TRUE
       OR public.neo_branch_in_scope(_branch)
           IS NOT TRUE
    THEN
        RAISE EXCEPTION 'Handoff evidence outside authorised scope'
            USING ERRCODE = '42501';
    END IF;

    IF NOT EXISTS (
        SELECT 1
        FROM public.pos_orders o
        WHERE o.id = _order
          AND o.organization_id = _organization
          AND o.branch_id IS NOT DISTINCT FROM _branch
    ) THEN
        RAISE EXCEPTION 'Order outside authorised scope'
            USING ERRCODE = '42501';
    END IF;

    WITH item_evidence AS (

        SELECT
            i.id AS order_item_id,
            i.item_name,
            i.status AS item_status,
            i.quantity,
            i.station_id AS expected_station_id,

            count(t.id) AS original_ticket_links,

            count(t.id) FILTER (
                WHERE t.station_id = i.station_id
            ) AS primary_ticket_links,

            count(t.id) FILTER (
                WHERE t.station_id IS DISTINCT FROM
                      i.station_id
            ) AS other_station_links

        FROM public.pos_order_items i

        LEFT JOIN public.station_ticket_items sti
          ON sti.order_item_id = i.id
         AND sti.organization_id = _organization
         AND sti.remake_of_id IS NULL
         AND coalesce(sti.status,'') NOT IN (
             'cancelled','voided'
         )

        LEFT JOIN public.station_tickets t
          ON t.id = sti.ticket_id
         AND t.organization_id = _organization
         AND t.branch_id IS NOT DISTINCT FROM _branch
         AND t.order_id = _order
         AND coalesce(t.status,'') NOT IN (
             'cancelled','voided'
         )

        WHERE i.organization_id = _organization
          AND i.order_id = _order
          AND i.held = false
          AND coalesce(i.status,'draft')
              NOT IN ('cancelled','voided')

        GROUP BY
            i.id,
            i.item_name,
            i.status,
            i.quantity,
            i.station_id

    ),
    classified AS (

        SELECT e.*,

            CASE
                WHEN e.expected_station_id IS NULL
                    THEN 'station-unresolved'

                WHEN e.original_ticket_links = 0
                    THEN 'missing-ticket'

                WHEN e.primary_ticket_links = 0
                    THEN 'missing-primary'

                WHEN e.primary_ticket_links > 1
                    THEN 'conflicting-primary'

                WHEN e.other_station_links > 0
                    THEN 'secondary-review-required'

                ELSE 'primary-link-present'
            END AS coverage_status

        FROM item_evidence e

    )

    SELECT
        count(*)::integer,

        count(*) FILTER (
            WHERE coverage_status =
                  'primary-link-present'
        )::integer,

        count(*) FILTER (
            WHERE coverage_status IN (
                'missing-ticket',
                'missing-primary',
                'station-unresolved'
            )
        )::integer,

        count(*) FILTER (
            WHERE coverage_status IN (
                'conflicting-primary',
                'secondary-review-required'
            )
        )::integer,

        coalesce(
            jsonb_agg(to_jsonb(classified)),
            '[]'::jsonb
        )

    INTO
        v_total,
        v_verified,
        v_missing,
        v_conflicting,
        v_items

    FROM classified;

    SELECT count(*)::integer
      INTO v_tickets
    FROM public.station_tickets t
    WHERE t.organization_id = _organization
      AND t.order_id = _order
      AND t.branch_id IS NOT DISTINCT FROM _branch;

    RETURN jsonb_build_object(
        'total_items',v_total,
        'primary_links_present',v_verified,
        'missing_primary_items',v_missing,
        'items_requiring_review',
            v_missing + v_conflicting,
        'ticket_count',v_tickets,
        'items',v_items,
        'secondary_coverage_status','unverified'
    );

END;
$function$;

REVOKE ALL ON FUNCTION
public.neo_pos_handoff_ticket_evidence(uuid,uuid,uuid)
FROM PUBLIC,anon,authenticated;



COMMIT;
