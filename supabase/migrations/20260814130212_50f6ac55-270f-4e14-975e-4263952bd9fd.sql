
-- ============================================================
-- PHASE 16 — Analytics, BI & AI governance layer
-- ============================================================

-- New permission vocabulary (global catalogue table)
INSERT INTO public.permissions (module, action, label) VALUES
  ('analytics','view','View Analytics'),
  ('analytics','create','Create Analytics Objects'),
  ('analytics','edit','Manage Analytics'),
  ('analytics','delete','Delete Analytics Objects'),
  ('analytics','approve','Approve Metrics & Alerts'),
  ('analytics','export','Export Analytics'),
  ('analytics','print','Print Analytics'),
  ('analytics','override','Override Analytics Governance'),
  ('ai','view','View AI Outputs'),
  ('ai','create','Use AI Assistant'),
  ('ai','edit','Manage AI Models & Limits'),
  ('ai','delete','Delete AI Records'),
  ('ai','approve','Approve AI Recommendations'),
  ('ai','export','Export AI Outputs')
ON CONFLICT DO NOTHING;

-- Shared timestamp trigger
CREATE OR REPLACE FUNCTION public.bi_touch_updated_at()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END; $$;

-- ---------- KPI catalogue -----------------------------------
CREATE TABLE public.metric_definitions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  code text NOT NULL,
  name text NOT NULL,
  description text,
  business_meaning text,
  formula text,
  numerator text,
  denominator text,
  included_records text,
  excluded_records text,
  source_tables text[] NOT NULL DEFAULT '{}',
  date_field text,
  currency_treatment text,
  timezone text,
  organization_scope text NOT NULL DEFAULT 'organization',
  branch_scope text NOT NULL DEFAULT 'branch',
  department_scope text,
  unit text NOT NULL DEFAULT 'number',
  refresh_frequency text NOT NULL DEFAULT 'daily',
  owner_role text,
  version integer NOT NULL DEFAULT 1,
  effective_date date NOT NULL DEFAULT current_date,
  status text NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft','under_review','approved','active','deprecated')),
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, code, version)
);

CREATE TABLE public.metric_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  metric_id uuid NOT NULL REFERENCES public.metric_definitions(id) ON DELETE CASCADE,
  version integer NOT NULL,
  snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
  change_reason text,
  changed_by uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- ---------- Dashboards & preferences -------------------------
CREATE TABLE public.user_dashboard_preferences (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  user_id uuid NOT NULL,
  dashboard_key text NOT NULL,
  widgets jsonb NOT NULL DEFAULT '[]'::jsonb,
  filters jsonb NOT NULL DEFAULT '{}'::jsonb,
  comparison_period text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, dashboard_key)
);

-- ---------- Refresh + freshness ------------------------------
CREATE TABLE public.analytics_snapshots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  branch_id uuid REFERENCES public.branches(id) ON DELETE CASCADE,
  department_id uuid REFERENCES public.departments(id) ON DELETE SET NULL,
  metric_code text NOT NULL,
  data_period_start date NOT NULL,
  data_period_end date NOT NULL,
  value numeric(18,4),
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  data_quality text NOT NULL DEFAULT 'ok',
  generated_at timestamptz NOT NULL DEFAULT now(),
  idempotency_key text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, metric_code, branch_id, data_period_start, data_period_end)
);
CREATE INDEX idx_analytics_snapshots_lookup
  ON public.analytics_snapshots (organization_id, metric_code, data_period_end DESC);

CREATE TABLE public.analytics_refresh_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  job_key text NOT NULL,
  name text NOT NULL,
  frequency text NOT NULL DEFAULT 'daily',
  freshness_class text NOT NULL DEFAULT 'daily'
    CHECK (freshness_class IN ('realtime','near_realtime','hourly','daily','scheduled')),
  last_run_at timestamptz,
  last_success_at timestamptz,
  next_run_at timestamptz,
  status text NOT NULL DEFAULT 'idle'
    CHECK (status IN ('idle','running','succeeded','failed','stale')),
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, job_key)
);

CREATE TABLE public.analytics_alerts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  job_id uuid REFERENCES public.analytics_refresh_jobs(id) ON DELETE CASCADE,
  severity text NOT NULL DEFAULT 'warning',
  title text NOT NULL,
  body text,
  status text NOT NULL DEFAULT 'open',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- ---------- Data quality -------------------------------------
CREATE TABLE public.data_quality_rules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  code text NOT NULL,
  name text NOT NULL,
  category text NOT NULL,
  module text NOT NULL,
  severity text NOT NULL DEFAULT 'warning' CHECK (severity IN ('info','warning','critical')),
  description text,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, code)
);

CREATE TABLE public.data_quality_issues (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  branch_id uuid REFERENCES public.branches(id) ON DELETE CASCADE,
  rule_id uuid REFERENCES public.data_quality_rules(id) ON DELETE SET NULL,
  rule_code text NOT NULL,
  category text NOT NULL,
  severity text NOT NULL DEFAULT 'warning',
  module text NOT NULL,
  record_count integer NOT NULL DEFAULT 0,
  detail jsonb NOT NULL DEFAULT '{}'::jsonb,
  first_detected_at timestamptz NOT NULL DEFAULT now(),
  last_detected_at timestamptz NOT NULL DEFAULT now(),
  owner_id uuid,
  status text NOT NULL DEFAULT 'open'
    CHECK (status IN ('open','acknowledged','resolved','ignored')),
  resolution_notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, rule_code, branch_id)
);

-- ---------- Forecasting --------------------------------------
CREATE TABLE public.forecast_models (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  code text NOT NULL,
  name text NOT NULL,
  method text NOT NULL,
  description text,
  version text NOT NULL DEFAULT 'v1',
  min_history_days integer NOT NULL DEFAULT 28,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, code, version)
);

CREATE TABLE public.forecasts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  branch_id uuid REFERENCES public.branches(id) ON DELETE CASCADE,
  department_id uuid REFERENCES public.departments(id) ON DELETE SET NULL,
  metric_code text NOT NULL,
  model_id uuid REFERENCES public.forecast_models(id) ON DELETE SET NULL,
  model_version text NOT NULL DEFAULT 'v1',
  horizon_days integer NOT NULL,
  input_period_start date NOT NULL,
  input_period_end date NOT NULL,
  data_sufficiency text NOT NULL DEFAULT 'sufficient'
    CHECK (data_sufficiency IN ('sufficient','limited','insufficient')),
  limitations text,
  generated_at timestamptz NOT NULL DEFAULT now(),
  generated_by uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_forecasts_metric ON public.forecasts (organization_id, metric_code, generated_at DESC);

CREATE TABLE public.forecast_values (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  forecast_id uuid NOT NULL REFERENCES public.forecasts(id) ON DELETE CASCADE,
  target_date date NOT NULL,
  predicted_value numeric(18,4) NOT NULL,
  lower_bound numeric(18,4),
  upper_bound numeric(18,4),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (forecast_id, target_date)
);

CREATE TABLE public.forecast_actuals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  forecast_id uuid NOT NULL REFERENCES public.forecasts(id) ON DELETE CASCADE,
  target_date date NOT NULL,
  predicted_value numeric(18,4) NOT NULL,
  actual_value numeric(18,4) NOT NULL,
  absolute_error numeric(18,4) NOT NULL,
  percentage_error numeric(10,4),
  recorded_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (forecast_id, target_date)
);

-- ---------- AI recommendations -------------------------------
CREATE TABLE public.ai_recommendations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  branch_id uuid REFERENCES public.branches(id) ON DELETE CASCADE,
  department_id uuid REFERENCES public.departments(id) ON DELETE SET NULL,
  reference text NOT NULL,
  title text NOT NULL,
  category text NOT NULL,
  observation text NOT NULL,
  supporting_data jsonb NOT NULL DEFAULT '{}'::jsonb,
  recommended_action text NOT NULL,
  expected_impact text,
  confidence text NOT NULL DEFAULT 'medium' CHECK (confidence IN ('low','medium','high')),
  limitations text,
  generated_by text NOT NULL DEFAULT 'rules',
  model_version text,
  data_period_start date,
  data_period_end date,
  expires_at timestamptz,
  status text NOT NULL DEFAULT 'new'
    CHECK (status IN ('new','reviewed','accepted','dismissed','converted','expired','resolved')),
  response_notes text,
  task_id uuid REFERENCES public.tasks(id) ON DELETE SET NULL,
  reviewed_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, reference)
);

CREATE TABLE public.ai_recommendation_evidence (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  recommendation_id uuid NOT NULL REFERENCES public.ai_recommendations(id) ON DELETE CASCADE,
  metric_code text,
  source_table text,
  source_record_id text,
  observed_value numeric(18,4),
  note text,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- ---------- Risk & anomalies ---------------------------------
CREATE TABLE public.risk_rules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  code text NOT NULL,
  name text NOT NULL,
  category text NOT NULL,
  rule_type text NOT NULL DEFAULT 'rule' CHECK (rule_type IN ('rule','statistical')),
  description text,
  threshold numeric(18,4),
  comparison text NOT NULL DEFAULT 'gt',
  window_days integer NOT NULL DEFAULT 7,
  severity text NOT NULL DEFAULT 'warning' CHECK (severity IN ('info','warning','critical')),
  version integer NOT NULL DEFAULT 1,
  active boolean NOT NULL DEFAULT true,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, code)
);

CREATE TABLE public.risk_alerts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  branch_id uuid REFERENCES public.branches(id) ON DELETE CASCADE,
  alert_number text NOT NULL,
  rule_id uuid REFERENCES public.risk_rules(id) ON DELETE SET NULL,
  rule_code text NOT NULL,
  rule_version integer NOT NULL DEFAULT 1,
  category text NOT NULL,
  severity text NOT NULL DEFAULT 'warning',
  observed_value numeric(18,4),
  expected_low numeric(18,4),
  expected_high numeric(18,4),
  explanation text NOT NULL,
  data_period_start date,
  data_period_end date,
  assigned_to uuid,
  status text NOT NULL DEFAULT 'new'
    CHECK (status IN ('new','under_review','investigating','confirmed','false_positive','resolved','escalated','closed')),
  investigation_notes text,
  resolution text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, alert_number)
);

CREATE TABLE public.risk_alert_evidence (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  alert_id uuid NOT NULL REFERENCES public.risk_alerts(id) ON DELETE CASCADE,
  source_module text NOT NULL,
  source_table text,
  source_record_id text,
  observed_value numeric(18,4),
  note text,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- ---------- Reporting ----------------------------------------
CREATE TABLE public.report_definitions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  code text NOT NULL,
  name text NOT NULL,
  report_type text NOT NULL,
  description text,
  permission_module text NOT NULL DEFAULT 'analytics',
  sensitive boolean NOT NULL DEFAULT false,
  default_filters jsonb NOT NULL DEFAULT '{}'::jsonb,
  metrics text[] NOT NULL DEFAULT '{}',
  version integer NOT NULL DEFAULT 1,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, code)
);

CREATE TABLE public.report_schedules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  branch_id uuid REFERENCES public.branches(id) ON DELETE CASCADE,
  report_id uuid NOT NULL REFERENCES public.report_definitions(id) ON DELETE CASCADE,
  name text NOT NULL,
  filters jsonb NOT NULL DEFAULT '{}'::jsonb,
  frequency text NOT NULL DEFAULT 'daily'
    CHECK (frequency IN ('daily','weekly','monthly','quarterly')),
  run_at_time time NOT NULL DEFAULT '07:00',
  timezone text NOT NULL DEFAULT 'Africa/Nairobi',
  recipients jsonb NOT NULL DEFAULT '[]'::jsonb,
  channels text[] NOT NULL DEFAULT '{library}',
  format text NOT NULL DEFAULT 'pdf',
  next_run_at timestamptz,
  last_run_at timestamptz,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','paused','failed')),
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.report_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  schedule_id uuid REFERENCES public.report_schedules(id) ON DELETE SET NULL,
  report_id uuid NOT NULL REFERENCES public.report_definitions(id) ON DELETE CASCADE,
  branch_id uuid REFERENCES public.branches(id) ON DELETE CASCADE,
  data_period_start date,
  data_period_end date,
  status text NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued','running','succeeded','failed')),
  error text,
  idempotency_key text,
  started_at timestamptz,
  finished_at timestamptz,
  triggered_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, idempotency_key)
);

CREATE TABLE public.generated_reports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  branch_id uuid REFERENCES public.branches(id) ON DELETE CASCADE,
  run_id uuid REFERENCES public.report_runs(id) ON DELETE SET NULL,
  report_id uuid NOT NULL REFERENCES public.report_definitions(id) ON DELETE CASCADE,
  name text NOT NULL,
  report_type text NOT NULL,
  data_period_start date,
  data_period_end date,
  format text NOT NULL DEFAULT 'pdf',
  storage_path text,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  sensitive boolean NOT NULL DEFAULT false,
  source_version text,
  generated_by uuid,
  generated_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz,
  status text NOT NULL DEFAULT 'available',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.report_deliveries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  generated_report_id uuid REFERENCES public.generated_reports(id) ON DELETE CASCADE,
  schedule_id uuid REFERENCES public.report_schedules(id) ON DELETE SET NULL,
  channel text NOT NULL,
  recipient_user_id uuid,
  recipient_address text,
  permission_checked boolean NOT NULL DEFAULT false,
  status text NOT NULL DEFAULT 'not_configured'
    CHECK (status IN ('not_configured','queued','sent','failed','blocked')),
  detail text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- ---------- AI governance ------------------------------------
CREATE TABLE public.ai_model_registry (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  provider text NOT NULL,
  model_name text NOT NULL,
  use_case text NOT NULL,
  allowed_data_classes text[] NOT NULL DEFAULT '{}',
  prohibited_data_classes text[] NOT NULL DEFAULT '{}',
  temperature numeric(4,2) NOT NULL DEFAULT 0.2,
  configuration jsonb NOT NULL DEFAULT '{}'::jsonb,
  monthly_cost_limit numeric(12,2),
  status text NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft','testing','approved','active','paused','retired')),
  evaluation_result text,
  approved_by uuid,
  effective_date date NOT NULL DEFAULT current_date,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, provider, model_name, use_case)
);

CREATE TABLE public.ai_prompt_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  model_id uuid REFERENCES public.ai_model_registry(id) ON DELETE CASCADE,
  feature text NOT NULL,
  version text NOT NULL,
  prompt_template text NOT NULL,
  change_reason text,
  status text NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft','testing','approved','active','retired')),
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, feature, version)
);

CREATE TABLE public.ai_feature_limits (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  feature text NOT NULL,
  enabled boolean NOT NULL DEFAULT true,
  daily_request_limit integer NOT NULL DEFAULT 200,
  per_user_daily_limit integer NOT NULL DEFAULT 50,
  monthly_budget numeric(12,2),
  max_response_chars integer NOT NULL DEFAULT 4000,
  cache_minutes integer NOT NULL DEFAULT 15,
  model_id uuid REFERENCES public.ai_model_registry(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, feature)
);

CREATE TABLE public.ai_usage_records (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  user_id uuid,
  feature text NOT NULL,
  model text,
  request_count integer NOT NULL DEFAULT 1,
  prompt_tokens integer NOT NULL DEFAULT 0,
  completion_tokens integer NOT NULL DEFAULT 0,
  estimated_cost numeric(12,6) NOT NULL DEFAULT 0,
  cache_hit boolean NOT NULL DEFAULT false,
  usage_date date NOT NULL DEFAULT current_date,
  error text,
  limit_status text NOT NULL DEFAULT 'ok',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_ai_usage_org_date ON public.ai_usage_records (organization_id, usage_date DESC);

-- ---------- AI assistant history -----------------------------
CREATE TABLE public.ai_conversations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  user_id uuid NOT NULL,
  branch_id uuid REFERENCES public.branches(id) ON DELETE SET NULL,
  title text NOT NULL DEFAULT 'New conversation',
  branch_scope jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.ai_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  conversation_id uuid NOT NULL REFERENCES public.ai_conversations(id) ON DELETE CASCADE,
  user_id uuid NOT NULL,
  role text NOT NULL CHECK (role IN ('user','assistant','system')),
  content text NOT NULL,
  answer_kind text,
  sources jsonb NOT NULL DEFAULT '[]'::jsonb,
  metric_codes text[] NOT NULL DEFAULT '{}',
  data_period_start date,
  data_period_end date,
  safety_outcome text NOT NULL DEFAULT 'ok',
  model text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_ai_messages_conv ON public.ai_messages (conversation_id, created_at);

CREATE TABLE public.ai_query_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  user_id uuid NOT NULL,
  conversation_id uuid REFERENCES public.ai_conversations(id) ON DELETE SET NULL,
  question text NOT NULL,
  resolved_intent text,
  approved_query text,
  branch_scope uuid,
  data_period_start date,
  data_period_end date,
  sources_used text[] NOT NULL DEFAULT '{}',
  result_classification text NOT NULL DEFAULT 'fact',
  refused boolean NOT NULL DEFAULT false,
  refusal_reason text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.ai_feedback (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  user_id uuid NOT NULL,
  message_id uuid REFERENCES public.ai_messages(id) ON DELETE CASCADE,
  recommendation_id uuid REFERENCES public.ai_recommendations(id) ON DELETE CASCADE,
  rating text NOT NULL
    CHECK (rating IN ('helpful','not_helpful','incorrect','outdated','unsafe','missing_context')),
  comment text,
  corrected_value text,
  review_status text NOT NULL DEFAULT 'new',
  created_at timestamptz NOT NULL DEFAULT now()
);

-- ============================================================
-- GRANTS
-- ============================================================
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'metric_definitions','metric_versions','user_dashboard_preferences','analytics_snapshots',
    'analytics_refresh_jobs','analytics_alerts','data_quality_rules','data_quality_issues',
    'forecast_models','forecasts','forecast_values','forecast_actuals',
    'ai_recommendations','ai_recommendation_evidence','risk_rules','risk_alerts','risk_alert_evidence',
    'report_definitions','report_schedules','report_runs','generated_reports','report_deliveries',
    'ai_model_registry','ai_prompt_versions','ai_feature_limits','ai_usage_records',
    'ai_conversations','ai_messages','ai_query_logs','ai_feedback'
  ] LOOP
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON public.%I TO authenticated', t);
    EXECUTE format('GRANT ALL ON public.%I TO service_role', t);
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE TRIGGER touch_%s BEFORE UPDATE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.bi_touch_updated_at()', t, t);
  END LOOP;
EXCEPTION WHEN undefined_column THEN NULL;
END $$;

-- Some tables have no updated_at; drop those triggers safely.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'metric_versions','analytics_snapshots','forecast_values','forecast_actuals',
    'ai_recommendation_evidence','risk_alert_evidence','report_runs','generated_reports',
    'ai_prompt_versions','ai_usage_records','ai_messages','ai_query_logs','ai_feedback','forecasts'
  ] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS touch_%s ON public.%I', t, t);
  END LOOP;
END $$;

-- ============================================================
-- RLS POLICIES
-- ============================================================

-- Read: analytics viewers within the tenant. Write: analytics editors/admins.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'metric_definitions','metric_versions','analytics_snapshots','analytics_refresh_jobs',
    'analytics_alerts','data_quality_rules','data_quality_issues','forecast_models','forecasts',
    'forecast_values','forecast_actuals','ai_recommendations','ai_recommendation_evidence',
    'risk_rules','risk_alerts','risk_alert_evidence','report_definitions','report_schedules',
    'report_runs','generated_reports','report_deliveries','ai_model_registry','ai_prompt_versions',
    'ai_feature_limits','ai_usage_records'
  ] LOOP
    EXECUTE format($f$
      CREATE POLICY "%1$s_select" ON public.%1$I FOR SELECT TO authenticated
      USING (organization_id = public.current_org_id()
             AND (public.is_org_admin() OR public.has_permission('analytics','view') OR public.has_permission('ai','view')))
    $f$, t);
    EXECUTE format($f$
      CREATE POLICY "%1$s_insert" ON public.%1$I FOR INSERT TO authenticated
      WITH CHECK (organization_id = public.current_org_id()
             AND (public.is_org_admin() OR public.has_permission('analytics','create') OR public.has_permission('analytics','edit')))
    $f$, t);
    EXECUTE format($f$
      CREATE POLICY "%1$s_update" ON public.%1$I FOR UPDATE TO authenticated
      USING (organization_id = public.current_org_id()
             AND (public.is_org_admin() OR public.has_permission('analytics','edit')))
      WITH CHECK (organization_id = public.current_org_id())
    $f$, t);
    EXECUTE format($f$
      CREATE POLICY "%1$s_delete" ON public.%1$I FOR DELETE TO authenticated
      USING (organization_id = public.current_org_id()
             AND (public.is_org_admin() OR public.has_permission('analytics','delete')))
    $f$, t);
  END LOOP;
END $$;

-- User-owned records: dashboards, conversations, messages, query logs, feedback.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['user_dashboard_preferences','ai_conversations','ai_messages','ai_query_logs','ai_feedback'] LOOP
    EXECUTE format($f$
      CREATE POLICY "%1$s_own" ON public.%1$I FOR ALL TO authenticated
      USING (organization_id = public.current_org_id() AND user_id = auth.uid())
      WITH CHECK (organization_id = public.current_org_id() AND user_id = auth.uid())
    $f$, t);
  END LOOP;
END $$;
