BEGIN;

-- ============================================================
-- EVENT REFUND OBLIGATION ALLOCATION
-- ============================================================

CREATE OR REPLACE FUNCTION
public.neo_event_refund_available(
    _payment uuid,
    _exclude_request uuid DEFAULT NULL
)
RETURNS numeric
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO pg_catalog, public
AS $function$
DECLARE

    evidence jsonb;

    b public.event_bookings;

    obligation public.neo_event_refund_obligations;

    reserved numeric;

BEGIN

    evidence :=
        public.neo_event_refund_receipt_evidence(
            _payment
        );

    IF evidence->>'entry_type'
        IS DISTINCT FROM 'deposit'
    THEN

        RAISE EXCEPTION
            'Event balance payments require separate credit reconciliation';

    END IF;

    SELECT *
    INTO b
    FROM public.event_bookings
    WHERE id = (evidence->>'booking_id')::uuid
      AND organization_id = public.current_org_id()
    FOR UPDATE;

    IF NOT FOUND
       OR b.status IS DISTINCT FROM 'cancelled'
    THEN

        RAISE EXCEPTION
            'Event cancellation must be recorded before refund';

    END IF;

    SELECT *
    INTO obligation
    FROM public.neo_event_refund_obligations
    WHERE organization_id = b.organization_id
      AND booking_id = b.id
    FOR UPDATE;

    IF NOT FOUND

       OR obligation.branch_id
          IS DISTINCT FROM b.branch_id

       OR obligation.status
          IS DISTINCT FROM 'awaiting-settlement'

    THEN

        RAISE EXCEPTION
            'Event refund obligation is unavailable or requires review';

    END IF;

    -- Do not refund against an already released deposit
    -- liability or an unreconciled earned-event journal.

    IF EXISTS (

        SELECT 1

        FROM public.journal_entries j

        WHERE j.organization_id = b.organization_id

          AND j.source_document_id = b.id

          AND j.source_document_type IN (
              'event_earned:earned',
              'event_cancellation:cancellation',
              'event_deposit:deposit'
          )

          AND j.status = 'posted'

          AND j.reversed_by_journal_id IS NULL

    ) THEN

        RAISE EXCEPTION
            'Existing event recognition requires financial reconciliation';

    END IF;

    IF EXISTS (

        SELECT 1

        FROM public.cash_refund_requests r

        JOIN public.payments p
          ON p.id = r.payment_id
         AND p.organization_id = r.organization_id

        WHERE r.organization_id = b.organization_id

          AND p.source_module = 'events'

          AND p.source_record_id = b.id

          AND r.status = 'settled'

          AND public.neo_cash_refund_payment_valid(
              r.refund_payment_id
          ) IS NOT TRUE

    ) THEN

        RAISE EXCEPTION
            'Earlier event payout evidence requires reconciliation';

    END IF;

    SELECT coalesce(sum(r.amount),0)

    INTO reserved

    FROM public.cash_refund_requests r

    JOIN public.payments p
      ON p.id = r.payment_id
     AND p.organization_id = r.organization_id

    WHERE r.organization_id = b.organization_id

      AND p.source_module = 'events'

      AND p.source_record_id = b.id

      AND r.status IN (
          'pending_approval',
          'approved',
          'settled'
      )

      AND r.id IS DISTINCT FROM _exclude_request;

    IF reserved < 0

       OR reserved::text IN (
           'NaN','Infinity','-Infinity'
       )

       OR reserved > obligation.amount

    THEN

        RAISE EXCEPTION
            'Event refund reservations exceed verified obligation';

    END IF;

    RETURN obligation.amount - reserved;

END;
$function$;

REVOKE ALL ON FUNCTION
public.neo_event_refund_available(uuid,uuid)
FROM PUBLIC,anon,authenticated;


-- ============================================================
-- CONNECT EVENT RECEIPTS TO EXISTING RECEIPT LOCK
-- ============================================================

DO $migration$
DECLARE

    d text;

    anchor text :=
        'IF p.source_module=''delivery'' THEN';

BEGIN

    d := pg_get_functiondef(
        'public.neo_refund_receipt_lock(uuid)'
        ::regprocedure
    );

    IF position(anchor IN d) = 0 THEN

        RAISE EXCEPTION
            'Canonical receipt lock differs';

    END IF;

    d := replace(

        d,

        anchor,

$patch$

  IF p.source_module = 'events' THEN

   PERFORM 1

   FROM public.event_bookings b

   WHERE b.id = p.source_record_id

     AND b.organization_id = org

   FOR UPDATE;

   IF NOT FOUND THEN

    RAISE EXCEPTION
        'Original event booking unavailable';

   END IF;

   PERFORM public.neo_event_refund_receipt_evidence(
       p.id
   );

  END IF;

$patch$

        || anchor

    );

    EXECUTE d;

END;
$migration$;


-- ============================================================
-- EVENT REFUND RESERVATION LIMIT AND MANDATORY APPROVAL
-- ============================================================

DO $migration$
DECLARE

    d text;

    anchor text :=
        'needs:=_force_review OR _amount>threshold;';

BEGIN

    d := pg_get_functiondef(
        'public.neo_refund_reserve(uuid,numeric,text,text,uuid,boolean,uuid)'
        ::regprocedure
    );

    IF position(anchor IN d) = 0 THEN

        RAISE EXCEPTION
            'Canonical refund reservation differs';

    END IF;

    d := replace(

        d,

        anchor,

$patch$

 IF p->>'source_module' = 'events' THEN

  IF _amount > public.neo_event_refund_available(
      _payment,
      NULL
  ) THEN

   RAISE EXCEPTION
       'Refund exceeds the outstanding event cancellation obligation';

  END IF;

 END IF;

 needs :=
     _force_review

     OR _amount > threshold

     OR coalesce(
         p->>'source_module' = 'events',
         false
     );

$patch$

    );

    EXECUTE d;

END;
$migration$;


-- ============================================================
-- REUSE CONTROLLED REFUND SETTLEMENT
-- ============================================================

DO $migration$
DECLARE

    d text;

    target regprocedure;

    anchor text;

BEGIN

    SELECT p.oid::regprocedure

    INTO STRICT target

    FROM pg_proc p

    JOIN pg_namespace n
      ON n.oid = p.pronamespace

    WHERE n.nspname = 'public'

      AND p.proname = 'neo_refund_settle_internal';

    d := pg_get_functiondef(target);

    anchor := $anchor$
 ELSIF nullif(p->>'deposit_id','') IS NOT NULL THEN
$anchor$;

    IF position(btrim(anchor) IN d) = 0 THEN

        RAISE EXCEPTION
            'Original receipt journal validation differs';

    END IF;

    d := replace(

        d,

        btrim(anchor),

$patch$

 ELSIF p->>'source_module' = 'events' THEN

  PERFORM public.neo_event_refund_receipt_evidence(
      r.payment_id
  );

  IF r.amount > public.neo_event_refund_available(
      r.payment_id,
      r.id
  ) THEN

   RAISE EXCEPTION
       'Event refund exceeds its remaining obligation';

  END IF;

 ELSIF nullif(p->>'deposit_id','') IS NOT NULL THEN

$patch$

    );

    anchor := 'debit_code:=''1060'';';

    IF position(anchor IN d) = 0 THEN

        RAISE EXCEPTION
            'Refund debit account selection differs';

    END IF;

    -- Insert after the ordinary non-POS refund default,
    -- before the reservation-deposit override.

    anchor := $anchor$
  debit_code:='1060';
  IF nullif(p->>'deposit_id','') IS NOT NULL THEN
$anchor$;

    IF position(btrim(anchor) IN d) = 0 THEN

        RAISE EXCEPTION
            'Non-POS refund account baseline differs';

    END IF;

    d := replace(

        d,

        btrim(anchor),

$patch$

  debit_code := '1060';

  IF p->>'source_module' = 'events' THEN

   debit_code :=

       public.neo_event_refund_receipt_evidence(
           r.payment_id
       )->>'original_credit_code';

   IF debit_code IS DISTINCT FROM '2030' THEN

    RAISE EXCEPTION
        'Event refund requires verified deposit liability';

   END IF;

  END IF;

  IF nullif(p->>'deposit_id','') IS NOT NULL THEN

$patch$

    );

    anchor := $anchor$
 IF NOT public.neo_cash_refund_payment_valid(pay) THEN RAISE EXCEPTION 'Saved refund receipt and journal did not reconcile'; END IF;
$anchor$;

    IF position(btrim(anchor) IN d) = 0 THEN

        RAISE EXCEPTION
            'Final refund evidence integration differs';

    END IF;

    d := replace(

        d,

        btrim(anchor),

        btrim(anchor) ||

$patch$

 IF p->>'source_module' = 'events' THEN

  PERFORM public.neo_reconcile_event_refund_obligation(
      r.payment_id
  );

 END IF;

$patch$

    );

    EXECUTE d;

END;
$migration$;


-- ============================================================
-- RECONCILE ACTUAL PAYOUTS AGAINST THE EVENT OBLIGATION
-- ============================================================

CREATE OR REPLACE FUNCTION
public.neo_reconcile_event_refund_obligation(
    _payment uuid
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO pg_catalog, public
AS $function$
DECLARE

    evidence jsonb;

    obligation public.neo_event_refund_obligations;

    settled numeric;

BEGIN

    evidence :=
        public.neo_event_refund_receipt_evidence(
            _payment
        );

    SELECT *
    INTO obligation

    FROM public.neo_event_refund_obligations

    WHERE organization_id = public.current_org_id()

      AND booking_id =
          (evidence->>'booking_id')::uuid

    FOR UPDATE;

    IF NOT FOUND THEN

        RAISE EXCEPTION
            'Original event refund obligation unavailable';

    END IF;

    IF EXISTS (

        SELECT 1

        FROM public.cash_refund_requests r

        JOIN public.payments p
          ON p.id = r.payment_id
         AND p.organization_id = r.organization_id

        WHERE r.organization_id =
              obligation.organization_id

          AND p.source_module = 'events'

          AND p.source_record_id =
              obligation.booking_id

          AND r.status = 'settled'

          AND public.neo_cash_refund_payment_valid(
              r.refund_payment_id
          ) IS NOT TRUE

    ) THEN

        RAISE EXCEPTION
            'Event refund payout evidence did not reconcile';

    END IF;

    SELECT coalesce(sum(r.amount),0)

    INTO settled

    FROM public.cash_refund_requests r

    JOIN public.payments p
      ON p.id = r.payment_id
     AND p.organization_id = r.organization_id

    WHERE r.organization_id =
          obligation.organization_id

      AND p.source_module = 'events'

      AND p.source_record_id =
          obligation.booking_id

      AND r.status = 'settled';

    IF settled > obligation.amount

       OR settled < 0

       OR settled::text IN (
           'NaN','Infinity','-Infinity'
       )

    THEN

        RAISE EXCEPTION
            'Event refund settlement exceeds obligation';

    END IF;

    IF settled = obligation.amount THEN

        UPDATE public.neo_event_refund_obligations

        SET status = 'settled'

        WHERE id = obligation.id

          AND organization_id =
              obligation.organization_id;

    END IF;

END;
$function$;

REVOKE ALL ON FUNCTION
public.neo_reconcile_event_refund_obligation(uuid)
FROM PUBLIC,anon,authenticated;

COMMIT;