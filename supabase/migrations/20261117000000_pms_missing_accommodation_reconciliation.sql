-- NEØ Cell 01-D2: Detect missing nightly accommodation postings.
-- LOCAL CANDIDATE ONLY. Does not post or modify guest charges.
BEGIN;

CREATE FUNCTION public.neo_pms_missing_accommodation(
    _org uuid,
    _branch uuid,
    _day date
)
RETURNS TABLE (
    stay_id uuid,
    reservation_id uuid,
    reference text,
    amount numeric
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path TO 'public'
AS $function$
    SELECT
        s.id,
        s.reservation_id,
        s.id::text,
        CASE
            WHEN r.organization_id = s.organization_id
            THEN r.nightly_rate
            ELSE NULL::numeric
        END
    FROM public.stays s
    JOIN public.reservations r
      ON r.id = s.reservation_id
    WHERE s.organization_id = _org
      AND s.branch_id = _branch
      AND s.status = 'in-house'
      AND r.nightly_rate > 0
      AND _day >= r.arrival_date
      AND _day < r.departure_date
      AND NOT EXISTS (
          SELECT 1
          FROM public.folio_lines fl
          JOIN public.folios f
            ON f.id = fl.folio_id
           AND f.organization_id = s.organization_id
           AND f.branch_id = s.branch_id
           AND f.stay_id = s.id
           AND f.reservation_id = s.reservation_id
           AND f.folio_type = 'guest'
          WHERE fl.organization_id = s.organization_id
            AND fl.branch_id = s.branch_id
            AND fl.reservation_id = s.reservation_id
            AND fl.operational_date = _day
            AND fl.category = 'accommodation'
            AND fl.line_type = 'charge'
            AND fl.status = 'posted'
      )
$function$;

-- Internal reconciliation helper: not an authenticated RPC.
REVOKE ALL ON FUNCTION
    public.neo_pms_missing_accommodation(uuid,uuid,date)
FROM PUBLIC, anon, authenticated;

COMMIT;