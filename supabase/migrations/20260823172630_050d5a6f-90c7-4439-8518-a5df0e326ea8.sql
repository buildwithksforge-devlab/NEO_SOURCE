CREATE OR REPLACE FUNCTION public.neo_event_readiness_from_task(_status text)
RETURNS text
LANGUAGE sql
IMMUTABLE
SET search_path TO 'public'
AS $$
  SELECT CASE lower(coalesce(_status,''))
    WHEN 'completed' THEN 'ready'
    WHEN 'complete' THEN 'ready'
    WHEN 'done' THEN 'ready'
    WHEN 'closed' THEN 'ready'
    WHEN 'in-progress' THEN 'in-progress'
    WHEN 'in_progress' THEN 'in-progress'
    WHEN 'active' THEN 'in-progress'
    WHEN 'started' THEN 'in-progress'
    WHEN 'blocked' THEN 'blocked'
    WHEN 'on-hold' THEN 'blocked'
    WHEN 'cancelled' THEN 'blocked'
    WHEN 'overdue' THEN 'at-risk'
    ELSE 'not-started'
  END
$$;

REVOKE ALL ON FUNCTION public.neo_event_readiness_from_task(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.neo_event_readiness_from_task(text) TO authenticated, service_role;

-- Backfill: post event receipts that never reached the ledger. Deposits already
-- posted under the legacy event_deposit route are skipped.
DO $do$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT p.id
      FROM public.event_payments p
     WHERE NOT EXISTS (
             SELECT 1 FROM public.finance_posting_receipts fr
              WHERE fr.source_module = 'event_payment' AND fr.source_id = p.id)
       AND NOT (p.entry_type = 'deposit' AND EXISTS (
             SELECT 1 FROM public.finance_posting_receipts fr
              WHERE fr.source_module = 'event_deposit' AND fr.source_id = p.booking_id
                AND fr.status = 'posted'))
     ORDER BY p.created_at
  LOOP
    PERFORM public.neo_event_post_payment(r.id);
  END LOOP;
END $do$;