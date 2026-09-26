-- Housekeeping duplicate cleaning repair (additive; no history removed)

ALTER TABLE public.housekeeping_jobs
  ADD COLUMN IF NOT EXISTS superseded_by uuid REFERENCES public.housekeeping_jobs(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS superseded_at timestamptz,
  ADD COLUMN IF NOT EXISTS supersede_reason text;

-- Which statuses count as an open cleaning obligation.
CREATE OR REPLACE FUNCTION public.hk_job_status_is_active(_status text)
RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
  SELECT _status = ANY (ARRAY['pending','assigned','in-progress','awaiting-inspection','rework']);
$$;

-- Cleaning job types that compete for the same room. Deep-clean and other
-- scheduled programmes are deliberately excluded.
CREATE OR REPLACE FUNCTION public.hk_job_type_is_room_cleaning(_job_type text)
RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
  SELECT _job_type = ANY (ARRAY['checkout-cleaning','stayover-cleaning','daily-cleaning','cleaning','turnover-cleaning']);
$$;

-- Repair the rows that already exist: keep the most advanced, then most
-- recent, active cleaning job per room and supersede the rest with a reason.
DO $repair$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT j.id, j.organization_id, j.branch_id, j.department_id, j.room_id, j.status,
           keeper.id AS keeper_id
    FROM public.housekeeping_jobs j
    JOIN LATERAL (
      SELECT k.id
      FROM public.housekeeping_jobs k
      WHERE k.organization_id = j.organization_id
        AND k.room_id = j.room_id
        AND public.hk_job_status_is_active(k.status)
        AND public.hk_job_type_is_room_cleaning(k.job_type)
      ORDER BY array_position(
                 ARRAY['awaiting-inspection','in-progress','rework','assigned','pending'], k.status),
               k.created_at DESC
      LIMIT 1
    ) keeper ON true
    WHERE j.room_id IS NOT NULL
      AND public.hk_job_status_is_active(j.status)
      AND public.hk_job_type_is_room_cleaning(j.job_type)
      AND keeper.id <> j.id
  LOOP
    UPDATE public.housekeeping_jobs
       SET status = 'superseded',
           superseded_by = r.keeper_id,
           superseded_at = now(),
           supersede_reason = 'Duplicate active cleaning job for the same room — superseded by the retained job during the housekeeping duplicate repair.',
           updated_at = now()
     WHERE id = r.id;

    UPDATE public.tasks t
       SET status = 'cancelled', updated_at = now()
      FROM public.housekeeping_jobs j
     WHERE j.id = r.id AND t.id = j.task_id AND t.status <> 'completed';

    INSERT INTO public.audit_logs (organization_id, branch_id, department_id, user_name, action, module, record_id, previous_value, new_value, reason)
    VALUES (r.organization_id, r.branch_id, r.department_id, 'System', 'housekeeping.job.superseded', 'housekeeping', r.id::text,
            jsonb_build_object('status', r.status),
            jsonb_build_object('status', 'superseded', 'superseded_by', r.keeper_id),
            'Duplicate active cleaning job for the same room');
  END LOOP;
END
$repair$;

-- Prevent new duplicates: a fresh cleaning job supersedes any older active one.
CREATE OR REPLACE FUNCTION public.tg_housekeeping_single_active_room_job()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE
  r record;
BEGIN
  IF NEW.room_id IS NULL
     OR NOT public.hk_job_status_is_active(NEW.status)
     OR NOT public.hk_job_type_is_room_cleaning(NEW.job_type) THEN
    RETURN NEW;
  END IF;

  FOR r IN
    SELECT id, status, branch_id, department_id, task_id
    FROM public.housekeeping_jobs
    WHERE organization_id = NEW.organization_id
      AND room_id = NEW.room_id
      AND id <> NEW.id
      AND public.hk_job_status_is_active(status)
      AND public.hk_job_type_is_room_cleaning(job_type)
    FOR UPDATE
  LOOP
    UPDATE public.housekeeping_jobs
       SET status = 'superseded',
           superseded_by = NEW.id,
           superseded_at = now(),
           supersede_reason = 'Replaced by a newer cleaning job for the same room.',
           updated_at = now()
     WHERE id = r.id;

    UPDATE public.tasks
       SET status = 'cancelled', updated_at = now()
     WHERE id = r.task_id AND status <> 'completed';

    INSERT INTO public.audit_logs (organization_id, branch_id, department_id, user_id, user_name, action, module, record_id, previous_value, new_value, reason)
    VALUES (NEW.organization_id, r.branch_id, r.department_id, auth.uid(), 'System',
            'housekeeping.job.superseded', 'housekeeping', r.id::text,
            jsonb_build_object('status', r.status),
            jsonb_build_object('status', 'superseded', 'superseded_by', NEW.id),
            'Replaced by a newer cleaning job for the same room');
  END LOOP;

  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS housekeeping_single_active_room_job ON public.housekeeping_jobs;
CREATE TRIGGER housekeeping_single_active_room_job
BEFORE INSERT ON public.housekeeping_jobs
FOR EACH ROW EXECUTE FUNCTION public.tg_housekeeping_single_active_room_job();

-- Safety net once the data is clean.
CREATE UNIQUE INDEX IF NOT EXISTS housekeeping_jobs_one_active_room_clean_idx
  ON public.housekeeping_jobs (organization_id, room_id)
  WHERE room_id IS NOT NULL
    AND status IN ('pending','assigned','in-progress','awaiting-inspection','rework')
    AND job_type IN ('checkout-cleaning','stayover-cleaning','daily-cleaning','cleaning','turnover-cleaning');

-- Administrator-callable repair for the caller's own workspace.
CREATE OR REPLACE FUNCTION public.neo_housekeeping_dedupe_room_jobs(_reason text DEFAULT 'Manual housekeeping duplicate repair')
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE
  v_org uuid := public.current_org_id();
  v_count integer := 0;
  r record;
BEGIN
  IF v_org IS NULL THEN RAISE EXCEPTION 'Authenticated organization context required'; END IF;
  IF NOT (public.is_org_admin() OR public.has_permission('housekeeping', 'board.edit')) THEN
    RAISE EXCEPTION 'Housekeeping supervision permission required';
  END IF;

  FOR r IN
    SELECT j.id, j.branch_id, j.department_id, j.status, j.task_id, keeper.id AS keeper_id
    FROM public.housekeeping_jobs j
    JOIN LATERAL (
      SELECT k.id
      FROM public.housekeeping_jobs k
      WHERE k.organization_id = j.organization_id
        AND k.room_id = j.room_id
        AND public.hk_job_status_is_active(k.status)
        AND public.hk_job_type_is_room_cleaning(k.job_type)
      ORDER BY array_position(
                 ARRAY['awaiting-inspection','in-progress','rework','assigned','pending'], k.status),
               k.created_at DESC
      LIMIT 1
    ) keeper ON true
    WHERE j.organization_id = v_org
      AND j.room_id IS NOT NULL
      AND public.hk_job_status_is_active(j.status)
      AND public.hk_job_type_is_room_cleaning(j.job_type)
      AND keeper.id <> j.id
  LOOP
    UPDATE public.housekeeping_jobs
       SET status = 'superseded', superseded_by = r.keeper_id, superseded_at = now(),
           supersede_reason = _reason, updated_at = now()
     WHERE id = r.id;

    UPDATE public.tasks SET status = 'cancelled', updated_at = now()
     WHERE id = r.task_id AND status <> 'completed';

    INSERT INTO public.audit_logs (organization_id, branch_id, department_id, user_id, user_name, action, module, record_id, previous_value, new_value, reason)
    VALUES (v_org, r.branch_id, r.department_id, auth.uid(), 'System',
            'housekeeping.job.superseded', 'housekeeping', r.id::text,
            jsonb_build_object('status', r.status),
            jsonb_build_object('status', 'superseded', 'superseded_by', r.keeper_id),
            _reason);
    v_count := v_count + 1;
  END LOOP;

  RETURN v_count;
END
$$;

REVOKE ALL ON FUNCTION public.neo_housekeeping_dedupe_room_jobs(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.neo_housekeeping_dedupe_room_jobs(text) TO authenticated;