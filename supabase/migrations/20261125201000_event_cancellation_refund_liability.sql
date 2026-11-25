BEGIN;

CREATE TABLE IF NOT EXISTS public.neo_event_refund_obligations (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id uuid NOT NULL,
    branch_id uuid,
    booking_id uuid NOT NULL
        REFERENCES public.event_bookings(id),
    amount numeric NOT NULL CHECK (
        amount > 0
        AND amount::text NOT IN (
            'NaN','Infinity','-Infinity'
        )
    ),
    status text NOT NULL DEFAULT 'awaiting-settlement'
        CHECK (
            status IN (
                'awaiting-settlement',
                'settlement-review-required',
                'settled'
            )
        ),
    created_at timestamptz NOT NULL DEFAULT now(),
    created_by uuid,
    UNIQUE (organization_id,booking_id)
);

ALTER TABLE public.neo_event_refund_obligations
ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.neo_event_refund_obligations
FROM PUBLIC,anon,authenticated;


CREATE FUNCTION public.neo_record_event_refund_obligation(
    _organization uuid,
    _booking uuid,
    _amount numeric
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog','public'
AS $function$
DECLARE
    b public.event_bookings;
    v_id uuid;
    v_amount numeric;
BEGIN

    IF auth.uid() IS NULL
       OR public.current_org_id()
           IS DISTINCT FROM _organization
    THEN
        RAISE EXCEPTION 'Event refund outside authorised scope'
            USING ERRCODE = '42501';
    END IF;

    SELECT *
    INTO b
    FROM public.event_bookings
    WHERE id = _booking
      AND organization_id = _organization
    FOR UPDATE;

    IF NOT FOUND
       OR public.neo_branch_in_scope(b.branch_id)
           IS NOT TRUE
    THEN
        RAISE EXCEPTION 'Event unavailable'
            USING ERRCODE = '42501';
    END IF;

    IF b.status IS DISTINCT FROM 'cancelled' THEN
        RAISE EXCEPTION 'Event has not been cancelled';
    END IF;

    IF _amount IS NULL
       OR _amount <= 0
       OR _amount::text IN (
           'NaN','Infinity','-Infinity'
       )
    THEN
        RAISE EXCEPTION 'Invalid refund obligation';
    END IF;

    IF round(_amount,2) <= 0
       OR round(_amount,2) >
           round(coalesce(b.deposit_paid,0),2)
    THEN
        RAISE EXCEPTION
            'Refund obligation exceeds recorded deposit position';
    END IF;

    INSERT INTO public.neo_event_refund_obligations (
        organization_id,
        branch_id,
        booking_id,
        amount,
        created_by
    )
    VALUES (
        _organization,
        b.branch_id,
        b.id,
        round(_amount,2),
        auth.uid()
    )
    ON CONFLICT (organization_id,booking_id)
    DO NOTHING;

    SELECT id,amount
    INTO v_id,v_amount
    FROM public.neo_event_refund_obligations
    WHERE organization_id = _organization
      AND booking_id = b.id;

    IF v_amount IS DISTINCT FROM round(_amount,2) THEN
        RAISE EXCEPTION
            'Existing refund obligation requires reconciliation';
    END IF;

    RETURN v_id;

END;
$function$;

REVOKE ALL ON FUNCTION
public.neo_record_event_refund_obligation(uuid,uuid,numeric)
FROM PUBLIC,anon,authenticated;


-- Preserve existing event recognition logic.
-- Record the refundable amount without claiming cash has left.

DO $migration$
DECLARE
    d text;
    anchor text :=
        'remainder := greatest(paid - amount, 0);';
BEGIN

    d := pg_get_functiondef(
        'public.neo_finance_post_txn(text,uuid,boolean)'
        ::regprocedure
    );

    IF (
        length(d)-length(replace(d,anchor,''))
    ) / length(anchor) <> 1 THEN
        RAISE EXCEPTION
            'Event cancellation refund anchor missing';
    END IF;

    d := replace(
        d,
        anchor,
        $patch$
        remainder := greatest(paid - amount, 0);

        IF remainder > 0 THEN

            PERFORM public.neo_record_event_refund_obligation(
                org,ev.id,remainder
            );

            RETURN jsonb_build_object(
                'ok',false,
                'reason','refund_settlement_required',
                'refund_obligation_recorded',true,
                'refund_amount',remainder,
                'detail',
                    'Cancellation requires controlled financial settlement.'
            );

        END IF;
$patch$
    );

    -- Move the original earned-revenue reversal below
    -- the refund obligation decision.

    IF strpos(
        d,
        'PERFORM public.neo_finance_reverse_posting(''event_earned'', ev.id, ''earned'', ''Event cancelled'');'
    ) = 0 THEN

        RAISE EXCEPTION
            'Original cancellation reversal anchor missing';

    END IF;

    d := replace(
        d,
        'PERFORM public.neo_finance_reverse_posting(''event_earned'', ev.id, ''earned'', ''Event cancelled'');',
        ''
    );

    d := replace(
        d,
        'IF amount = 0 AND remainder = 0 THEN',
        'PERFORM public.neo_finance_reverse_posting(''event_earned'', ev.id, ''earned'', ''Event cancelled'');'
        || E'\n        IF amount = 0 AND remainder = 0 THEN'
    );

    EXECUTE d;

END;
$migration$;

COMMIT;