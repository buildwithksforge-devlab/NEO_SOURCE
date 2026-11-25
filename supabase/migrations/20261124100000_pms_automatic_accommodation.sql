-- NEØ: Controlled automatic accommodation posting.
-- STAGED ONLY. No cron job is created or activated.
-- Reuses the installed property-scoped pricing and folio engine.

BEGIN;

DO $install$
DECLARE
    source_fn regprocedure :=
      to_regprocedure('public.pms_post_accommodation_scoped(uuid,date)');

    definition text;
    original_header text :=
      'CREATE OR REPLACE FUNCTION public.pms_post_accommodation_scoped(';

    new_header text :=
      'CREATE OR REPLACE FUNCTION public.neo_pms_post_accommodation_job(_service_org uuid, ';

    original_org text :=
      'DECLARE _org uuid := public.current_org_id();';

    service_org text :=
      'DECLARE _org uuid := _service_org;';

    guard_start integer;
    permission_start integer;
    permission_end integer;
    count_matches integer;

    service_guard text := $guard$
  -- This function is not an employee-facing RPC.
  -- Its EXECUTE privilege is restricted to the database owner.
  IF _service_org IS NULL OR _branch IS NULL
     OR _operational_date IS NULL THEN
    RAISE EXCEPTION 'Scheduled posting requires organisation, property and date';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM public.branches b
    WHERE b.id = _branch
      AND b.organization_id = _service_org
  ) THEN
    RAISE EXCEPTION 'Scheduled posting property is outside its organisation';
  END IF;

  IF _operational_date >
     (now() AT TIME ZONE 'Africa/Nairobi')::date THEN
    RAISE EXCEPTION 'Future scheduled accommodation posting is prohibited';
  END IF;

  -- Coordinate with normal accommodation posting and day closure.
  PERFORM pg_advisory_xact_lock(
    hashtextextended(
      'business-day:' || _service_org::text || ':' || _branch::text,
      0
    )
  );

  PERFORM pg_advisory_xact_lock(
    hashtextextended(
      _service_org::text || ':accommodation:' ||
      _branch::text || ':' || _operational_date::text,
      0
    )
  );

  IF NOT EXISTS (
    SELECT 1
    FROM public.business_days bd
    WHERE bd.organization_id = _service_org
      AND bd.branch_id = _branch
      AND bd.business_date = _operational_date
      AND bd.status = 'open'
    FOR UPDATE
  ) THEN
    RAISE EXCEPTION 'Scheduled accommodation requires an open business day';
  END IF;
$guard$;

BEGIN
    IF source_fn IS NULL THEN
        RAISE EXCEPTION 'Scoped accommodation engine must be installed first';
    END IF;

    IF to_regprocedure(
      'public.neo_pms_post_accommodation_job(uuid,uuid,date)'
    ) IS NOT NULL THEN
        RAISE EXCEPTION 'Automatic accommodation engine already exists';
    END IF;

    SELECT pg_get_functiondef(source_fn)
      INTO definition;

    -- Only clone the verified accommodation implementation.
    IF position('pkg_allocate_folio_line' IN definition) = 0
       OR position('service_charge_amount' IN definition) = 0
       OR position('tax_treatment' IN definition) = 0
       OR position('s.branch_id=_branch' IN definition) = 0
       OR position('pg_advisory_xact_lock' IN definition) = 0
       OR position('EXCEPTION WHEN unique_violation' IN definition) = 0
    THEN
        RAISE EXCEPTION 'Scoped financial engine differs from reviewed contract';
    END IF;

    IF position(original_header IN definition) <> 1 THEN
        RAISE EXCEPTION 'Unexpected accommodation function header';
    END IF;

    count_matches :=
      (length(definition) -
       length(replace(definition, original_org, '')))
       / length(original_org);

    IF count_matches <> 1 THEN
        RAISE EXCEPTION 'Organisation declaration differs from reviewed contract';
    END IF;

    definition :=
      replace(definition, original_header, new_header);

    definition :=
      replace(definition, original_org, service_org);

    -- Replace employee-session guards with explicit service context.
    -- Preserve the original accommodation calculation and INSERT logic.
    guard_start :=
      position('IF auth.uid() IS NULL OR _org IS NULL THEN' IN definition);

    permission_start :=
      position('IF NOT public.has_permission' IN definition);

    IF guard_start = 0
       OR permission_start <= guard_start THEN
        RAISE EXCEPTION 'Employee guard boundaries differ from reviewed contract';
    END IF;

    permission_end :=
      position(
        'END IF;'
        IN substring(definition FROM permission_start)
      );

    IF permission_end = 0 THEN
        RAISE EXCEPTION 'Original posting permission guard is incomplete';
    END IF;

    permission_end :=
      permission_start + permission_end - 1 + length('END IF;');

    definition :=
      substring(definition FROM 1 FOR guard_start - 1)
      || service_guard
      || substring(definition FROM permission_end);

    -- The service engine must not depend on the employee permission check.
    IF position('IF NOT public.has_permission' IN definition) > 0
       OR position('IF auth.uid() IS NULL' IN definition) > 0
       OR position('public.current_org_id()' IN definition) > 0
    THEN
        RAISE EXCEPTION 'Employee-context dependency remains in service engine';
    END IF;

    -- Automatic posting has no employee actor.
    -- Never inherit auth.uid() from the original manual posting engine.
    -- Leave posted_by NULL and retain the scheduled-job evidence.
    count_matches :=
      (length(definition) -
       length(replace(definition, 'auth.uid()', '')))
       / length('auth.uid()');

    IF count_matches <> 1 THEN
        RAISE EXCEPTION
          'Unexpected employee attribution in automatic accommodation engine: % occurrences',
          count_matches;
    END IF;

    definition := replace(
      definition,
      'auth.uid()',
      'NULL::uuid'
    );

    IF position('auth.uid()' IN definition) > 0 THEN
        RAISE EXCEPTION
          'Employee attribution remains in automatic posting engine';
    END IF;

    EXECUTE definition;

    IF to_regprocedure(
      'public.neo_pms_post_accommodation_job(uuid,uuid,date)'
    ) IS NULL THEN
        RAISE EXCEPTION 'Automatic accommodation function installation failed';
    END IF;

    -- Only privileged database-owned routines may invoke the engine.
    -- Do not grant this internal financial operation to service_role.
    REVOKE ALL ON FUNCTION
      public.neo_pms_post_accommodation_job(uuid,uuid,date)
      FROM PUBLIC, anon, authenticated, service_role;

    IF has_function_privilege(
      'authenticated',
      'public.neo_pms_post_accommodation_job(uuid,uuid,date)',
      'EXECUTE'
    ) THEN
        RAISE EXCEPTION 'Internal financial engine remains exposed';
    END IF;
END;
$install$;

-- Durable evidence of scheduled accommodation posting.
CREATE TABLE public.neo_pms_accommodation_job_runs (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id uuid NOT NULL,
    branch_id uuid NOT NULL,
    business_date date NOT NULL,
    started_at timestamptz NOT NULL DEFAULT now(),
    posted_count integer NOT NULL DEFAULT 0,
    status text NOT NULL,
    error_message text,
    CONSTRAINT neo_pms_job_run_status
      CHECK (status IN ('completed', 'failed')),
    CONSTRAINT neo_pms_job_run_count
      CHECK (posted_count >= 0)
);

CREATE INDEX neo_pms_job_runs_property_date_idx
ON public.neo_pms_accommodation_job_runs
    (organization_id, branch_id, business_date, started_at DESC);

ALTER TABLE public.neo_pms_accommodation_job_runs
ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.neo_pms_accommodation_job_runs
FROM PUBLIC, anon, authenticated;

-- Service-only entry point. Default behaviour is non-posting.
CREATE OR REPLACE FUNCTION
public.neo_pms_post_accommodation_scheduled(
    _execute boolean DEFAULT false
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
    property_day record;
    posted integer;
    completed integer := 0;
    failed integer := 0;
    total_posted integer := 0;
    inspected integer := 0;
    failure_text text;
BEGIN
    IF _execute IS NOT TRUE THEN
        SELECT count(*)
        INTO inspected
        FROM public.business_days bd
        JOIN public.branches b
          ON b.id = bd.branch_id
         AND b.organization_id = bd.organization_id
        WHERE bd.status = 'open'
          AND bd.business_date <=
              (now() AT TIME ZONE 'Africa/Nairobi')::date;

        RETURN jsonb_build_object(
            'status', 'dry_run',
            'properties_with_open_days', inspected,
            'posted', 0,
            'completed', 0,
            'failed', 0
        );
    END IF;

    FOR property_day IN
        SELECT
            bd.organization_id,
            bd.branch_id,
            bd.business_date
        FROM public.business_days bd
        JOIN public.branches b
          ON b.id = bd.branch_id
         AND b.organization_id = bd.organization_id
        WHERE bd.status = 'open'
          AND bd.business_date <=
              (now() AT TIME ZONE 'Africa/Nairobi')::date
        ORDER BY bd.organization_id, bd.branch_id, bd.business_date
    LOOP
        BEGIN
            posted :=
              public.neo_pms_post_accommodation_job(
                property_day.organization_id,
                property_day.branch_id,
                property_day.business_date
              );

            INSERT INTO public.neo_pms_accommodation_job_runs(
                organization_id,
                branch_id,
                business_date,
                posted_count,
                status
            )
            VALUES (
                property_day.organization_id,
                property_day.branch_id,
                property_day.business_date,
                posted,
                'completed'
            );

            completed := completed + 1;
            total_posted := total_posted + posted;

        EXCEPTION WHEN OTHERS THEN
            failure_text := SQLERRM;

            -- Failed property posting rolls back before saving this evidence.
            INSERT INTO public.neo_pms_accommodation_job_runs(
                organization_id,
                branch_id,
                business_date,
                posted_count,
                status,
                error_message
            )
            VALUES (
                property_day.organization_id,
                property_day.branch_id,
                property_day.business_date,
                0,
                'failed',
                failure_text
            );

            failed := failed + 1;
        END;
    END LOOP;

    RETURN jsonb_build_object(
        'status', CASE WHEN failed = 0 THEN 'completed'
                       ELSE 'exceptions' END,
        'completed', completed,
        'failed', failed,
        'posted', total_posted
    );
END;
$function$;

REVOKE ALL ON FUNCTION
  public.neo_pms_post_accommodation_scheduled(boolean)
  FROM PUBLIC, anon, authenticated, service_role;

-- No API role may execute the cross-property financial scheduler.
-- A future pg_cron job must run as the verified database owner.
-- Do not grant this function to service_role.

DO $security$
BEGIN
  IF has_function_privilege(
    'service_role',
    'public.neo_pms_post_accommodation_scheduled(boolean)',
    'EXECUTE'
  ) THEN
    RAISE EXCEPTION
      'Service-role access to automatic accommodation posting remains enabled';
  END IF;
END;
$security$;

-- IMPORTANT:
-- No cron.schedule() call is installed here.
-- No automatic financial posting is activated.

NOTIFY pgrst, 'reload schema';

COMMIT;