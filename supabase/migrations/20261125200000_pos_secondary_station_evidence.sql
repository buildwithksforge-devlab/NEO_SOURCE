BEGIN;

CREATE FUNCTION public.neo_pos_secondary_station_evidence(
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
    v_requirements jsonb;
    v_missing integer;
    v_conflicting integer;
    v_total integer;
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

    WITH candidates AS (

        SELECT
            i.id AS order_item_id,
            i.item_name,
            r.id AS routing_rule_id,
            r.station_id AS primary_station_id,
            r.secondary_station_id,
            r.priority,
            r.modifier_option_id,
            ps.name AS primary_station_name,
            ss.name AS secondary_station_name,

            (
                SELECT count(*)
                FROM public.station_ticket_items sti
                JOIN public.station_tickets t
                  ON t.id = sti.ticket_id
                 AND t.organization_id = _organization
                WHERE sti.organization_id = _organization
                  AND sti.order_item_id = i.id
                  AND sti.remake_of_id IS NULL
                  AND t.order_id = _order
                  AND t.branch_id IS NOT DISTINCT FROM _branch
                  AND t.station_id = r.secondary_station_id
                  AND coalesce(t.status,'') NOT IN (
                      'cancelled','voided'
                  )
                  AND coalesce(sti.status,'') NOT IN (
                      'cancelled','voided'
                  )
            ) AS active_secondary_ticket_links

        FROM public.pos_order_items i

        JOIN public.pos_orders o
          ON o.id = i.order_id
         AND o.organization_id = _organization

        LEFT JOIN public.menu_items mi
          ON mi.id = i.menu_item_id
         AND mi.organization_id = _organization

        JOIN public.station_routing_rules r
          ON r.organization_id = _organization
         AND r.active IS TRUE
         AND (r.branch_id IS NULL OR r.branch_id = _branch)
         AND (
             r.menu_item_id IS NULL
             OR r.menu_item_id = i.menu_item_id
         )
         AND (
             r.category_id IS NULL
             OR r.category_id = mi.category_id
         )
         AND (
             r.order_type IS NULL
             OR r.order_type = o.order_type
         )

        LEFT JOIN public.operational_stations ps
          ON ps.id = r.station_id
          AND ps.organization_id = _organization

        LEFT JOIN public.operational_stations ss
          ON ss.id = r.secondary_station_id
          AND ss.organization_id = _organization

        WHERE i.organization_id = _organization
          AND i.order_id = _order
          AND i.held = false
          AND coalesce(i.status,'draft') NOT IN (
              'cancelled','voided'
          )
          AND r.secondary_station_id IS NOT NULL

    ),
    classified AS (

        SELECT c.*,

            CASE
                WHEN modifier_option_id IS NOT NULL
                    THEN 'modifier-match-unverified'

                WHEN primary_station_id = secondary_station_id
                    THEN 'conflicting-configuration'

                WHEN active_secondary_ticket_links = 0
                    THEN 'candidate-secondary-link-missing'

                WHEN active_secondary_ticket_links > 1
                    THEN 'conflicting-secondary-links'

                ELSE 'candidate-secondary-link-present'
            END AS coverage_status

        FROM candidates c
    )

    SELECT
        count(*)::integer,

        count(*) FILTER (
            WHERE coverage_status =
                  'candidate-secondary-link-missing'
        )::integer,

        count(*) FILTER (
            WHERE coverage_status IN (
                'conflicting-configuration',
                'conflicting-secondary-links'
            )
        )::integer,

        coalesce(
            jsonb_agg(to_jsonb(classified)),
            '[]'::jsonb
        )

    INTO
        v_total,
        v_missing,
        v_conflicting,
        v_requirements

    FROM classified;

    RETURN jsonb_build_object(
        'status','configuration-review-required',
        'candidate_rule_count',v_total,
        'missing_secondary_links',v_missing,
        'conflicting_secondary_links',v_conflicting,
        'secondary_station_requirements',v_requirements,
        'rule_precedence_verified',false,
        'requires_operational_confirmation',true
    );

END;
$function$;

REVOKE ALL ON FUNCTION
public.neo_pos_secondary_station_evidence(uuid,uuid,uuid)
FROM PUBLIC,anon,authenticated;



COMMIT;
