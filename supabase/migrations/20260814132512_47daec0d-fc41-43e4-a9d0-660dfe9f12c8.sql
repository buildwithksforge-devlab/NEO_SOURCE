
-- =====================================================================
-- PHASE 17 — Integrations, environments, commercial, quality, support
-- =====================================================================

CREATE TABLE public.platform_admins (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL UNIQUE,
  platform_role text NOT NULL DEFAULT 'platform_admin',
  active boolean NOT NULL DEFAULT true,
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT ON public.platform_admins TO authenticated;
GRANT ALL ON public.platform_admins TO service_role;
ALTER TABLE public.platform_admins ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION public.is_platform_admin()
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (SELECT 1 FROM public.platform_admins p WHERE p.user_id = auth.uid() AND p.active)
$$;
REVOKE EXECUTE ON FUNCTION public.is_platform_admin() FROM public, anon;
GRANT EXECUTE ON FUNCTION public.is_platform_admin() TO authenticated, service_role;

CREATE POLICY "platform_admins_self_read" ON public.platform_admins
  FOR SELECT TO authenticated USING (user_id = auth.uid() OR public.is_platform_admin());
CREATE POLICY "platform_admins_manage" ON public.platform_admins
  FOR ALL TO authenticated USING (public.is_platform_admin()) WITH CHECK (public.is_platform_admin());

CREATE TABLE public.environment_registry (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  key text NOT NULL UNIQUE,
  name text NOT NULL,
  kind text NOT NULL DEFAULT 'development',
  banner_label text,
  is_production boolean NOT NULL DEFAULT false,
  project_reference_masked text,
  webhook_base_url text,
  checklist jsonb NOT NULL DEFAULT '[]'::jsonb,
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.feature_flags (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  key text NOT NULL UNIQUE,
  name text NOT NULL,
  description text,
  scope text NOT NULL DEFAULT 'platform',
  environment text,
  default_enabled boolean NOT NULL DEFAULT false,
  beta boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.feature_flag_overrides (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  flag_id uuid NOT NULL REFERENCES public.feature_flags(id) ON DELETE CASCADE,
  organization_id uuid REFERENCES public.organizations(id) ON DELETE CASCADE,
  branch_id uuid REFERENCES public.branches(id) ON DELETE CASCADE,
  plan_code text,
  environment text,
  enabled boolean NOT NULL DEFAULT false,
  reason text,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.subscription_plans (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text NOT NULL UNIQUE,
  name text NOT NULL,
  description text,
  billing_frequency text NOT NULL DEFAULT 'annual',
  currency text NOT NULL DEFAULT 'KES',
  licence_fee numeric(14,2),
  hosting_fee numeric(14,2),
  setup_fee numeric(14,2),
  training_fee numeric(14,2),
  limits jsonb NOT NULL DEFAULT '{}'::jsonb,
  entitlements text[] NOT NULL DEFAULT '{}',
  support_plan_code text,
  is_custom boolean NOT NULL DEFAULT false,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.organization_subscriptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  plan_id uuid REFERENCES public.subscription_plans(id),
  status text NOT NULL DEFAULT 'trial',
  trial_ends_at date,
  contract_start date,
  contract_end date,
  current_period_start date,
  current_period_end date,
  grace_until date,
  renewal_date date,
  billing_frequency text NOT NULL DEFAULT 'annual',
  currency text NOT NULL DEFAULT 'KES',
  licence_fee numeric(14,2),
  hosting_fee numeric(14,2),
  setup_fee numeric(14,2),
  training_fee numeric(14,2),
  discount numeric(14,2),
  tax_rate numeric(6,2),
  invoice_reference text,
  payment_status text NOT NULL DEFAULT 'not_invoiced',
  account_manager text,
  is_demo boolean NOT NULL DEFAULT false,
  is_pilot boolean NOT NULL DEFAULT false,
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX organization_subscriptions_org_idx ON public.organization_subscriptions(organization_id);

CREATE TABLE public.subscription_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  subscription_id uuid REFERENCES public.organization_subscriptions(id) ON DELETE CASCADE,
  event_type text NOT NULL,
  from_status text,
  to_status text,
  effective_date date,
  actor_id uuid,
  notes text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.organization_entitlements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  feature_key text NOT NULL,
  enabled boolean NOT NULL DEFAULT true,
  source text NOT NULL DEFAULT 'plan',
  limit_value numeric,
  expires_at date,
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, feature_key)
);

CREATE OR REPLACE FUNCTION public.org_has_entitlement(_feature text)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT COALESCE(
    (SELECT e.enabled FROM public.organization_entitlements e
      WHERE e.organization_id = public.current_org_id() AND e.feature_key = _feature
        AND (e.expires_at IS NULL OR e.expires_at >= current_date)),
    EXISTS (
      SELECT 1 FROM public.organization_subscriptions s
      JOIN public.subscription_plans p ON p.id = s.plan_id
      WHERE s.organization_id = public.current_org_id()
        AND s.status IN ('trial','active','grace_period')
        AND _feature = ANY (p.entitlements)),
    false)
$$;
REVOKE EXECUTE ON FUNCTION public.org_has_entitlement(text) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.org_has_entitlement(text) TO authenticated, service_role;

CREATE TABLE public.integration_providers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text NOT NULL UNIQUE,
  name text NOT NULL,
  category text NOT NULL,
  purpose text,
  documentation_url text,
  requires_partner_approval boolean NOT NULL DEFAULT false,
  supports_webhooks boolean NOT NULL DEFAULT false,
  supports_sandbox boolean NOT NULL DEFAULT true,
  required_secret_names text[] NOT NULL DEFAULT '{}',
  sort_order integer NOT NULL DEFAULT 100,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.integration_connections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  branch_id uuid REFERENCES public.branches(id) ON DELETE SET NULL,
  provider_code text NOT NULL REFERENCES public.integration_providers(code) ON UPDATE CASCADE,
  environment text NOT NULL DEFAULT 'sandbox',
  status text NOT NULL DEFAULT 'not_configured',
  health text NOT NULL DEFAULT 'unknown',
  enabled boolean NOT NULL DEFAULT false,
  masked_identifier text,
  configuration jsonb NOT NULL DEFAULT '{}'::jsonb,
  secret_names jsonb NOT NULL DEFAULT '[]'::jsonb,
  credentials_expire_at date,
  last_success_at timestamptz,
  last_webhook_at timestamptz,
  last_error text,
  last_error_at timestamptz,
  error_count integer NOT NULL DEFAULT 0,
  sandbox_test_passed_at timestamptz,
  security_review_passed_at timestamptz,
  production_approved_at timestamptz,
  production_approved_by uuid,
  verification_notes text,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, provider_code, environment, branch_id)
);

CREATE TABLE public.integration_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  branch_id uuid REFERENCES public.branches(id) ON DELETE SET NULL,
  connection_id uuid REFERENCES public.integration_connections(id) ON DELETE SET NULL,
  provider_code text NOT NULL,
  event_type text NOT NULL,
  direction text NOT NULL DEFAULT 'outbound',
  source_module text,
  source_record_id uuid,
  idempotency_key text NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  payload_reference text,
  status text NOT NULL DEFAULT 'pending',
  attempt_count integer NOT NULL DEFAULT 0,
  max_attempts integer NOT NULL DEFAULT 5,
  next_retry_at timestamptz,
  provider_reference text,
  response_code text,
  error_message text,
  dead_lettered_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, provider_code, idempotency_key)
);
CREATE INDEX integration_events_status_idx ON public.integration_events(organization_id, status, next_retry_at);

CREATE TABLE public.integration_webhook_receipts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid REFERENCES public.organizations(id) ON DELETE CASCADE,
  provider_code text NOT NULL,
  external_event_id text NOT NULL,
  event_type text,
  signature_verified boolean NOT NULL DEFAULT false,
  replay_detected boolean NOT NULL DEFAULT false,
  processed boolean NOT NULL DEFAULT false,
  processed_at timestamptz,
  safe_summary jsonb NOT NULL DEFAULT '{}'::jsonb,
  error_message text,
  received_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider_code, external_event_id)
);

CREATE TABLE public.integration_test_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  connection_id uuid REFERENCES public.integration_connections(id) ON DELETE CASCADE,
  provider_code text NOT NULL,
  environment text NOT NULL DEFAULT 'sandbox',
  test_type text NOT NULL DEFAULT 'connection',
  status text NOT NULL DEFAULT 'not_configured',
  duration_ms integer,
  request_summary text,
  response_summary text,
  error_message text,
  run_by uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.data_migration_batches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  branch_id uuid REFERENCES public.branches(id) ON DELETE SET NULL,
  reference text NOT NULL,
  data_type text NOT NULL,
  status text NOT NULL DEFAULT 'draft',
  source_filename text,
  storage_path text,
  row_count integer NOT NULL DEFAULT 0,
  valid_rows integer NOT NULL DEFAULT 0,
  invalid_rows integer NOT NULL DEFAULT 0,
  imported_rows integer NOT NULL DEFAULT 0,
  column_mapping jsonb NOT NULL DEFAULT '{}'::jsonb,
  validation_summary jsonb NOT NULL DEFAULT '{}'::jsonb,
  dry_run_summary jsonb NOT NULL DEFAULT '{}'::jsonb,
  import_summary jsonb NOT NULL DEFAULT '{}'::jsonb,
  reconciliation jsonb NOT NULL DEFAULT '{}'::jsonb,
  checkpoint_reference text,
  approved_by uuid,
  approved_at timestamptz,
  signed_off_by uuid,
  signed_off_at timestamptz,
  locked_at timestamptz,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, reference)
);

CREATE TABLE public.data_migration_rows (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  batch_id uuid NOT NULL REFERENCES public.data_migration_batches(id) ON DELETE CASCADE,
  row_number integer NOT NULL,
  raw_values jsonb NOT NULL DEFAULT '{}'::jsonb,
  normalized_values jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'pending',
  errors jsonb NOT NULL DEFAULT '[]'::jsonb,
  warnings jsonb NOT NULL DEFAULT '[]'::jsonb,
  duplicate_of text,
  imported_record_id uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX data_migration_rows_batch_idx ON public.data_migration_rows(batch_id, row_number);

CREATE TABLE public.test_suites (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid REFERENCES public.organizations(id) ON DELETE CASCADE,
  code text NOT NULL,
  name text NOT NULL,
  category text NOT NULL DEFAULT 'regression',
  description text,
  release_blocking boolean NOT NULL DEFAULT false,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, code)
);

CREATE TABLE public.test_cases (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid REFERENCES public.organizations(id) ON DELETE CASCADE,
  suite_id uuid NOT NULL REFERENCES public.test_suites(id) ON DELETE CASCADE,
  code text NOT NULL,
  title text NOT NULL,
  journey text,
  role_scope text,
  preconditions text,
  steps text,
  expected_result text,
  release_blocking boolean NOT NULL DEFAULT false,
  sort_order integer NOT NULL DEFAULT 100,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.test_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid REFERENCES public.organizations(id) ON DELETE CASCADE,
  suite_id uuid REFERENCES public.test_suites(id) ON DELETE SET NULL,
  environment text NOT NULL DEFAULT 'testing',
  status text NOT NULL DEFAULT 'not_run',
  passed integer NOT NULL DEFAULT 0,
  failed integer NOT NULL DEFAULT 0,
  blocked integer NOT NULL DEFAULT 0,
  not_configured integer NOT NULL DEFAULT 0,
  not_applicable integer NOT NULL DEFAULT 0,
  evidence_reference text,
  notes text,
  started_at timestamptz,
  finished_at timestamptz,
  run_by uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.test_case_results (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid REFERENCES public.organizations(id) ON DELETE CASCADE,
  run_id uuid NOT NULL REFERENCES public.test_runs(id) ON DELETE CASCADE,
  case_id uuid REFERENCES public.test_cases(id) ON DELETE SET NULL,
  status text NOT NULL DEFAULT 'not_run',
  actual_result text,
  evidence_reference text,
  severity text,
  tester uuid,
  tested_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.defects (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid REFERENCES public.organizations(id) ON DELETE CASCADE,
  branch_id uuid REFERENCES public.branches(id) ON DELETE SET NULL,
  reference text NOT NULL,
  environment text NOT NULL DEFAULT 'testing',
  module text NOT NULL,
  summary text NOT NULL,
  steps_to_reproduce text,
  expected_result text,
  actual_result text,
  severity text NOT NULL DEFAULT 'medium',
  priority text NOT NULL DEFAULT 'normal',
  status text NOT NULL DEFAULT 'new',
  release_blocking boolean NOT NULL DEFAULT false,
  evidence_reference text,
  owner_id uuid,
  fix_version text,
  retest_status text,
  regression_status text,
  reported_by uuid,
  resolved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.uat_signoffs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  role_scope text NOT NULL,
  script_name text NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  tester_name text,
  tested_at timestamptz,
  evidence_reference text,
  defect_reference text,
  signed_by uuid,
  signed_at timestamptz,
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.security_findings_register (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid REFERENCES public.organizations(id) ON DELETE CASCADE,
  reference text NOT NULL,
  title text NOT NULL,
  category text,
  severity text NOT NULL DEFAULT 'medium',
  affected_component text,
  evidence text,
  remediation text,
  owner_id uuid,
  status text NOT NULL DEFAULT 'open',
  retest_status text,
  release_blocking boolean NOT NULL DEFAULT false,
  detected_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.releases (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  version text NOT NULL UNIQUE,
  name text,
  status text NOT NULL DEFAULT 'planned',
  environment text NOT NULL DEFAULT 'staging',
  released_at timestamptz,
  features text,
  fixes text,
  breaking_changes text,
  migrations text,
  known_issues text,
  rollback_notes text,
  tenant_release_notes text,
  approved_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.deployment_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  release_id uuid REFERENCES public.releases(id) ON DELETE CASCADE,
  environment text NOT NULL,
  action text NOT NULL,
  status text NOT NULL DEFAULT 'succeeded',
  actor_id uuid,
  notes text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.backup_records (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid REFERENCES public.organizations(id) ON DELETE CASCADE,
  backup_type text NOT NULL DEFAULT 'database',
  scope text NOT NULL DEFAULT 'platform',
  environment text NOT NULL DEFAULT 'production',
  taken_at timestamptz NOT NULL DEFAULT now(),
  location_reference text,
  verified boolean NOT NULL DEFAULT false,
  restore_tested_at timestamptz,
  restore_result text,
  retention_until date,
  notes text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.monitoring_checks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text NOT NULL UNIQUE,
  name text NOT NULL,
  target text,
  environment text NOT NULL DEFAULT 'production',
  category text NOT NULL DEFAULT 'availability',
  status text NOT NULL DEFAULT 'not_configured',
  threshold_ms integer,
  last_checked_at timestamptz,
  last_latency_ms integer,
  last_error text,
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.service_incidents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid REFERENCES public.organizations(id) ON DELETE CASCADE,
  reference text NOT NULL,
  title text NOT NULL,
  severity text NOT NULL DEFAULT 'minor',
  status text NOT NULL DEFAULT 'investigating',
  impact text,
  affected_services text[] NOT NULL DEFAULT '{}',
  customer_message text,
  started_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz,
  root_cause text,
  owner_id uuid,
  show_banner boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.readiness_gates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid REFERENCES public.organizations(id) ON DELETE CASCADE,
  gate_key text NOT NULL,
  name text NOT NULL,
  category text NOT NULL DEFAULT 'quality',
  mandatory boolean NOT NULL DEFAULT true,
  status text NOT NULL DEFAULT 'not_started',
  evidence_reference text,
  owner_id uuid,
  verified_by uuid,
  verified_at timestamptz,
  notes text,
  sort_order integer NOT NULL DEFAULT 100,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, gate_key)
);

CREATE TABLE public.support_plans (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text NOT NULL UNIQUE,
  name text NOT NULL,
  first_response_minutes integer,
  resolution_minutes integer,
  business_hours text,
  escalation_path text,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.support_tickets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  branch_id uuid REFERENCES public.branches(id) ON DELETE SET NULL,
  reference text NOT NULL,
  module text NOT NULL,
  severity text NOT NULL DEFAULT 'medium',
  subject text NOT NULL,
  description text NOT NULL,
  attachment_path text,
  affected_users text,
  inspection_consent boolean NOT NULL DEFAULT false,
  status text NOT NULL DEFAULT 'new',
  support_plan_code text,
  assigned_agent_id uuid,
  first_response_at timestamptz,
  resolved_at timestamptz,
  resolution text,
  satisfaction_rating integer,
  sla_breached boolean NOT NULL DEFAULT false,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, reference)
);

CREATE TABLE public.support_ticket_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  ticket_id uuid NOT NULL REFERENCES public.support_tickets(id) ON DELETE CASCADE,
  author_id uuid,
  author_type text NOT NULL DEFAULT 'customer',
  body text NOT NULL,
  internal_only boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.support_access_grants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  agent_user_id uuid NOT NULL,
  ticket_id uuid REFERENCES public.support_tickets(id) ON DELETE SET NULL,
  reason text NOT NULL,
  scope text NOT NULL DEFAULT 'read_only',
  granted_by uuid,
  granted_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.knowledge_articles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid REFERENCES public.organizations(id) ON DELETE CASCADE,
  slug text NOT NULL,
  title text NOT NULL,
  audience text NOT NULL DEFAULT 'all_staff',
  module text,
  summary text,
  content text NOT NULL,
  version text NOT NULL DEFAULT '1.0',
  status text NOT NULL DEFAULT 'draft',
  owner text,
  related_slugs text[] NOT NULL DEFAULT '{}',
  last_reviewed_at date,
  sort_order integer NOT NULL DEFAULT 100,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX knowledge_articles_slug_idx
  ON public.knowledge_articles(COALESCE(organization_id, '00000000-0000-0000-0000-000000000000'::uuid), slug);

-- =====================================================================
-- Grants, RLS and policies
-- =====================================================================
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['environment_registry','feature_flags','feature_flag_overrides',
                           'subscription_plans','integration_providers','support_plans',
                           'monitoring_checks','releases','deployment_events','backup_records']
  LOOP
    EXECUTE format('GRANT SELECT ON public.%I TO authenticated', t);
    EXECUTE format('GRANT ALL ON public.%I TO service_role', t);
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY "%1$s_read" ON public.%1$I FOR SELECT TO authenticated USING (true)$p$, t);
    EXECUTE format($p$CREATE POLICY "%1$s_write" ON public.%1$I FOR ALL TO authenticated
                      USING (public.is_platform_admin()) WITH CHECK (public.is_platform_admin())$p$, t);
  END LOOP;
END $$;

DROP POLICY "releases_read" ON public.releases;
CREATE POLICY "releases_read" ON public.releases FOR SELECT TO authenticated
  USING (public.is_platform_admin() OR status IN ('released','deployed'));
DROP POLICY "backup_records_read" ON public.backup_records;
CREATE POLICY "backup_records_read" ON public.backup_records FOR SELECT TO authenticated
  USING (public.is_platform_admin() OR (organization_id IS NOT NULL AND organization_id = public.current_org_id() AND public.is_org_admin()));
DROP POLICY "deployment_events_read" ON public.deployment_events;
CREATE POLICY "deployment_events_read" ON public.deployment_events FOR SELECT TO authenticated
  USING (public.is_platform_admin());

DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT * FROM (VALUES
      ('integration_connections','integrations'),
      ('integration_events','integrations'),
      ('integration_test_runs','integrations'),
      ('integration_webhook_receipts','integrations'),
      ('data_migration_batches','migration'),
      ('data_migration_rows','migration'),
      ('test_suites','quality'),
      ('test_cases','quality'),
      ('test_runs','quality'),
      ('test_case_results','quality'),
      ('defects','quality'),
      ('uat_signoffs','quality'),
      ('security_findings_register','quality'),
      ('service_incidents','quality'),
      ('readiness_gates','quality'),
      ('organization_subscriptions','platform'),
      ('subscription_events','platform'),
      ('organization_entitlements','platform'),
      ('support_access_grants','support'),
      ('knowledge_articles','support')
    ) AS v(tbl, module)
  LOOP
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON public.%I TO authenticated', r.tbl);
    EXECUTE format('GRANT ALL ON public.%I TO service_role', r.tbl);
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', r.tbl);

    EXECUTE format($p$CREATE POLICY "%1$s_select" ON public.%1$I FOR SELECT TO authenticated
        USING ((organization_id IS NULL AND public.is_platform_admin())
            OR (organization_id = public.current_org_id()
                AND (public.is_org_admin() OR public.has_permission('%2$s','view'))))$p$, r.tbl, r.module);

    EXECUTE format($p$CREATE POLICY "%1$s_insert" ON public.%1$I FOR INSERT TO authenticated
        WITH CHECK ((organization_id IS NULL AND public.is_platform_admin())
            OR (organization_id = public.current_org_id()
                AND (public.is_org_admin() OR public.has_permission('%2$s','create'))))$p$, r.tbl, r.module);

    EXECUTE format($p$CREATE POLICY "%1$s_update" ON public.%1$I FOR UPDATE TO authenticated
        USING ((organization_id IS NULL AND public.is_platform_admin())
            OR (organization_id = public.current_org_id()
                AND (public.is_org_admin() OR public.has_permission('%2$s','edit'))))
        WITH CHECK ((organization_id IS NULL AND public.is_platform_admin())
            OR organization_id = public.current_org_id())$p$, r.tbl, r.module);

    EXECUTE format($p$CREATE POLICY "%1$s_delete" ON public.%1$I FOR DELETE TO authenticated
        USING ((organization_id IS NULL AND public.is_platform_admin())
            OR (organization_id = public.current_org_id()
                AND (public.is_org_admin() OR public.has_permission('%2$s','delete'))))$p$, r.tbl, r.module);
  END LOOP;
END $$;

CREATE POLICY "knowledge_articles_platform_read" ON public.knowledge_articles
  FOR SELECT TO authenticated
  USING (organization_id IS NULL AND status = 'published');

GRANT SELECT, INSERT, UPDATE, DELETE ON public.support_tickets TO authenticated;
GRANT ALL ON public.support_tickets TO service_role;
ALTER TABLE public.support_tickets ENABLE ROW LEVEL SECURITY;
CREATE POLICY "support_tickets_select" ON public.support_tickets FOR SELECT TO authenticated
  USING (organization_id = public.current_org_id()
         AND (created_by = auth.uid() OR assigned_agent_id = auth.uid()
              OR public.is_org_admin() OR public.has_permission('support','view')));
CREATE POLICY "support_tickets_insert" ON public.support_tickets FOR INSERT TO authenticated
  WITH CHECK (organization_id = public.current_org_id() AND created_by = auth.uid());
CREATE POLICY "support_tickets_update" ON public.support_tickets FOR UPDATE TO authenticated
  USING (organization_id = public.current_org_id()
         AND (created_by = auth.uid() OR assigned_agent_id = auth.uid()
              OR public.is_org_admin() OR public.has_permission('support','edit')))
  WITH CHECK (organization_id = public.current_org_id());

GRANT SELECT, INSERT ON public.support_ticket_messages TO authenticated;
GRANT ALL ON public.support_ticket_messages TO service_role;
ALTER TABLE public.support_ticket_messages ENABLE ROW LEVEL SECURITY;
CREATE POLICY "support_messages_select" ON public.support_ticket_messages FOR SELECT TO authenticated
  USING (organization_id = public.current_org_id()
         AND (NOT internal_only OR public.is_org_admin() OR public.has_permission('support','view'))
         AND EXISTS (SELECT 1 FROM public.support_tickets t WHERE t.id = ticket_id));
CREATE POLICY "support_messages_insert" ON public.support_ticket_messages FOR INSERT TO authenticated
  WITH CHECK (organization_id = public.current_org_id() AND author_id = auth.uid());

-- =====================================================================
-- updated_at triggers
-- =====================================================================
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['platform_admins','environment_registry','feature_flags','feature_flag_overrides',
      'subscription_plans','organization_subscriptions','organization_entitlements','integration_providers',
      'integration_connections','integration_events','data_migration_batches','test_suites','test_cases',
      'defects','uat_signoffs','security_findings_register','releases','monitoring_checks','service_incidents',
      'readiness_gates','support_plans','support_tickets','knowledge_articles']
  LOOP
    EXECUTE format('CREATE TRIGGER %1$s_touch BEFORE UPDATE ON public.%1$I
                    FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at()', t);
  END LOOP;
END $$;

-- =====================================================================
-- Permissions vocabulary for the new modules
-- =====================================================================
INSERT INTO public.permissions (module, action, label)
SELECT m.module, a.action,
       initcap(replace(a.action,'-',' ')) || ' ' || initcap(replace(m.module,'-',' '))
FROM (VALUES ('integrations'),('migration'),('quality'),('support'),('platform')) AS m(module)
CROSS JOIN (VALUES ('view'),('create'),('edit'),('delete'),('approve'),('export'),('override')) AS a(action)
WHERE NOT EXISTS (
  SELECT 1 FROM public.permissions p WHERE p.module = m.module AND p.action = a.action);

INSERT INTO public.role_permissions (organization_id, role_id, permission_id)
SELECT r.organization_id, r.id, p.id
FROM public.roles r
JOIN public.permissions p
  ON p.module IN ('integrations','migration','quality','support','platform')
WHERE (lower(r.name) LIKE '%owner%' OR lower(r.name) LIKE '%director%'
       OR lower(r.name) LIKE '%system administrator%' OR lower(r.name) LIKE '%general manager%')
  AND NOT EXISTS (
    SELECT 1 FROM public.role_permissions rp
    WHERE rp.role_id = r.id AND rp.permission_id = p.id);

-- =====================================================================
-- Reference data
-- =====================================================================
INSERT INTO public.environment_registry (key, name, kind, banner_label, is_production, checklist) VALUES
  ('local','Local Development','development','LOCAL — synthetic data only', false, '["Separate database","No production secrets","No live callbacks"]'::jsonb),
  ('development','Development','development','DEVELOPMENT ENVIRONMENT', false, '["Separate database","Sandbox provider keys","Seeded synthetic tenants"]'::jsonb),
  ('testing','Testing','testing','TESTING ENVIRONMENT — automated suites run here', false, '["Isolated test tenants","No live payment callbacks","Resettable data"]'::jsonb),
  ('staging','Staging / UAT','staging','STAGING — UAT only, not live operations', false, '["Production-like schema","Sandbox payment credentials","Separate webhook URLs"]'::jsonb),
  ('production','Production','production', NULL, true, '["Production secrets restricted","Backups verified","Monitoring active","Rollback plan approved"]'::jsonb);

INSERT INTO public.integration_providers (code, name, category, purpose, requires_partner_approval, supports_webhooks, required_secret_names, sort_order) VALUES
  ('supabase','Lovable Cloud','platform','Database, authentication, storage and server functions', false, false, '{}', 10),
  ('booking_com','Booking.com','ota','Reservation import, modification and cancellation', true, true, '{BOOKING_COM_API_KEY}', 20),
  ('expedia','Expedia','ota','Reservation import, modification and cancellation', true, true, '{EXPEDIA_API_KEY}', 21),
  ('daraja','Safaricom Daraja (M-Pesa)','payments','STK push, C2B confirmation and reconciliation', true, true, '{DARAJA_CONSUMER_KEY,DARAJA_CONSUMER_SECRET,DARAJA_PASSKEY,DARAJA_SHORTCODE}', 30),
  ('card_terminal','Card Terminal','payments','Card present authorisation and settlement reference', true, false, '{}', 31),
  ('qr_payments','QR Payments','payments','QR payment request and confirmation', true, true, '{}', 32),
  ('etims','KRA eTIMS','compliance','Tax invoice and credit note submission', true, false, '{ETIMS_DEVICE_ID,ETIMS_API_KEY}', 40),
  ('resend','Resend Email','messaging','Transactional and marketing email delivery', false, true, '{RESEND_API_KEY}', 50),
  ('whatsapp','WhatsApp Business','messaging','Template messaging and delivery receipts', true, true, '{WHATSAPP_TOKEN,WHATSAPP_PHONE_NUMBER_ID}', 51),
  ('africas_talking','Africa''s Talking SMS','messaging','SMS delivery and delivery reports', true, true, '{AT_API_KEY,AT_USERNAME}', 52),
  ('google_maps','Google Maps','location','Address validation, delivery zones and ETA', false, false, '{GOOGLE_MAPS_SERVER_KEY}', 60),
  ('google_calendar','Google Calendar','productivity','Optional event and interview calendar sync', false, false, '{GOOGLE_CALENDAR_CLIENT_ID,GOOGLE_CALENDAR_CLIENT_SECRET}', 61),
  ('lovable_ai','AI Gateway','ai','Model access for AI assistance and narratives', false, false, '{LOVABLE_API_KEY}', 70),
  ('monitoring','Monitoring & Alerting','operations','Uptime, error and performance monitoring', false, true, '{}', 80);

INSERT INTO public.support_plans (code, name, first_response_minutes, resolution_minutes, business_hours, escalation_path) VALUES
  ('standard','Standard', 480, 4320, 'Mon-Fri 08:00-17:00', 'Support agent → Support lead'),
  ('priority','Priority', 120, 1440, 'Mon-Sun 07:00-21:00', 'Support agent → Support lead → Platform owner'),
  ('enterprise','Enterprise', 30, 480, '24/7', 'On-call engineer → Support lead → Platform owner'),
  ('custom','Custom Contract', NULL, NULL, 'As contracted', 'As contracted');

INSERT INTO public.subscription_plans (code, name, description, billing_frequency, currency, entitlements, limits, support_plan_code, is_custom) VALUES
  ('starter','Starter','Single property running front office, restaurant and finance essentials.','annual','KES',
   '{pms,pos,kds,inventory,finance,crm,housekeeping,reports}',
   '{"properties":1,"branches":1,"rooms":40,"staff_users":25,"ai_requests_per_month":0}'::jsonb,'standard',false),
  ('professional','Professional','Multi-department property with procurement, events, HR and marketing.','annual','KES',
   '{pms,pos,kds,inventory,procurement,finance,crm,events,housekeeping,hr,marketing,delivery,reports,advanced_reports}',
   '{"properties":1,"branches":3,"rooms":150,"staff_users":120,"ai_requests_per_month":2000}'::jsonb,'priority',false),
  ('enterprise','Enterprise','Multi-property group with AI analytics, integrations and premium support.','annual','KES',
   '{pms,pos,kds,inventory,procurement,finance,crm,events,housekeeping,hr,marketing,delivery,ai,analytics,multi_property,advanced_reports,premium_support,integrations}',
   '{"properties":null,"branches":null,"rooms":null,"staff_users":null,"ai_requests_per_month":20000}'::jsonb,'enterprise',false),
  ('pilot','Pilot Programme','Authorised pilot tenant with full modules and close support during evaluation.','annual','KES',
   '{pms,pos,kds,inventory,procurement,finance,crm,events,housekeeping,hr,marketing,delivery,ai,analytics,advanced_reports,integrations}',
   '{"properties":1,"branches":2,"rooms":80,"staff_users":80,"ai_requests_per_month":5000}'::jsonb,'enterprise',true);

INSERT INTO public.feature_flags (key, name, description, scope, default_enabled, beta) VALUES
  ('integration_centre','Integration Centre','Administration screen for provider connections.','platform', true, false),
  ('data_migration','Data Migration Workspace','Tenant data import with dry run and reconciliation.','organization', true, true),
  ('ai_assistant','AI Assistant','Natural language questions over the approved metric catalogue.','organization', false, true),
  ('ota_connectivity','OTA Connectivity','Booking.com and Expedia reservation synchronisation.','organization', false, true),
  ('card_terminal','Card Terminal Payments','Card present payment capture.','organization', false, true),
  ('pwa_offline','Offline-tolerant Workspaces','Limited offline behaviour for POS and rider screens.','platform', false, true);

INSERT INTO public.monitoring_checks (code, name, target, environment, category, status, threshold_ms) VALUES
  ('app_availability','Application availability','Published application','production','availability','not_configured', 3000),
  ('database_health','Database health','Primary database','production','availability','not_configured', 1000),
  ('payment_callbacks','Payment callback processing','Daraja callbacks','production','integration','not_configured', 5000),
  ('etims_queue','eTIMS submission queue','Tax submission queue','production','integration','not_configured', NULL),
  ('outbound_messaging','Outbound messaging queue','Email, SMS and WhatsApp queue','production','integration','not_configured', NULL),
  ('scheduled_jobs','Scheduled jobs','Automation and reporting jobs','production','jobs','not_configured', NULL),
  ('error_rate','Application error rate','Client and server errors','production','errors','not_configured', NULL);

INSERT INTO public.readiness_gates (organization_id, gate_key, name, category, mandatory, sort_order) VALUES
  (NULL,'architecture_reviewed','Architecture reviewed','architecture', true, 10),
  (NULL,'migrations_applied','Database migrations applied','architecture', true, 20),
  (NULL,'rls_tests_passed','Tenant isolation (RLS) tests passed','security', true, 30),
  (NULL,'security_tests_passed','Security testing completed','security', true, 40),
  (NULL,'performance_tests_passed','Performance testing completed','performance', true, 50),
  (NULL,'uat_passed','User acceptance testing signed off','quality', true, 60),
  (NULL,'critical_defects_closed','Critical defects closed','quality', true, 70),
  (NULL,'high_defects_addressed','High defects closed or formally accepted','quality', true, 80),
  (NULL,'backup_verified','Backup verified','operations', true, 90),
  (NULL,'restore_tested','Restore tested','operations', true, 100),
  (NULL,'monitoring_enabled','Monitoring and alerting enabled','operations', true, 110),
  (NULL,'incident_plan_approved','Incident response plan approved','operations', true, 120),
  (NULL,'integrations_verified','Integration statuses verified and truthful','integrations', true, 130),
  (NULL,'training_completed','Staff training completed','pilot', true, 140),
  (NULL,'opening_balances_approved','Opening balances approved','pilot', true, 150),
  (NULL,'migration_reconciled','Data migration reconciled','pilot', true, 160),
  (NULL,'legal_documents_approved','Legal documents approved','legal', true, 170),
  (NULL,'support_ready','Support team ready','support', true, 180),
  (NULL,'rollback_plan_ready','Rollback plan tested','operations', true, 190),
  (NULL,'pilot_signoff','Pilot sign-off complete','pilot', true, 200);
