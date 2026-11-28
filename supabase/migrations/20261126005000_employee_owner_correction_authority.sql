BEGIN;

DO $migration$
DECLARE
    d text;
    old_guard text :=
        'NOT (public.is_org_admin() IS TRUE AND public.has_permission(''administration'',''users'',''assign_owner'') IS TRUE)';
    new_guard text := $guard$
        NOT EXISTS (
            SELECT 1
            FROM public.user_roles ur
            JOIN public.roles r
              ON r.id = ur.role_id
            JOIN public.profiles p
              ON p.id = ur.user_id
            WHERE ur.user_id = auth.uid()
              AND ur.organization_id = org
              AND r.organization_id = org
              AND p.organization_id = org
              AND p.account_status = 'active'
              AND r.active IS TRUE
              AND coalesce(r.role_status,'active') <> 'archived'
              AND coalesce(
                  r.normalized_role_key,
                  public.neo_norm_key(r.name)
              ) = 'owner'
        )
$guard$;
BEGIN
    d := pg_get_functiondef(
        'public.neo_hr_delete_incorrect_employee(uuid,text,text)'
        ::regprocedure
    );

    IF position(old_guard IN d) = 0 THEN
        RAISE EXCEPTION
            'Employee deletion authority baseline differs';
    END IF;

    d := replace(d, old_guard, new_guard);

    EXECUTE d;
END;
$migration$;

COMMIT;