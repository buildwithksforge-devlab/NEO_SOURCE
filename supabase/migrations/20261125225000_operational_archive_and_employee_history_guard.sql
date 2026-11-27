BEGIN;

-- Preserve historical access while preventing explicitly inactive
-- menu records from entering new operational transactions.

DO $migration$
DECLARE
    d text;

    anchor text :=
        'IF item.availability IS DISTINCT FROM ''available''';

BEGIN

    d := pg_get_functiondef(
        'public.neo_pos_sellable_menu_guard()'
        ::regprocedure
    );

    IF position(anchor IN d) = 0 THEN

        RAISE EXCEPTION
            'Installed menu sellability guard differs';

    END IF;

    d := replace(

        d,

        anchor,

$patch$

    -- neo_operational_menu_archive_guard_v1

    IF lower(coalesce(to_jsonb(item)->>'status',''))
        IN ('archived','inactive','disabled','retired','deleted')

       OR lower(coalesce(to_jsonb(item)->>'active',''))
          = 'false'

       OR lower(coalesce(to_jsonb(item)->>'is_active',''))
          = 'false'

       OR lower(coalesce(to_jsonb(item)->>'archived',''))
          = 'true'

       OR lower(coalesce(to_jsonb(item)->>'is_archived',''))
          = 'true'

       OR nullif(to_jsonb(item)->>'archived_at','')
          IS NOT NULL

       OR nullif(to_jsonb(item)->>'deleted_at','')
          IS NOT NULL

    THEN

        RAISE EXCEPTION
            'Archived or inactive menu items cannot be ordered'

            USING ERRCODE = '23514';

    END IF;

$patch$

        || anchor

    );

    EXECUTE d;

END;
$migration$;

-- Permanent employee deletion must not silently remove
-- existing leave-balance records through cascading foreign keys.

DO $migration$
DECLARE

    d text;

    anchor text :=
        'IF ref.table_name=''leave_balances''';

BEGIN

    d := pg_get_functiondef(
        'public.neo_hr_delete_incorrect_employee(uuid,text,text)'
        ::regprocedure
    );

    IF position(anchor IN d) = 0

       OR position(
           'neo_private.rows_exist_matching' IN d
       ) = 0

       OR position(
           'hr.employee.incorrect_record_deleted' IN d
       ) = 0

    THEN

        RAISE EXCEPTION
            'Installed employee deletion safeguards differ';

    END IF;

    d := replace(

        d,

        anchor,

$patch$

    -- neo_employee_leave_history_preservation_v1

    IF ref.table_name = 'leave_balances'
       AND ref.column_name = 'employee_id'
    THEN

        found_reference :=
            neo_private.rows_exist_matching(
                ref.relid::regclass,
                ref.column_name,
                e.id
            );

        IF found_reference THEN

            blockers := array_append(
                blockers,
                ref.table_name::text
            );

        END IF;

        CONTINUE;

    END IF;

$patch$

        || anchor

    );

    EXECUTE d;

END;
$migration$;

COMMIT;