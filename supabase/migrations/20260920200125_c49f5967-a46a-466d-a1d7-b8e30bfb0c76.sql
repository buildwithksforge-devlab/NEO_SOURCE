-- 1. Housekeeper execution capability (template-level, so every org inherits it)
INSERT INTO public.role_feature_templates (role_key, module, feature, action)
SELECT v.role_key, v.module, v.feature, v.action
FROM (VALUES
  ('housekeeper','housekeeping','cleaning','start'),
  ('housekeeper','housekeeping','cleaning','complete'),
  ('housekeeper','maintenance','work-orders','create')
) AS v(role_key, module, feature, action)
WHERE EXISTS (
  SELECT 1 FROM public.permissions p
  WHERE p.module = v.module AND p.feature = v.feature AND p.action = v.action
)
AND NOT EXISTS (
  SELECT 1 FROM public.role_feature_templates t
  WHERE t.role_key = v.role_key AND t.module = v.module
    AND t.feature = v.feature AND t.action = v.action
);

-- 2. A generic task linked to a housekeeping job may never finish on its own.
CREATE OR REPLACE FUNCTION public.hk_guard_linked_task_state()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_job public.housekeeping_jobs;
BEGIN
  IF NEW.status IS NOT DISTINCT FROM OLD.status THEN
    RETURN NEW;
  END IF;
  IF NEW.status NOT IN ('completed', 'review', 'closed', 'done') THEN
    RETURN NEW;
  END IF;

  SELECT * INTO v_job
  FROM public.housekeeping_jobs
  WHERE task_id = NEW.id
  ORDER BY created_at DESC
  LIMIT 1;

  IF v_job.id IS NULL THEN
    RETURN NEW;
  END IF;

  IF v_job.status NOT IN ('completed', 'cancelled', 'closed', 'inspected', 'awaiting-inspection') THEN
    RAISE EXCEPTION
      'This task belongs to housekeeping job %. Finish the clean in Housekeeping — the task closes with it.',
      coalesce(v_job.job_number, v_job.id::text);
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS hk_guard_linked_task_state ON public.tasks;
CREATE TRIGGER hk_guard_linked_task_state
BEFORE UPDATE ON public.tasks
FOR EACH ROW
EXECUTE FUNCTION public.hk_guard_linked_task_state();