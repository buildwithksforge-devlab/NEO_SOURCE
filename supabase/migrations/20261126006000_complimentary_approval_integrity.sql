BEGIN;

CREATE OR REPLACE FUNCTION
public.neo_complimentary_register_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path TO pg_catalog, public
AS $function$
DECLARE
    actor uuid := auth.uid();
    org uuid := public.current_org_id();
BEGIN
    IF actor IS NULL
       OR org IS NULL
       OR public.current_access_scope() IS NULL
       OR public.current_access_scope() = 'technical'
    THEN
        RAISE EXCEPTION
            'Authorized workspace access is required'
            USING ERRCODE = '42501';
    END IF;

    IF NEW.organization_id IS DISTINCT FROM org
       OR NEW.branch_id IS NULL
       OR public.neo_branch_in_scope(NEW.branch_id)
          IS NOT TRUE
    THEN
        RAISE EXCEPTION
            'Complimentary record is outside your workspace scope'
            USING ERRCODE = '42501';
    END IF;

    IF TG_OP = 'INSERT' THEN

        IF public.has_permission(
            'restaurant','complimentary','create'
        ) IS NOT TRUE
        AND public.is_org_admin() IS NOT TRUE
        THEN
            RAISE EXCEPTION
                'Complimentary request permission is required'
                USING ERRCODE = '42501';
        END IF;

        NEW.requested_by := actor;
        NEW.created_by := actor;
        NEW.approved_by := NULL;
        NEW.approved_at := NULL;
        NEW.status := 'pending';

        IF length(
            btrim(coalesce(NEW.reason,''))
        ) < 3 THEN
            RAISE EXCEPTION
                'Enter a reason for the complimentary request';
        END IF;

        RETURN NEW;
    END IF;

    IF NEW.organization_id
       IS DISTINCT FROM OLD.organization_id
       OR NEW.branch_id
          IS DISTINCT FROM OLD.branch_id
       OR NEW.requested_by
          IS DISTINCT FROM OLD.requested_by
       OR NEW.created_by
          IS DISTINCT FROM OLD.created_by
    THEN
        RAISE EXCEPTION
            'Complimentary request identity cannot be changed';
    END IF;

    IF OLD.status IN ('approved','rejected') THEN
        IF to_jsonb(NEW) IS DISTINCT FROM to_jsonb(OLD)
        THEN
            RAISE EXCEPTION
                'This complimentary decision is already finalized';
        END IF;

        RETURN NEW;
    END IF;

    IF NEW.status IS DISTINCT FROM OLD.status THEN

        IF NEW.status NOT IN ('approved','rejected')
        THEN
            RAISE EXCEPTION
                'Invalid complimentary approval transition';
        END IF;

        IF actor IS NOT DISTINCT FROM OLD.requested_by
           OR actor IS NOT DISTINCT FROM OLD.created_by
        THEN
            RAISE EXCEPTION
                'You cannot approve or reject your own request'
                USING ERRCODE = '42501';
        END IF;

        IF NOT EXISTS (
            SELECT 1
            FROM public.user_roles ur
            JOIN public.roles r ON r.id = ur.role_id
            WHERE ur.user_id = actor
              AND ur.organization_id = org
              AND r.organization_id = org
              AND coalesce(r.active,true)
              AND public.neo_resolve_role_template_key(
                  r.normalized_role_key,r.name
              ) = 'owner'
        )
        THEN
            RAISE EXCEPTION
                'Complimentary approval authority is required'
                USING ERRCODE = '42501';
        END IF;

        IF (
            to_jsonb(NEW)
            - ARRAY[
                'status',
                'approved_by',
                'approved_at',
                'notes',
                'updated_at'
            ]
        ) IS DISTINCT FROM (
            to_jsonb(OLD)
            - ARRAY[
                'status',
                'approved_by',
                'approved_at',
                'notes',
                'updated_at'
            ]
        ) THEN
            RAISE EXCEPTION
                'Approval cannot change the original request';
        END IF;

        NEW.approved_by := actor;
        NEW.approved_at := now();

        RETURN NEW;
    END IF;

    IF (
        to_jsonb(NEW) - ARRAY['updated_at']
    ) IS DISTINCT FROM (
        to_jsonb(OLD) - ARRAY['updated_at']
    ) THEN
        RAISE EXCEPTION
            'Submitted complimentary requests cannot be edited';
    END IF;

    IF NEW.approved_by IS DISTINCT FROM OLD.approved_by
       OR NEW.approved_at IS DISTINCT FROM OLD.approved_at
    THEN
        RAISE EXCEPTION
            'Approval evidence cannot be assigned directly';
    END IF;

    RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS
    trg_neo_complimentary_register_guard
ON public.complimentary_register;

CREATE TRIGGER
    trg_neo_complimentary_register_guard
BEFORE INSERT OR UPDATE
ON public.complimentary_register
FOR EACH ROW
EXECUTE FUNCTION
    public.neo_complimentary_register_guard();

COMMIT;