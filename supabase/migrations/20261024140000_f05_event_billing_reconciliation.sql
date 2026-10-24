-- NEØ F05: Consistent Events Billing financial totals.
-- DEF-MVIG04I9
--
-- Align the Events Billing overview with the individual
-- event statement.
--
-- Read-only calculations. No historical data changes.

CREATE OR REPLACE FUNCTION public.neo_event_billing(
    _branch uuid DEFAULT NULL,
    _from date DEFAULT NULL,
    _to date DEFAULT NULL
)
RETURNS TABLE (
    booking_id uuid,
    event_reference text,
    event_name text,
    status text,
    payment_status text,
    event_date date,
    branch_id uuid,
    branch_name text,
    customer_name text,
    total_amount numeric,
    paid_amount numeric,
    balance_due numeric,
    deposit_required numeric,
    deposit_paid numeric,
    billing_items integer,
    billing_total numeric
)
LANGUAGE plpgsql
STABLE SECURITY INVOKER
SET search_path = public
AS $function$
BEGIN
    IF NOT public.has_permission('events', 'billing', 'view') THEN
        RAISE EXCEPTION
            'The events.billing.view permission is required.'
            USING ERRCODE = '42501';
    END IF;

    IF _branch IS NOT NULL
       AND NOT public.neo_branch_in_scope(_branch) THEN
        RAISE EXCEPTION
            'That property is outside your access scope.'
            USING ERRCODE = '42501';
    END IF;

    RETURN QUERY
    SELECT
        b.id,
        b.event_reference,
        b.event_name,
        b.status,
        b.payment_status,
        b.event_date,
        b.branch_id,
        br.name,
        NULLIF(TRIM(COALESCE(c.full_name, '')), ''),

        -- Contracted charges excluding complimentary items.
        COALESCE(bl.chargeable, 0),

        -- All recorded event payment entries.
        COALESCE(ep.received, 0),

        -- The same outstanding formula used by the statement.
        COALESCE(bl.chargeable, 0)
          - COALESCE(ep.received, 0),

        COALESCE(b.deposit_required, 0),

        -- Actual recorded deposit entries.
        COALESCE(ep.deposits, 0),

        COALESCE(bl.items, 0)::integer,

        COALESCE(bl.chargeable, 0)

    FROM public.event_bookings b

    LEFT JOIN public.branches br
      ON br.id = b.branch_id

    LEFT JOIN public.customers c
      ON c.id = b.customer_id

    LEFT JOIN LATERAL (
        SELECT
            COUNT(*) AS items,
            COALESCE(
                SUM(
                    CASE
                        WHEN i.is_complimentary THEN 0
                        ELSE i.line_total
                    END
                ), 0
            ) AS chargeable
        FROM public.event_billing_items i
        WHERE i.booking_id = b.id
    ) bl ON TRUE

    LEFT JOIN LATERAL (
        SELECT
            COALESCE(SUM(p.amount), 0) AS received,
            COALESCE(
                SUM(p.amount)
                    FILTER (WHERE p.entry_type = 'deposit'),
                0
            ) AS deposits
        FROM public.event_payments p
        WHERE p.booking_id = b.id
    ) ep ON TRUE

    WHERE b.organization_id = public.current_org_id()
      AND public.neo_branch_in_scope(b.branch_id)
      AND (_branch IS NULL OR b.branch_id = _branch)
      AND (_from IS NULL OR b.event_date >= _from)
      AND (_to IS NULL OR b.event_date <= _to)

    ORDER BY b.event_date DESC;
END;
$function$;

REVOKE ALL ON FUNCTION
    public.neo_event_billing(uuid, date, date)
FROM PUBLIC, anon;

GRANT EXECUTE ON FUNCTION
    public.neo_event_billing(uuid, date, date)
TO authenticated, service_role;