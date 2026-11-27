BEGIN;

DO $migration$
DECLARE

    d text;

    anchor text :=
        'IF existing.status=''posted'' THEN';

BEGIN

    d := pg_get_functiondef(
        'public.neo_gl_post(uuid,uuid,text,text,uuid,text,date,text,text,jsonb,uuid,uuid)'
        ::regprocedure
    );

    IF position(anchor IN d) = 0

       OR position(
           'Existing draft lines differ from the requested posting'
           IN d
       ) = 0

    THEN

        RAISE EXCEPTION
            'Canonical journal posting function differs';

    END IF;

    d := replace(

        d,

        anchor,

$patch$

    -- neo_posted_journal_replay_evidence_v1

    IF EXISTS (

        WITH wanted AS (

            SELECT

                requested.value->>'code' AS code,

                sum(
                    round(
                        coalesce(
                            (requested.value->>'debit')::numeric,
                            0
                        ),
                        2
                    )
                ) AS debit,

                sum(
                    round(
                        coalesce(
                            (requested.value->>'credit')::numeric,
                            0
                        ),
                        2
                    )
                ) AS credit

            FROM jsonb_array_elements(_lines)
                AS requested(value)

            GROUP BY 1

        ),

        actual AS (

            SELECT

                a.code,

                sum(l.debit) AS debit,

                sum(l.credit) AS credit

            FROM public.journal_entry_lines l

            JOIN public.chart_of_accounts a
              ON a.id = l.account_id

            WHERE l.journal_id = j

            GROUP BY a.code

        )

        SELECT 1

        FROM wanted w

        FULL JOIN actual a
          ON a.code = w.code

        WHERE coalesce(w.debit,0)
              <> coalesce(a.debit,0)

           OR coalesce(w.credit,0)
              <> coalesce(a.credit,0)

    ) THEN

        RAISE EXCEPTION
            'Existing journal accounting differs from the requested posting; reconciliation is required'

            USING ERRCODE = '23514';

    END IF;

    IF EXISTS (

        SELECT 1

        FROM public.journal_entry_lines l

        WHERE l.journal_id = j

          AND (

              l.organization_id IS DISTINCT FROM _org

              OR l.branch_id IS DISTINCT FROM _branch

              OR l.customer_id IS DISTINCT FROM _customer

              OR l.debit::text IN (
                  'NaN','Infinity','-Infinity'
              )

              OR l.credit::text IN (
                  'NaN','Infinity','-Infinity'
              )

          )

    ) THEN

        RAISE EXCEPTION
            'Existing journal property, customer or amount evidence differs'

            USING ERRCODE = '23514';

    END IF;

$patch$

        || anchor

    );

    EXECUTE d;

END;
$migration$;

COMMIT;