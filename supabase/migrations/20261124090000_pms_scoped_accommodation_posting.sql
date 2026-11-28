-- NEØ: Property-scoped accommodation posting.
-- STAGED ONLY. Do not deploy before isolated PostgreSQL verification.
-- Preserve the installed accommodation pricing and folio posting engine.

BEGIN;

DO $install$
DECLARE
    original_fn regprocedure :=
        to_regprocedure('public.pms_post_accommodation(date)');

    scoped_fn regprocedure :=
        to_regprocedure('public.pms_post_accommodation_scoped(uuid,date)');

    definition text;
    original_header text;
    scoped_header text;

    original_body text;
    scoped_body text;

    -- Restrict the existing accommodation query to the selected property.
    -- Preserve all existing rate-plan, folio and room relationship guards.
    anchor text :=
        'WHERE s.organization_id=_org';

    replacement text :=
        'WHERE s.organization_id=_org AND s.branch_id=_branch';

    guard_sql text := $guard$
  IF auth.uid() IS NULL OR _org IS NULL THEN
    RAISE EXCEPTION 'Authenticated workspace required'
      USING ERRCODE='42501';
  END IF;

  IF _branch IS NULL OR _operational_date IS NULL THEN
    RAISE EXCEPTION 'Property and operational date are required';
  END IF;

  IF public.has_permission(
      'pms','folios.post_charge'
  ) IS NOT TRUE THEN
    RAISE EXCEPTION 'Not permitted to post accommodation'
      USING ERRCODE='42501';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM public.branches b
    WHERE b.id=_branch
      AND b.organization_id=_org
  ) THEN
    RAISE EXCEPTION 'Unknown property'
      USING ERRCODE='42501';
  END IF;

  IF public.neo_branch_in_scope(_branch) IS NOT TRUE
     AND public.is_org_admin() IS NOT TRUE THEN
    RAISE EXCEPTION 'Property outside permitted scope'
      USING ERRCODE='42501';
  END IF;

  -- Kenya-local calendar guard. Verify property timezone policy
  -- before enabling this operation for other timezones.
  IF _operational_date >
     (now() AT TIME ZONE 'Africa/Nairobi')::date THEN
    RAISE EXCEPTION 'Future accommodation posting is prohibited';
  END IF;

  -- The requested date must be the property's open business day.
  IF NOT EXISTS (
    SELECT 1
    FROM public.business_days bd
    WHERE bd.organization_id=_org
      AND bd.branch_id=_branch
      AND bd.business_date=_operational_date
      AND bd.status='open'
  ) THEN
    RAISE EXCEPTION
      'Accommodation posting requires the open property business day';
  END IF;

  -- Coordinate with neo_close_business_day and neo_open_business_day.
  -- Acquire the shared business-day lock before the accommodation lock.
  PERFORM pg_advisory_xact_lock(
    hashtextextended(
      'business-day:' || _org::text || ':' || _branch::text,
      0
    )
  );

  -- Serialize all requests for the same property and night.
  PERFORM pg_advisory_xact_lock(
    hashtextextended(
      _org::text || ':accommodation:' ||
      _branch::text || ':' ||
      _operational_date::text,
      0
    )
  );

  -- Recheck under serialization.
  IF NOT EXISTS (
    SELECT 1
    FROM public.business_days bd
    WHERE bd.organization_id=_org
      AND bd.branch_id=_branch
      AND bd.business_date=_operational_date
      AND bd.status='open'
    FOR UPDATE
  ) THEN
    RAISE EXCEPTION 'Business day changed during posting';
  END IF;
$guard$;

BEGIN
    IF original_fn IS NULL THEN
        RAISE EXCEPTION
          'Original accommodation engine is missing';
    END IF;

    IF scoped_fn IS NOT NULL THEN
        RAISE EXCEPTION
          'Scoped accommodation engine already exists; manual review required';
    END IF;

    SELECT pg_get_functiondef(original_fn)
    INTO definition;

    IF position('pkg_allocate_folio_line' IN definition)=0
       OR position('service_charge_amount' IN definition)=0
       OR position('service_charge_rate' IN definition)=0
       OR position('tax_treatment' IN definition)=0
       OR position('res.organization_id = s.organization_id' IN definition)=0
       OR position('f.branch_id = s.branch_id' IN definition)=0
       OR position('rm.organization_id = s.organization_id' IN definition)=0
       OR position('EXCEPTION WHEN unique_violation' IN definition)=0
    THEN
        RAISE EXCEPTION
          'Required existing accommodation repairs are not installed';
    END IF;

    -- Require the expected declaration and original posting scope.
    -- Do not rewrite an unknown version of the financial engine.
    IF position(
       'DECLARE _org uuid := public.current_org_id();'
       IN definition
    )=0 THEN
        RAISE EXCEPTION
          'Accommodation declaration differs from reviewed contract';
    END IF;

    IF (
      length(definition) -
      length(replace(definition,anchor,''))
    ) <> length(anchor) THEN
        RAISE EXCEPTION
          'Accommodation scope anchor differs from reviewed contract';
    END IF;

    -- Rename the function and add the mandatory property parameter.
    original_header :=
      'CREATE OR REPLACE FUNCTION public.pms_post_accommodation(';

    scoped_header :=
      'CREATE OR REPLACE FUNCTION public.pms_post_accommodation_scoped(_branch uuid, ';

    IF position(original_header IN definition) <> 1 THEN
        RAISE EXCEPTION 'Unexpected accommodation function header';
    END IF;

    definition :=
      replace(definition,original_header,scoped_header);

    definition :=
      replace(definition,anchor,replacement);

    -- Insert the property/date checks at function entry.
    -- Insert the guard immediately before the original permission check.
    -- Do not depend on PostgreSQL's formatting of BEGIN or indentation.
    original_body :=
      'IF NOT public.has_permission';

    scoped_body :=
      guard_sql || chr(10) ||
      '  IF NOT public.has_permission';

    IF position(original_body IN definition)=0 THEN
        RAISE EXCEPTION
          'Accommodation function entry differs from reviewed contract';
    END IF;

    definition :=
      replace(definition,original_body,scoped_body);

    -- Preserve the existing finance calculation and posting statements.
    EXECUTE definition;

    SELECT pg_get_functiondef(
      'public.pms_post_accommodation_scoped(uuid,date)'::regprocedure
    )
    INTO definition;

    IF position('s.branch_id=_branch' IN definition)=0
       OR position('business_days' IN definition)=0
       OR position('pg_advisory_xact_lock' IN definition)=0
       OR position('pkg_allocate_folio_line' IN definition)=0
       OR position('service_charge_amount' IN definition)=0
    THEN
        RAISE EXCEPTION
          'Scoped accommodation installation verification failed';
    END IF;

    -- Do not expose the new financial operation to public/anonymous callers.
    EXECUTE
      'REVOKE ALL ON FUNCTION
       public.pms_post_accommodation_scoped(uuid,date)
       FROM PUBLIC, anon, authenticated';

    EXECUTE
      'GRANT EXECUTE ON FUNCTION
       public.pms_post_accommodation_scoped(uuid,date)
       TO authenticated';

    -- Retire direct authenticated access to the legacy
    -- organisation-wide financial posting operation.
    -- Preserve the function definition and historical records.
    REVOKE EXECUTE ON FUNCTION
      public.pms_post_accommodation(date)
      FROM PUBLIC, anon, authenticated;

    IF has_function_privilege(
      'authenticated',
      'public.pms_post_accommodation(date)',
      'EXECUTE'
    ) THEN
      RAISE EXCEPTION
        'Legacy accommodation endpoint remains accessible';
    END IF;

END;
$install$;

COMMIT;