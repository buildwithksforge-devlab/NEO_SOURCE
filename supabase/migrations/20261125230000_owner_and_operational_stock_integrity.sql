BEGIN;

-- ============================================================
-- 1. CANONICAL ACTIVE OWNER AUTHORITY
-- ============================================================

CREATE OR REPLACE FUNCTION
public.neo_employee_deletion_owner_authority()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO public, pg_temp
AS $function$

    SELECT

        auth.uid() IS NOT NULL

        AND public.current_org_id() IS NOT NULL

        AND coalesce(
            public.is_active_staff(),
            false
        )

        AND public.current_access_scope() IS NOT NULL

        AND public.current_access_scope() <> 'technical'

        AND EXISTS (

            SELECT 1

            FROM public.user_roles ur

            JOIN public.roles r
              ON r.id = ur.role_id

            JOIN public.profiles p
              ON p.id = ur.user_id

            WHERE ur.user_id = auth.uid()

              AND ur.organization_id =
                  public.current_org_id()

              AND r.organization_id =
                  public.current_org_id()

              AND p.organization_id =
                  public.current_org_id()

              AND p.account_status = 'active'

              AND r.active IS TRUE

              AND coalesce(
                  r.role_status,
                  'active'
              ) = 'active'

              AND coalesce(
                  r.normalized_role_key,
                  public.neo_norm_key(r.name)
              ) = 'owner'

        );

$function$;

REVOKE ALL ON FUNCTION
public.neo_employee_deletion_owner_authority()
FROM PUBLIC,anon,authenticated;

-- Preserve all original employee deletion protections.

DO $migration$
DECLARE

    d text;

    anchor text :=
        'IF length(btrim(coalesce(_reason,'''')))<3';

BEGIN

    d := pg_get_functiondef(
        'public.neo_hr_delete_incorrect_employee(uuid,text,text)'
        ::regprocedure
    );

    IF position(anchor IN d) = 0
       OR position(
           'neo_employee_leave_history_preservation_v1' IN d
       ) = 0
    THEN

        RAISE EXCEPTION
            'Employee deletion baseline differs';

    END IF;

    d := replace(

        d,

        anchor,

$patch$

 IF public.neo_employee_deletion_owner_authority()
    IS NOT TRUE
 THEN

     RAISE EXCEPTION
         'Only an active organisation Owner may permanently delete an employee record'

         USING ERRCODE = '42501';

 END IF;

$patch$

        || anchor

    );

    EXECUTE d;

END;
$migration$;

-- ============================================================
-- 2. COMMON OPERATIONAL ARCHIVE CLASSIFICATION
-- ============================================================

CREATE OR REPLACE FUNCTION
public.neo_record_operationally_enabled(
    _record jsonb
)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
SET search_path TO pg_catalog
AS $function$

    SELECT

        _record IS NOT NULL

        AND jsonb_typeof(_record) = 'object'

        AND lower(
            coalesce(_record->>'status','')
        ) NOT IN (
            'archived',
            'inactive',
            'disabled',
            'retired',
            'deleted',
            'terminated'
        )

        AND lower(
            coalesce(_record->>'active','')
        ) <> 'false'

        AND lower(
            coalesce(_record->>'is_active','')
        ) <> 'false'

        AND lower(
            coalesce(_record->>'archived','')
        ) <> 'true'

        AND lower(
            coalesce(_record->>'is_archived','')
        ) <> 'true'

        AND nullif(
            _record->>'archived_at',
            ''
        ) IS NULL

        AND nullif(
            _record->>'deleted_at',
            ''
        ) IS NULL;

$function$;

REVOKE ALL ON FUNCTION
public.neo_record_operationally_enabled(jsonb)
FROM PUBLIC,anon,authenticated;

-- ============================================================
-- 3. STOCK ITEM AVAILABILITY AND PROPERTY SCOPE
-- ============================================================

CREATE OR REPLACE FUNCTION
public.neo_assert_operational_stock_item(
    _org uuid,
    _branch uuid,
    _item uuid
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, pg_temp
AS $function$

DECLARE

    v_item public.stock_items;

BEGIN

    SELECT *

    INTO v_item

    FROM public.stock_items

    WHERE id = _item

      AND organization_id = _org

      AND (
          branch_id IS NULL
          OR branch_id = _branch
      )

    FOR SHARE;

    IF NOT FOUND THEN

        RAISE EXCEPTION
            'Stock item is outside the current property catalogue'

            USING ERRCODE = '23514';

    END IF;

    IF public.neo_record_operationally_enabled(
        to_jsonb(v_item)
    ) IS NOT TRUE THEN

        RAISE EXCEPTION
            'Archived or inactive stock items cannot be used in new operational requests'

            USING ERRCODE = '23514';

    END IF;

END;
$function$;

REVOKE ALL ON FUNCTION
public.neo_assert_operational_stock_item(
    uuid,uuid,uuid
)
FROM PUBLIC,anon,authenticated;

-- ============================================================
-- 4. STOCK TRANSFER DISPATCH PROTECTION
-- ============================================================

DO $migration$
DECLARE

    d text;

    source_anchor text :=
        'PERFORM 1 FROM public.stock_locations';

    line_anchor text :=
        'v_unit := coalesce(v_unit,';

BEGIN

    d := pg_get_functiondef(
        'public.neo_stores_transfer_create(uuid,uuid,uuid,jsonb,text,uuid)'
        ::regprocedure
    );

    IF position(source_anchor IN d) = 0

       OR position(line_anchor IN d) = 0

       OR position('attempt_key' IN d) = 0

    THEN

        RAISE EXCEPTION
            'Installed stock transfer baseline differs';

    END IF;

    -- Restrict both source and destination stores.
    -- Existing replay handling remains before these checks.

    d := replace(

        d,

        'AND branch_id IS NOT DISTINCT FROM _branch;',

        'AND branch_id IS NOT DISTINCT FROM _branch
         AND active IS TRUE;'

    );

    IF position(
        'AND active IS TRUE;' IN d
    ) = 0 THEN

        RAISE EXCEPTION
            'Stock location guard was not installed';

    END IF;

    d := replace(

        d,

        line_anchor,

$patch$

    PERFORM public.neo_assert_operational_stock_item(
        v_org,
        _branch,
        v_item
    );

$patch$

        || line_anchor

    );

    EXECUTE d;

END;
$migration$;

-- ============================================================
-- 5. DEPARTMENTAL REQUISITION PROTECTION
-- ============================================================

DO $migration$
DECLARE

    d text;

    anchor text :=
        'INSERT INTO public.internal_requisition_lines';

BEGIN

    d := pg_get_functiondef(
        'public.neo_department_requisition_create(uuid,jsonb,uuid,date,text,text,uuid)'
        ::regprocedure
    );

    IF position(anchor IN d) = 0 THEN

        RAISE EXCEPTION
            'Departmental requisition integration point differs';

    END IF;

    IF position('stock_item_id' IN d) = 0 THEN

        RAISE EXCEPTION
            'Departmental requisition item field differs';

    END IF;

    d := replace(

        d,

        anchor,

$patch$

        PERFORM public.neo_assert_operational_stock_item(
            v_org,
            _branch,
            nullif(v_line->>'stock_item_id','')::uuid
        );

$patch$

        || anchor

    );

    EXECUTE d;

END;
$migration$;

COMMIT;