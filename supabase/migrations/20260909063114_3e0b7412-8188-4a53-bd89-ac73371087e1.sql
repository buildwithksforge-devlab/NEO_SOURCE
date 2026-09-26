CREATE TABLE IF NOT EXISTS public.neo_test_environments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  control_org_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  test_org_id uuid,
  label text NOT NULL,
  kind text NOT NULL DEFAULT 'primary',
  owner_user_id uuid,
  branch_id uuid,
  accounts jsonb NOT NULL DEFAULT '[]'::jsonb,
  seed jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'active',
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  purged_at timestamptz
);

CREATE TABLE IF NOT EXISTS public.neo_test_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  control_org_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  run_ref text NOT NULL,
  environment text NOT NULL DEFAULT 'Simulation',
  status text NOT NULL DEFAULT 'running',
  totals jsonb NOT NULL DEFAULT '{}'::jsonb,
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  duration_ms integer,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS neo_test_runs_ref_idx ON public.neo_test_runs (control_org_id, run_ref);

CREATE TABLE IF NOT EXISTS public.neo_test_results (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id uuid NOT NULL REFERENCES public.neo_test_runs(id) ON DELETE CASCADE,
  control_org_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  suite text NOT NULL,
  suite_order integer NOT NULL DEFAULT 0,
  case_key text NOT NULL,
  name text NOT NULL,
  status text NOT NULL,
  severity text NOT NULL DEFAULT 'normal',
  duration_ms integer NOT NULL DEFAULT 0,
  assertions jsonb NOT NULL DEFAULT '[]'::jsonb,
  evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
  detail text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS neo_test_results_run_idx ON public.neo_test_results (run_id, suite_order);

GRANT SELECT ON public.neo_test_environments TO authenticated;
GRANT SELECT ON public.neo_test_runs TO authenticated;
GRANT SELECT ON public.neo_test_results TO authenticated;
GRANT ALL ON public.neo_test_environments TO service_role;
GRANT ALL ON public.neo_test_runs TO service_role;
GRANT ALL ON public.neo_test_results TO service_role;

ALTER TABLE public.neo_test_environments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.neo_test_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.neo_test_results ENABLE ROW LEVEL SECURITY;

CREATE POLICY neo_test_environments_read ON public.neo_test_environments
  FOR SELECT TO authenticated
  USING (control_org_id = public.current_org_id() AND public.is_org_admin_for(control_org_id));

CREATE POLICY neo_test_runs_read ON public.neo_test_runs
  FOR SELECT TO authenticated
  USING (control_org_id = public.current_org_id() AND public.is_org_admin_for(control_org_id));

CREATE POLICY neo_test_results_read ON public.neo_test_results
  FOR SELECT TO authenticated
  USING (control_org_id = public.current_org_id() AND public.is_org_admin_for(control_org_id));

CREATE TRIGGER neo_test_environments_touch BEFORE UPDATE ON public.neo_test_environments
  FOR EACH ROW EXECUTE FUNCTION public.bi_touch_updated_at();
CREATE TRIGGER neo_test_runs_touch BEFORE UPDATE ON public.neo_test_runs
  FOR EACH ROW EXECUTE FUNCTION public.bi_touch_updated_at();