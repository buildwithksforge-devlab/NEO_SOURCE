BEGIN;

-- ============================================================
-- SUPPLIER OPERATIONAL ELIGIBILITY
-- ============================================================

CREATE OR REPLACE FUNCTION public.neo_assert_operational_supplier(
    _org uuid,
    _branch uuid,
    _supplier uuid
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, pg_temp
AS $function$
BEGIN

    PERFORM 1
    FROM public.suppliers s
    WHERE s.id = _supplier
      AND s.organization_id = _org
      AND s.active IS TRUE
      AND (
          s.branch_id IS NULL
          OR s.branch_id = _branch
      )
    FOR SHARE;

    IF NOT FOUND THEN

        RAISE EXCEPTION
            'Supplier is inactive, unavailable or outside the order property'

            USING ERRCODE = '23514';

    END IF;

END;
$function$;

REVOKE ALL ON FUNCTION
public.neo_assert_operational_supplier(uuid,uuid,uuid)
FROM PUBLIC,anon,authenticated;

-- ============================================================
-- NEW PURCHASE ORDERS AND SUPPLIER REASSIGNMENTS
-- ============================================================

CREATE OR REPLACE FUNCTION
public.neo_guard_purchase_order_supplier()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, pg_temp
AS $function$
BEGIN

    IF TG_OP = 'INSERT' THEN

        PERFORM public.neo_assert_operational_supplier(
            NEW.organization_id,
            NEW.branch_id,
            NEW.supplier_id
        );

    ELSIF NEW.supplier_id IS DISTINCT FROM OLD.supplier_id

       OR NEW.organization_id IS DISTINCT FROM OLD.organization_id

       OR NEW.branch_id IS DISTINCT FROM OLD.branch_id

       OR (
           NEW.status IS DISTINCT FROM OLD.status

           AND NEW.status IN (
               'approved',
               'pending-delivery',
               'pending_approval',
               'pending-approval'
           )

           AND OLD.status IN (
               'draft',
               'rejected',
               'pending_approval',
               'pending-approval'
           )
       )

    THEN

        PERFORM public.neo_assert_operational_supplier(
            NEW.organization_id,
            NEW.branch_id,
            NEW.supplier_id
        );

    END IF;

    RETURN NEW;

END;
$function$;

DROP TRIGGER IF EXISTS
neo_purchase_order_supplier_operational_guard
ON public.purchase_orders;

CREATE TRIGGER neo_purchase_order_supplier_operational_guard

BEFORE INSERT OR UPDATE
ON public.purchase_orders

FOR EACH ROW

EXECUTE FUNCTION
public.neo_guard_purchase_order_supplier();

-- ============================================================
-- STAFF OPERATIONAL ELIGIBILITY
-- ============================================================

CREATE OR REPLACE FUNCTION
public.neo_assert_operational_staff(
    _org uuid,
    _staff uuid
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, pg_temp
AS $function$
BEGIN

    PERFORM 1

    FROM public.profiles p

    WHERE p.id = _staff

      AND p.organization_id = _org

      AND p.account_status = 'active'

      AND p.account_type = 'staff'

      AND lower(coalesce(p.employment_status,'')) NOT IN (
          'exited',
          'terminated',
          'archived',
          'inactive',
          'retired',
          'suspended'
      )

    FOR SHARE;

    IF NOT FOUND THEN

        RAISE EXCEPTION
            'Staff member is inactive, exited or unavailable'

            USING ERRCODE = '23514';

    END IF;

    IF EXISTS (

        SELECT 1

        FROM public.employees e

        WHERE e.profile_id = _staff

          AND e.organization_id = _org

          AND (
              lower(coalesce(e.employment_status,'')) IN (
                  'exited',
                  'terminated',
                  'archived',
                  'inactive',
                  'retired',
                  'suspended'
              )

              OR e.system_access_status = 'revoked'
          )

    ) THEN

        RAISE EXCEPTION
            'Employee has exited or operational access has been revoked'

            USING ERRCODE = '23514';

    END IF;

END;
$function$;

REVOKE ALL ON FUNCTION
public.neo_assert_operational_staff(uuid,uuid)
FROM PUBLIC,anon,authenticated;

-- ============================================================
-- EVENT STAFF ASSIGNMENT INTEGRITY
-- ============================================================

CREATE OR REPLACE FUNCTION
public.neo_guard_event_staff_assignment()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, pg_temp
AS $function$
BEGIN

    IF TG_OP = 'INSERT' THEN

        PERFORM public.neo_assert_operational_staff(
            NEW.organization_id,
            NEW.staff_user_id
        );

    ELSIF NEW.staff_user_id IS DISTINCT FROM OLD.staff_user_id

       OR NEW.organization_id IS DISTINCT FROM OLD.organization_id

       OR NEW.branch_id IS DISTINCT FROM OLD.branch_id

       OR NEW.booking_id IS DISTINCT FROM OLD.booking_id

       OR (
           NEW.status = 'assigned'

           AND (
               NEW.status IS DISTINCT FROM OLD.status
               OR NEW.station IS DISTINCT FROM OLD.station
               OR NEW.duties IS DISTINCT FROM OLD.duties
           )
       )

    THEN

        PERFORM public.neo_assert_operational_staff(
            NEW.organization_id,
            NEW.staff_user_id
        );

    END IF;

    RETURN NEW;

END;
$function$;

DROP TRIGGER IF EXISTS
neo_event_staff_operational_guard
ON public.event_staff_assignments;

CREATE TRIGGER neo_event_staff_operational_guard

BEFORE INSERT OR UPDATE
ON public.event_staff_assignments

FOR EACH ROW

EXECUTE FUNCTION
public.neo_guard_event_staff_assignment();

-- ============================================================
-- STAFF ASSIGNMENT STATION AND ROLE RESTRICTIONS
-- ============================================================

DO $migration$
DECLARE

    d text;

    station_anchor text :=
        'and s.branch_id = _branch';

    role_anchor text :=
        'or r.active is not true';

BEGIN

    d := pg_get_functiondef(
        'public.neo_staff_assignment_save(uuid,text,text,uuid,uuid,uuid[],uuid,uuid,boolean)'
        ::regprocedure
    );

    IF position(
        'neo_staff_assignment_scope_guard_v1' IN d
    ) = 0

    OR position(station_anchor IN d) = 0

    OR position(role_anchor IN d) = 0

    THEN

        RAISE EXCEPTION
            'Installed staff assignment baseline differs';

    END IF;

    d := replace(

        d,

        station_anchor,

        station_anchor ||

$patch$

        and s.active is true
        and s.status = 'active'

$patch$

    );

    d := replace(

        d,

        role_anchor,

        role_anchor ||

$patch$

       or coalesce(r.role_status,'active') <> 'active'

$patch$

    );

    EXECUTE d;

END;
$migration$;

-- ============================================================
-- EVENT PROPERTY SCOPE
-- ============================================================

DO $migration$
DECLARE

    d text;

    anchor text :=
        'INSERT INTO public.event_staff_assignments';

BEGIN

    d := pg_get_functiondef(
        'public.neo_event_assign_staff(uuid,uuid,text,text)'
        ::regprocedure
    );

    IF position(anchor IN d) = 0 THEN

        RAISE EXCEPTION
            'Installed event assignment baseline differs';

    END IF;

    d := replace(

        d,

        anchor,

$patch$

    IF public.neo_branch_in_scope(v_branch) IS NOT TRUE THEN

        RAISE EXCEPTION
            'Event property is outside authorized scope'

            USING ERRCODE = '42501';

    END IF;

    PERFORM public.neo_assert_operational_staff(
        public.current_org_id(),
        _staff
    );

$patch$

        || anchor

    );

    EXECUTE d;

END;
$migration$;

COMMIT;