-- NE? POS-to-Finance reconciliation: room-charge evidence.
--
-- Read-only reporting function.
-- SECURITY INVOKER preserves caller table privileges and RLS.
-- A missing accessible record is NOT proof of a missing posting.
--
-- This function verifies structural posting evidence.
-- It does not certify Finance revenue recognition or account coding.
--
-- Partial room transfers require separate payment-allocation
-- reconciliation and are deliberately not marked matched.

CREATE OR REPLACE FUNCTION
public.neo_pos_finance_room_transfer_register(
    _from date,
    _to date,
    _branch uuid DEFAULT NULL
)
RETURNS TABLE (
    order_id uuid,
    order_number text,
    branch_id uuid,
    currency text,
    bill_value numeric,
    room_transfer_paid_total numeric,
    folio_line_id uuid,
    folio_line_count integer,
    folio_net_amount numeric,
    journal_id uuid,
    journal_count integer,
    journal_debit numeric,
    journal_credit numeric,
    direct_pos_journal_count integer,
    reconciliation_status text
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $function$

SELECT
    o.id,
    o.order_number,
    o.branch_id,
    o.currency,
    o.grand_total,
    coalesce(o.room_transfer_paid_total, 0),

    fl.line_id,
    fl.line_count,
    fl.net_amount,

    j.journal_id,
    j.journal_count,
    jl.debit_total,
    jl.credit_total,

    direct_j.direct_count,

    CASE
        WHEN direct_j.direct_count > 0
            THEN 'duplicate-posting-risk'

        WHEN fl.line_count > 1
            THEN 'ambiguous-folio-evidence'

        WHEN j.journal_count > 1
            THEN 'ambiguous-journal-evidence'

        WHEN fl.line_count <> 1
            THEN 'unverified-folio'

        WHEN round(
            coalesce(fl.net_amount, 0), 2
        ) <> round(o.grand_total, 2)
            THEN 'amount-mismatch'

        WHEN j.journal_count <> 1
            THEN 'unverified-journal'

        WHEN
            round(coalesce(jl.debit_total, 0), 2)
                <> round(o.grand_total, 2)
            OR
            round(coalesce(jl.credit_total, 0), 2)
                <> round(o.grand_total, 2)
            OR
            round(coalesce(j.header_debit, 0), 2)
                <> round(coalesce(jl.debit_total, 0), 2)
            OR
            round(coalesce(j.header_credit, 0), 2)
                <> round(coalesce(jl.credit_total, 0), 2)
            THEN 'journal-amount-mismatch'

        WHEN coalesce(
            o.room_transfer_paid_total, 0
        ) > 0
            THEN 'partial-payment-review'

        ELSE 'structurally-matched'
    END AS reconciliation_status

FROM public.pos_orders o

LEFT JOIN LATERAL (
    SELECT
        count(*)::integer AS line_count,
        min(f.id) AS line_id,
        sum(f.net_amount) AS net_amount
    FROM public.folio_lines f
    WHERE f.organization_id = o.organization_id
      AND f.branch_id IS NOT DISTINCT FROM o.branch_id
      AND f.folio_id = o.folio_id
      AND f.source_module = 'pos'
      AND f.source_record_uuid = o.id
      AND f.line_type = 'charge'
      AND f.status = 'posted'
) fl ON TRUE

LEFT JOIN LATERAL (
    SELECT
        count(*)::integer AS journal_count,
        min(x.id) AS journal_id,
        sum(x.total_debit) AS header_debit,
        sum(x.total_credit) AS header_credit
    FROM public.journal_entries x
    WHERE x.organization_id = o.organization_id
      AND x.branch_id IS NOT DISTINCT FROM o.branch_id
      AND x.source_document_id = fl.line_id
      AND x.source_document_type = 'folio_charge:revenue'
      AND x.status = 'posted'
      AND x.reversed_by_journal_id IS NULL
      AND x.journal_type <> 'reversal'
) j ON TRUE

LEFT JOIN LATERAL (
    SELECT
        sum(l.debit) AS debit_total,
        sum(l.credit) AS credit_total
    FROM public.journal_entry_lines l
    WHERE l.journal_id = j.journal_id
      AND l.organization_id = o.organization_id
      AND l.branch_id IS NOT DISTINCT FROM o.branch_id
) jl ON TRUE

LEFT JOIN LATERAL (
    SELECT
        count(*)::integer AS direct_count
    FROM public.journal_entries x
    WHERE x.organization_id = o.organization_id
      AND x.branch_id IS NOT DISTINCT FROM o.branch_id
      AND x.source_document_id = o.id
      AND x.source_document_type LIKE 'pos_order:%'
      AND x.status = 'posted'
      AND x.reversed_by_journal_id IS NULL
      AND x.journal_type <> 'reversal'
) direct_j ON TRUE

WHERE
    auth.uid() IS NOT NULL
    AND public.current_org_id() IS NOT NULL
    AND o.organization_id = public.current_org_id()

    AND public.has_permission(
        'pos',
        'reports.view'
    )

    AND (_from IS NOT NULL AND _to IS NOT NULL)
    AND _from <= _to

    AND (
        _branch IS NULL
        OR o.branch_id = _branch
    )

    AND (
        o.status = 'charged-to-room'
        OR o.folio_post_status = 'posted'
    )

    AND o.closed_at >= (
        _from::timestamp AT TIME ZONE 'Africa/Nairobi'
    )

    AND o.closed_at < (
        (_to + 1)::timestamp
        AT TIME ZONE 'Africa/Nairobi'
    )

ORDER BY
    o.closed_at DESC,
    o.id DESC;

$function$;

REVOKE ALL ON FUNCTION
public.neo_pos_finance_room_transfer_register(
    date, date, uuid
)
FROM PUBLIC, anon;

GRANT EXECUTE ON FUNCTION
public.neo_pos_finance_room_transfer_register(
    date, date, uuid
)
TO authenticated;
