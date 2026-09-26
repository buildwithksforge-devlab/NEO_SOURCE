ALTER TABLE public.housekeeping_job_results
  ALTER COLUMN organization_id SET DEFAULT public.current_org_id(),
  ALTER COLUMN recorded_by SET DEFAULT auth.uid();

CREATE UNIQUE INDEX IF NOT EXISTS housekeeping_job_results_job_label_key
  ON public.housekeeping_job_results (job_id, label);

DROP POLICY IF EXISTS housekeeping_job_results_select ON public.housekeeping_job_results;
CREATE POLICY housekeeping_job_results_select
  ON public.housekeeping_job_results FOR SELECT
  USING (
    organization_id = public.current_org_id()
    AND EXISTS (
      SELECT 1 FROM public.housekeeping_jobs j
      WHERE j.id = housekeeping_job_results.job_id
    )
  );