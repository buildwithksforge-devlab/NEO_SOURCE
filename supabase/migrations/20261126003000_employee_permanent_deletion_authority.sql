BEGIN;

DO $migration$
DECLARE
    d text;

    anchor text :=
        'NOT coalesce(public.is_org_admin() OR public.has_permission(''hr-employees'',''delete''),false)';

BEGIN

    d := pg_get_functiondef(
        'public.neo_hr_delete_incorrect_employee(uuid,text,text)'
        ::regprocedure
    );

    IF (
        length(d) -
        length(replace(d,anchor,''))
    ) <> length(anchor) THEN

        RAISE EXCEPTION
            'Employee deletion authority anchor differs';

    END IF;

    d := replace(

        d,

        anchor,

$patch$

        NOT (
            public.is_org_admin() IS TRUE

            AND public.has_permission(
                'administration',
                'users',
                'assign_owner'
            ) IS TRUE
        )

$patch$

    );

    d := replace(
        d,
        'Employee deletion requires existing HR delete authority',
        'Permanent employee deletion requires Owner-level authority'
    );

    EXECUTE d;

END;
$migration$;

COMMIT;