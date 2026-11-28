BEGIN;

CREATE OR REPLACE FUNCTION
public.neo_pos_consumption_exception_queue(
    _branch uuid DEFAULT NULL,
    _limit integer DEFAULT 100
)
RETURNS TABLE (
    order_id uuid,
    order_number text,
    order_status text,
    order_item_id uuid,
    menu_item_id uuid,
    item_name text,
    item_quantity numeric,
    item_status text,
    branch_id uuid,
    consumption_mode text,
    order_channel text,
    posting_status text,
    exception_category text,
    posting_details jsonb,
    last_posting_at timestamptz,
    item_created_at timestamptz
)
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path TO 'pg_catalog','public'
AS $function$
DECLARE
    v_org uuid := public.current_org_id();
BEGIN

    IF auth.uid() IS NULL OR v_org IS NULL THEN
        RAISE EXCEPTION 'Authentication required'
            USING ERRCODE = '42501';
    END IF;

    IF NOT (
        public.is_org_admin() IS TRUE
        OR public.has_permission('finance','view') IS TRUE
        OR public.has_permission('inventory','stock.manage') IS TRUE
    ) THEN
        RAISE EXCEPTION 'Inventory exception reporting permission required'
            USING ERRCODE = '42501';
    END IF;

    IF _branch IS NOT NULL
       AND public.neo_branch_in_scope(_branch) IS NOT TRUE
    THEN
        RAISE EXCEPTION 'Property outside authorised scope'
            USING ERRCODE = '42501';
    END IF;

    RETURN QUERY

    WITH candidates AS (

        SELECT
            o.id AS oid,
            o.order_number::text AS ono,
            o.status::text AS ost,
            i.id AS iid,
            i.menu_item_id AS mid,
            i.item_name::text AS iname,
            i.quantity::numeric AS qty,
            i.status::text AS ist,
            o.branch_id AS bid,

            coalesce(
                to_jsonb(m)->>'consumption_mode',
                'unknown'
            ) AS mode,

            coalesce(
                to_jsonb(o)->>'order_channel',
                to_jsonb(o)->>'channel',
                'unknown'
            ) AS channel,

            p.status::text AS pst,
            p.payload AS details,
            p.updated_at AS posting_time,
            i.created_at AS item_time,

            CASE

                WHEN p.status = 'failed'
                    THEN 'FAILED_POSTING'

                WHEN coalesce(
                    p.payload->>'reason',''
                ) IN (
                    'channel-excluded',
                    'channel_excluded'
                )
                    THEN 'CHANNEL_EXCLUDED'

                WHEN coalesce(
                    p.payload->>'reason',''
                ) IN (
                    'no-consumption',
                    'consumption-disabled',
                    'no_consumption'
                )
                    THEN 'CONFIGURED_NO_CONSUMPTION'

                WHEN p.status = 'skipped'
                    THEN 'SKIPPED_POSTING_REVIEW'

                WHEN p.id IS NULL
                    THEN 'NO_POSTING_EVENT'

                WHEN p.status NOT IN ('posted','reversed')
                    THEN 'NOT_POSTED_REVIEW'

                ELSE NULL

            END AS category

        FROM public.pos_order_items i

        JOIN public.pos_orders o
          ON o.id = i.order_id
         AND o.organization_id = v_org

        LEFT JOIN public.menu_items m
          ON m.id = i.menu_item_id
         AND m.organization_id = v_org

        LEFT JOIN LATERAL (

            SELECT e.*
            FROM public.inventory_posting_events e
            WHERE e.organization_id = v_org
              AND e.order_id = o.id
              AND e.order_item_id = i.id
              AND e.posting_type = 'consumption'
              AND e.idempotency_key =
                  'consume:' || i.id::text
            ORDER BY e.created_at DESC,e.id DESC
            LIMIT 1

        ) p ON true

        WHERE i.organization_id = v_org
          AND public.neo_branch_in_scope(o.branch_id) IS TRUE

          AND (
              _branch IS NULL
              OR o.branch_id = _branch
          )

          AND i.status::text NOT IN (
              'draft','voided','cancelled'
          )

          AND (
              o.status::text IN (
                  'closed','paid','completed'
              )
              OR i.sent_at IS NOT NULL
              OR i.ready_at IS NOT NULL
              OR i.served_at IS NOT NULL
              OR p.status = 'failed'
          )

    )

    SELECT
        c.oid,
        c.ono,
        c.ost,
        c.iid,
        c.mid,
        c.iname,
        c.qty,
        c.ist,
        c.bid,
        c.mode,
        c.channel,
        c.pst,
        c.category,
        c.details,
        c.posting_time,
        c.item_time

    FROM candidates c
    WHERE c.category IS NOT NULL

    ORDER BY
        CASE WHEN c.category = 'FAILED_POSTING'
             THEN 0 ELSE 1 END,
        c.item_time DESC,
        c.iid DESC

    LIMIT greatest(1,least(coalesce(_limit,100),500));

END;
$function$;

REVOKE ALL ON FUNCTION
public.neo_pos_consumption_exception_queue(uuid,integer)
FROM PUBLIC,anon,authenticated;

GRANT EXECUTE ON FUNCTION
public.neo_pos_consumption_exception_queue(uuid,integer)
TO authenticated;

COMMIT;