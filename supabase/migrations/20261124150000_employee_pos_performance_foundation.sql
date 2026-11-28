-- NE? employee POS performance foundation.
-- READ ONLY: no inserts, updates, deletes or operational posting.
-- SECURITY INVOKER: existing RLS remains authoritative.
--
-- Finalized bill value is NOT recognized revenue.
-- Payment, refund and ledger parity are handled separately.

CREATE OR REPLACE FUNCTION public.neo_employee_pos_performance(
    _from date,
    _to date,
    _branch uuid DEFAULT NULL
)
RETURNS TABLE (
    profile_id uuid,
    employee_id uuid,
    orders_created bigint,
    orders_currently_assigned bigint,
    created_orders_finalized bigint,
    created_orders_cancelled bigint,
    created_orders_voided bigint,
    finalized_bill_value numeric,
    assigned_orders_finalized bigint
)
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = public, pg_temp
AS $function$
DECLARE
    _org uuid;
    _viewer uuid;
    _can_report boolean;
BEGIN
    _org := public.current_org_id();
    _viewer := auth.uid();

    IF _org IS NULL OR _viewer IS NULL THEN
        RAISE EXCEPTION 'Authentication required'
            USING ERRCODE = '42501';
    END IF;

    IF _from IS NULL OR _to IS NULL OR _from > _to THEN
        RAISE EXCEPTION 'Invalid performance period'
            USING ERRCODE = '22023';
    END IF;

    IF _to - _from > 366 THEN
        RAISE EXCEPTION 'Performance period cannot exceed 366 days'
            USING ERRCODE = '22023';
    END IF;

    IF _branch IS NOT NULL
       AND NOT COALESCE(
           public.neo_branch_in_scope(_branch), FALSE
       )
    THEN
        RAISE EXCEPTION 'Property is outside your access'
            USING ERRCODE = '42501';
    END IF;

    -- Reuse NE?'s established reporting boundary.
    -- This validates the session, reporting period and property scope.
    PERFORM public.neo_assert_reporting_scope(
        _branch, _from, _to
    );

    _can_report := COALESCE(
        public.has_permission('pos', 'reports.view'),
        FALSE
    );

    RETURN QUERY
    WITH visible_orders AS (
        SELECT
            o.id,
            o.created_by,
            o.waiter_id,
            o.status,
            o.grand_total
        FROM public.pos_orders o
        WHERE o.organization_id = _org
          AND o.created_at >= _from::timestamptz
          AND o.created_at < (_to + 1)::timestamptz
          AND (
              _branch IS NULL
              OR o.branch_id = _branch
          )
          AND (
              _can_report
              OR o.created_by = _viewer
              OR o.waiter_id = _viewer
          )
    ),
    attributed AS (
        SELECT
            v.id,
            actor.staff_profile_id,
            actor.is_creator,
            actor.is_assigned,
            v.status,
            v.grand_total
        FROM visible_orders v
        CROSS JOIN LATERAL (
            SELECT
                identity_row.staff_profile_id,
                BOOL_OR(identity_row.is_creator) AS is_creator,
                BOOL_OR(identity_row.is_assigned) AS is_assigned
            FROM (
                VALUES
                    (v.created_by, TRUE, FALSE),
                    (v.waiter_id, FALSE, TRUE)
            ) AS identity_row(
                staff_profile_id,
                is_creator,
                is_assigned
            )
            WHERE identity_row.staff_profile_id IS NOT NULL
            GROUP BY identity_row.staff_profile_id
        ) actor
    )
    SELECT
        a.staff_profile_id AS profile_id,
        e.id AS employee_id,

        COUNT(*) FILTER (
            WHERE a.is_creator
        ) AS orders_created,

        COUNT(*) FILTER (
            WHERE a.is_assigned
        ) AS orders_currently_assigned,

        COUNT(*) FILTER (
            WHERE a.is_creator
              AND a.status IN (
                  'paid',
                  'charged-to-room',
                  'credit',
                  'closed'
              )
        ) AS created_orders_finalized,

        COUNT(*) FILTER (
            WHERE a.is_creator
              AND a.status = 'cancelled'
        ) AS created_orders_cancelled,

        COUNT(*) FILTER (
            WHERE a.is_creator
              AND a.status = 'voided'
        ) AS created_orders_voided,

        COALESCE(
            SUM(a.grand_total) FILTER (
                WHERE a.is_creator
                  AND a.status IN (
                      'paid',
                      'charged-to-room',
                      'credit',
                      'closed'
                  )
            ),
            0
        ) AS finalized_bill_value,

        COUNT(*) FILTER (
            WHERE a.is_assigned
              AND a.status IN (
                  'paid',
                  'charged-to-room',
                  'credit',
                  'closed'
              )
        ) AS assigned_orders_finalized

    FROM attributed a

    LEFT JOIN public.employees e
        ON e.profile_id = a.staff_profile_id
       AND e.organization_id = _org

    WHERE (
        _can_report
        OR a.staff_profile_id = _viewer
    )

    GROUP BY
        a.staff_profile_id,
        e.id

    ORDER BY
        7 DESC,
        3 DESC;

END;
$function$;

REVOKE ALL
ON FUNCTION public.neo_employee_pos_performance(date,date,uuid)
FROM PUBLIC;

GRANT EXECUTE
ON FUNCTION public.neo_employee_pos_performance(date,date,uuid)
TO authenticated;
