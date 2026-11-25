-- NE? POS employee collection evidence.
--
-- Read-only operational reporting.
-- Not a replacement for the Finance ledger.
--
-- SECURITY DEFINER is intentional:
-- a cashier may receive payment for an order owned by
-- another waiter and must receive collection credit.
--
-- The function validates the authenticated session and
-- reporting scope, then limits output to the caller's
-- cashier identity unless POS reporting permission exists.
--
-- Do not add raw order/payment identifiers to this RPC.
-- Do not grant direct SELECT on other employees' orders.
--
-- Excludes room-charge, corporate-credit and complimentary
-- methods from cash-equivalent collections.
--
-- Does not calculate a net-revenue total because refunded and
-- reversed payment states require ledger-level reconciliation.

CREATE FUNCTION public.neo_employee_pos_collection_evidence(
    _from date,
    _to date,
    _branch uuid DEFAULT NULL
)
RETURNS TABLE (
    cashier_profile_id uuid,
    employee_id uuid,
    confirmed_payment_count bigint,
    confirmed_collection_amount numeric,
    processed_refund_count bigint,
    processed_refund_amount numeric
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
    _org uuid;
    _viewer uuid;
    _can_report boolean;
BEGIN
    _viewer := auth.uid();
    _org := public.current_org_id();

    IF _viewer IS NULL OR _org IS NULL THEN
        RAISE EXCEPTION 'Authentication required'
            USING ERRCODE = '42501';
    END IF;

    -- Use the existing NE? reporting security contract.
    PERFORM public.neo_assert_reporting_scope(
        _branch, _from, _to
    );

    _can_report := COALESCE(
        public.has_permission('pos', 'reports.view'),
        FALSE
    );

    -- The existing reporting guard validates the selected
    -- property and rejects unauthorized organization-wide
    -- reports. Keep an explicit property check as well.
    IF _branch IS NOT NULL
       AND NOT COALESCE(
           public.neo_branch_in_scope(_branch),
           FALSE
       )
    THEN
        RAISE EXCEPTION 'Property is outside your access'
            USING ERRCODE = '42501';
    END IF;

    RETURN QUERY

    WITH eligible_orders AS (
        SELECT
            o.id,
            o.organization_id,
            o.branch_id,
            o.created_by,
            o.waiter_id
        FROM public.pos_orders o
        WHERE o.organization_id = _org
          AND (
              _branch IS NULL
              OR o.branch_id = _branch
          )
    ),

    confirmed AS (
        SELECT
            p.id,
            p.cashier_id,
            p.amount
        FROM public.pos_payments p
        JOIN eligible_orders o
          ON o.id = p.order_id
         AND o.organization_id = p.organization_id
        WHERE p.organization_id = _org
          AND p.status = 'confirmed'
          AND p.method NOT IN (
              'room-charge',
              'corporate-credit',
              'complimentary'
          )
          AND p.paid_at >= _from::timestamptz
          AND p.paid_at < (_to + 1)::timestamptz
          AND (
              _can_report
              OR p.cashier_id = _viewer
          )
    ),

    processed_refunds AS (
        SELECT
            r.id,
            p.cashier_id,
            r.amount
        FROM public.pos_refund_requests r
        JOIN public.pos_payments p
          ON p.id = r.payment_id
         AND p.organization_id = r.organization_id
         AND p.order_id = r.order_id
        JOIN eligible_orders o
          ON o.id = p.order_id
         AND o.organization_id = p.organization_id
        WHERE r.organization_id = _org
          AND r.status = 'processed'
          AND p.method NOT IN (
              'room-charge',
              'corporate-credit',
              'complimentary'
          )
          -- The current POS refund schema does not expose
          -- a dedicated processed_at column.
          -- Only dated decisions are reported here.
          AND r.decided_at >= _from::timestamptz
          AND r.decided_at < (_to + 1)::timestamptz
          AND (
              _can_report
              OR p.cashier_id = _viewer
          )
    ),

    activity AS (
        SELECT
            c.cashier_id,
            1::bigint AS payment_count,
            c.amount AS collection_amount,
            0::bigint AS refund_count,
            0::numeric AS refund_amount
        FROM confirmed c

        UNION ALL

        SELECT
            r.cashier_id,
            0::bigint,
            0::numeric,
            1::bigint,
            r.amount
        FROM processed_refunds r
    )

    SELECT
        a.cashier_id,
        e.id,
        SUM(a.payment_count)::bigint,
        COALESCE(SUM(a.collection_amount), 0),
        SUM(a.refund_count)::bigint,
        COALESCE(SUM(a.refund_amount), 0)

    FROM activity a

    LEFT JOIN public.employees e
      ON e.profile_id = a.cashier_id
     AND e.organization_id = _org

    WHERE (
        _can_report
        OR a.cashier_id = _viewer
    )

    GROUP BY
        a.cashier_id,
        e.id

    ORDER BY
        4 DESC,
        1;

END;
$function$;

REVOKE ALL
ON FUNCTION public.neo_employee_pos_collection_evidence(
    date,date,uuid
)
FROM PUBLIC;

GRANT EXECUTE
ON FUNCTION public.neo_employee_pos_collection_evidence(
    date,date,uuid
)
TO authenticated;
