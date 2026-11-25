BEGIN;

CREATE FUNCTION public.neo_event_deposit_settlement_lines(
    _organization uuid,
    _event uuid,
    _amount numeric
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog','public'
AS $function$
DECLARE
    v_lines jsonb;
    v_total numeric;
    v_unresolved integer;
BEGIN

    IF public.current_org_id()
        IS DISTINCT FROM _organization
    THEN
        RAISE EXCEPTION 'organisation_out_of_scope'
            USING ERRCODE = '42501';
    END IF;

    IF NOT EXISTS (
        SELECT 1
        FROM public.event_bookings e
        WHERE e.id = _event
          AND e.organization_id = _organization
          AND public.neo_branch_in_scope(e.branch_id) IS TRUE
    ) THEN
        RAISE EXCEPTION 'event_out_of_scope'
            USING ERRCODE = '42501';
    END IF;

    IF _amount IS NULL
       OR _amount <= 0
       OR _amount::text IN (
           'NaN','Infinity','-Infinity'
       )
    THEN
        RAISE EXCEPTION 'invalid_event_deposit_amount';
    END IF;

    WITH payment_evidence AS (
        SELECT
            p.amount,
            public.neo_gl_account_code(
                p.organization_id,
                p.method,
                p.destination_account_id
            ) AS account_code

        FROM public.payments p

        WHERE p.organization_id = _organization
          AND p.source_module = 'events'
          AND p.source_record_id = _event
          AND p.status IN (
              'confirmed','completed','paid',
              'succeeded','captured'
          )
    ),
    grouped AS (
        SELECT
            account_code,
            sum(amount) AS amount

        FROM payment_evidence

        WHERE account_code IS NOT NULL
          AND btrim(account_code) <> ''
          AND amount > 0
          AND amount::text NOT IN (
              'NaN','Infinity','-Infinity'
          )

        GROUP BY account_code
    )

    SELECT
        (
            SELECT coalesce(sum(amount),0)
            FROM grouped
        ),
        (
            SELECT count(*)
            FROM payment_evidence
            WHERE account_code IS NULL
               OR btrim(account_code) = ''
               OR amount IS NULL
               OR amount <= 0
               OR amount::text IN (
                   'NaN','Infinity','-Infinity'
               )
        ),
        (
            SELECT coalesce(
                jsonb_agg(
                    jsonb_build_object(
                        'code',account_code,
                        'debit',round(amount,2),
                        'description',
                            'Confirmed event deposit settlement'
                    )
                    ORDER BY account_code
                ),
                '[]'::jsonb
            )
            FROM grouped
        )

    INTO v_total,v_unresolved,v_lines;

    IF v_unresolved > 0
       OR round(v_total,2) <> round(_amount,2)
       OR jsonb_array_length(v_lines) = 0
    THEN
        RAISE EXCEPTION
            'Event deposit payment evidence requires reconciliation';
    END IF;

    IF (
        SELECT sum((x->>'debit')::numeric)
        FROM jsonb_array_elements(v_lines) x
    ) <> round(_amount,2)
    THEN
        RAISE EXCEPTION
            'Event settlement rounding requires reconciliation';
    END IF;

    RETURN v_lines || jsonb_build_array(
        jsonb_build_object(
            'code','2030',
            'credit',round(_amount,2),
            'description','Event deposit liability'
        )
    );

END;
$function$;

REVOKE ALL ON FUNCTION
public.neo_event_deposit_settlement_lines(uuid,uuid,numeric)
FROM PUBLIC,anon,authenticated;


-- Preserve the installed finance posting routine.
-- Replace only the event deposit settlement construction.

DO $migration$
DECLARE
    d text;
    v_start integer;
    v_finish integer;
    v_section text;
    v_lines integer;
BEGIN

    d := pg_get_functiondef(
        'public.neo_finance_post_txn(text,uuid,boolean)'
        ::regprocedure
    );

    v_start := strpos(
        d,
        'ELSIF _source_type = ''event_deposit'' THEN'
    );

    v_finish := strpos(
        d,
        'ELSIF _source_type = ''event_invoice'' THEN'
    );

    IF v_start = 0 OR v_finish <= v_start THEN
        RAISE EXCEPTION
            'Event deposit posting integration point missing';
    END IF;

    v_section := substring(
        d FROM v_start FOR v_finish - v_start
    );

    v_lines := strpos(v_section,'lines := jsonb_build_array(');

    IF v_lines = 0 THEN
        RAISE EXCEPTION
            'Event deposit journal construction requires review';
    END IF;

    d :=
        substring(d FROM 1 FOR v_start - 1)
        ||
        substring(v_section FROM 1 FOR v_lines - 1)
        ||
        $replacement$
        lines := public.neo_event_deposit_settlement_lines(
            org,ev.id,amount
        );

$replacement$
        ||
        substring(d FROM v_finish);

    EXECUTE d;

END;
$migration$;


-- Replace the single-account restriction with
-- exact settlement account and amount reconciliation.

DO $migration$
DECLARE
    d text;
    anchor text := $old$
    IF v_accounts <> 1 THEN
        RAISE EXCEPTION
            'Mixed or unresolved event settlement accounts require allocation review';
    END IF;
$old$;
BEGIN

    d := pg_get_functiondef(
        'public.neo_guard_event_deposit_allocation()'
        ::regprocedure
    );

    IF strpos(d,btrim(anchor)) = 0 THEN
        RAISE EXCEPTION
            'Event settlement guard integration point missing';
    END IF;

    d := replace(
        d,
        btrim(anchor),
        $new$
        IF EXISTS (
            WITH expected AS (
                SELECT
                    x->>'code' AS code,
                    sum(
                        coalesce(
                            (x->>'debit')::numeric,0
                        )
                    ) AS debit,
                    sum(
                        coalesce(
                            (x->>'credit')::numeric,0
                        )
                    ) AS credit

                FROM jsonb_array_elements(
                    public.neo_event_deposit_settlement_lines(
                        NEW.organization_id,
                        v_event.id,
                        v_deposited
                    )
                ) x

                GROUP BY x->>'code'
            ),
            actual AS (
                SELECT
                    a.code,
                    sum(l.debit) AS debit,
                    sum(l.credit) AS credit

                FROM public.journal_entry_lines l

                JOIN public.chart_of_accounts a
                  ON a.id = l.account_id
                 AND a.organization_id =
                     NEW.organization_id

                WHERE l.journal_id = NEW.id
                  AND l.organization_id =
                      NEW.organization_id

                GROUP BY a.code
            )

            SELECT 1
            FROM expected e
            FULL JOIN actual a USING (code)
            WHERE coalesce(e.debit,0)
                  <> coalesce(a.debit,0)
               OR coalesce(e.credit,0)
                  <> coalesce(a.credit,0)
        ) THEN

            RAISE EXCEPTION
                'Event deposit journal does not match confirmed settlement allocations';

        END IF;
$new$
    );

    EXECUTE d;

END;
$migration$;

COMMIT;