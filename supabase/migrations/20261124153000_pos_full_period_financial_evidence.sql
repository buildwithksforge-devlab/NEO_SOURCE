-- NE? POS full-period financial evidence.
--
-- Read-only management reporting.
-- Independent aggregates prevent multiplication of amounts.
-- This is NOT a Finance general-ledger revenue report.
--
-- Finalized bills use closed_at, not order creation time.
-- Bills lacking closed_at are NOT silently assigned a date.
--
-- Confirmed collections use paid_at.
-- Processed refund evidence uses decided_at because the
-- current POS refund schema has no processed_at column.

CREATE FUNCTION public.neo_pos_full_period_financial_evidence(
    _from date,
    _to date,
    _branch uuid DEFAULT NULL
)
RETURNS TABLE (
    finalized_order_count bigint,
    finalized_bill_value numeric,
    finalized_discount_value numeric,
    confirmed_payment_count bigint,
    confirmed_collection_value numeric,
    room_charge_payment_count bigint,
    room_charge_payment_value numeric,
    processed_refund_count bigint,
    processed_refund_value numeric
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
    _org uuid;
BEGIN
    _org := public.current_org_id();

    IF auth.uid() IS NULL OR _org IS NULL THEN
        RAISE EXCEPTION 'Authentication required'
            USING ERRCODE = '42501';
    END IF;

    -- The existing guard validates active staff, selected
    -- property, organization scope and reporting period.
    PERFORM public.neo_assert_reporting_scope(
        _branch, _from, _to
    );

    -- This RPC returns management financial aggregates.
    -- Individual cashiers use their separately scoped
    -- employee collection-evidence RPC.
    IF NOT COALESCE(
        public.has_permission('pos', 'reports.view'),
        FALSE
    ) THEN
        RAISE EXCEPTION 'POS reporting permission required'
            USING ERRCODE = '42501';
    END IF;

    RETURN QUERY

    WITH relevant_orders AS MATERIALIZED (
        SELECT
            o.id,
            o.organization_id,
            o.branch_id,
            o.status,
            o.closed_at,
            o.grand_total,
            o.discount_total
        FROM public.pos_orders o
        WHERE o.organization_id = _org
          AND (
              _branch IS NULL
              OR o.branch_id = _branch
          )
          AND (
              _branch IS NOT NULL
              OR COALESCE(
                  public.neo_branch_in_scope(o.branch_id),
                  FALSE
              )
          )
    ),

    finalized AS (
        SELECT
            COUNT(*)::bigint AS bill_count,
            COALESCE(
                SUM(o.grand_total), 0
            )::numeric AS bill_value,
            COALESCE(
                SUM(o.discount_total), 0
            )::numeric AS discount_value
        FROM relevant_orders o
        WHERE o.status IN (
            'paid',
            'charged-to-room',
            'credit',
            'closed'
        )
          AND o.closed_at >= _from::timestamptz
          AND o.closed_at < (_to + 1)::timestamptz
    ),

    payment_activity AS (
        SELECT
            COUNT(*) FILTER (
                WHERE p.status = 'confirmed'
                  AND p.method NOT IN (
                      'room-charge',
                      'corporate-credit',
                      'complimentary'
                  )
            )::bigint AS collection_count,

            COALESCE(
                SUM(p.amount) FILTER (
                    WHERE p.status = 'confirmed'
                      AND p.method NOT IN (
                          'room-charge',
                          'corporate-credit',
                          'complimentary'
                      )
                ),
                0
            )::numeric AS collection_value,

            COUNT(*) FILTER (
                WHERE p.status = 'confirmed'
                  AND p.method = 'room-charge'
            )::bigint AS room_count,

            COALESCE(
                SUM(p.amount) FILTER (
                    WHERE p.status = 'confirmed'
                      AND p.method = 'room-charge'
                ),
                0
            )::numeric AS room_value

        FROM public.pos_payments p

        JOIN relevant_orders o
          ON o.id = p.order_id
         AND o.organization_id = p.organization_id

        WHERE p.organization_id = _org
          AND p.paid_at >= _from::timestamptz
          AND p.paid_at < (_to + 1)::timestamptz
    ),

    refund_activity AS (
        SELECT
            COUNT(*)::bigint AS refund_count,

            COALESCE(
                SUM(r.amount), 0
            )::numeric AS refund_value

        FROM public.pos_refund_requests r

        JOIN public.pos_payments p
          ON p.id = r.payment_id
         AND p.order_id = r.order_id
         AND p.organization_id = r.organization_id

        JOIN relevant_orders o
          ON o.id = r.order_id
         AND o.organization_id = r.organization_id

        WHERE r.organization_id = _org
          AND r.status = 'processed'
          AND r.decided_at >= _from::timestamptz
          AND r.decided_at < (_to + 1)::timestamptz
          AND p.method NOT IN (
              'room-charge',
              'corporate-credit',
              'complimentary'
          )
    )

    SELECT
        f.bill_count,
        f.bill_value,
        f.discount_value,
        p.collection_count,
        p.collection_value,
        p.room_count,
        p.room_value,
        r.refund_count,
        r.refund_value

    FROM finalized f
    CROSS JOIN payment_activity p
    CROSS JOIN refund_activity r;

END;
$function$;

REVOKE ALL
ON FUNCTION public.neo_pos_full_period_financial_evidence(
    date, date, uuid
)
FROM PUBLIC;

GRANT EXECUTE
ON FUNCTION public.neo_pos_full_period_financial_evidence(
    date, date, uuid
)
TO authenticated;
