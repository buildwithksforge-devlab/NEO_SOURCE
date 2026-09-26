CREATE OR REPLACE FUNCTION public.ops_room_state_reconciliation(_branch uuid DEFAULT NULL::uuid)
RETURNS TABLE(room_id uuid, room_number text, issue text, detail text)
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  WITH s AS (
    SELECT * FROM public.ops_room_state(_branch)
    WHERE organization_id = public.current_org_id()
  ), stale AS (
    SELECT j.room_id,
           r.room_number,
           j.job_number,
           j.status,
           coalesce(j.started_at, j.due_at, j.updated_at, j.created_at) AS stale_since
      FROM public.housekeeping_jobs j
      JOIN public.rooms r ON r.id = j.room_id
     WHERE j.organization_id = public.current_org_id()
       AND (_branch IS NULL OR j.branch_id = _branch)
       AND public.hk_job_is_open(j.status, j.superseded_by)
       AND coalesce(j.started_at, j.due_at, j.updated_at, j.created_at) < now() - interval '24 hours'
  )
  SELECT s.room_id, s.room_number, 'cleaning-in-progress-without-task',
         'Room reports cleaning in progress but no open housekeeping task exists'
  FROM s WHERE s.housekeeping_state='cleaning_in_progress' AND s.current_job_id IS NULL
  UNION ALL
  SELECT s.room_id, s.room_number, 'awaiting-inspection-without-inspection',
         'Room awaits inspection but no cleaning job is awaiting inspection'
  FROM s WHERE s.housekeeping_state='awaiting_inspection'
    AND NOT EXISTS (SELECT 1 FROM public.housekeeping_jobs j
                    WHERE j.room_id=s.room_id AND j.status IN ('awaiting-inspection','rework')
                      AND j.superseded_by IS NULL)
  UNION ALL
  SELECT s.room_id, s.room_number, 'sellable-with-maintenance-block',
         'Room is marked sellable while a maintenance block is in place'
  FROM s WHERE s.sellable_now AND s.maintenance_status <> 'operational'
  UNION ALL
  SELECT s.room_id, s.room_number, 'duplicate-open-cleaning-task',
         'More than one open cleaning task exists for this room'
  FROM s WHERE (SELECT count(*) FROM public.housekeeping_jobs j
                WHERE j.room_id=s.room_id
                  AND public.hk_job_is_open(j.status, j.superseded_by)) > 1
  UNION ALL
  SELECT s.room_id, s.room_number, 'dirty-without-cleaning-task',
         'Room is dirty or in rework but no open cleaning task exists'
  FROM s WHERE s.housekeeping_state IN ('dirty','rework_required') AND s.current_job_id IS NULL
  UNION ALL
  SELECT s.room_id, s.room_number, 'orphan-inspection-flag',
         'Inspection state is set on a room that is not clean'
  FROM s WHERE s.inspection_status <> 'not-required'
    AND s.housekeeping_state IN ('dirty','cleaning_queued','cleaning_in_progress')
  UNION ALL
  SELECT stale.room_id, stale.room_number, 'stale-open-cleaning-task',
         concat(coalesce(stale.job_number, 'Cleaning task'), ' has remained ', replace(stale.status, '-', ' '), ' since ', to_char(stale.stale_since, 'DD Mon YYYY HH24:MI'))
  FROM stale;
$function$;

REVOKE ALL ON FUNCTION public.ops_room_state_reconciliation(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.ops_room_state_reconciliation(uuid) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.neo_normalise_canonical_payment_state()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $function$
BEGIN
  IF public.neo_financial_family(NEW.source_module) = 'payment'
     AND NEW.financial_state = 'posted'
     AND lower(coalesce(NEW.operational_state, '')) IN ('pending', 'processing', 'submitted', '') THEN
    NEW.operational_state := 'confirmed';
    NEW.next_action := 'Posted to the general ledger.';
    NEW.blocking_reason := NULL;
  END IF;
  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS normalise_canonical_payment_state ON public.canonical_transaction_states;
CREATE TRIGGER normalise_canonical_payment_state
BEFORE INSERT OR UPDATE ON public.canonical_transaction_states
FOR EACH ROW EXECUTE FUNCTION public.neo_normalise_canonical_payment_state();

REVOKE ALL ON FUNCTION public.neo_normalise_canonical_payment_state() FROM PUBLIC, anon, authenticated;