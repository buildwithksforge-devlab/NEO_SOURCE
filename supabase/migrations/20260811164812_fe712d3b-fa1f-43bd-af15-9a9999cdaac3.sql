
-- ============ Phase 6: Automation & Communication Engine ============

CREATE OR REPLACE FUNCTION public.automation_touch_updated_at()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END; $$;

-- ---------- domain events (outbox) ----------
CREATE TABLE public.domain_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  branch_id uuid REFERENCES public.branches(id) ON DELETE SET NULL,
  event_type text NOT NULL,
  source_module text NOT NULL,
  source_record_id uuid,
  customer_id uuid REFERENCES public.customers(id) ON DELETE SET NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  schema_version integer NOT NULL DEFAULT 1,
  correlation_id uuid NOT NULL DEFAULT gen_random_uuid(),
  idempotency_key text NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  retry_count integer NOT NULL DEFAULT 0,
  last_error text,
  automation_origin boolean NOT NULL DEFAULT false,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, idempotency_key)
);
CREATE INDEX domain_events_pending_idx ON public.domain_events (status, occurred_at) WHERE status IN ('pending','retrying');
CREATE INDEX domain_events_org_idx ON public.domain_events (organization_id, event_type, occurred_at DESC);

-- ---------- workflow definitions & versions ----------
CREATE TABLE public.workflow_definitions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  branch_id uuid REFERENCES public.branches(id) ON DELETE SET NULL,
  department_id uuid REFERENCES public.departments(id) ON DELETE SET NULL,
  name text NOT NULL,
  description text NOT NULL DEFAULT '',
  category text NOT NULL DEFAULT 'operations',
  status text NOT NULL DEFAULT 'draft',
  current_version integer NOT NULL DEFAULT 1,
  published_version integer,
  trigger_type text NOT NULL DEFAULT 'event',
  trigger_event text,
  last_run_at timestamptz,
  successful_runs integer NOT NULL DEFAULT 0,
  failed_runs integer NOT NULL DEFAULT 0,
  is_system_template boolean NOT NULL DEFAULT false,
  created_by uuid,
  published_by uuid,
  published_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX workflow_definitions_org_idx ON public.workflow_definitions (organization_id, status);
CREATE INDEX workflow_definitions_trigger_idx ON public.workflow_definitions (organization_id, trigger_event) WHERE status = 'active';

CREATE TABLE public.workflow_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  workflow_id uuid NOT NULL REFERENCES public.workflow_definitions(id) ON DELETE CASCADE,
  version integer NOT NULL,
  trigger jsonb NOT NULL DEFAULT '{}'::jsonb,
  conditions jsonb NOT NULL DEFAULT '[]'::jsonb,
  actions jsonb NOT NULL DEFAULT '[]'::jsonb,
  retry_policy jsonb NOT NULL DEFAULT '{"max_attempts":3,"backoff_seconds":300}'::jsonb,
  notes text NOT NULL DEFAULT '',
  published boolean NOT NULL DEFAULT false,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workflow_id, version)
);

CREATE TABLE public.workflow_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  branch_id uuid REFERENCES public.branches(id) ON DELETE SET NULL,
  workflow_id uuid NOT NULL REFERENCES public.workflow_definitions(id) ON DELETE CASCADE,
  workflow_version integer NOT NULL,
  event_id uuid REFERENCES public.domain_events(id) ON DELETE SET NULL,
  correlation_id uuid,
  mode text NOT NULL DEFAULT 'live',
  status text NOT NULL DEFAULT 'running',
  matched boolean NOT NULL DEFAULT true,
  actions_total integer NOT NULL DEFAULT 0,
  actions_completed integer NOT NULL DEFAULT 0,
  error_message text,
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  duration_ms integer,
  triggered_by uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX workflow_runs_org_idx ON public.workflow_runs (organization_id, started_at DESC);
CREATE INDEX workflow_runs_wf_idx ON public.workflow_runs (workflow_id, started_at DESC);

CREATE TABLE public.workflow_run_steps (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  run_id uuid NOT NULL REFERENCES public.workflow_runs(id) ON DELETE CASCADE,
  step_index integer NOT NULL,
  action_type text NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  detail text NOT NULL DEFAULT '',
  result jsonb NOT NULL DEFAULT '{}'::jsonb,
  error_message text,
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz
);
CREATE INDEX workflow_run_steps_run_idx ON public.workflow_run_steps (run_id, step_index);

-- ---------- scheduling & idempotency ----------
CREATE TABLE public.scheduled_actions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  branch_id uuid REFERENCES public.branches(id) ON DELETE SET NULL,
  workflow_id uuid REFERENCES public.workflow_definitions(id) ON DELETE CASCADE,
  run_id uuid REFERENCES public.workflow_runs(id) ON DELETE SET NULL,
  event_id uuid REFERENCES public.domain_events(id) ON DELETE SET NULL,
  action_type text NOT NULL,
  action_config jsonb NOT NULL DEFAULT '{}'::jsonb,
  context jsonb NOT NULL DEFAULT '{}'::jsonb,
  scheduled_for timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'scheduled',
  attempts integer NOT NULL DEFAULT 0,
  last_error text,
  idempotency_key text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, idempotency_key)
);
CREATE INDEX scheduled_actions_due_idx ON public.scheduled_actions (status, scheduled_for) WHERE status = 'scheduled';

CREATE TABLE public.automation_idempotency_keys (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  scope text NOT NULL,
  idempotency_key text NOT NULL,
  result_reference text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, scope, idempotency_key)
);

-- ---------- message templates ----------
CREATE TABLE public.message_templates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  branch_id uuid REFERENCES public.branches(id) ON DELETE SET NULL,
  key text NOT NULL,
  name text NOT NULL,
  category text NOT NULL DEFAULT 'reservation',
  channel text NOT NULL DEFAULT 'email',
  language text NOT NULL DEFAULT 'en',
  subject text NOT NULL DEFAULT '',
  body text NOT NULL DEFAULT '',
  header text NOT NULL DEFAULT '',
  footer text NOT NULL DEFAULT '',
  allowed_variables jsonb NOT NULL DEFAULT '[]'::jsonb,
  is_marketing boolean NOT NULL DEFAULT false,
  status text NOT NULL DEFAULT 'draft',
  version integer NOT NULL DEFAULT 1,
  provider_template_id text,
  last_tested_at timestamptz,
  created_by uuid,
  approved_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, key, channel, language)
);

CREATE TABLE public.message_template_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  template_id uuid NOT NULL REFERENCES public.message_templates(id) ON DELETE CASCADE,
  version integer NOT NULL,
  subject text NOT NULL DEFAULT '',
  body text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'draft',
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (template_id, version)
);

-- ---------- communication queue ----------
CREATE TABLE public.communication_queue (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  branch_id uuid REFERENCES public.branches(id) ON DELETE SET NULL,
  customer_id uuid REFERENCES public.customers(id) ON DELETE SET NULL,
  communication_id uuid REFERENCES public.customer_communications(id) ON DELETE SET NULL,
  template_id uuid REFERENCES public.message_templates(id) ON DELETE SET NULL,
  template_key text,
  channel text NOT NULL,
  recipient text NOT NULL,
  subject text NOT NULL DEFAULT '',
  rendered_body text NOT NULL DEFAULT '',
  variables jsonb NOT NULL DEFAULT '{}'::jsonb,
  is_marketing boolean NOT NULL DEFAULT false,
  consent_verified boolean NOT NULL DEFAULT false,
  scheduled_for timestamptz NOT NULL DEFAULT now(),
  provider text,
  provider_reference text,
  status text NOT NULL DEFAULT 'queued',
  attempt_count integer NOT NULL DEFAULT 0,
  max_attempts integer NOT NULL DEFAULT 3,
  last_attempt_at timestamptz,
  failure_code text,
  failure_message text,
  suppression_reason text,
  internal_note text NOT NULL DEFAULT '',
  workflow_id uuid REFERENCES public.workflow_definitions(id) ON DELETE SET NULL,
  run_id uuid REFERENCES public.workflow_runs(id) ON DELETE SET NULL,
  source_module text,
  source_record_id uuid,
  idempotency_key text NOT NULL,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, idempotency_key)
);
CREATE INDEX communication_queue_due_idx ON public.communication_queue (status, scheduled_for);
CREATE INDEX communication_queue_org_idx ON public.communication_queue (organization_id, created_at DESC);

CREATE TABLE public.communication_delivery_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  communication_queue_id uuid NOT NULL REFERENCES public.communication_queue(id) ON DELETE CASCADE,
  provider text NOT NULL,
  event_type text NOT NULL,
  provider_event_id text,
  detail text NOT NULL DEFAULT '',
  occurred_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, provider, provider_event_id)
);

-- ---------- providers ----------
CREATE TABLE public.provider_connections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  provider text NOT NULL,
  display_name text NOT NULL,
  channel text NOT NULL,
  status text NOT NULL DEFAULT 'not_configured',
  configuration jsonb NOT NULL DEFAULT '{}'::jsonb,
  secret_names jsonb NOT NULL DEFAULT '[]'::jsonb,
  last_checked_at timestamptz,
  last_error text,
  enabled boolean NOT NULL DEFAULT false,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, provider)
);

CREATE TABLE public.provider_webhook_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid REFERENCES public.organizations(id) ON DELETE CASCADE,
  provider text NOT NULL,
  provider_event_id text NOT NULL,
  event_type text NOT NULL,
  signature_verified boolean NOT NULL DEFAULT false,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  processed boolean NOT NULL DEFAULT false,
  error_message text,
  received_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider, provider_event_id)
);

-- ---------- rules ----------
CREATE TABLE public.task_assignment_rules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  branch_id uuid REFERENCES public.branches(id) ON DELETE SET NULL,
  department_id uuid REFERENCES public.departments(id) ON DELETE SET NULL,
  station_id uuid REFERENCES public.operational_stations(id) ON DELETE SET NULL,
  name text NOT NULL,
  event_type text,
  task_category text NOT NULL DEFAULT 'general',
  strategy text NOT NULL DEFAULT 'department_queue',
  assignee_user_id uuid,
  assignee_role_id uuid REFERENCES public.roles(id) ON DELETE SET NULL,
  due_in_minutes integer NOT NULL DEFAULT 120,
  priority text NOT NULL DEFAULT 'normal',
  escalation_policy_id uuid,
  active boolean NOT NULL DEFAULT true,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.escalation_policies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  branch_id uuid REFERENCES public.branches(id) ON DELETE SET NULL,
  department_id uuid REFERENCES public.departments(id) ON DELETE SET NULL,
  name text NOT NULL,
  applies_to text NOT NULL DEFAULT 'task',
  condition text NOT NULL DEFAULT 'overdue',
  priority_filter text,
  levels jsonb NOT NULL DEFAULT '[]'::jsonb,
  max_level integer NOT NULL DEFAULT 3,
  respect_business_hours boolean NOT NULL DEFAULT true,
  pause_when_waiting boolean NOT NULL DEFAULT true,
  active boolean NOT NULL DEFAULT true,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.escalation_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  branch_id uuid REFERENCES public.branches(id) ON DELETE SET NULL,
  department_id uuid REFERENCES public.departments(id) ON DELETE SET NULL,
  policy_id uuid REFERENCES public.escalation_policies(id) ON DELETE SET NULL,
  subject_type text NOT NULL,
  subject_id uuid NOT NULL,
  level integer NOT NULL DEFAULT 1,
  reason text NOT NULL DEFAULT '',
  notified_user_id uuid,
  acknowledged_at timestamptz,
  acknowledged_by uuid,
  resolved_at timestamptz,
  idempotency_key text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, idempotency_key)
);

CREATE TABLE public.feedback_automation_rules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  branch_id uuid REFERENCES public.branches(id) ON DELETE SET NULL,
  name text NOT NULL,
  trigger_event text NOT NULL DEFAULT 'stay.checked_out',
  delay_minutes integer NOT NULL DEFAULT 120,
  channel text NOT NULL DEFAULT 'email',
  template_key text,
  expires_after_days integer NOT NULL DEFAULT 14,
  category text,
  rating_threshold integer NOT NULL DEFAULT 3,
  route_department_id uuid REFERENCES public.departments(id) ON DELETE SET NULL,
  route_role_id uuid REFERENCES public.roles(id) ON DELETE SET NULL,
  create_complaint boolean NOT NULL DEFAULT true,
  active boolean NOT NULL DEFAULT true,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.feedback_invitations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  branch_id uuid REFERENCES public.branches(id) ON DELETE SET NULL,
  customer_id uuid REFERENCES public.customers(id) ON DELETE SET NULL,
  rule_id uuid REFERENCES public.feedback_automation_rules(id) ON DELETE SET NULL,
  source_module text NOT NULL DEFAULT 'pms',
  source_record_id uuid,
  channel text NOT NULL DEFAULT 'email',
  token text NOT NULL UNIQUE DEFAULT encode(gen_random_bytes(24), 'hex'),
  status text NOT NULL DEFAULT 'scheduled',
  scheduled_for timestamptz NOT NULL DEFAULT now(),
  sent_at timestamptz,
  responded_at timestamptz,
  feedback_id uuid REFERENCES public.customer_feedback(id) ON DELETE SET NULL,
  expires_at timestamptz,
  idempotency_key text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, idempotency_key)
);

CREATE TABLE public.notification_rules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  branch_id uuid REFERENCES public.branches(id) ON DELETE SET NULL,
  department_id uuid REFERENCES public.departments(id) ON DELETE SET NULL,
  station_id uuid REFERENCES public.operational_stations(id) ON DELETE SET NULL,
  name text NOT NULL,
  event_type text NOT NULL,
  recipient_strategy text NOT NULL DEFAULT 'department',
  recipient_role_id uuid REFERENCES public.roles(id) ON DELETE SET NULL,
  recipient_user_id uuid,
  category text NOT NULL DEFAULT 'operations',
  priority text NOT NULL DEFAULT 'normal',
  title_template text NOT NULL DEFAULT '',
  body_template text NOT NULL DEFAULT '',
  link_template text,
  active boolean NOT NULL DEFAULT true,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.workflow_failures (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  branch_id uuid REFERENCES public.branches(id) ON DELETE SET NULL,
  workflow_id uuid REFERENCES public.workflow_definitions(id) ON DELETE SET NULL,
  run_id uuid REFERENCES public.workflow_runs(id) ON DELETE SET NULL,
  event_id uuid REFERENCES public.domain_events(id) ON DELETE SET NULL,
  step_index integer,
  error_category text NOT NULL DEFAULT 'unknown',
  error_message text NOT NULL DEFAULT '',
  recommended_action text NOT NULL DEFAULT '',
  retry_count integer NOT NULL DEFAULT 0,
  first_failed_at timestamptz NOT NULL DEFAULT now(),
  last_failed_at timestamptz NOT NULL DEFAULT now(),
  status text NOT NULL DEFAULT 'new',
  resolution_note text NOT NULL DEFAULT '',
  resolved_by uuid,
  resolved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.automation_settings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL UNIQUE REFERENCES public.organizations(id) ON DELETE CASCADE,
  timezone text NOT NULL DEFAULT 'Africa/Nairobi',
  quiet_hours_start time NOT NULL DEFAULT '21:00',
  quiet_hours_end time NOT NULL DEFAULT '07:00',
  enforce_quiet_hours boolean NOT NULL DEFAULT true,
  max_message_attempts integer NOT NULL DEFAULT 3,
  retry_backoff_seconds integer NOT NULL DEFAULT 600,
  max_workflow_depth integer NOT NULL DEFAULT 3,
  test_recipient_email text,
  test_recipient_phone text,
  automation_enabled boolean NOT NULL DEFAULT true,
  updated_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- ---------- grants ----------
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'domain_events','workflow_definitions','workflow_versions','workflow_runs','workflow_run_steps',
    'scheduled_actions','automation_idempotency_keys','message_templates','message_template_versions',
    'communication_queue','communication_delivery_events','provider_connections','provider_webhook_events',
    'task_assignment_rules','escalation_policies','escalation_events','feedback_automation_rules',
    'feedback_invitations','notification_rules','workflow_failures','automation_settings']
  LOOP
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON public.%I TO authenticated', t);
    EXECUTE format('GRANT ALL ON public.%I TO service_role', t);
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.automation_touch_updated_at()', 'touch_'||t, t);
  END LOOP;
END $$;

-- updated_at trigger not valid on tables without the column
DROP TRIGGER IF EXISTS touch_automation_idempotency_keys ON public.automation_idempotency_keys;
DROP TRIGGER IF EXISTS touch_workflow_run_steps ON public.workflow_run_steps;
DROP TRIGGER IF EXISTS touch_communication_delivery_events ON public.communication_delivery_events;
DROP TRIGGER IF EXISTS touch_provider_webhook_events ON public.provider_webhook_events;
DROP TRIGGER IF EXISTS touch_escalation_events ON public.escalation_events;
DROP TRIGGER IF EXISTS touch_message_template_versions ON public.message_template_versions;
DROP TRIGGER IF EXISTS touch_workflow_runs ON public.workflow_runs;

-- ---------- RLS ----------
DO $$
DECLARE t text; view_perm text; manage_perm text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'domain_events','workflow_definitions','workflow_versions','workflow_runs','workflow_run_steps',
    'scheduled_actions','automation_idempotency_keys','message_templates','message_template_versions',
    'communication_queue','communication_delivery_events','task_assignment_rules','escalation_policies',
    'escalation_events','feedback_automation_rules','feedback_invitations','notification_rules',
    'workflow_failures','automation_settings']
  LOOP
    EXECUTE format($p$CREATE POLICY %I ON public.%I FOR SELECT TO authenticated
      USING (organization_id = current_org_id() AND (is_org_admin() OR has_permission('automation','view')))$p$, t||' tenant read', t);
    EXECUTE format($p$CREATE POLICY %I ON public.%I FOR INSERT TO authenticated
      WITH CHECK (organization_id = current_org_id() AND (is_org_admin() OR has_permission('automation','create')))$p$, t||' insert', t);
    EXECUTE format($p$CREATE POLICY %I ON public.%I FOR UPDATE TO authenticated
      USING (organization_id = current_org_id() AND (is_org_admin() OR has_permission('automation','edit')))
      WITH CHECK (organization_id = current_org_id())$p$, t||' update', t);
    EXECUTE format($p$CREATE POLICY %I ON public.%I FOR DELETE TO authenticated
      USING (organization_id = current_org_id() AND (is_org_admin() OR has_permission('automation','delete')))$p$, t||' delete', t);
  END LOOP;
END $$;

-- provider connections: administrators / explicit provider permission only
CREATE POLICY "provider_connections read" ON public.provider_connections FOR SELECT TO authenticated
  USING (organization_id = current_org_id() AND (is_org_admin() OR has_permission('automation-providers','view')));
CREATE POLICY "provider_connections insert" ON public.provider_connections FOR INSERT TO authenticated
  WITH CHECK (organization_id = current_org_id() AND (is_org_admin() OR has_permission('automation-providers','edit')));
CREATE POLICY "provider_connections update" ON public.provider_connections FOR UPDATE TO authenticated
  USING (organization_id = current_org_id() AND (is_org_admin() OR has_permission('automation-providers','edit')))
  WITH CHECK (organization_id = current_org_id());
CREATE POLICY "provider_connections delete" ON public.provider_connections FOR DELETE TO authenticated
  USING (organization_id = current_org_id() AND is_org_admin());

-- webhook events: administrators only, written by the server
CREATE POLICY "provider_webhook_events read" ON public.provider_webhook_events FOR SELECT TO authenticated
  USING (organization_id = current_org_id() AND is_org_admin());

-- ---------- permissions ----------
INSERT INTO public.permissions (module, action, label) VALUES
  ('automation','view','View automation'),
  ('automation','create','Create automation records'),
  ('automation','edit','Edit automation records'),
  ('automation','delete','Delete automation records'),
  ('automation','approve','Publish workflows'),
  ('automation','override','Retry / replay automation'),
  ('automation','export','Export automation reports'),
  ('automation-providers','view','View provider connections'),
  ('automation-providers','edit','Manage provider connections'),
  ('automation-ai','view','View AI smart notifications'),
  ('automation-ai','create','Generate AI summaries')
ON CONFLICT DO NOTHING;

INSERT INTO public.role_permissions (organization_id, role_id, permission_id)
SELECT r.organization_id, r.id, p.id
FROM public.roles r
CROSS JOIN public.permissions p
WHERE r.name IN ('Owner','System Administrator','General Manager')
  AND p.module IN ('automation','automation-providers','automation-ai')
ON CONFLICT DO NOTHING;

-- ---------- event emission ----------
CREATE OR REPLACE FUNCTION public.emit_domain_event(
  _org uuid, _branch uuid, _type text, _module text, _record uuid,
  _payload jsonb, _idem text, _customer uuid DEFAULT NULL
) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE _id uuid;
BEGIN
  IF _org IS NULL THEN RETURN NULL; END IF;
  INSERT INTO public.domain_events (organization_id, branch_id, event_type, source_module,
    source_record_id, customer_id, payload, idempotency_key, created_by)
  VALUES (_org, _branch, _type, _module, _record, _customer, COALESCE(_payload,'{}'::jsonb), _idem, auth.uid())
  ON CONFLICT (organization_id, idempotency_key) DO NOTHING
  RETURNING id INTO _id;
  RETURN _id;
END; $$;

CREATE OR REPLACE FUNCTION public.tg_reservation_events()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE p jsonb;
BEGIN
  p := jsonb_build_object('reservation_id', NEW.id, 'confirmation_number', NEW.confirmation_number,
    'status', NEW.status, 'payment_status', NEW.payment_status, 'arrival_date', NEW.arrival_date,
    'departure_date', NEW.departure_date, 'nights', NEW.nights, 'adults', NEW.adults,
    'children', NEW.children, 'total_amount', NEW.total_amount, 'balance', NEW.balance,
    'deposit_paid', NEW.deposit_paid, 'is_vip', NEW.is_vip);
  IF TG_OP = 'INSERT' THEN
    PERFORM emit_domain_event(NEW.organization_id, NEW.branch_id, 'reservation.created', 'pms', NEW.id, p,
      'reservation.created:'||NEW.id, NEW.customer_id);
  ELSE
    IF NEW.status IS DISTINCT FROM OLD.status THEN
      PERFORM emit_domain_event(NEW.organization_id, NEW.branch_id, 'reservation.'||NEW.status, 'pms', NEW.id, p,
        'reservation.'||NEW.status||':'||NEW.id||':'||NEW.updated_at, NEW.customer_id);
    ELSIF NEW.arrival_date IS DISTINCT FROM OLD.arrival_date
       OR NEW.departure_date IS DISTINCT FROM OLD.departure_date
       OR NEW.room_type_id IS DISTINCT FROM OLD.room_type_id
       OR NEW.meal_plan_id IS DISTINCT FROM OLD.meal_plan_id
       OR NEW.total_amount IS DISTINCT FROM OLD.total_amount THEN
      PERFORM emit_domain_event(NEW.organization_id, NEW.branch_id, 'reservation.modified', 'pms', NEW.id, p,
        'reservation.modified:'||NEW.id||':'||NEW.updated_at, NEW.customer_id);
    END IF;
    IF NEW.payment_status IS DISTINCT FROM OLD.payment_status THEN
      PERFORM emit_domain_event(NEW.organization_id, NEW.branch_id, 'reservation.payment_status_changed', 'pms', NEW.id, p,
        'reservation.payment:'||NEW.id||':'||NEW.payment_status||':'||NEW.updated_at, NEW.customer_id);
    END IF;
  END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER reservations_domain_events AFTER INSERT OR UPDATE ON public.reservations
FOR EACH ROW EXECUTE FUNCTION public.tg_reservation_events();

CREATE OR REPLACE FUNCTION public.tg_payment_events()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE p jsonb;
BEGIN
  p := jsonb_build_object('payment_id', NEW.id, 'receipt_number', NEW.receipt_number,
    'amount', NEW.amount, 'currency', NEW.currency, 'method', NEW.method, 'status', NEW.status,
    'reservation_id', NEW.reservation_id, 'folio_id', NEW.folio_id);
  IF (TG_OP = 'INSERT' AND NEW.status = 'confirmed')
     OR (TG_OP = 'UPDATE' AND NEW.status = 'confirmed' AND OLD.status IS DISTINCT FROM 'confirmed') THEN
    PERFORM emit_domain_event(NEW.organization_id, NEW.branch_id, 'payment.confirmed', 'finance', NEW.id, p,
      'payment.confirmed:'||NEW.id, NEW.customer_id);
  ELSIF TG_OP = 'UPDATE' AND NEW.status = 'failed' AND OLD.status IS DISTINCT FROM 'failed' THEN
    PERFORM emit_domain_event(NEW.organization_id, NEW.branch_id, 'payment.failed', 'finance', NEW.id, p,
      'payment.failed:'||NEW.id||':'||NEW.updated_at, NEW.customer_id);
  END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER payments_domain_events AFTER INSERT OR UPDATE ON public.payments
FOR EACH ROW EXECUTE FUNCTION public.tg_payment_events();

CREATE OR REPLACE FUNCTION public.tg_stay_events()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE p jsonb;
BEGIN
  p := jsonb_build_object('stay_id', NEW.id, 'reservation_id', NEW.reservation_id,
    'room_id', NEW.room_id, 'status', NEW.status, 'checked_in_at', NEW.checked_in_at,
    'checked_out_at', NEW.checked_out_at, 'expected_departure', NEW.expected_departure);
  IF TG_OP = 'INSERT' AND NEW.checked_in_at IS NOT NULL THEN
    PERFORM emit_domain_event(NEW.organization_id, NEW.branch_id, 'stay.checked_in', 'pms', NEW.id, p,
      'stay.checked_in:'||NEW.id, NEW.customer_id);
  ELSIF TG_OP = 'UPDATE' THEN
    IF NEW.checked_in_at IS NOT NULL AND OLD.checked_in_at IS NULL THEN
      PERFORM emit_domain_event(NEW.organization_id, NEW.branch_id, 'stay.checked_in', 'pms', NEW.id, p,
        'stay.checked_in:'||NEW.id, NEW.customer_id);
    END IF;
    IF NEW.checked_out_at IS NOT NULL AND OLD.checked_out_at IS NULL THEN
      PERFORM emit_domain_event(NEW.organization_id, NEW.branch_id, 'stay.checked_out', 'pms', NEW.id, p,
        'stay.checked_out:'||NEW.id, NEW.customer_id);
    END IF;
  END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER stays_domain_events AFTER INSERT OR UPDATE ON public.stays
FOR EACH ROW EXECUTE FUNCTION public.tg_stay_events();

CREATE OR REPLACE FUNCTION public.tg_folio_line_events()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NEW.source_module IS NOT NULL AND NEW.source_module <> 'pms' AND NEW.line_type = 'charge' THEN
    PERFORM emit_domain_event(NEW.organization_id, NEW.branch_id, 'folio.room_charge_posted', NEW.source_module, NEW.id,
      jsonb_build_object('folio_id', NEW.folio_id, 'reservation_id', NEW.reservation_id,
        'amount', NEW.net_amount, 'description', NEW.description, 'source_module', NEW.source_module),
      'folio.charge:'||NEW.id);
  END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER folio_lines_domain_events AFTER INSERT ON public.folio_lines
FOR EACH ROW EXECUTE FUNCTION public.tg_folio_line_events();

CREATE OR REPLACE FUNCTION public.tg_task_events()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE p jsonb;
BEGIN
  p := jsonb_build_object('task_id', NEW.id, 'reference', NEW.reference, 'title', NEW.title,
    'status', NEW.status, 'priority', NEW.priority, 'due_at', NEW.due_at,
    'assignee_id', NEW.assignee_id, 'department_id', NEW.department_id);
  IF TG_OP = 'INSERT' AND NEW.assignee_id IS NOT NULL THEN
    PERFORM emit_domain_event(NEW.organization_id, NEW.branch_id, 'task.assigned', 'tasks', NEW.id, p, 'task.assigned:'||NEW.id);
  ELSIF TG_OP = 'UPDATE' THEN
    IF NEW.assignee_id IS DISTINCT FROM OLD.assignee_id AND NEW.assignee_id IS NOT NULL THEN
      PERFORM emit_domain_event(NEW.organization_id, NEW.branch_id, 'task.assigned', 'tasks', NEW.id, p,
        'task.assigned:'||NEW.id||':'||NEW.assignee_id);
    END IF;
    IF NEW.status = 'completed' AND OLD.status IS DISTINCT FROM 'completed' THEN
      PERFORM emit_domain_event(NEW.organization_id, NEW.branch_id, 'task.completed', 'tasks', NEW.id, p, 'task.completed:'||NEW.id);
    END IF;
  END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER tasks_domain_events AFTER INSERT OR UPDATE ON public.tasks
FOR EACH ROW EXECUTE FUNCTION public.tg_task_events();

CREATE OR REPLACE FUNCTION public.tg_approval_events()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE p jsonb;
BEGIN
  p := jsonb_build_object('approval_id', NEW.id, 'reference', NEW.reference,
    'approval_type', NEW.approval_type, 'status', NEW.status, 'amount', NEW.amount,
    'level', NEW.level, 'requester_id', NEW.requester_id, 'approver_id', NEW.approver_id);
  IF TG_OP = 'INSERT' THEN
    PERFORM emit_domain_event(NEW.organization_id, NEW.branch_id, 'approval.requested', 'approvals', NEW.id, p, 'approval.requested:'||NEW.id);
  ELSIF NEW.status IS DISTINCT FROM OLD.status THEN
    PERFORM emit_domain_event(NEW.organization_id, NEW.branch_id, 'approval.'||NEW.status, 'approvals', NEW.id, p,
      'approval.'||NEW.status||':'||NEW.id||':'||NEW.updated_at);
  END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER approvals_domain_events AFTER INSERT OR UPDATE ON public.approval_requests
FOR EACH ROW EXECUTE FUNCTION public.tg_approval_events();

CREATE OR REPLACE FUNCTION public.tg_feedback_events()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE p jsonb;
BEGIN
  p := jsonb_build_object('feedback_id', NEW.id, 'reference', NEW.reference, 'category', NEW.category,
    'rating', NEW.rating, 'feedback_type', NEW.feedback_type, 'status', NEW.status,
    'priority', NEW.priority, 'subject', NEW.subject);
  IF TG_OP = 'INSERT' THEN
    PERFORM emit_domain_event(NEW.organization_id, NEW.branch_id, 'feedback.received', 'crm', NEW.id, p,
      'feedback.received:'||NEW.id, NEW.customer_id);
  ELSIF NEW.status IS DISTINCT FROM OLD.status AND NEW.status = 'resolved' THEN
    PERFORM emit_domain_event(NEW.organization_id, NEW.branch_id, 'complaint.resolved', 'crm', NEW.id, p,
      'complaint.resolved:'||NEW.id, NEW.customer_id);
  END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER feedback_domain_events AFTER INSERT OR UPDATE ON public.customer_feedback
FOR EACH ROW EXECUTE FUNCTION public.tg_feedback_events();

CREATE OR REPLACE FUNCTION public.tg_customer_events()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  PERFORM emit_domain_event(NEW.organization_id, NEW.primary_branch_id, 'customer.created', 'crm', NEW.id,
    jsonb_build_object('customer_id', NEW.id, 'customer_number', NEW.customer_number,
      'customer_type', NEW.customer_type, 'is_vip', NEW.is_vip),
    'customer.created:'||NEW.id, NEW.id);
  RETURN NEW;
END; $$;
CREATE TRIGGER customers_domain_events AFTER INSERT ON public.customers
FOR EACH ROW EXECUTE FUNCTION public.tg_customer_events();
