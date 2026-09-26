
-- 1. Block a second open task of the same cleaning type on the same room.
CREATE OR REPLACE FUNCTION public.hk_block_duplicate_open_job()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE v_existing text;
BEGIN
  IF NEW.room_id IS NULL THEN RETURN NEW; END IF;
  IF coalesce(current_setting('neo.hk_allow_duplicate', true), '') = 'on' THEN RETURN NEW; END IF;
  IF NOT public.hk_job_is_open(NEW.status, NEW.superseded_by) THEN RETURN NEW; END IF;

  SELECT coalesce(j.job_number, j.id::text) INTO v_existing
    FROM public.housekeeping_jobs j
   WHERE j.organization_id = NEW.organization_id
     AND j.room_id = NEW.room_id
     AND j.job_type = NEW.job_type
     AND j.id <> NEW.id
     AND public.hk_job_is_open(j.status, j.superseded_by)
   LIMIT 1;

  IF v_existing IS NOT NULL THEN
    RAISE EXCEPTION 'An open % task already exists for this room (%). Resolve, cancel or replace it before raising another.',
      replace(NEW.job_type, '-', ' '), v_existing;
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS hk_block_duplicate_open_job ON public.housekeeping_jobs;
CREATE TRIGGER hk_block_duplicate_open_job
BEFORE INSERT ON public.housekeeping_jobs
FOR EACH ROW EXECUTE FUNCTION public.hk_block_duplicate_open_job();

-- 2. Explicit, audited resolution of a stale open task.
CREATE OR REPLACE FUNCTION public.hk_resolve_stale_job(
  _job uuid,
  _action text,
  _reason text DEFAULT NULL,
  _assignee uuid DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_org uuid := public.current_org_id();
  v_actor uuid := auth.uid();
  v_job public.housekeeping_jobs;
  v_reason text := nullif(btrim(coalesce(_reason, '')), '');
  v_before jsonb;
  v_new jsonb;
  v_audit uuid;
BEGIN
  IF v_org IS NULL OR v_actor IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'no_organisation');
  END IF;
  IF NOT (public.has_permission('housekeeping','tasks.manage')
          OR public.has_permission('housekeeping','tasks.assign')
          OR public.is_org_admin_for(v_org)) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_permitted');
  END IF;
  IF _action NOT IN ('complete','cancel','reassign','replace') THEN
    RAISE EXCEPTION 'Unsupported action: %', _action;
  END IF;

  SELECT * INTO v_job FROM public.housekeeping_jobs
   WHERE id = _job AND organization_id = v_org FOR UPDATE;
  IF v_job.id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_found');
  END IF;
  IF NOT public.neo_branch_in_scope(v_job.branch_id) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_permitted');
  END IF;
  IF NOT public.hk_job_is_open(v_job.status, v_job.superseded_by) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'already_resolved', 'status', v_job.status);
  END IF;
  IF _action IN ('cancel','replace') AND v_reason IS NULL THEN
    RAISE EXCEPTION 'A written reason is required to % this task', _action;
  END IF;

  v_before := to_jsonb(v_job);

  IF _action = 'reassign' THEN
    IF _assignee IS NULL THEN RAISE EXCEPTION 'Choose the person to take this task over'; END IF;
    PERFORM public.neo_assert_worker_scope(_assignee, v_job.branch_id, 'housekeeping');
    UPDATE public.housekeeping_jobs
       SET assignee_id = _assignee,
           status = CASE WHEN status = 'pending' THEN 'assigned' ELSE status END,
           notes = coalesce(notes || E'\n', '') || coalesce('Reassigned: ' || v_reason, 'Reassigned'),
           updated_at = now()
     WHERE id = _job;
    UPDATE public.tasks SET assignee_id = _assignee,
           status = CASE WHEN status = 'open' THEN 'assigned' ELSE status END,
           updated_at = now()
     WHERE id = v_job.task_id;

  ELSIF _action = 'complete' THEN
    UPDATE public.housekeeping_jobs
       SET status = 'completed',
           completed_at = now(),
           inspection_status = CASE WHEN inspection_status = 'pending' THEN 'not-required' ELSE inspection_status END,
           notes = coalesce(notes || E'\n', '') || coalesce('Closed by supervisor: ' || v_reason, 'Closed by supervisor'),
           updated_at = now()
     WHERE id = _job;
    UPDATE public.tasks SET status = 'completed', updated_at = now() WHERE id = v_job.task_id;
    IF v_job.room_id IS NOT NULL THEN PERFORM public.hk_recalculate_room(v_job.room_id); END IF;

  ELSIF _action = 'cancel' THEN
    UPDATE public.housekeeping_jobs
       SET status = 'cancelled',
           skipped_reason = v_reason,
           notes = coalesce(notes || E'\n', '') || 'Cancelled: ' || v_reason,
           updated_at = now()
     WHERE id = _job;
    UPDATE public.tasks SET status = 'cancelled', updated_at = now() WHERE id = v_job.task_id;
    IF v_job.room_id IS NOT NULL THEN PERFORM public.hk_recalculate_room(v_job.room_id); END IF;

  ELSE -- replace
    IF v_job.room_id IS NULL THEN RAISE EXCEPTION 'Only a room task can be replaced'; END IF;
    UPDATE public.housekeeping_jobs
       SET status = 'cancelled',
           superseded_at = now(),
           supersede_reason = v_reason,
           notes = coalesce(notes || E'\n', '') || 'Superseded: ' || v_reason,
           updated_at = now()
     WHERE id = _job;
    UPDATE public.tasks SET status = 'cancelled', updated_at = now() WHERE id = v_job.task_id;

    v_new := public.hk_raise_cleaning_task(
      v_job.room_id, v_job.job_type, v_reason, v_job.priority, NULL,
      coalesce(_assignee, v_job.assignee_id), v_job.assigned_team, v_job.reservation_id,
      'replacement', _job, 'hk-replace:' || _job::text, gen_random_uuid());

    UPDATE public.housekeeping_jobs
       SET superseded_by = nullif(v_new->>'job_id','')::uuid
     WHERE id = _job;
  END IF;

  v_audit := public.log_audit_event(
    'housekeeping.task.' || _action, 'housekeeping', _job::text, v_before,
    (SELECT to_jsonb(j) FROM public.housekeeping_jobs j WHERE j.id = _job),
    v_reason, 'housekeeping.tasks.manage', v_job.branch_id, v_job.department_id, v_job.station_id,
    v_job.correlation_id::text, NULL, NULL);

  RETURN jsonb_build_object('ok', true, 'action', _action, 'job_id', _job,
    'replacement', v_new, 'audit_event_id', v_audit);
END $$;

REVOKE ALL ON FUNCTION public.hk_resolve_stale_job(uuid, text, text, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.hk_resolve_stale_job(uuid, text, text, uuid) TO authenticated;
