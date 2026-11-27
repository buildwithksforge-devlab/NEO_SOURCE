BEGIN;

CREATE OR REPLACE FUNCTION
public.neo_cashier_personal_collection_history(
    _branch uuid,
    _from timestamptz,
    _to timestamptz
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path TO pg_catalog,public
AS $function$
DECLARE
    actor uuid := auth.uid();

    org uuid := public.current_org_id();

    result jsonb;

    attribution_column text;

BEGIN

    IF actor IS NULL
       OR org IS NULL
       OR _branch IS NULL
       OR public.current_access_scope() IS NULL
       OR public.current_access_scope() = 'technical'
       OR public.neo_branch_in_scope(_branch) IS NOT TRUE
    THEN

        RAISE EXCEPTION
            'Authorized cashier property required'
            USING ERRCODE='42501';

    END IF;

    IF _from IS NULL
       OR _to IS NULL
       OR _from >= _to
       OR _to - _from > interval '366 days'
    THEN

        RAISE EXCEPTION
            'Choose a valid collection period of up to 366 days';

    END IF;

    -- Require explicit collector attribution.
    -- Do not assume that the record creator,
    -- waiter or approver collected the payment.

    SELECT a.attname INTO attribution_column

    FROM pg_attribute a

    WHERE a.attrelid = 'public.payments'::regclass

      AND a.attname IN (
          'received_by'
      )

      AND a.atttypid = 'uuid'::regtype

      AND NOT a.attisdropped

    ORDER BY a.attname

    LIMIT 1;

    IF attribution_column IS NULL THEN

        RAISE EXCEPTION
            'Canonical payment collector attribution requires integration';

    END IF;

    EXECUTE format(
        $query$

        SELECT coalesce(

            jsonb_agg(

                jsonb_build_object(

                    'id',p.id,

                    'amount',p.amount,

                    'currency',to_jsonb(p)->>'currency',

                    'method',p.method,

                    'status',p.status,

                    'created_at',coalesce(p.paid_at,p.created_at),

                    'source_module',p.source_module,

                    'source_record_id',p.source_record_id,

                    'reference',
                        coalesce(
                            to_jsonb(p)->>'receipt_number',
                            to_jsonb(p)->>'external_reference',
                            to_jsonb(p)->>'reference'
                        )

                )

                ORDER BY coalesce(p.paid_at,p.created_at) DESC,p.id

            ),

            '[]'::jsonb

        )

        FROM public.payments p

        WHERE p.organization_id = $1

          AND p.branch_id = $2

          AND p.%I = $3

          AND coalesce(p.paid_at,p.created_at) >= $4

          AND coalesce(p.paid_at,p.created_at) < $5

        $query$,

        attribution_column

    )

    INTO result

    USING org,_branch,actor,_from,_to;

    RETURN result;

END;
$function$;

REVOKE ALL ON FUNCTION
public.neo_cashier_personal_collection_history(
    uuid,timestamptz,timestamptz
)
FROM PUBLIC,anon;

GRANT EXECUTE ON FUNCTION
public.neo_cashier_personal_collection_history(
    uuid,timestamptz,timestamptz
)
TO authenticated;

NOTIFY pgrst,'reload schema';

COMMIT;