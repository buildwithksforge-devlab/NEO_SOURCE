BEGIN;

CREATE OR REPLACE FUNCTION public.neo_pos_my_order_history(
    _from date DEFAULT NULL,
    _to date DEFAULT NULL,
    _branch uuid DEFAULT NULL,
    _closed_only boolean DEFAULT false,
    _limit integer DEFAULT 50,
    _offset integer DEFAULT 0
)
RETURNS TABLE (
    order_id uuid,
    order_number text,
    branch_id uuid,
    order_status text,
    order_value numeric,
    created_at timestamptz,
    closed_at timestamptz,
    original_creator boolean,
    current_waiter boolean,
    previously_assigned boolean
)
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path TO 'pg_catalog','public'
AS $function$
DECLARE
    v_org uuid := public.current_org_id();
    v_actor uuid := auth.uid();
BEGIN

    IF v_org IS NULL OR v_actor IS NULL THEN
        RAISE EXCEPTION 'Authentication required'
            USING ERRCODE = '42501';
    END IF;

    IF _branch IS NOT NULL
       AND public.neo_branch_in_scope(_branch) IS NOT TRUE
    THEN
        RAISE EXCEPTION 'Property outside authorised scope'
            USING ERRCODE = '42501';
    END IF;

    IF _from IS NOT NULL
       AND _to IS NOT NULL
       AND _from > _to
    THEN
        RAISE EXCEPTION 'Invalid reporting date range'
            USING ERRCODE = '22023';
    END IF;

    RETURN QUERY

    WITH visible_orders AS (

        SELECT
            o.id,
            o.order_number::text AS number,
            o.branch_id AS property_id,
            o.status::text AS state,
            o.grand_total::numeric AS amount,
            o.created_at AS opened_at,
            o.closed_at AS finished_at,

            EXISTS (
                SELECT 1
                FROM public.pos_order_assignment_history h
                WHERE h.organization_id = v_org
                  AND h.order_id = o.id
                  AND h.original_creator_id = v_actor
            ) OR coalesce(o.created_by = v_actor,false) AS creator_match,

            EXISTS (
                SELECT 1
                FROM public.pos_order_assignment_history h
                WHERE h.organization_id = v_org
                  AND h.order_id = o.id
                  AND (
                      h.previous_waiter_id = v_actor
                      OR h.new_waiter_id = v_actor
                  )
            ) AS assignment_match,

            o.waiter_id AS latest_waiter

        FROM public.pos_orders o

        WHERE o.organization_id = v_org

          AND public.neo_branch_in_scope(o.branch_id)
              IS TRUE

          AND (
              _branch IS NULL
              OR o.branch_id = _branch
          )

          AND (
              NOT coalesce(_closed_only,false)
              OR o.status::text IN (
                  'closed','paid','completed'
              )
          )

          AND (
              _from IS NULL
              OR (
                  o.created_at AT TIME ZONE
                  public.neo_fact_timezone(v_org,o.branch_id)
              )::date >= _from
          )

          AND (
              _to IS NULL
              OR (
                  o.created_at AT TIME ZONE
                  public.neo_fact_timezone(v_org,o.branch_id)
              )::date <= _to
          )

    )

    SELECT
        v.id,
        v.number,
        v.property_id,
        v.state,
        v.amount,
        v.opened_at,
        v.finished_at,
        v.creator_match,
        coalesce(v.latest_waiter = v_actor,false),
        v.assignment_match

    FROM visible_orders v

    WHERE v.creator_match
       OR v.assignment_match
       OR v.latest_waiter = v_actor

    ORDER BY v.opened_at DESC,v.id DESC

    LIMIT greatest(1,least(coalesce(_limit,50),200))
    OFFSET greatest(0,coalesce(_offset,0));

END;
$function$;

REVOKE ALL ON FUNCTION
public.neo_pos_my_order_history(
    date,date,uuid,boolean,integer,integer
)
FROM PUBLIC,anon,authenticated;

GRANT EXECUTE ON FUNCTION
public.neo_pos_my_order_history(
    date,date,uuid,boolean,integer,integer
)
TO authenticated;

COMMIT;