
-- ============================================================
-- PHASE 15 — MARKETING, CRM AUTOMATION & CUSTOMER ENGAGEMENT
-- ============================================================

-- Helper: does the given CRM customer belong to the signed-in auth user?
CREATE OR REPLACE FUNCTION public.is_my_customer(_customer uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (SELECT 1 FROM public.customers c WHERE c.id = _customer AND c.auth_user_id = auth.uid());
$$;
REVOKE EXECUTE ON FUNCTION public.is_my_customer(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.is_my_customer(uuid) TO authenticated, service_role;

-- ---------- 1. Settings & consent notices ----------
CREATE TABLE public.marketing_settings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL UNIQUE REFERENCES public.organizations(id) ON DELETE CASCADE,
  default_sender_name text,
  reply_to_email text,
  email_provider text,
  email_domain_status text NOT NULL DEFAULT 'not_configured',
  whatsapp_provider text,
  whatsapp_status text NOT NULL DEFAULT 'not_configured',
  sms_provider text,
  sms_status text NOT NULL DEFAULT 'not_configured',
  ai_status text NOT NULL DEFAULT 'not_configured',
  quiet_hours_start time NOT NULL DEFAULT '21:00',
  quiet_hours_end time NOT NULL DEFAULT '07:00',
  frequency_cap_per_week integer NOT NULL DEFAULT 3 CHECK (frequency_cap_per_week >= 0),
  unsubscribe_wording text NOT NULL DEFAULT 'Reply STOP or use the unsubscribe link to stop marketing messages.',
  default_language text NOT NULL DEFAULT 'en',
  campaign_approval_threshold numeric(14,2) NOT NULL DEFAULT 0,
  discount_approval_threshold numeric(14,2) NOT NULL DEFAULT 0,
  test_recipients jsonb NOT NULL DEFAULT '[]'::jsonb,
  attribution_model text NOT NULL DEFAULT 'last_touch',
  conversion_window_days integer NOT NULL DEFAULT 30 CHECK (conversion_window_days > 0),
  review_escalation_rating integer NOT NULL DEFAULT 3 CHECK (review_escalation_rating BETWEEN 1 AND 5),
  data_retention_months integer NOT NULL DEFAULT 60,
  created_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.consent_notice_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  version text NOT NULL,
  title text NOT NULL,
  body text NOT NULL,
  effective_from date NOT NULL DEFAULT current_date,
  active boolean NOT NULL DEFAULT true,
  created_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, version)
);

-- ---------- 2. Consent extension (channel + purpose specific) ----------
ALTER TABLE public.customer_consents
  ADD COLUMN IF NOT EXISTS branch_id uuid REFERENCES public.branches(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS channel text NOT NULL DEFAULT 'email',
  ADD COLUMN IF NOT EXISTS purpose text NOT NULL DEFAULT 'marketing',
  ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'unknown',
  ADD COLUMN IF NOT EXISTS notice_version_id uuid REFERENCES public.consent_notice_versions(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS ip_address text,
  ADD COLUMN IF NOT EXISTS device text,
  ADD COLUMN IF NOT EXISTS expires_at timestamptz,
  ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();

ALTER TABLE public.customer_consents
  DROP CONSTRAINT IF EXISTS customer_consents_status_check;
ALTER TABLE public.customer_consents
  ADD CONSTRAINT customer_consents_status_check CHECK (status IN
    ('unknown','pending','granted','withdrawn','objected','not_required','expired'));
ALTER TABLE public.customer_consents
  DROP CONSTRAINT IF EXISTS customer_consents_channel_check;
ALTER TABLE public.customer_consents
  ADD CONSTRAINT customer_consents_channel_check CHECK (channel IN
    ('email','sms','whatsapp','push','in_app','phone','post'));
ALTER TABLE public.customer_consents
  DROP CONSTRAINT IF EXISTS customer_consents_purpose_check;
ALTER TABLE public.customer_consents
  ADD CONSTRAINT customer_consents_purpose_check CHECK (purpose IN
    ('service','marketing','profiling','personalised_offers','review_requests'));

CREATE UNIQUE INDEX IF NOT EXISTS customer_consents_unique_channel_purpose
  ON public.customer_consents (customer_id, channel, purpose);

-- ---------- 3. Suppression ----------
CREATE TABLE public.suppression_entries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  customer_id uuid REFERENCES public.customers(id) ON DELETE CASCADE,
  channel text NOT NULL CHECK (channel IN ('email','sms','whatsapp','push','all')),
  address text,
  reason text NOT NULL CHECK (reason IN
    ('unsubscribed','do_not_contact','email_bounce','invalid_phone','whatsapp_opt_out','sms_opt_out',
     'complaint','deceased','legal_restriction','internal_test','duplicate_record','temporary')),
  notes text,
  source text,
  active boolean NOT NULL DEFAULT true,
  expires_at timestamptz,
  created_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX suppression_entries_lookup ON public.suppression_entries (organization_id, customer_id, channel) WHERE active;

-- ---------- 4. Tags ----------
CREATE TABLE public.customer_tags (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  name text NOT NULL,
  colour text NOT NULL DEFAULT 'default',
  description text,
  created_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, name)
);

CREATE TABLE public.customer_tag_assignments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  tag_id uuid NOT NULL REFERENCES public.customer_tags(id) ON DELETE CASCADE,
  customer_id uuid NOT NULL REFERENCES public.customers(id) ON DELETE CASCADE,
  assigned_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tag_id, customer_id)
);

-- ---------- 5. Leads ----------
CREATE TABLE public.lead_sources (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  code text NOT NULL,
  name text NOT NULL,
  category text NOT NULL DEFAULT 'other',
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, code)
);

CREATE TABLE public.leads (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  branch_id uuid REFERENCES public.branches(id) ON DELETE SET NULL,
  lead_number text NOT NULL,
  lead_type text NOT NULL DEFAULT 'accommodation',
  customer_id uuid REFERENCES public.customers(id) ON DELETE SET NULL,
  corporate_account_id uuid REFERENCES public.corporate_accounts(id) ON DELETE SET NULL,
  company text,
  contact_name text NOT NULL,
  phone text,
  email text,
  preferred_channel text NOT NULL DEFAULT 'phone',
  source_id uuid REFERENCES public.lead_sources(id) ON DELETE SET NULL,
  source_label text,
  campaign_id uuid,
  interest text,
  requirements text,
  budget numeric(14,2),
  expected_start date,
  expected_end date,
  guest_count integer,
  assigned_to uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  assigned_at timestamptz,
  next_action text,
  next_followup_at timestamptz,
  probability integer NOT NULL DEFAULT 0 CHECK (probability BETWEEN 0 AND 100),
  estimated_value numeric(14,2) NOT NULL DEFAULT 0,
  stage text NOT NULL DEFAULT 'new' CHECK (stage IN
    ('new','assigned','contacted','qualified','needs_analysis','quotation','negotiation',
     'awaiting_customer','won','lost','unqualified','nurture','archived')),
  loss_reason text,
  conversion_module text,
  conversion_reference uuid,
  consent_status text NOT NULL DEFAULT 'unknown',
  utm jsonb NOT NULL DEFAULT '{}'::jsonb,
  landing_page text,
  created_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, lead_number)
);
CREATE INDEX leads_pipeline_idx ON public.leads (organization_id, stage, next_followup_at);
CREATE INDEX leads_assignee_idx ON public.leads (organization_id, assigned_to);

CREATE TABLE public.lead_activities (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  lead_id uuid NOT NULL REFERENCES public.leads(id) ON DELETE CASCADE,
  activity_type text NOT NULL CHECK (activity_type IN
    ('call','email','whatsapp','sms','meeting','site_visit','quotation_reminder','payment_reminder','note','task')),
  channel text,
  purpose text,
  notes text,
  outcome text,
  next_action text,
  due_at timestamptz,
  completed_at timestamptz,
  status text NOT NULL DEFAULT 'planned' CHECK (status IN ('planned','completed','cancelled','overdue')),
  task_id uuid REFERENCES public.tasks(id) ON DELETE SET NULL,
  performed_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.lead_stage_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  lead_id uuid NOT NULL REFERENCES public.leads(id) ON DELETE CASCADE,
  from_stage text,
  to_stage text NOT NULL,
  reason text,
  changed_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- ---------- 6. Campaigns ----------
CREATE TABLE public.campaigns (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  branch_id uuid REFERENCES public.branches(id) ON DELETE SET NULL,
  campaign_number text NOT NULL,
  name text NOT NULL,
  objective text,
  campaign_type text NOT NULL DEFAULT 'email',
  channels jsonb NOT NULL DEFAULT '["email"]'::jsonb,
  segment_id uuid REFERENCES public.customer_segments(id) ON DELETE SET NULL,
  exclusion_segment_id uuid REFERENCES public.customer_segments(id) ON DELETE SET NULL,
  template_id uuid REFERENCES public.message_templates(id) ON DELETE SET NULL,
  promotion_code_id uuid REFERENCES public.promotion_codes(id) ON DELETE SET NULL,
  offer_description text,
  budget numeric(14,2) NOT NULL DEFAULT 0,
  expected_revenue numeric(14,2) NOT NULL DEFAULT 0,
  owner_id uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  starts_at timestamptz,
  ends_at timestamptz,
  send_at timestamptz,
  timezone text NOT NULL DEFAULT 'Africa/Nairobi',
  frequency_cap integer,
  tracking jsonb NOT NULL DEFAULT '{}'::jsonb,
  approval_status text NOT NULL DEFAULT 'not_required'
    CHECK (approval_status IN ('not_required','pending','approved','rejected')),
  approval_request_id uuid REFERENCES public.approval_requests(id) ON DELETE SET NULL,
  approved_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  approved_at timestamptz,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN
    ('draft','pending_approval','approved','scheduled','running','paused','completed','cancelled','failed','archived')),
  last_test_at timestamptz,
  launched_at timestamptz,
  created_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, campaign_number)
);

ALTER TABLE public.leads
  ADD CONSTRAINT leads_campaign_fk FOREIGN KEY (campaign_id) REFERENCES public.campaigns(id) ON DELETE SET NULL;

CREATE TABLE public.segment_snapshots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  segment_id uuid REFERENCES public.customer_segments(id) ON DELETE SET NULL,
  campaign_id uuid REFERENCES public.campaigns(id) ON DELETE CASCADE,
  member_count integer NOT NULL DEFAULT 0,
  reachable_count integer NOT NULL DEFAULT 0,
  excluded_count integer NOT NULL DEFAULT 0,
  criteria jsonb NOT NULL DEFAULT '{}'::jsonb,
  taken_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.campaign_audiences (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  campaign_id uuid NOT NULL REFERENCES public.campaigns(id) ON DELETE CASCADE,
  snapshot_id uuid REFERENCES public.segment_snapshots(id) ON DELETE SET NULL,
  customer_id uuid NOT NULL REFERENCES public.customers(id) ON DELETE CASCADE,
  channel text NOT NULL,
  eligible boolean NOT NULL DEFAULT true,
  consent_result text NOT NULL DEFAULT 'unknown',
  suppression_result text NOT NULL DEFAULT 'clear',
  exclusion_reason text,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN
    ('excluded','pending','queued','sent','delivered','read','opened','clicked','failed','bounced','unsubscribed','complained','converted')),
  queue_id uuid REFERENCES public.communication_queue(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (campaign_id, customer_id, channel)
);
CREATE INDEX campaign_audiences_campaign_idx ON public.campaign_audiences (campaign_id, status);

ALTER TABLE public.communication_queue
  ADD COLUMN IF NOT EXISTS campaign_id uuid REFERENCES public.campaigns(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS is_test boolean NOT NULL DEFAULT false;

CREATE TABLE public.campaign_conversions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  branch_id uuid REFERENCES public.branches(id) ON DELETE SET NULL,
  campaign_id uuid NOT NULL REFERENCES public.campaigns(id) ON DELETE CASCADE,
  customer_id uuid REFERENCES public.customers(id) ON DELETE SET NULL,
  conversion_type text NOT NULL,
  source_module text,
  source_record_id uuid,
  revenue numeric(14,2) NOT NULL DEFAULT 0,
  gross_profit numeric(14,2),
  attribution_model text NOT NULL DEFAULT 'last_touch',
  confidence text NOT NULL DEFAULT 'correlated',
  occurred_at timestamptz NOT NULL DEFAULT now(),
  idempotency_key text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, idempotency_key)
);

CREATE TABLE public.attribution_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  customer_id uuid REFERENCES public.customers(id) ON DELETE CASCADE,
  lead_id uuid REFERENCES public.leads(id) ON DELETE SET NULL,
  campaign_id uuid REFERENCES public.campaigns(id) ON DELETE SET NULL,
  touch_type text NOT NULL DEFAULT 'last_touch',
  source text,
  medium text,
  campaign_tag text,
  content text,
  term text,
  referrer_url text,
  landing_page text,
  promotion_code text,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.marketing_costs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  branch_id uuid REFERENCES public.branches(id) ON DELETE SET NULL,
  campaign_id uuid REFERENCES public.campaigns(id) ON DELETE CASCADE,
  cost_type text NOT NULL CHECK (cost_type IN
    ('messaging','advertising','discount','voucher','complimentary','creative','agency','activation','other')),
  description text,
  amount numeric(14,2) NOT NULL DEFAULT 0 CHECK (amount >= 0),
  incurred_on date NOT NULL DEFAULT current_date,
  verified_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  verified_at timestamptz,
  journal_entry_id uuid REFERENCES public.journal_entries(id) ON DELETE SET NULL,
  created_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- ---------- 7. Journeys ----------
CREATE TABLE public.marketing_journeys (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  branch_id uuid REFERENCES public.branches(id) ON DELETE SET NULL,
  name text NOT NULL,
  description text,
  trigger_event text NOT NULL,
  entry_conditions jsonb NOT NULL DEFAULT '{}'::jsonb,
  exit_conditions jsonb NOT NULL DEFAULT '{}'::jsonb,
  requires_marketing_consent boolean NOT NULL DEFAULT true,
  consent_channel text NOT NULL DEFAULT 'email',
  frequency_cap integer NOT NULL DEFAULT 1 CHECK (frequency_cap >= 0),
  respect_quiet_hours boolean NOT NULL DEFAULT true,
  max_duration_days integer NOT NULL DEFAULT 30 CHECK (max_duration_days > 0),
  reentry_rule text NOT NULL DEFAULT 'once_per_year',
  version integer NOT NULL DEFAULT 1,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','testing','active','paused','archived','failed')),
  owner_id uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.marketing_journey_steps (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  journey_id uuid NOT NULL REFERENCES public.marketing_journeys(id) ON DELETE CASCADE,
  position integer NOT NULL DEFAULT 1,
  step_type text NOT NULL CHECK (step_type IN
    ('wait','condition','send_message','add_segment','remove_segment','create_voucher','award_points',
     'create_task','notify_staff','request_review','update_tag','branch','stop')),
  label text NOT NULL,
  config jsonb NOT NULL DEFAULT '{}'::jsonb,
  template_id uuid REFERENCES public.message_templates(id) ON DELETE SET NULL,
  wait_hours integer,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (journey_id, position)
);

CREATE TABLE public.marketing_journey_enrollments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  journey_id uuid NOT NULL REFERENCES public.marketing_journeys(id) ON DELETE CASCADE,
  customer_id uuid NOT NULL REFERENCES public.customers(id) ON DELETE CASCADE,
  current_step integer NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','completed','exited','failed','suppressed')),
  entered_at timestamptz NOT NULL DEFAULT now(),
  next_run_at timestamptz,
  completed_at timestamptz,
  exit_reason text,
  idempotency_key text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (journey_id, idempotency_key)
);

-- ---------- 8. Reputation & recovery ----------
CREATE TABLE public.reviews (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  branch_id uuid REFERENCES public.branches(id) ON DELETE SET NULL,
  source text NOT NULL DEFAULT 'internal' CHECK (source IN
    ('internal','website','restaurant','delivery','event','stay','google','booking_com','tripadvisor','other')),
  external_review_id text,
  customer_id uuid REFERENCES public.customers(id) ON DELETE SET NULL,
  feedback_id uuid REFERENCES public.customer_feedback(id) ON DELETE SET NULL,
  service_type text,
  reviewer_name text,
  rating integer CHECK (rating BETWEEN 1 AND 5),
  title text,
  body text,
  review_date timestamptz NOT NULL DEFAULT now(),
  sentiment text,
  topics jsonb NOT NULL DEFAULT '[]'::jsonb,
  assigned_to uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  status text NOT NULL DEFAULT 'new' CHECK (status IN
    ('new','assigned','investigating','response_drafted','pending_approval','responded','escalated','resolved','closed')),
  escalated boolean NOT NULL DEFAULT false,
  resolution_notes text,
  created_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, source, external_review_id)
);

CREATE TABLE public.review_responses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  review_id uuid NOT NULL REFERENCES public.reviews(id) ON DELETE CASCADE,
  draft_body text NOT NULL,
  ai_assisted boolean NOT NULL DEFAULT false,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','pending_approval','approved','rejected','published')),
  drafted_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  approved_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  approved_at timestamptz,
  published_at timestamptz,
  publish_channel text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.service_recovery_cases (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  branch_id uuid REFERENCES public.branches(id) ON DELETE SET NULL,
  case_number text NOT NULL,
  customer_id uuid REFERENCES public.customers(id) ON DELETE SET NULL,
  review_id uuid REFERENCES public.reviews(id) ON DELETE SET NULL,
  feedback_id uuid REFERENCES public.customer_feedback(id) ON DELETE SET NULL,
  severity text NOT NULL DEFAULT 'medium' CHECK (severity IN ('low','medium','high','critical')),
  summary text NOT NULL,
  department_id uuid REFERENCES public.departments(id) ON DELETE SET NULL,
  assigned_to uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  related_module text,
  related_reference uuid,
  due_at timestamptz,
  contact_channel text,
  compensation_type text CHECK (compensation_type IN
    ('none','apology','voucher','points','discount','complimentary','refund')),
  compensation_value numeric(14,2) NOT NULL DEFAULT 0,
  approval_request_id uuid REFERENCES public.approval_requests(id) ON DELETE SET NULL,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','in_progress','awaiting_approval','resolved','closed')),
  resolution_notes text,
  followup_rating integer CHECK (followup_rating BETWEEN 1 AND 5),
  resolved_at timestamptz,
  created_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, case_number)
);

-- ---------- 9. Referrals ----------
CREATE TABLE public.referral_programmes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  name text NOT NULL,
  description text,
  referrer_reward_type text NOT NULL DEFAULT 'points',
  referrer_reward_value numeric(14,2) NOT NULL DEFAULT 0,
  referee_reward_type text NOT NULL DEFAULT 'voucher',
  referee_reward_value numeric(14,2) NOT NULL DEFAULT 0,
  qualification_event text NOT NULL DEFAULT 'first_paid_order',
  minimum_spend numeric(14,2) NOT NULL DEFAULT 0,
  expiry_days integer NOT NULL DEFAULT 90,
  active boolean NOT NULL DEFAULT true,
  created_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.customer_referrals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  programme_id uuid REFERENCES public.referral_programmes(id) ON DELETE SET NULL,
  referrer_customer_id uuid NOT NULL REFERENCES public.customers(id) ON DELETE CASCADE,
  referral_code text NOT NULL,
  referred_customer_id uuid REFERENCES public.customers(id) ON DELETE SET NULL,
  referred_email text,
  referred_phone text,
  qualification_reference uuid,
  qualified_at timestamptz,
  reward_status text NOT NULL DEFAULT 'pending' CHECK (reward_status IN
    ('pending','qualified','rewarded','rejected','under_review','expired')),
  fraud_flag boolean NOT NULL DEFAULT false,
  fraud_reason text,
  expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, referral_code, referred_customer_id),
  CHECK (referred_customer_id IS NULL OR referred_customer_id <> referrer_customer_id)
);

-- ---------- 10. Customer value ----------
CREATE TABLE public.customer_value_metrics (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  customer_id uuid NOT NULL REFERENCES public.customers(id) ON DELETE CASCADE,
  historical_value numeric(14,2) NOT NULL DEFAULT 0,
  predicted_clv numeric(14,2),
  gross_margin_rate numeric(6,4),
  visit_count integer NOT NULL DEFAULT 0,
  average_transaction numeric(14,2) NOT NULL DEFAULT 0,
  retention_months integer,
  acquisition_cost numeric(14,2),
  refunds numeric(14,2) NOT NULL DEFAULT 0,
  discounts numeric(14,2) NOT NULL DEFAULT 0,
  method text NOT NULL DEFAULT 'historical',
  data_period_start date,
  data_period_end date,
  confidence text NOT NULL DEFAULT 'low',
  limitations text,
  calculated_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, customer_id)
);

-- ---------- 11. Voucher extension ----------
ALTER TABLE public.reward_vouchers
  ADD COLUMN IF NOT EXISTS branch_id uuid REFERENCES public.branches(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS campaign_id uuid REFERENCES public.campaigns(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS journey_id uuid REFERENCES public.marketing_journeys(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS voucher_type text NOT NULL DEFAULT 'discount',
  ADD COLUMN IF NOT EXISTS reward_source text NOT NULL DEFAULT 'manual',
  ADD COLUMN IF NOT EXISTS eligible_service text,
  ADD COLUMN IF NOT EXISTS min_spend numeric(14,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS starts_at timestamptz,
  ADD COLUMN IF NOT EXISTS usage_limit integer NOT NULL DEFAULT 1 CHECK (usage_limit > 0),
  ADD COLUMN IF NOT EXISTS times_used integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS transferable boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS redemption_reference uuid,
  ADD COLUMN IF NOT EXISTS idempotency_key text;
CREATE UNIQUE INDEX IF NOT EXISTS reward_vouchers_idem ON public.reward_vouchers (organization_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

-- ---------- 12. updated_at triggers ----------
CREATE OR REPLACE FUNCTION public.mkt_touch_updated_at()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END; $$;
REVOKE EXECUTE ON FUNCTION public.mkt_touch_updated_at() FROM PUBLIC, anon, authenticated;

-- ---------- 13. Grants, RLS and policies ----------
DO $$
DECLARE t text;
  staff_tables text[] := ARRAY[
    'marketing_settings','consent_notice_versions','suppression_entries','customer_tags',
    'customer_tag_assignments','lead_sources','leads','lead_activities','lead_stage_history',
    'campaigns','segment_snapshots','campaign_audiences','campaign_conversions','attribution_events',
    'marketing_costs','marketing_journeys','marketing_journey_steps','marketing_journey_enrollments',
    'reviews','review_responses','service_recovery_cases','referral_programmes','customer_referrals',
    'customer_value_metrics'];
BEGIN
  FOREACH t IN ARRAY staff_tables LOOP
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON public.%I TO authenticated', t);
    EXECUTE format('GRANT ALL ON public.%I TO service_role', t);
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format($f$CREATE TRIGGER %I BEFORE UPDATE ON public.%I
      FOR EACH ROW EXECUTE FUNCTION public.mkt_touch_updated_at()$f$, 'touch_' || t, t);

    EXECUTE format($p$CREATE POLICY "%1$s_read" ON public.%1$I FOR SELECT TO authenticated
      USING (organization_id = public.current_org_id()
             AND (public.is_org_admin() OR public.has_permission('marketing','view')))$p$, t);
    EXECUTE format($p$CREATE POLICY "%1$s_insert" ON public.%1$I FOR INSERT TO authenticated
      WITH CHECK (organization_id = public.current_org_id()
             AND (public.is_org_admin() OR public.has_permission('marketing','create')))$p$, t);
    EXECUTE format($p$CREATE POLICY "%1$s_update" ON public.%1$I FOR UPDATE TO authenticated
      USING (organization_id = public.current_org_id()
             AND (public.is_org_admin() OR public.has_permission('marketing','edit')))
      WITH CHECK (organization_id = public.current_org_id())$p$, t);
    EXECUTE format($p$CREATE POLICY "%1$s_delete" ON public.%1$I FOR DELETE TO authenticated
      USING (organization_id = public.current_org_id()
             AND (public.is_org_admin() OR public.has_permission('marketing','delete')))$p$, t);
  END LOOP;
END $$;

-- Customer self-service policies (own records only)
CREATE POLICY "customer_reads_own_suppression" ON public.suppression_entries FOR SELECT TO authenticated
  USING (public.is_my_customer(customer_id));
CREATE POLICY "customer_manages_own_suppression" ON public.suppression_entries FOR INSERT TO authenticated
  WITH CHECK (public.is_my_customer(customer_id) AND reason IN ('unsubscribed','do_not_contact'));

CREATE POLICY "customer_reads_own_referrals" ON public.customer_referrals FOR SELECT TO authenticated
  USING (public.is_my_customer(referrer_customer_id) OR public.is_my_customer(referred_customer_id));

CREATE POLICY "customer_reads_own_reviews" ON public.reviews FOR SELECT TO authenticated
  USING (public.is_my_customer(customer_id));
CREATE POLICY "customer_creates_own_reviews" ON public.reviews FOR INSERT TO authenticated
  WITH CHECK (public.is_my_customer(customer_id) AND source IN ('internal','website'));

CREATE POLICY "customer_reads_own_value" ON public.customer_value_metrics FOR SELECT TO authenticated
  USING (public.is_my_customer(customer_id));

-- Consent: customers manage their own records
DROP POLICY IF EXISTS "customer_manages_own_consent" ON public.customer_consents;
CREATE POLICY "customer_manages_own_consent" ON public.customer_consents FOR SELECT TO authenticated
  USING (public.is_my_customer(customer_id));
CREATE POLICY "customer_inserts_own_consent" ON public.customer_consents FOR INSERT TO authenticated
  WITH CHECK (public.is_my_customer(customer_id));
CREATE POLICY "customer_updates_own_consent" ON public.customer_consents FOR UPDATE TO authenticated
  USING (public.is_my_customer(customer_id)) WITH CHECK (public.is_my_customer(customer_id));

-- ---------- 14. Server-side marketing eligibility check ----------
CREATE OR REPLACE FUNCTION public.mkt_can_send(_customer uuid, _channel text, _marketing boolean DEFAULT true)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE v_org uuid; v_status text; v_sup text;
BEGIN
  SELECT organization_id INTO v_org FROM public.customers WHERE id = _customer;
  IF v_org IS NULL OR v_org <> public.current_org_id() THEN
    RETURN jsonb_build_object('allowed', false, 'reason', 'out_of_scope');
  END IF;

  SELECT reason INTO v_sup FROM public.suppression_entries
   WHERE customer_id = _customer AND active
     AND (channel = _channel OR channel = 'all')
     AND (expires_at IS NULL OR expires_at > now())
   LIMIT 1;
  IF v_sup IS NOT NULL THEN
    RETURN jsonb_build_object('allowed', false, 'reason', 'suppressed:' || v_sup);
  END IF;

  IF NOT _marketing THEN
    RETURN jsonb_build_object('allowed', true, 'reason', 'service_message');
  END IF;

  SELECT status INTO v_status FROM public.customer_consents
   WHERE customer_id = _customer AND channel = _channel AND purpose = 'marketing'
   ORDER BY created_at DESC LIMIT 1;

  IF v_status IS DISTINCT FROM 'granted' THEN
    RETURN jsonb_build_object('allowed', false, 'reason', 'no_consent:' || COALESCE(v_status, 'unknown'));
  END IF;

  RETURN jsonb_build_object('allowed', true, 'reason', 'consented');
END $$;
REVOKE EXECUTE ON FUNCTION public.mkt_can_send(uuid, text, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.mkt_can_send(uuid, text, boolean) TO authenticated, service_role;

-- ---------- 15. Marketing dashboard metrics ----------
CREATE OR REPLACE FUNCTION public.marketing_metrics(_branch uuid DEFAULT NULL, _from date DEFAULT NULL, _to date DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE v_org uuid := public.current_org_id();
  v_from date := COALESCE(_from, current_date - 30);
  v_to date := COALESCE(_to, current_date);
  v_cost numeric := 0; v_rev numeric := 0; result jsonb;
BEGIN
  IF v_org IS NULL THEN RETURN '{}'::jsonb; END IF;
  IF NOT (public.is_org_admin() OR public.has_permission('marketing','view')) THEN
    RETURN jsonb_build_object('error', 'forbidden');
  END IF;

  SELECT COALESCE(sum(amount),0) INTO v_cost FROM public.marketing_costs
   WHERE organization_id = v_org AND incurred_on BETWEEN v_from AND v_to
     AND (_branch IS NULL OR branch_id = _branch);
  SELECT COALESCE(sum(revenue),0) INTO v_rev FROM public.campaign_conversions
   WHERE organization_id = v_org AND occurred_at::date BETWEEN v_from AND v_to
     AND (_branch IS NULL OR branch_id = _branch);

  SELECT jsonb_build_object(
    'range', jsonb_build_object('from', v_from, 'to', v_to),
    'leads_total', (SELECT count(*) FROM public.leads l WHERE l.organization_id = v_org
        AND l.created_at::date BETWEEN v_from AND v_to AND (_branch IS NULL OR l.branch_id = _branch)),
    'leads_new', (SELECT count(*) FROM public.leads l WHERE l.organization_id = v_org AND l.stage = 'new'),
    'leads_overdue', (SELECT count(*) FROM public.leads l WHERE l.organization_id = v_org
        AND l.next_followup_at < now() AND l.stage NOT IN ('won','lost','archived','unqualified')),
    'leads_won', (SELECT count(*) FROM public.leads l WHERE l.organization_id = v_org AND l.stage = 'won'
        AND l.updated_at::date BETWEEN v_from AND v_to),
    'pipeline_value', (SELECT COALESCE(sum(estimated_value),0) FROM public.leads l WHERE l.organization_id = v_org
        AND l.stage NOT IN ('won','lost','archived','unqualified')),
    'campaigns_running', (SELECT count(*) FROM public.campaigns c WHERE c.organization_id = v_org AND c.status = 'running'),
    'campaigns_scheduled', (SELECT count(*) FROM public.campaigns c WHERE c.organization_id = v_org AND c.status = 'scheduled'),
    'messages_sent', (SELECT count(*) FROM public.campaign_audiences a WHERE a.organization_id = v_org
        AND a.status IN ('sent','delivered','read','opened','clicked','converted')),
    'messages_delivered', (SELECT count(*) FROM public.campaign_audiences a WHERE a.organization_id = v_org
        AND a.status IN ('delivered','read','opened','clicked','converted')),
    'messages_excluded', (SELECT count(*) FROM public.campaign_audiences a WHERE a.organization_id = v_org AND a.status = 'excluded'),
    'loyalty_members', (SELECT count(*) FROM public.loyalty_accounts la WHERE la.organization_id = v_org),
    'points_outstanding', (SELECT COALESCE(sum(points_available),0) FROM public.loyalty_accounts la WHERE la.organization_id = v_org),
    'active_vouchers', (SELECT count(*) FROM public.reward_vouchers v WHERE v.organization_id = v_org AND v.status = 'active'),
    'reviews_total', (SELECT count(*) FROM public.reviews r WHERE r.organization_id = v_org
        AND r.review_date::date BETWEEN v_from AND v_to AND (_branch IS NULL OR r.branch_id = _branch)),
    'average_rating', (SELECT round(AVG(rating)::numeric, 2) FROM public.reviews r WHERE r.organization_id = v_org
        AND r.rating IS NOT NULL AND r.review_date::date BETWEEN v_from AND v_to),
    'open_recovery_cases', (SELECT count(*) FROM public.service_recovery_cases s WHERE s.organization_id = v_org
        AND s.status NOT IN ('resolved','closed')),
    'suppressed_contacts', (SELECT count(*) FROM public.suppression_entries s WHERE s.organization_id = v_org AND s.active),
    'marketing_cost', v_cost,
    'attributed_revenue', v_rev,
    'romi', CASE WHEN v_cost > 0 THEN round(((v_rev - v_cost) / v_cost)::numeric, 4) ELSE NULL END,
    'romi_basis', 'revenue_based'
  ) INTO result;
  RETURN result;
END $$;
REVOKE EXECUTE ON FUNCTION public.marketing_metrics(uuid, date, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.marketing_metrics(uuid, date, date) TO authenticated, service_role;
