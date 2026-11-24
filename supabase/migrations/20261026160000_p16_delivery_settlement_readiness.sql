-- ========================================================
-- NEO P1.6 - RIDER CASH SETTLEMENT READINESS
-- LOCAL DRAFT - NOT DEPLOYED
--
-- Read-only reconciliation information.
-- Does not create payments, journals or invoices.
-- ========================================================

CREATE OR REPLACE FUNCTION public.neo_delivery_remittance_settlement_readiness(
    _remittance uuid
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
    v_rem public.rider_cash_remittances%ROWTYPE;
    v_total numeric := 0;
    v_count integer := 0;
    v_missing integer := 0;
    v_already_paid integer := 0;
    v_rows jsonb := '[]'::jsonb;
BEGIN
    SELECT *
      INTO v_rem
      FROM public.rider_cash_remittances
     WHERE id = _remittance
       AND organization_id = public.current_org_id();

    IF NOT FOUND THEN
        RETURN jsonb_build_object(
            'ok', false,
            'reason', 'remittance_not_found'
        );
    END IF;

    SELECT
        coalesce(sum(c.collected_amount), 0),
        count(*)::integer,
        count(*) FILTER (WHERE i.id IS NULL)::integer,
        count(*) FILTER (
            WHERE i.id IS NOT NULL
              AND coalesce(i.balance, 0) <= 0
        )::integer,
        coalesce(
            jsonb_agg(
                jsonb_build_object(
                    'delivery_order_id', c.delivery_order_id,
                    'collected_amount', c.collected_amount,
                    'invoice_id', i.id,
                    'invoice_balance', i.balance,
                    'invoice_status', i.status
                )
                ORDER BY c.delivery_order_id
            ),
            '[]'::jsonb
        )
    INTO
        v_total,
        v_count,
        v_missing,
        v_already_paid,
        v_rows
    FROM public.rider_cash_collections c
    LEFT JOIN LATERAL (
        SELECT inv.id, inv.balance, inv.status
          FROM public.invoices inv
         WHERE inv.organization_id = c.organization_id
           AND inv.notes LIKE
               '%delivery-order:' || c.delivery_order_id::text || '%'
         ORDER BY inv.created_at DESC
         LIMIT 1
    ) i ON true
    WHERE c.remittance_id = _remittance
      AND c.organization_id = v_rem.organization_id;

    RETURN jsonb_build_object(
        'ok', true,
        'remittance_id', _remittance,
        'remittance_status', v_rem.status,
        'expected_amount', v_rem.expected_amount,
        'declared_amount', v_rem.declared_amount,
        'counted_amount', v_rem.counted_amount,
        'variance', v_rem.variance,
        'collections_total', v_total,
        'collection_count', v_count,
        'missing_invoices', v_missing,
        'already_settled_invoices', v_already_paid,
        'amount_matches',
            round(v_total, 2) =
            round(coalesce(v_rem.counted_amount, -1), 2),
        'ready_for_automatic_settlement',
            v_rem.status = 'reconciled'
            AND round(v_total, 2) =
                round(coalesce(v_rem.counted_amount, -1), 2)
            AND v_missing = 0
            AND v_already_paid = 0,
        'collections', v_rows
    );
END;
$$;

REVOKE ALL ON FUNCTION
    public.neo_delivery_remittance_settlement_readiness(uuid)
FROM PUBLIC;

GRANT EXECUTE ON FUNCTION
    public.neo_delivery_remittance_settlement_readiness(uuid)
TO authenticated;
