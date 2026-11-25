-- NEØ: Controlled nightly accommodation automation.
-- Property opt-in, bounded business dates and charge-level audit linkage.
-- STAGED ONLY. No automatic posting is activated.

BEGIN;

-- ============================================================
-- 1. PROPERTY-LEVEL AUTOMATION CONFIGURATION
-- ============================================================

CREATE TABLE public.neo_pms_accommodation_automation_settings (
    organization_id uuid NOT NULL,
    branch_id uuid NOT NULL REFERENCES public.branches(id),
    enabled boolean NOT NULL DEFAULT false,
    activation_date date,
    updated_at timestamptz NOT NULL DEFAULT now(),

    PRIMARY KEY (organization_id, branch_id),

    CONSTRAINT neo_pms_automation_activation_required
      CHECK (enabled IS NOT TRUE OR activation_date IS NOT NULL)
);

ALTER TABLE public.neo_pms_accommodation_automation_settings
ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.neo_pms_accommodation_automation_settings
FROM PUBLIC, anon, authenticated, service_role;

-- Prevent configuration records from claiming another
-- organisation's property.

CREATE OR REPLACE FUNCTION
public.neo_pms_validate_automation_property()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM public.branches b
        WHERE b.id = NEW.branch_id
          AND b.organization_id = NEW.organization_id
    ) THEN
        RAISE EXCEPTION
          'Accommodation automation property/organisation mismatch';
    END IF;

    NEW.updated_at := now();

    RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION
public.neo_pms_validate_automation_property()
FROM PUBLIC, anon, authenticated, service_role;

CREATE TRIGGER neo_pms_validate_automation_property
BEFORE INSERT OR UPDATE
ON public.neo_pms_accommodation_automation_settings
FOR EACH ROW
EXECUTE FUNCTION public.neo_pms_validate_automation_property();


-- ============================================================
-- 2. AUDIT RUN STATUS
-- ============================================================

-- The run must exist before its financial transactions.
-- A successful run transitions from running to completed.

ALTER TABLE public.neo_pms_accommodation_job_runs
DROP CONSTRAINT neo_pms_job_run_status;

ALTER TABLE public.neo_pms_accommodation_job_runs
ADD CONSTRAINT neo_pms_job_run_status
CHECK (status IN ('running', 'completed', 'failed'));


-- ============================================================
-- 3. DIRECT FINANCIAL CHARGE-TO-RUN LINKAGE
-- ============================================================

ALTER TABLE public.folio_lines
ADD COLUMN automatic_job_run_id uuid
REFERENCES public.neo_pms_accommodation_job_runs(id);

CREATE INDEX neo_pms_folio_automatic_run_idx
ON public.folio_lines(automatic_job_run_id)
WHERE automatic_job_run_id IS NOT NULL;

-- The scheduler supplies the run identifier transaction-locally.
-- An accommodation charge is linked only to the matching
-- active run for its organisation, property and business date.

CREATE OR REPLACE FUNCTION
public.neo_pms_attach_automatic_job_run()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
    run_text text;
    run_id uuid;
BEGIN
    run_text :=
      NULLIF(
        current_setting(
          'neo.pms_accommodation_job_run_id',
          true
        ),
        ''
      );

    IF run_text IS NULL THEN
        IF NEW.automatic_job_run_id IS NOT NULL THEN
            RAISE EXCEPTION
              'Automatic job attribution requires an active scheduled run';
        END IF;

        RETURN NEW;
    END IF;

    IF NEW.category <> 'accommodation'
       OR NEW.line_type <> 'charge'
       OR NEW.source_module <> 'pms'
    THEN
        RETURN NEW;
    END IF;

    -- An authenticated employee cannot claim system-generated attribution.
    IF auth.uid() IS NOT NULL THEN
        RAISE EXCEPTION
          'Employee sessions cannot claim automatic accommodation attribution'
          USING ERRCODE = '42501';
    END IF;

    run_id := run_text::uuid;

    IF NOT EXISTS (
        SELECT 1
        FROM public.neo_pms_accommodation_job_runs r
        WHERE r.id = run_id
          AND r.organization_id = NEW.organization_id
          AND r.branch_id = NEW.branch_id
          AND r.business_date = NEW.operational_date
          AND r.status = 'running'
    ) THEN
        RAISE EXCEPTION
          'Accommodation charge cannot be linked to the active job run';
    END IF;

    IF NEW.automatic_job_run_id IS NOT NULL
       AND NEW.automatic_job_run_id <> run_id
    THEN
        RAISE EXCEPTION
          'Accommodation charge has a conflicting job identifier';
    END IF;

    NEW.automatic_job_run_id := run_id;

    RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION
public.neo_pms_attach_automatic_job_run()
FROM PUBLIC, anon, authenticated, service_role;

CREATE TRIGGER neo_pms_attach_automatic_job_run
BEFORE INSERT
ON public.folio_lines
FOR EACH ROW
EXECUTE FUNCTION public.neo_pms_attach_automatic_job_run();



-- Once recorded, a charge's automatic execution reference is immutable.
CREATE OR REPLACE FUNCTION
public.neo_pms_protect_automatic_job_reference()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
BEGIN
    IF OLD.automatic_job_run_id
       IS DISTINCT FROM NEW.automatic_job_run_id THEN

        RAISE EXCEPTION
          'Accommodation automatic-job attribution cannot be changed';
    END IF;

    RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION
public.neo_pms_protect_automatic_job_reference()
FROM PUBLIC, anon, authenticated, service_role;

CREATE TRIGGER neo_pms_protect_automatic_job_reference
BEFORE UPDATE OF automatic_job_run_id
ON public.folio_lines
FOR EACH ROW
EXECUTE FUNCTION public.neo_pms_protect_automatic_job_reference();
-- ============================================================
-- 4. REPLACE SCHEDULER WITH OPT-IN EXECUTION
-- ============================================================

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
    run_id uuid;
    posted integer;

    completed integer := 0;
    failed integer := 0;
    total_posted integer := 0;
    eligible integer := 0;

    local_date date :=
      (now() AT TIME ZONE 'Africa/Nairobi')::date;

    failure_text text;
BEGIN

    -- Only opted-in properties can qualify.
    -- Never automatically post an arbitrary historical business day.

    SELECT COUNT(*)::integer
    INTO eligible
    FROM public.business_days bd
    JOIN public.branches b
      ON b.id = bd.branch_id
     AND b.organization_id = bd.organization_id
    JOIN public.neo_pms_accommodation_automation_settings cfg
      ON cfg.organization_id = bd.organization_id
     AND cfg.branch_id = bd.branch_id
    WHERE cfg.enabled IS TRUE
      AND cfg.activation_date IS NOT NULL
      AND bd.status = 'open'
      AND bd.business_date >= cfg.activation_date
      AND bd.business_date BETWEEN
          local_date - 1 AND local_date;

    IF _execute IS NOT TRUE THEN
        RETURN jsonb_build_object(
            'status', 'dry_run',
            'eligible_property_days', eligible,
            'completed', 0,
            'failed', 0,
            'posted', 0
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
        JOIN public.neo_pms_accommodation_automation_settings cfg
          ON cfg.organization_id = bd.organization_id
         AND cfg.branch_id = bd.branch_id
        WHERE cfg.enabled IS TRUE
          AND cfg.activation_date IS NOT NULL
          AND bd.status = 'open'
          AND bd.business_date >= cfg.activation_date
          AND bd.business_date BETWEEN
              local_date - 1 AND local_date
        ORDER BY
            bd.organization_id,
            bd.branch_id,
            bd.business_date

    LOOP
        BEGIN
            -- The run is created before financial posting.
            -- Failure rolls back the run and its partial charges.

            INSERT INTO public.neo_pms_accommodation_job_runs(
                organization_id,
                branch_id,
                business_date,
                status
            )
            VALUES (
                property_day.organization_id,
                property_day.branch_id,
                property_day.business_date,
                'running'
            )
            RETURNING id INTO run_id;

            -- Only accommodation lines inserted during this
            -- transaction receive the active run identifier.

            PERFORM set_config(
                'neo.pms_accommodation_job_run_id',
                run_id::text,
                true
            );

            posted :=
              public.neo_pms_post_accommodation_job(
                property_day.organization_id,
                property_day.branch_id,
                property_day.business_date
              );

            PERFORM set_config(
                'neo.pms_accommodation_job_run_id',
                '',
                true
            );

            UPDATE public.neo_pms_accommodation_job_runs
            SET
                status = 'completed',
                posted_count = posted
            WHERE id = run_id;

            completed := completed + 1;
            total_posted := total_posted + posted;

        EXCEPTION WHEN OTHERS THEN

            -- PostgreSQL rolls back the failed property's
            -- financial operations within this exception block.

            failure_text := SQLERRM;

            PERFORM set_config(
                'neo.pms_accommodation_job_run_id',
                '',
                true
            );

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
        'status',
          CASE
            WHEN failed = 0 THEN 'completed'
            ELSE 'exceptions'
          END,
        'eligible_property_days', eligible,
        'completed', completed,
        'failed', failed,
        'posted', total_posted
    );
END;
$function$;

-- Do not expose financial automation through API roles.

REVOKE ALL ON FUNCTION
public.neo_pms_post_accommodation_scheduled(boolean)
FROM PUBLIC, anon, authenticated, service_role;


-- ============================================================
-- 5. NO AUTOMATIC ACTIVATION
-- ============================================================

-- No property is enabled by this migration.
-- No cron.schedule() call.
-- No historical accommodation backfill.
-- No live financial posting.

NOTIFY pgrst, 'reload schema';

COMMIT;