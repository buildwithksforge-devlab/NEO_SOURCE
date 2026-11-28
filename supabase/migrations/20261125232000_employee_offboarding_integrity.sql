BEGIN;

DO $migration$
DECLARE

    d text;

    lock_anchor text :=
        'WHERE id = _employee AND organization_id = _org;';

    exited_anchor text :=
        'IF _emp.employment_status = ''exited'' THEN';

    update_anchor text :=
        'IF _revoke_access AND _emp.profile_id IS NOT NULL THEN';

BEGIN

    d := pg_get_functiondef(
        'public.neo_hr_offboard_employee(uuid,date,text,text,boolean)'
        ::regprocedure
    );

    IF position(lock_anchor IN d) = 0

       OR position(exited_anchor IN d) = 0

       OR position(update_anchor IN d) = 0

    THEN

        RAISE EXCEPTION
            'Employee offboarding baseline differs';

    END IF;

    -- Lock the actual employee before checking lifecycle state.

    d := replace(

        d,

        lock_anchor,

        'WHERE id = _employee
           AND organization_id = _org
         FOR UPDATE;'

    );

    -- Enforce property scope and prevent unauthorized Owner removal.
    -- Preserve existing HR authority.

    d := replace(

        d,

        exited_anchor,

$patch$

    -- neo_employee_offboarding_scope_v1

    IF auth.uid() IS NULL

       OR public.current_access_scope() IS NULL

       OR public.current_access_scope() = 'technical'

    THEN

        RAISE EXCEPTION
            'Authorized staff access is required'

            USING ERRCODE = '42501';

    END IF;

    IF _emp.branch_id IS NOT NULL

       AND public.neo_branch_in_scope(_emp.branch_id)
           IS NOT TRUE

    THEN

        RAISE EXCEPTION
            'Employee property is outside your access scope'

            USING ERRCODE = '42501';

    END IF;

    IF _emp.branch_id IS NULL

       AND public.current_access_scope()
           IS DISTINCT FROM 'organisation'

       AND public.is_org_admin() IS NOT TRUE

    THEN

        RAISE EXCEPTION
            'Organisation-scoped authority is required'

            USING ERRCODE = '42501';

    END IF;

    IF _emp.profile_id = auth.uid() THEN

        RAISE EXCEPTION
            'Self-offboarding requires another authorized administrator'

            USING ERRCODE = '42501';

    END IF;

    IF _revoke_access

       AND EXISTS (

           SELECT 1

           FROM public.user_roles ur

           JOIN public.roles r
             ON r.id = ur.role_id

           WHERE ur.user_id = _emp.profile_id

             AND ur.organization_id = _org

             AND r.organization_id = _org

             AND lower(
                 coalesce(r.normalized_role_key,r.name)
             ) = 'owner'

       )

       AND public.has_permission(
           'administration','users','assign_owner'
       ) IS NOT TRUE

    THEN

        RAISE EXCEPTION
            'Owner lifecycle changes require Owner assignment authority'

            USING ERRCODE = '42501';

    END IF;

$patch$

        || exited_anchor

    );

    -- Allow an already exited employee to have outstanding access
    -- revoked without duplicating the employment separation history.

    d := replace(

        d,

        exited_anchor,

$patch$

    IF _emp.employment_status = 'exited'

       AND _revoke_access IS TRUE

       AND _emp.profile_id IS NOT NULL

    THEN

        IF NOT EXISTS (

            SELECT 1

            FROM public.profiles p

            WHERE p.id = _emp.profile_id
              AND p.organization_id = _org

        ) THEN

            RAISE EXCEPTION
                'Linked employee account does not match this workspace';

        END IF;

        WITH removed AS (

            DELETE FROM public.user_roles

            WHERE user_id = _emp.profile_id
              AND organization_id = _org

            RETURNING 1

        )

        SELECT count(*) INTO _roles_removed
        FROM removed;

        UPDATE public.profiles

           SET account_status = 'inactive',
               employment_status = 'exited',
               updated_at = now()

         WHERE id = _emp.profile_id

           AND organization_id = _org;

        UPDATE public.employees

           SET system_access_status = 'revoked',
               updated_at = now()

         WHERE id = _emp.id

           AND organization_id = _org;

        PERFORM public.neo_bump_access_epoch(_org);

        PERFORM public.log_audit_event(

            'hr.employee.outstanding_access_revoked',

            'human-resources',

            _emp.id::text,

            jsonb_build_object(
                'employment_status','exited'
            ),

            jsonb_build_object(
                'access_revoked',true,
                'roles_removed',_roles_removed
            ),

            _reason

        );

        RETURN jsonb_build_object(

            'employee_id',_emp.id,

            'already_exited',true,

            'roles_removed',_roles_removed,

            'account_closed',true

        );

    END IF;

$patch$

        || exited_anchor

    );

    -- Keep existing initial offboarding logic.
    -- Explicitly reject an invalid linked login.

    d := replace(

        d,

        update_anchor,

$patch$

    IF _revoke_access

       AND _emp.profile_id IS NOT NULL

       AND NOT EXISTS (

           SELECT 1

           FROM public.profiles p

           WHERE p.id = _emp.profile_id

             AND p.organization_id = _org

       )

    THEN

        RAISE EXCEPTION
            'Linked employee account does not match this workspace';

    END IF;

$patch$

        || update_anchor

    );

    IF position('_account_closed := true;' IN d) = 0 THEN

        RAISE EXCEPTION
            'Access revocation integration point differs';

    END IF;

    d := replace(

        d,

        '_account_closed := true;',

        '_account_closed := true;
         PERFORM public.neo_bump_access_epoch(_org);'

    );

    EXECUTE d;

END;
$migration$;

COMMIT;