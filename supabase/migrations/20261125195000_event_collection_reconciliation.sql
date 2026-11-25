BEGIN;

CREATE OR REPLACE FUNCTION
public.neo_event_collection_posting_evidence(
    _organization uuid,
    _booking uuid
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'pg_catalog','public'
AS $function$
DECLARE
    b public.event_bookings;
    v_count integer;
    v_verified integer;
    v_deposits numeric;
    v_posted numeric;
BEGIN

    IF public.current_org_id()
       IS DISTINCT FROM _organization
    THEN
        RAISE EXCEPTION 'organisation_out_of_scope'
            USING ERRCODE = '42501';
    END IF;

    SELECT e.* INTO b
    FROM public.event_bookings e
    WHERE e.organization_id = _organization
      AND e.id = _booking
      AND public.neo_branch_in_scope(e.branch_id)
          IS TRUE;

    IF b.id IS NULL THEN
        RAISE EXCEPTION 'event_out_of_scope'
            USING ERRCODE = '42501';
    END IF;

    WITH evidence AS (
        SELECT
            ep.id,
            ep.amount,

            EXISTS (
                SELECT 1
                FROM public.payments p

                JOIN public.journal_entries j
                  ON j.id = p.posted_journal_id
                 AND j.organization_id =
                     p.organization_id

                WHERE p.id = ep.payment_id
                  AND p.organization_id =
                      _organization
                  AND p.branch_id IS NOT DISTINCT FROM
                      b.branch_id
                  AND p.source_module = 'events'
                  AND p.source_record_id = b.id
                  AND p.status IN (
                      'confirmed','completed','paid',
                      'succeeded','captured'
                  )
                  AND p.amount = ep.amount
                  AND j.branch_id IS NOT DISTINCT FROM
                      b.branch_id
                  AND j.source_document_type =
                      'event_payment'
                  AND j.source_document_id = ep.id
                  AND j.status = 'posted'
                  AND j.reversed_by_journal_id IS NULL

                  AND (
                      SELECT coalesce(
                          sum(l.credit-l.debit),0
                      )
                      FROM public.journal_entry_lines l
                      JOIN public.chart_of_accounts a
                        ON a.id = l.account_id
                       AND a.organization_id =
                           _organization
                      WHERE l.journal_id = j.id
                        AND l.organization_id =
                            _organization
                        AND a.code = '2030'
                  ) = ep.amount

                  AND (
                      SELECT coalesce(
                          sum(l.debit-l.credit),0
                      )
                      FROM public.journal_entry_lines l
                      JOIN public.chart_of_accounts a
                        ON a.id = l.account_id
                       AND a.organization_id =
                           _organization
                      WHERE l.journal_id = j.id
                        AND l.organization_id =
                            _organization
                        AND a.code =
                            public.neo_gl_account_code(
                                p.organization_id,
                                p.method,
                                p.destination_account_id
                            )
                  ) = ep.amount

            ) AS verified

        FROM public.event_payments ep
        WHERE ep.organization_id = _organization
          AND ep.booking_id = _booking
          AND ep.branch_id IS NOT DISTINCT FROM
              b.branch_id
          AND ep.entry_type = 'deposit'
          AND ep.amount > 0
    )

    SELECT
        count(*)::integer,
        count(*) FILTER (
            WHERE verified
        )::integer,
        coalesce(sum(amount),0),
        coalesce(sum(amount) FILTER (
            WHERE verified
        ),0)

    INTO
        v_count,
        v_verified,
        v_deposits,
        v_posted

    FROM evidence;

    RETURN jsonb_build_object(
        'booking_id',b.id,
        'deposit_entries',v_count,
        'verified_entries',v_verified,
        'recorded_deposits',v_deposits,
        'posted_deposits',v_posted,
        'booking_deposit_balance',b.deposit_paid,
        'fully_posted',
            v_count > 0
            AND v_count = v_verified
            AND v_deposits = v_posted
            AND v_deposits =
                coalesce(b.deposit_paid,0)
    );

END;
$function$;

REVOKE ALL ON FUNCTION
public.neo_event_collection_posting_evidence(uuid,uuid)
FROM PUBLIC,anon,authenticated;


-- Never duplicate an individually accounted event collection.

CREATE OR REPLACE FUNCTION
public.neo_guard_duplicate_event_collection()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog','public'
AS $function$
BEGIN

    IF NEW.source_document_type IS DISTINCT FROM
       'event_deposit:deposit'
       OR NEW.status IS DISTINCT FROM 'posted'
    THEN
        RETURN NEW;
    END IF;

    IF TG_OP = 'UPDATE' THEN
        IF OLD.status = 'posted' THEN
            RETURN NEW;
        END IF;
    END IF;

    IF EXISTS (
        SELECT 1
        FROM public.event_payments ep
        JOIN public.payments p
          ON p.id = ep.payment_id
         AND p.organization_id =
             ep.organization_id
        JOIN public.journal_entries j
          ON j.id = p.posted_journal_id
         AND j.organization_id =
             p.organization_id
        WHERE ep.organization_id =
              NEW.organization_id
          AND ep.booking_id =
              NEW.source_document_id
          AND ep.entry_type = 'deposit'
          AND j.status = 'posted'
          AND j.reversed_by_journal_id IS NULL
    ) THEN

        RAISE EXCEPTION
            'Aggregate event deposit posting conflicts with individual receipt accounting';

    END IF;

    RETURN NEW;

END;
$function$;

CREATE TRIGGER neo_event_duplicate_collection_guard
BEFORE INSERT OR UPDATE OF status
ON public.journal_entries
FOR EACH ROW
EXECUTE FUNCTION
public.neo_guard_duplicate_event_collection();

REVOKE ALL ON FUNCTION
public.neo_guard_duplicate_event_collection()
FROM PUBLIC,anon,authenticated;


-- Return existing accounting evidence instead of reposting
-- event deposits already accounted for by individual receipts.

DO $migration$
DECLARE
    d text;
    anchor text :=
        'ELSIF _source_type = ''event_deposit'' THEN';
BEGIN

    d := pg_get_functiondef(
        'public.neo_finance_post_txn(text,uuid,boolean)'
        ::regprocedure
    );

    IF (
        length(d)-length(replace(d,anchor,''))
    ) / length(anchor) <> 1 THEN
        RAISE EXCEPTION
            'Event deposit reconciliation anchor missing';
    END IF;

    d := replace(
        d,
        anchor,
        $patch$
ELSIF _source_type = 'event_deposit' THEN

    IF EXISTS (
        SELECT 1
        FROM public.event_payments ep
        WHERE ep.organization_id = org
          AND ep.booking_id = _source_id
          AND ep.entry_type = 'deposit'
    ) THEN

        IF (
            public.neo_event_collection_posting_evidence(
                org,_source_id
            )->>'fully_posted'
        )::boolean IS TRUE THEN

            RETURN jsonb_build_object(
                'ok',true,
                'reason','already_posted_individually',
                'duplicate_prevented',true,
                'evidence',
                    public.neo_event_collection_posting_evidence(
                        org,_source_id
                    )
            );

        ELSE

            RETURN jsonb_build_object(
                'ok',false,
                'reason','event_collection_reconciliation_required',
                'detail',
                    'Individual event deposits must be reconciled before aggregate posting.'
            );

        END IF;

    END IF;

$patch$
    );

    EXECUTE d;

END;
$migration$;

COMMIT;