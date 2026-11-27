BEGIN;

-- NEO_EVENT_ANCHOR_NORMALIZATION_V1
DO $migration$
DECLARE
    d text;
    target regprocedure;
    anchor text;
    replacement text;
BEGIN

    SELECT p.oid::regprocedure
    INTO STRICT target
    FROM pg_proc p
    JOIN pg_namespace n
      ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.proname = 'neo_finance_post_txn'
      AND p.prosrc LIKE '%event_cancellation%'
      AND p.prosrc LIKE '%neo_record_event_refund_obligation%';

    d := pg_get_functiondef(target);

    anchor := $old$
RETURN jsonb_build_object('ok',false,'reason','refund_settlement_required','refund_obligation_recorded',true,'refund_amount',remainder,'detail','Cancellation requires controlled financial settlement.');
$old$;
    anchor := btrim(anchor, E' \t\r\n');

    replacement := $new$
-- Refund liability remains outstanding until authorised settlement.
-- Cancellation fee recognition proceeds independently.
$new$;

    IF (
        length(d) -
        length(replace(d,anchor,''))
    ) <> length(anchor) THEN
        RAISE EXCEPTION
            'Event refund obligation return contract differs';
    END IF;

    d := replace(d,anchor,replacement);

    anchor := $old$
IF amount = 0 AND remainder = 0 THEN
$old$;
    anchor := btrim(anchor, E' \t\r\n');

    replacement := $new$
IF amount = 0 THEN
$new$;

    IF (
        length(d) -
        length(replace(d,anchor,''))
    ) <> length(anchor) THEN
        RAISE EXCEPTION
            'Zero-fee cancellation contract differs';
    END IF;

    d := replace(d,anchor,replacement);

    anchor := $old$
jsonb_build_object('code','2030','debit',paid,'description','Deposit released')
$old$;
    anchor := btrim(anchor, E' \t\r\n');

    replacement := $new$
jsonb_build_object(
    'code','2030',
    'debit',least(paid,amount),
    'description','Deposit applied to cancellation fee'
)
$new$;

    IF (
        length(d) -
        length(replace(d,anchor,''))
    ) <> length(anchor) THEN
        RAISE EXCEPTION
            'Event cancellation deposit accounting differs';
    END IF;

    d := replace(d,anchor,replacement);

    anchor := $old$
,jsonb_build_object('code',settle,'credit',remainder,'description','Refund to client')
$old$;
    anchor := btrim(anchor, E' \t\r\n');

    IF (
        length(d) -
        length(replace(d,anchor,''))
    ) <> length(anchor) THEN
        RAISE EXCEPTION
            'Event cancellation refund accounting differs';
    END IF;

    d := replace(d,anchor,'');

    anchor := $old$
amount:=greatest(amount,paid);
$old$;
    anchor := btrim(anchor, E' \t\r\n');

    IF (
        length(d) -
        length(replace(d,anchor,''))
    ) <> length(anchor) THEN
        RAISE EXCEPTION
            'Event cancellation posting amount differs';
    END IF;

    d := replace(
        d,
        anchor,
        '-- Posting amount represents the cancellation fee only.'
    );

    EXECUTE d;

END;
$migration$;



CREATE OR REPLACE FUNCTION
public.neo_event_cancellation_fee_journal_valid(
    _org uuid,
    _booking uuid,
    _journal uuid
)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO pg_catalog,public
AS $function$
DECLARE
    b public.event_bookings;
    fee numeric;
    deposit numeric;
    liability_debit numeric;
    receivable_debit numeric;
    other_debits numeric;
    total_credit numeric;
    prohibited_credits numeric;
    line_count bigint;
    invalid_lines bigint;
BEGIN

    SELECT *
    INTO b
    FROM public.event_bookings
    WHERE id = _booking
      AND organization_id = _org;

    IF NOT FOUND
       OR b.status IS DISTINCT FROM 'cancelled'
    THEN
        RETURN false;
    END IF;

    fee := coalesce(b.cancellation_fee,0);
    deposit := coalesce(b.deposit_paid,0);

    IF fee <= 0
       OR deposit < 0
       OR fee::text IN ('NaN','Infinity','-Infinity')
       OR deposit::text IN ('NaN','Infinity','-Infinity')
    THEN
        RETURN false;
    END IF;

    IF NOT EXISTS (
        SELECT 1
        FROM public.journal_entries j
        WHERE j.id = _journal
          AND j.organization_id = _org
          AND j.branch_id IS NOT DISTINCT FROM b.branch_id
          AND j.source_document_id = _booking
          AND j.source_document_type =
              'event_cancellation:cancellation'
          AND j.status = 'posted'
          AND j.reversed_by_journal_id IS NULL
    ) THEN
        RETURN false;
    END IF;

    -- NEO_EVENT_DUPLICATE_JOURNAL_GUARD_V1

    IF (
        SELECT count(*)
        FROM public.journal_entries j
        WHERE j.organization_id = _org
          AND j.source_document_id = _booking
          AND j.source_document_type =
              'event_cancellation:cancellation'
          AND j.status = 'posted'
          AND j.reversed_by_journal_id IS NULL
    ) <> 1 THEN
        RETURN false;
    END IF;

    SELECT
        count(*),

        count(*) FILTER (
            WHERE a.id IS NULL
               OR l.debit IS NULL
               OR l.credit IS NULL
               OR l.debit < 0
               OR l.credit < 0
               OR l.debit::text IN (
                   'NaN','Infinity','-Infinity'
               )
               OR l.credit::text IN (
                   'NaN','Infinity','-Infinity'
               )
               OR (l.debit > 0 AND l.credit > 0)
        ),

        coalesce(sum(l.debit) FILTER (
            WHERE a.code = '2030'
        ),0),

        coalesce(sum(l.debit) FILTER (
            WHERE a.code = '1060'
        ),0),

        coalesce(sum(l.debit) FILTER (
            WHERE a.code NOT IN ('2030','1060')
        ),0),

        coalesce(sum(l.credit),0),

        coalesce(sum(l.credit) FILTER (
            WHERE a.code IS DISTINCT FROM
                public.neo_gl_revenue_code_scoped(
                    _org,'events',NULL
                )
        ),0)

    INTO
        line_count,
        invalid_lines,
        liability_debit,
        receivable_debit,
        other_debits,
        total_credit,
        prohibited_credits

    FROM public.journal_entry_lines l

    LEFT JOIN public.chart_of_accounts a
      ON a.id = l.account_id
     AND a.organization_id = _org

    WHERE l.journal_id = _journal
      AND l.organization_id = _org;

    RETURN
        line_count > 0
        AND invalid_lines = 0
        AND round(liability_debit,2) =
            round(least(deposit,fee),2)
        AND round(receivable_debit,2) =
            round(greatest(fee-deposit,0),2)
        AND other_debits = 0
        AND round(total_credit,2) = round(fee,2)
        AND prohibited_credits = 0;

END;
$function$;

REVOKE ALL ON FUNCTION
public.neo_event_cancellation_fee_journal_valid(
    uuid,uuid,uuid
)
FROM PUBLIC,anon,authenticated;


DO $refund_compatibility$
DECLARE
    d text;
    anchor text;
    replacement text;
BEGIN

    d := pg_get_functiondef(
        'public.neo_event_refund_available(uuid,uuid)'
        ::regprocedure
    );

    anchor := $anchor$
AND j.source_document_type IN (
              'event_earned:earned',
              'event_cancellation:cancellation',
              'event_deposit:deposit'
          )
$anchor$;

    -- Normalize whitespace only for locating the exact
    -- source-document condition.

    IF position(anchor IN d) = 0 THEN

        anchor := substring(
            d FROM
            'AND j[.]source_document_type IN [(][[:space:]]*''event_earned:earned'',[[:space:]]*''event_cancellation:cancellation'',[[:space:]]*''event_deposit:deposit''[[:space:]]*[)]'
        );

    END IF;

    IF anchor IS NULL OR length(anchor) = 0 THEN
        RAISE EXCEPTION
            'Event refund journal protection differs';
    END IF;

    IF (
        length(d) -
        length(replace(d,anchor,''))
    ) <> length(anchor) THEN
        RAISE EXCEPTION
            'Event journal protection is ambiguous';
    END IF;

    replacement := $patch$

AND (
    j.source_document_type IN (
        'event_earned:earned',
        'event_deposit:deposit'
    )

    OR (
        j.source_document_type =
            'event_cancellation:cancellation'

        AND public.neo_event_cancellation_fee_journal_valid(
            b.organization_id,
            b.id,
            j.id
        ) IS NOT TRUE
    )
)

$patch$;

    d := replace(d,anchor,replacement);

    EXECUTE d;

END;
$refund_compatibility$;


NOTIFY pgrst,'reload schema';

COMMIT;