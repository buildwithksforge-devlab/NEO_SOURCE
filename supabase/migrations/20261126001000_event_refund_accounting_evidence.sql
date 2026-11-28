BEGIN;

CREATE OR REPLACE FUNCTION
public.neo_event_refund_receipt_evidence(
    _payment uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO pg_catalog, public
AS $function$
DECLARE

    p public.payments;

    ep public.event_payments;

    b public.event_bookings;

    v_code text;

    v_count integer;

BEGIN

    SELECT *
    INTO p

    FROM public.payments

    WHERE id = _payment

      AND organization_id =
          public.current_org_id()

      AND source_module = 'events';

    IF NOT FOUND THEN

        RAISE EXCEPTION
            'Original event receipt unavailable';

    END IF;

    SELECT *
    INTO b

    FROM public.event_bookings

    WHERE id = p.source_record_id

      AND organization_id = p.organization_id

    FOR UPDATE;

    IF NOT FOUND

       OR auth.uid() IS NULL

       OR public.current_access_scope() IS NULL

       OR public.current_access_scope() = 'technical'

       OR public.neo_branch_in_scope(
           p.branch_id
       ) IS NOT TRUE

    THEN

        RAISE EXCEPTION
            'Event refund outside authorised scope'

            USING ERRCODE = '42501';

    END IF;

    IF b.branch_id IS DISTINCT FROM p.branch_id

       OR p.status IS DISTINCT FROM 'confirmed'

       OR p.amount IS NULL

       OR p.amount <= 0

       OR p.amount::text IN (
           'NaN','Infinity','-Infinity'
       )

       OR p.posted_journal_id IS NULL

    THEN

        RAISE EXCEPTION
            'Original event receipt evidence is incomplete';

    END IF;

    SELECT count(*)
    INTO v_count

    FROM public.event_payments

    WHERE organization_id = p.organization_id

      AND payment_id = p.id;

    IF v_count <> 1 THEN

        RAISE EXCEPTION
            'Event receipt must have one unambiguous billing entry';

    END IF;

    SELECT *
    INTO ep

    FROM public.event_payments

    WHERE organization_id = p.organization_id

      AND payment_id = p.id;

    IF ep.booking_id IS DISTINCT FROM b.id

       OR ep.branch_id IS DISTINCT FROM b.branch_id

       OR ep.currency IS DISTINCT FROM p.currency

       OR ep.amount IS DISTINCT FROM p.amount

       OR ep.entry_type NOT IN (
           'deposit','payment'
       )

    THEN

        RAISE EXCEPTION
            'Event billing and receipt evidence differs';

    END IF;

    IF public.neo_connection_journal_matches(

        p.posted_journal_id,

        p.organization_id,

        p.branch_id,

        p.currency,

        p.amount,

        'event_payment',

        ep.id

    ) IS NOT TRUE THEN

        RAISE EXCEPTION
            'Original event receipt journal needs reconciliation';

    END IF;

    v_code := CASE

        WHEN ep.entry_type = 'deposit'
        THEN '2030'

        ELSE '1060'

    END;

    IF (

        SELECT coalesce(sum(l.credit),0)

        FROM public.journal_entry_lines l

        JOIN public.chart_of_accounts a
          ON a.id = l.account_id
         AND a.organization_id = p.organization_id

        WHERE l.journal_id = p.posted_journal_id

          AND l.organization_id = p.organization_id

          AND l.branch_id IS NOT DISTINCT FROM p.branch_id

          AND a.code = v_code

    ) IS DISTINCT FROM p.amount THEN

        RAISE EXCEPTION
            'Original event journal account allocation differs';

    END IF;

    RETURN jsonb_build_object(

        'status','validated',

        'payment_id',p.id,

        'booking_id',b.id,

        'event_payment_id',ep.id,

        'journal_id',p.posted_journal_id,

        'entry_type',ep.entry_type,

        'original_credit_code',v_code,

        'amount',p.amount,

        'currency',p.currency,

        'branch_id',p.branch_id

    );

END;
$function$;

REVOKE ALL ON FUNCTION
public.neo_event_refund_receipt_evidence(uuid)
FROM PUBLIC,anon,authenticated;

COMMIT;