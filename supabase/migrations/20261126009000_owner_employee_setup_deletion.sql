BEGIN;

CREATE OR REPLACE FUNCTION
public.neo_hr_delete_employee_setup(
    _org uuid,
    _employee uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO pg_catalog,public
AS $function$
DECLARE
    actor uuid := auth.uid();

    e public.employees;

    table_name text;

    relation_id regclass;

    removed_count bigint;

    result jsonb := '{}'::jsonb;

BEGIN

    IF actor IS NULL

       OR public.current_org_id()
          IS DISTINCT FROM _org

       OR public.current_access_scope() IS NULL

       OR public.current_access_scope() = 'technical'

    THEN

        RAISE EXCEPTION
            'Authorized Owner access is required'
            USING ERRCODE = '42501';

    END IF;

    IF NOT EXISTS (

        SELECT 1

        FROM public.user_roles ur

        JOIN public.roles r
          ON r.id = ur.role_id

        JOIN public.profiles p
          ON p.id = ur.user_id

        WHERE ur.user_id = actor

          AND ur.organization_id = _org

          AND r.organization_id = _org

          AND p.organization_id = _org

          AND p.account_status = 'active'

          AND r.active IS TRUE

          AND coalesce(r.role_status,'active')
              <> 'archived'

          AND coalesce(
              r.normalized_role_key,
              public.neo_norm_key(r.name)
          ) = 'owner'

    ) THEN

        RAISE EXCEPTION
            'Only an active Owner may permanently remove employee setup'
            USING ERRCODE = '42501';

    END IF;

    SELECT *
    INTO e

    FROM public.employees

    WHERE id = _employee

      AND organization_id = _org

    FOR UPDATE;

    IF NOT FOUND THEN

        RAISE EXCEPTION
            'Employee record is unavailable';

    END IF;

    IF e.branch_id IS NOT NULL

       AND public.neo_branch_in_scope(
           e.branch_id
       ) IS NOT TRUE

    THEN

        RAISE EXCEPTION
            'Employee belongs to another property'
            USING ERRCODE = '42501';

    END IF;

    IF e.profile_id = actor THEN

        RAISE EXCEPTION
            'Owner cannot permanently remove their own employee record';

    END IF;

    -- Explicitly allowlisted employee setup data.
    -- No dynamic deletion of unknown financial,
    -- payroll or operational transaction tables.

    FOREACH table_name IN ARRAY ARRAY[

        'employee_identifiers',

        'employee_emergency_contacts',

        'employee_payment_details',

        'employee_compensation',

        'employee_branch_assignments'

    ]

    LOOP

        relation_id := to_regclass(
            format('public.%I',table_name)
        );

        IF relation_id IS NULL THEN

            CONTINUE;

        END IF;

        IF NOT EXISTS (

            SELECT 1

            FROM pg_attribute

            WHERE attrelid = relation_id

              AND attname = 'employee_id'

              AND NOT attisdropped

        ) THEN

            RAISE EXCEPTION
                'Employee setup table % requires explicit reconciliation',
                table_name;

        END IF;

        IF NOT EXISTS (

            SELECT 1

            FROM pg_attribute

            WHERE attrelid = relation_id

              AND attname = 'organization_id'

              AND NOT attisdropped

        ) THEN

            RAISE EXCEPTION
                'Employee setup table % lacks verified organization scope',
                table_name;

        END IF;

        EXECUTE format(

            'DELETE FROM public.%I
             WHERE employee_id = $1
             AND organization_id = $2',

            table_name

        )

        USING _employee,_org;

        GET DIAGNOSTICS removed_count = ROW_COUNT;

        result := result || jsonb_build_object(

            table_name,

            removed_count

        );

    END LOOP;

    RETURN result;

END;
$function$;


REVOKE ALL ON FUNCTION
public.neo_hr_delete_employee_setup(uuid,uuid)
FROM PUBLIC,anon,authenticated;


DO $employee_deletion$
DECLARE

    d text;

    anchor text;

    replacement text;

BEGIN

    d := pg_get_functiondef(

        'public.neo_hr_delete_incorrect_employee(uuid,text,text)'

        ::regprocedure

    );

    anchor := substring(

        d FROM

        'FOR ref IN[[:space:]]*'

    );

    IF anchor IS NULL THEN

        RAISE EXCEPTION
            'Existing employee dependency scan differs';

    END IF;

    IF (

        length(d) -

        length(replace(d,anchor,''))

    ) <> length(anchor) THEN

        RAISE EXCEPTION
            'Employee dependency scan is ambiguous';

    END IF;

    replacement :=

        'PERFORM public.neo_hr_delete_employee_setup(org,e.id);'

        || E'\n\n    '

        || anchor;

    d := replace(

        d,

        anchor,

        replacement

    );

    EXECUTE d;

END;
$employee_deletion$;


NOTIFY pgrst,'reload schema';

COMMIT;