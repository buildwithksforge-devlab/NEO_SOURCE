-- NEØ F08: prevent new GL postings into an explicitly closed business day.
-- No operational data modifications.
-- Existing posted journals remain unchanged.
-- Does not require historical dates to have business_days records.

CREATE OR REPLACE FUNCTION public.neo_assert_gl_business_day_open(
    _org uuid,
    _branch uuid,
    _date date
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
BEGIN
    IF _org IS NULL OR _branch IS NULL OR _date IS NULL THEN
        RAISE EXCEPTION
            'Organisation, property and accounting date are required';
    END IF;

    -- Coordinate with neo_close_business_day for this property.
    -- A posting and a day closure cannot pass their checks concurrently.
    PERFORM pg_advisory_xact_lock(
        hashtextextended(
            'business-day:' || _org::text || ':' || _branch::text,
            0
        )
    );

    IF EXISTS (
        SELECT 1
        FROM public.business_days bd
        WHERE bd.organization_id = _org
          AND bd.branch_id = _branch
          AND bd.business_date = _date
          AND bd.status = 'closed'
    ) THEN
        RAISE EXCEPTION
            'Business day % is closed for this property. Post the correction on an authorised open accounting date.',
            _date
            USING ERRCODE = '23514';
    END IF;
END;
$function$;

REVOKE ALL ON FUNCTION
public.neo_assert_gl_business_day_open(uuid,uuid,date)
FROM PUBLIC;

-- Guard at the journal status transition so both manual and
-- automatic journal-posting pathways are covered.
CREATE OR REPLACE FUNCTION public.neo_guard_closed_day_journal_post()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
BEGIN
    IF NEW.status = 'posted' THEN
        IF TG_OP = 'INSERT' THEN
            PERFORM public.neo_assert_gl_business_day_open(
                NEW.organization_id,
                NEW.branch_id,
                NEW.accounting_date
            );
        ELSIF TG_OP = 'UPDATE' THEN
            IF OLD.status IS DISTINCT FROM 'posted' THEN
                PERFORM public.neo_assert_gl_business_day_open(
                    NEW.organization_id,
                    NEW.branch_id,
                    NEW.accounting_date
                );
            END IF;
        END IF;
    END IF;

    RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trg_neo_closed_day_journal_post
ON public.journal_entries;

CREATE TRIGGER trg_neo_closed_day_journal_post
BEFORE INSERT OR UPDATE OF status
ON public.journal_entries
FOR EACH ROW
EXECUTE FUNCTION public.neo_guard_closed_day_journal_post();
