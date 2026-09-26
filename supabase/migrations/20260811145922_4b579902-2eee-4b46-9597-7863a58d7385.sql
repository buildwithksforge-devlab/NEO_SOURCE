-- ============ customers ============
CREATE TABLE public.customers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  primary_branch_id uuid REFERENCES public.branches(id),
  auth_user_id uuid UNIQUE,
  customer_number text NOT NULL,
  customer_type text NOT NULL DEFAULT 'individual-guest',
  full_name text NOT NULL,
  preferred_name text NOT NULL DEFAULT '',
  avatar_url text,
  nationality text NOT NULL DEFAULT '',
  date_of_birth date,
  anniversary_date date,
  gender text NOT NULL DEFAULT '',
  phone text NOT NULL DEFAULT '',
  alt_phone text NOT NULL DEFAULT '',
  email text NOT NULL DEFAULT '',
  address text NOT NULL DEFAULT '',
  city text NOT NULL DEFAULT '',
  country text NOT NULL DEFAULT '',
  occupation text NOT NULL DEFAULT '',
  company text NOT NULL DEFAULT '',
  job_title text NOT NULL DEFAULT '',
  preferred_language text NOT NULL DEFAULT 'English',
  corporate_account_id uuid,
  account_manager_id uuid,
  is_vip boolean NOT NULL DEFAULT false,
  vip_notes text NOT NULL DEFAULT '',
  account_status text NOT NULL DEFAULT 'active',
  marketing_consent boolean NOT NULL DEFAULT false,
  source text NOT NULL DEFAULT 'staff-entry',
  last_interaction_at timestamptz,
  archived_at timestamptz,
  merged_into_id uuid REFERENCES public.customers(id),
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, customer_number)
);
CREATE INDEX idx_customers_org ON public.customers(organization_id);
CREATE INDEX idx_customers_email ON public.customers(organization_id, lower(email));
CREATE INDEX idx_customers_phone ON public.customers(organization_id, phone);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.customers TO authenticated;
GRANT ALL ON public.customers TO service_role;
ALTER TABLE public.customers ENABLE ROW LEVEL SECURITY;
CREATE POLICY "staff read customers" ON public.customers FOR SELECT TO authenticated
  USING (public.is_staff() AND organization_id = public.current_org_id());
CREATE POLICY "staff write customers" ON public.customers FOR INSERT TO authenticated
  WITH CHECK (public.is_staff() AND organization_id = public.current_org_id());
CREATE POLICY "staff update customers" ON public.customers FOR UPDATE TO authenticated
  USING (public.is_staff() AND organization_id = public.current_org_id())
  WITH CHECK (public.is_staff() AND organization_id = public.current_org_id());
CREATE POLICY "customer reads own record" ON public.customers FOR SELECT TO authenticated
  USING (auth_user_id = auth.uid());

CREATE TRIGGER customers_touch BEFORE UPDATE ON public.customers
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

CREATE OR REPLACE FUNCTION public.my_customer_id()
RETURNS uuid LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT id FROM public.customers WHERE auth_user_id = auth.uid() LIMIT 1;
$$;

-- ============ corporate accounts ============
CREATE TABLE public.corporate_accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  branch_id uuid REFERENCES public.branches(id),
  account_number text NOT NULL,
  account_type text NOT NULL DEFAULT 'company',
  legal_name text NOT NULL,
  trading_name text NOT NULL DEFAULT '',
  registration_number text NOT NULL DEFAULT '',
  tax_number text NOT NULL DEFAULT '',
  industry text NOT NULL DEFAULT '',
  address text NOT NULL DEFAULT '',
  billing_address text NOT NULL DEFAULT '',
  phone text NOT NULL DEFAULT '',
  email text NOT NULL DEFAULT '',
  website text NOT NULL DEFAULT '',
  account_manager_id uuid,
  account_status text NOT NULL DEFAULT 'active',
  notes text NOT NULL DEFAULT '',
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, account_number)
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.corporate_accounts TO authenticated;
GRANT ALL ON public.corporate_accounts TO service_role;
ALTER TABLE public.corporate_accounts ENABLE ROW LEVEL SECURITY;
CREATE POLICY "staff manage corporate accounts" ON public.corporate_accounts FOR ALL TO authenticated
  USING (public.is_staff() AND organization_id = public.current_org_id())
  WITH CHECK (public.is_staff() AND organization_id = public.current_org_id());
CREATE TRIGGER corporate_accounts_touch BEFORE UPDATE ON public.corporate_accounts
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

ALTER TABLE public.customers
  ADD CONSTRAINT customers_corporate_fk FOREIGN KEY (corporate_account_id)
  REFERENCES public.corporate_accounts(id) ON DELETE SET NULL;

CREATE TABLE public.corporate_contacts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  corporate_account_id uuid NOT NULL REFERENCES public.corporate_accounts(id) ON DELETE CASCADE,
  customer_id uuid REFERENCES public.customers(id) ON DELETE SET NULL,
  full_name text NOT NULL,
  job_title text NOT NULL DEFAULT '',
  phone text NOT NULL DEFAULT '',
  email text NOT NULL DEFAULT '',
  preferred_channel text NOT NULL DEFAULT 'email',
  is_primary boolean NOT NULL DEFAULT false,
  is_billing boolean NOT NULL DEFAULT false,
  is_booking boolean NOT NULL DEFAULT false,
  active boolean NOT NULL DEFAULT true,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.corporate_contacts TO authenticated;
GRANT ALL ON public.corporate_contacts TO service_role;
ALTER TABLE public.corporate_contacts ENABLE ROW LEVEL SECURITY;
CREATE POLICY "staff manage corporate contacts" ON public.corporate_contacts FOR ALL TO authenticated
  USING (public.is_staff() AND organization_id = public.current_org_id())
  WITH CHECK (public.is_staff() AND organization_id = public.current_org_id());
CREATE TRIGGER corporate_contacts_touch BEFORE UPDATE ON public.corporate_contacts
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

CREATE TABLE public.corporate_credit_settings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  corporate_account_id uuid NOT NULL UNIQUE REFERENCES public.corporate_accounts(id) ON DELETE CASCADE,
  credit_status text NOT NULL DEFAULT 'active',
  credit_limit numeric NOT NULL DEFAULT 0,
  outstanding_balance numeric NOT NULL DEFAULT 0,
  overdue_balance numeric NOT NULL DEFAULT 0,
  payment_terms_days integer NOT NULL DEFAULT 30,
  billing_cycle text NOT NULL DEFAULT 'monthly',
  risk_status text NOT NULL DEFAULT 'normal',
  last_approval_request_id uuid REFERENCES public.approval_requests(id),
  approved_by uuid,
  approved_at timestamptz,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.corporate_credit_settings TO authenticated;
GRANT ALL ON public.corporate_credit_settings TO service_role;
ALTER TABLE public.corporate_credit_settings ENABLE ROW LEVEL SECURITY;
CREATE POLICY "staff manage credit settings" ON public.corporate_credit_settings FOR ALL TO authenticated
  USING (public.is_staff() AND organization_id = public.current_org_id())
  WITH CHECK (public.is_staff() AND organization_id = public.current_org_id());
CREATE TRIGGER corporate_credit_settings_touch BEFORE UPDATE ON public.corporate_credit_settings
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

-- ============ customer detail tables ============
CREATE TABLE public.customer_identifiers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  customer_id uuid NOT NULL REFERENCES public.customers(id) ON DELETE CASCADE,
  document_type text NOT NULL,
  masked_number text NOT NULL,
  issuing_country text NOT NULL DEFAULT '',
  expiry_date date,
  verification_status text NOT NULL DEFAULT 'unverified',
  verified_by uuid,
  verified_at timestamptz,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.customer_identifiers TO authenticated;
GRANT ALL ON public.customer_identifiers TO service_role;
ALTER TABLE public.customer_identifiers ENABLE ROW LEVEL SECURITY;
CREATE POLICY "identity view restricted" ON public.customer_identifiers FOR SELECT TO authenticated
  USING (organization_id = public.current_org_id()
     AND (public.is_org_admin() OR public.has_permission('front-office','view')));
CREATE POLICY "identity write restricted" ON public.customer_identifiers FOR INSERT TO authenticated
  WITH CHECK (organization_id = public.current_org_id()
     AND (public.is_org_admin() OR public.has_permission('front-office','edit')));
CREATE POLICY "identity update restricted" ON public.customer_identifiers FOR UPDATE TO authenticated
  USING (organization_id = public.current_org_id()
     AND (public.is_org_admin() OR public.has_permission('front-office','edit')))
  WITH CHECK (organization_id = public.current_org_id());
CREATE TRIGGER customer_identifiers_touch BEFORE UPDATE ON public.customer_identifiers
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

CREATE TABLE public.customer_addresses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  customer_id uuid NOT NULL REFERENCES public.customers(id) ON DELETE CASCADE,
  label text NOT NULL DEFAULT 'home',
  address_line text NOT NULL DEFAULT '',
  city text NOT NULL DEFAULT '',
  country text NOT NULL DEFAULT '',
  postal_code text NOT NULL DEFAULT '',
  is_primary boolean NOT NULL DEFAULT false,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.customer_addresses TO authenticated;
GRANT ALL ON public.customer_addresses TO service_role;
ALTER TABLE public.customer_addresses ENABLE ROW LEVEL SECURITY;
CREATE POLICY "staff manage addresses" ON public.customer_addresses FOR ALL TO authenticated
  USING (public.is_staff() AND organization_id = public.current_org_id())
  WITH CHECK (public.is_staff() AND organization_id = public.current_org_id());
CREATE POLICY "customer reads own addresses" ON public.customer_addresses FOR SELECT TO authenticated
  USING (customer_id = public.my_customer_id());
CREATE TRIGGER customer_addresses_touch BEFORE UPDATE ON public.customer_addresses
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

CREATE TABLE public.customer_emergency_contacts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  customer_id uuid NOT NULL REFERENCES public.customers(id) ON DELETE CASCADE,
  full_name text NOT NULL,
  relationship text NOT NULL DEFAULT '',
  phone text NOT NULL DEFAULT '',
  email text NOT NULL DEFAULT '',
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.customer_emergency_contacts TO authenticated;
GRANT ALL ON public.customer_emergency_contacts TO service_role;
ALTER TABLE public.customer_emergency_contacts ENABLE ROW LEVEL SECURITY;
CREATE POLICY "emergency contacts restricted" ON public.customer_emergency_contacts FOR ALL TO authenticated
  USING (organization_id = public.current_org_id()
     AND (public.is_org_admin() OR public.has_permission('front-office','view')))
  WITH CHECK (organization_id = public.current_org_id() AND public.is_staff());
CREATE TRIGGER customer_emergency_contacts_touch BEFORE UPDATE ON public.customer_emergency_contacts
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

CREATE TABLE public.customer_preferences (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  customer_id uuid NOT NULL REFERENCES public.customers(id) ON DELETE CASCADE,
  category text NOT NULL,
  preference_key text NOT NULL,
  preference_value text NOT NULL DEFAULT '',
  is_critical boolean NOT NULL DEFAULT false,
  source text NOT NULL DEFAULT 'staff-entry',
  verification_status text NOT NULL DEFAULT 'unverified',
  notes text NOT NULL DEFAULT '',
  active boolean NOT NULL DEFAULT true,
  recorded_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.customer_preferences TO authenticated;
GRANT ALL ON public.customer_preferences TO service_role;
ALTER TABLE public.customer_preferences ENABLE ROW LEVEL SECURITY;
CREATE POLICY "staff manage preferences" ON public.customer_preferences FOR ALL TO authenticated
  USING (public.is_staff() AND organization_id = public.current_org_id())
  WITH CHECK (public.is_staff() AND organization_id = public.current_org_id());
CREATE POLICY "customer reads own preferences" ON public.customer_preferences FOR SELECT TO authenticated
  USING (customer_id = public.my_customer_id());
CREATE TRIGGER customer_preferences_touch BEFORE UPDATE ON public.customer_preferences
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

CREATE TABLE public.customer_relationships (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  customer_id uuid NOT NULL REFERENCES public.customers(id) ON DELETE CASCADE,
  related_customer_id uuid REFERENCES public.customers(id) ON DELETE CASCADE,
  dependent_name text NOT NULL DEFAULT '',
  dependent_birth_year integer,
  relationship text NOT NULL,
  is_dependent boolean NOT NULL DEFAULT false,
  service_notes text NOT NULL DEFAULT '',
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.customer_relationships TO authenticated;
GRANT ALL ON public.customer_relationships TO service_role;
ALTER TABLE public.customer_relationships ENABLE ROW LEVEL SECURITY;
CREATE POLICY "staff manage relationships" ON public.customer_relationships FOR ALL TO authenticated
  USING (public.is_staff() AND organization_id = public.current_org_id())
  WITH CHECK (public.is_staff() AND organization_id = public.current_org_id());
CREATE TRIGGER customer_relationships_touch BEFORE UPDATE ON public.customer_relationships
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

CREATE TABLE public.customer_notes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  customer_id uuid NOT NULL REFERENCES public.customers(id) ON DELETE CASCADE,
  branch_id uuid REFERENCES public.branches(id),
  category text NOT NULL DEFAULT 'general',
  body text NOT NULL,
  is_internal boolean NOT NULL DEFAULT true,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.customer_notes TO authenticated;
GRANT ALL ON public.customer_notes TO service_role;
ALTER TABLE public.customer_notes ENABLE ROW LEVEL SECURITY;
CREATE POLICY "staff manage notes" ON public.customer_notes FOR ALL TO authenticated
  USING (public.is_staff() AND organization_id = public.current_org_id())
  WITH CHECK (public.is_staff() AND organization_id = public.current_org_id());
CREATE TRIGGER customer_notes_touch BEFORE UPDATE ON public.customer_notes
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

CREATE TABLE public.customer_documents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  customer_id uuid NOT NULL REFERENCES public.customers(id) ON DELETE CASCADE,
  document_type text NOT NULL,
  title text NOT NULL,
  storage_path text NOT NULL,
  is_sensitive boolean NOT NULL DEFAULT true,
  retention_until date,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.customer_documents TO authenticated;
GRANT ALL ON public.customer_documents TO service_role;
ALTER TABLE public.customer_documents ENABLE ROW LEVEL SECURITY;
CREATE POLICY "documents restricted" ON public.customer_documents FOR ALL TO authenticated
  USING (organization_id = public.current_org_id()
     AND (public.is_org_admin() OR public.has_permission('front-office','view')))
  WITH CHECK (organization_id = public.current_org_id() AND public.is_staff());
CREATE TRIGGER customer_documents_touch BEFORE UPDATE ON public.customer_documents
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

-- ============ loyalty ============
CREATE TABLE public.loyalty_programs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  name text NOT NULL,
  description text NOT NULL DEFAULT '',
  points_per_currency numeric NOT NULL DEFAULT 1,
  currency_per_point numeric NOT NULL DEFAULT 1,
  min_redemption_points integer NOT NULL DEFAULT 100,
  max_redemption_points integer NOT NULL DEFAULT 100000,
  point_expiry_months integer NOT NULL DEFAULT 24,
  reward_validity_days integer NOT NULL DEFAULT 90,
  eligible_services jsonb NOT NULL DEFAULT '[]'::jsonb,
  excluded_transactions jsonb NOT NULL DEFAULT '[]'::jsonb,
  requires_approval_above integer NOT NULL DEFAULT 5000,
  branch_scope text NOT NULL DEFAULT 'all',
  active boolean NOT NULL DEFAULT true,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.loyalty_programs TO authenticated;
GRANT ALL ON public.loyalty_programs TO service_role;
ALTER TABLE public.loyalty_programs ENABLE ROW LEVEL SECURITY;
CREATE POLICY "staff manage programs" ON public.loyalty_programs FOR ALL TO authenticated
  USING (public.is_staff() AND organization_id = public.current_org_id())
  WITH CHECK (public.is_staff() AND organization_id = public.current_org_id());
CREATE POLICY "customer reads programs" ON public.loyalty_programs FOR SELECT TO authenticated
  USING (active AND organization_id IN (SELECT organization_id FROM public.customers WHERE auth_user_id = auth.uid()));
CREATE TRIGGER loyalty_programs_touch BEFORE UPDATE ON public.loyalty_programs
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

CREATE TABLE public.loyalty_tiers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  program_id uuid NOT NULL REFERENCES public.loyalty_programs(id) ON DELETE CASCADE,
  name text NOT NULL,
  threshold_points integer NOT NULL DEFAULT 0,
  benefits text NOT NULL DEFAULT '',
  color text NOT NULL DEFAULT '#0f766e',
  sort_order integer NOT NULL DEFAULT 0,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.loyalty_tiers TO authenticated;
GRANT ALL ON public.loyalty_tiers TO service_role;
ALTER TABLE public.loyalty_tiers ENABLE ROW LEVEL SECURITY;
CREATE POLICY "staff manage tiers" ON public.loyalty_tiers FOR ALL TO authenticated
  USING (public.is_staff() AND organization_id = public.current_org_id())
  WITH CHECK (public.is_staff() AND organization_id = public.current_org_id());
CREATE POLICY "customer reads tiers" ON public.loyalty_tiers FOR SELECT TO authenticated
  USING (organization_id IN (SELECT organization_id FROM public.customers WHERE auth_user_id = auth.uid()));
CREATE TRIGGER loyalty_tiers_touch BEFORE UPDATE ON public.loyalty_tiers
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

CREATE TABLE public.loyalty_accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  customer_id uuid NOT NULL REFERENCES public.customers(id) ON DELETE CASCADE,
  program_id uuid NOT NULL REFERENCES public.loyalty_programs(id) ON DELETE CASCADE,
  membership_number text NOT NULL,
  tier_id uuid REFERENCES public.loyalty_tiers(id),
  enrolled_at timestamptz NOT NULL DEFAULT now(),
  points_earned integer NOT NULL DEFAULT 0,
  points_redeemed integer NOT NULL DEFAULT 0,
  points_expired integer NOT NULL DEFAULT 0,
  points_available integer NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'active',
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (customer_id, program_id),
  UNIQUE (organization_id, membership_number),
  CONSTRAINT loyalty_points_not_negative CHECK (points_available >= 0)
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.loyalty_accounts TO authenticated;
GRANT ALL ON public.loyalty_accounts TO service_role;
ALTER TABLE public.loyalty_accounts ENABLE ROW LEVEL SECURITY;
CREATE POLICY "staff manage loyalty accounts" ON public.loyalty_accounts FOR ALL TO authenticated
  USING (public.is_staff() AND organization_id = public.current_org_id())
  WITH CHECK (public.is_staff() AND organization_id = public.current_org_id());
CREATE POLICY "customer reads own loyalty" ON public.loyalty_accounts FOR SELECT TO authenticated
  USING (customer_id = public.my_customer_id());
CREATE TRIGGER loyalty_accounts_touch BEFORE UPDATE ON public.loyalty_accounts
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

CREATE TABLE public.loyalty_transactions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  branch_id uuid REFERENCES public.branches(id),
  account_id uuid NOT NULL REFERENCES public.loyalty_accounts(id) ON DELETE CASCADE,
  customer_id uuid NOT NULL REFERENCES public.customers(id) ON DELETE CASCADE,
  transaction_type text NOT NULL,
  points integer NOT NULL,
  source_module text NOT NULL DEFAULT 'crm',
  source_reference text,
  reason text NOT NULL DEFAULT '',
  approval_request_id uuid REFERENCES public.approval_requests(id),
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, source_module, source_reference, transaction_type)
);
GRANT SELECT, INSERT ON public.loyalty_transactions TO authenticated;
GRANT ALL ON public.loyalty_transactions TO service_role;
ALTER TABLE public.loyalty_transactions ENABLE ROW LEVEL SECURITY;
CREATE POLICY "staff read loyalty ledger" ON public.loyalty_transactions FOR SELECT TO authenticated
  USING (public.is_staff() AND organization_id = public.current_org_id());
CREATE POLICY "staff insert loyalty ledger" ON public.loyalty_transactions FOR INSERT TO authenticated
  WITH CHECK (public.is_staff() AND organization_id = public.current_org_id());
CREATE POLICY "customer reads own ledger" ON public.loyalty_transactions FOR SELECT TO authenticated
  USING (customer_id = public.my_customer_id());

CREATE OR REPLACE FUNCTION public.apply_loyalty_transaction()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE _acct public.loyalty_accounts;
BEGIN
  SELECT * INTO _acct FROM public.loyalty_accounts WHERE id = NEW.account_id FOR UPDATE;
  IF _acct.id IS NULL THEN RAISE EXCEPTION 'Loyalty account not found'; END IF;
  IF NEW.points <= 0 THEN RAISE EXCEPTION 'Points must be greater than zero'; END IF;

  IF NEW.transaction_type = 'earn' THEN
    UPDATE public.loyalty_accounts SET points_earned = points_earned + NEW.points,
      points_available = points_available + NEW.points WHERE id = _acct.id;
  ELSIF NEW.transaction_type = 'redeem' THEN
    IF _acct.points_available < NEW.points THEN
      RAISE EXCEPTION 'Insufficient available points';
    END IF;
    UPDATE public.loyalty_accounts SET points_redeemed = points_redeemed + NEW.points,
      points_available = points_available - NEW.points WHERE id = _acct.id;
  ELSIF NEW.transaction_type = 'expire' THEN
    IF _acct.points_available < NEW.points THEN RAISE EXCEPTION 'Cannot expire more points than available'; END IF;
    UPDATE public.loyalty_accounts SET points_expired = points_expired + NEW.points,
      points_available = points_available - NEW.points WHERE id = _acct.id;
  ELSIF NEW.transaction_type = 'adjust' THEN
    UPDATE public.loyalty_accounts SET points_earned = points_earned + NEW.points,
      points_available = points_available + NEW.points WHERE id = _acct.id;
  ELSIF NEW.transaction_type = 'reverse' THEN
    IF _acct.points_available < NEW.points THEN RAISE EXCEPTION 'Cannot reverse more points than available'; END IF;
    UPDATE public.loyalty_accounts SET points_earned = GREATEST(points_earned - NEW.points, 0),
      points_available = points_available - NEW.points WHERE id = _acct.id;
  ELSE
    RAISE EXCEPTION 'Unknown loyalty transaction type %', NEW.transaction_type;
  END IF;
  RETURN NEW;
END; $$;

CREATE TRIGGER loyalty_transactions_apply AFTER INSERT ON public.loyalty_transactions
  FOR EACH ROW EXECUTE FUNCTION public.apply_loyalty_transaction();

CREATE TABLE public.reward_vouchers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  customer_id uuid NOT NULL REFERENCES public.customers(id) ON DELETE CASCADE,
  program_id uuid REFERENCES public.loyalty_programs(id) ON DELETE SET NULL,
  code text NOT NULL,
  reward_type text NOT NULL DEFAULT 'discount',
  description text NOT NULL DEFAULT '',
  points_cost integer NOT NULL DEFAULT 0,
  value_amount numeric NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'issued',
  valid_until date,
  redeemed_at timestamptz,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, code)
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.reward_vouchers TO authenticated;
GRANT ALL ON public.reward_vouchers TO service_role;
ALTER TABLE public.reward_vouchers ENABLE ROW LEVEL SECURITY;
CREATE POLICY "staff manage vouchers" ON public.reward_vouchers FOR ALL TO authenticated
  USING (public.is_staff() AND organization_id = public.current_org_id())
  WITH CHECK (public.is_staff() AND organization_id = public.current_org_id());
CREATE POLICY "customer reads own vouchers" ON public.reward_vouchers FOR SELECT TO authenticated
  USING (customer_id = public.my_customer_id());
CREATE TRIGGER reward_vouchers_touch BEFORE UPDATE ON public.reward_vouchers
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

-- ============ communications & consent ============
CREATE TABLE public.customer_communications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  branch_id uuid REFERENCES public.branches(id),
  customer_id uuid REFERENCES public.customers(id) ON DELETE CASCADE,
  corporate_account_id uuid REFERENCES public.corporate_accounts(id) ON DELETE CASCADE,
  channel text NOT NULL,
  direction text NOT NULL DEFAULT 'outgoing',
  category text NOT NULL DEFAULT 'service',
  subject text NOT NULL DEFAULT '',
  summary text NOT NULL DEFAULT '',
  template_key text,
  sender_user_id uuid,
  recipient text NOT NULL DEFAULT '',
  delivery_status text NOT NULL DEFAULT 'logged',
  read_at timestamptz,
  is_marketing boolean NOT NULL DEFAULT false,
  consent_verified boolean NOT NULL DEFAULT false,
  customer_visible boolean NOT NULL DEFAULT true,
  related_module text,
  related_reference text,
  external_reference text,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.customer_communications TO authenticated;
GRANT ALL ON public.customer_communications TO service_role;
ALTER TABLE public.customer_communications ENABLE ROW LEVEL SECURITY;
CREATE POLICY "staff manage communications" ON public.customer_communications FOR ALL TO authenticated
  USING (public.is_staff() AND organization_id = public.current_org_id())
  WITH CHECK (public.is_staff() AND organization_id = public.current_org_id());
CREATE POLICY "customer reads own communications" ON public.customer_communications FOR SELECT TO authenticated
  USING (customer_visible AND customer_id = public.my_customer_id());
CREATE TRIGGER customer_communications_touch BEFORE UPDATE ON public.customer_communications
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

CREATE TABLE public.customer_consents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  customer_id uuid NOT NULL REFERENCES public.customers(id) ON DELETE CASCADE,
  consent_type text NOT NULL,
  granted boolean NOT NULL,
  consent_source text NOT NULL DEFAULT 'staff-entry',
  consent_wording text NOT NULL DEFAULT '',
  policy_version text NOT NULL DEFAULT 'v1',
  effective_at timestamptz NOT NULL DEFAULT now(),
  withdrawn_at timestamptz,
  recorded_by uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_consents_customer ON public.customer_consents(customer_id, consent_type, effective_at DESC);
GRANT SELECT, INSERT ON public.customer_consents TO authenticated;
GRANT ALL ON public.customer_consents TO service_role;
ALTER TABLE public.customer_consents ENABLE ROW LEVEL SECURITY;
CREATE POLICY "staff read consents" ON public.customer_consents FOR SELECT TO authenticated
  USING (public.is_staff() AND organization_id = public.current_org_id());
CREATE POLICY "staff insert consents" ON public.customer_consents FOR INSERT TO authenticated
  WITH CHECK (public.is_staff() AND organization_id = public.current_org_id());
CREATE POLICY "customer reads own consents" ON public.customer_consents FOR SELECT TO authenticated
  USING (customer_id = public.my_customer_id());
CREATE POLICY "customer records own consent" ON public.customer_consents FOR INSERT TO authenticated
  WITH CHECK (customer_id = public.my_customer_id() AND consent_source = 'guest-portal');

-- ============ feedback ============
CREATE TABLE public.customer_feedback (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  branch_id uuid REFERENCES public.branches(id),
  department_id uuid REFERENCES public.departments(id),
  station_id uuid REFERENCES public.operational_stations(id),
  customer_id uuid REFERENCES public.customers(id) ON DELETE SET NULL,
  corporate_account_id uuid REFERENCES public.corporate_accounts(id) ON DELETE SET NULL,
  reference text NOT NULL,
  feedback_type text NOT NULL DEFAULT 'review',
  source text NOT NULL DEFAULT 'staff-entry',
  rating integer,
  category text NOT NULL DEFAULT 'general',
  subject text NOT NULL,
  description text NOT NULL DEFAULT '',
  priority text NOT NULL DEFAULT 'normal',
  assigned_department_id uuid REFERENCES public.departments(id),
  assigned_user_id uuid,
  status text NOT NULL DEFAULT 'new',
  received_at timestamptz NOT NULL DEFAULT now(),
  first_response_at timestamptz,
  resolution_due_at timestamptz,
  resolved_at timestamptz,
  closed_at timestamptz,
  resolution_notes text NOT NULL DEFAULT '',
  satisfaction_after_resolution integer,
  related_module text,
  related_reference text,
  task_id uuid REFERENCES public.tasks(id) ON DELETE SET NULL,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, reference)
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.customer_feedback TO authenticated;
GRANT ALL ON public.customer_feedback TO service_role;
ALTER TABLE public.customer_feedback ENABLE ROW LEVEL SECURITY;
CREATE POLICY "staff manage feedback" ON public.customer_feedback FOR ALL TO authenticated
  USING (public.is_staff() AND organization_id = public.current_org_id())
  WITH CHECK (public.is_staff() AND organization_id = public.current_org_id());
CREATE POLICY "customer reads own feedback" ON public.customer_feedback FOR SELECT TO authenticated
  USING (customer_id = public.my_customer_id());
CREATE POLICY "customer submits feedback" ON public.customer_feedback FOR INSERT TO authenticated
  WITH CHECK (customer_id = public.my_customer_id() AND source = 'guest-portal');
CREATE TRIGGER customer_feedback_touch BEFORE UPDATE ON public.customer_feedback
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

CREATE TABLE public.complaint_actions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  feedback_id uuid NOT NULL REFERENCES public.customer_feedback(id) ON DELETE CASCADE,
  action text NOT NULL,
  comment text NOT NULL DEFAULT '',
  is_internal boolean NOT NULL DEFAULT true,
  actor_id uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT ON public.complaint_actions TO authenticated;
GRANT ALL ON public.complaint_actions TO service_role;
ALTER TABLE public.complaint_actions ENABLE ROW LEVEL SECURITY;
CREATE POLICY "staff read complaint actions" ON public.complaint_actions FOR SELECT TO authenticated
  USING (public.is_staff() AND organization_id = public.current_org_id());
CREATE POLICY "staff insert complaint actions" ON public.complaint_actions FOR INSERT TO authenticated
  WITH CHECK (public.is_staff() AND organization_id = public.current_org_id());
CREATE POLICY "customer reads public actions" ON public.complaint_actions FOR SELECT TO authenticated
  USING (NOT is_internal AND feedback_id IN (SELECT id FROM public.customer_feedback WHERE customer_id = public.my_customer_id()));

-- ============ segments ============
CREATE TABLE public.customer_segments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  name text NOT NULL,
  description text NOT NULL DEFAULT '',
  rule_type text NOT NULL DEFAULT 'dynamic',
  conditions jsonb NOT NULL DEFAULT '[]'::jsonb,
  estimated_members integer NOT NULL DEFAULT 0,
  last_calculated_at timestamptz,
  owner_id uuid,
  status text NOT NULL DEFAULT 'active',
  campaign_eligible boolean NOT NULL DEFAULT true,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, name)
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.customer_segments TO authenticated;
GRANT ALL ON public.customer_segments TO service_role;
ALTER TABLE public.customer_segments ENABLE ROW LEVEL SECURITY;
CREATE POLICY "staff manage segments" ON public.customer_segments FOR ALL TO authenticated
  USING (public.is_staff() AND organization_id = public.current_org_id())
  WITH CHECK (public.is_staff() AND organization_id = public.current_org_id());
CREATE TRIGGER customer_segments_touch BEFORE UPDATE ON public.customer_segments
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

CREATE TABLE public.customer_segment_memberships (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  segment_id uuid NOT NULL REFERENCES public.customer_segments(id) ON DELETE CASCADE,
  customer_id uuid NOT NULL REFERENCES public.customers(id) ON DELETE CASCADE,
  added_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (segment_id, customer_id)
);
GRANT SELECT, INSERT, DELETE ON public.customer_segment_memberships TO authenticated;
GRANT ALL ON public.customer_segment_memberships TO service_role;
ALTER TABLE public.customer_segment_memberships ENABLE ROW LEVEL SECURITY;
CREATE POLICY "staff manage segment members" ON public.customer_segment_memberships FOR ALL TO authenticated
  USING (public.is_staff() AND organization_id = public.current_org_id())
  WITH CHECK (public.is_staff() AND organization_id = public.current_org_id());

-- ============ timeline, metrics, AI, merges ============
CREATE TABLE public.customer_timeline_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  customer_id uuid NOT NULL REFERENCES public.customers(id) ON DELETE CASCADE,
  branch_id uuid REFERENCES public.branches(id),
  department_id uuid REFERENCES public.departments(id),
  event_type text NOT NULL,
  description text NOT NULL DEFAULT '',
  source_module text NOT NULL DEFAULT 'crm',
  source_record_id text,
  staff_user_id uuid,
  customer_visible boolean NOT NULL DEFAULT false,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_timeline_customer ON public.customer_timeline_events(customer_id, occurred_at DESC);
GRANT SELECT, INSERT ON public.customer_timeline_events TO authenticated;
GRANT ALL ON public.customer_timeline_events TO service_role;
ALTER TABLE public.customer_timeline_events ENABLE ROW LEVEL SECURITY;
CREATE POLICY "staff read timeline" ON public.customer_timeline_events FOR SELECT TO authenticated
  USING (public.is_staff() AND organization_id = public.current_org_id());
CREATE POLICY "staff insert timeline" ON public.customer_timeline_events FOR INSERT TO authenticated
  WITH CHECK (public.is_staff() AND organization_id = public.current_org_id());
CREATE POLICY "customer reads own timeline" ON public.customer_timeline_events FOR SELECT TO authenticated
  USING (customer_visible AND customer_id = public.my_customer_id());

CREATE TABLE public.customer_metrics (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  customer_id uuid NOT NULL UNIQUE REFERENCES public.customers(id) ON DELETE CASCADE,
  total_stays integer NOT NULL DEFAULT 0,
  total_nights integer NOT NULL DEFAULT 0,
  average_length_of_stay numeric NOT NULL DEFAULT 0,
  last_stay_date date,
  next_stay_date date,
  preferred_room_type text NOT NULL DEFAULT '',
  most_used_booking_source text NOT NULL DEFAULT '',
  total_spend numeric NOT NULL DEFAULT 0,
  accommodation_spend numeric NOT NULL DEFAULT 0,
  average_transaction_value numeric NOT NULL DEFAULT 0,
  outstanding_balance numeric NOT NULL DEFAULT 0,
  refund_total numeric NOT NULL DEFAULT 0,
  visit_count integer NOT NULL DEFAULT 0,
  satisfaction_score numeric,
  computed_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE ON public.customer_metrics TO authenticated;
GRANT ALL ON public.customer_metrics TO service_role;
ALTER TABLE public.customer_metrics ENABLE ROW LEVEL SECURITY;
CREATE POLICY "staff manage customer metrics" ON public.customer_metrics FOR ALL TO authenticated
  USING (public.is_staff() AND organization_id = public.current_org_id())
  WITH CHECK (public.is_staff() AND organization_id = public.current_org_id());
CREATE TRIGGER customer_metrics_touch BEFORE UPDATE ON public.customer_metrics
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

CREATE TABLE public.customer_ai_insights (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  customer_id uuid REFERENCES public.customers(id) ON DELETE CASCADE,
  scope text NOT NULL DEFAULT 'customer',
  period_start timestamptz NOT NULL,
  period_end timestamptz NOT NULL,
  summary text NOT NULL,
  insights jsonb NOT NULL DEFAULT '[]'::jsonb,
  data_sources jsonb NOT NULL DEFAULT '[]'::jsonb,
  model text NOT NULL,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT ON public.customer_ai_insights TO authenticated;
GRANT ALL ON public.customer_ai_insights TO service_role;
ALTER TABLE public.customer_ai_insights ENABLE ROW LEVEL SECURITY;
CREATE POLICY "staff read ai insights" ON public.customer_ai_insights FOR SELECT TO authenticated
  USING (public.is_staff() AND organization_id = public.current_org_id());
CREATE POLICY "staff insert ai insights" ON public.customer_ai_insights FOR INSERT TO authenticated
  WITH CHECK (public.is_staff() AND organization_id = public.current_org_id());

CREATE TABLE public.customer_merge_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  surviving_customer_id uuid NOT NULL REFERENCES public.customers(id) ON DELETE CASCADE,
  merged_customer_id uuid NOT NULL REFERENCES public.customers(id) ON DELETE CASCADE,
  reason text NOT NULL DEFAULT '',
  snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
  performed_by uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT ON public.customer_merge_history TO authenticated;
GRANT ALL ON public.customer_merge_history TO service_role;
ALTER TABLE public.customer_merge_history ENABLE ROW LEVEL SECURITY;
CREATE POLICY "admin reads merges" ON public.customer_merge_history FOR SELECT TO authenticated
  USING (public.is_staff() AND organization_id = public.current_org_id());
CREATE POLICY "admin inserts merges" ON public.customer_merge_history FOR INSERT TO authenticated
  WITH CHECK (public.is_staff() AND organization_id = public.current_org_id() AND public.is_org_admin());

-- ============ CRM permissions ============
INSERT INTO public.permissions (module, action, label) VALUES
  ('crm-customers','view','View customers'),
  ('crm-customers','create','Create customers'),
  ('crm-customers','edit','Edit customers'),
  ('crm-customers','export','Export customer data'),
  ('crm-customers','merge','Merge duplicate profiles'),
  ('crm-identity','view','View restricted identity data'),
  ('crm-identity','edit','Edit restricted identity data'),
  ('crm-preferences','view','View guest preferences'),
  ('crm-preferences','edit','Edit guest preferences'),
  ('crm-corporate','view','View corporate accounts'),
  ('crm-corporate','edit','Manage corporate accounts'),
  ('crm-credit','view','View credit accounts'),
  ('crm-credit','create','Request credit limits'),
  ('crm-credit','approve','Approve credit limits'),
  ('crm-loyalty','view','View loyalty'),
  ('crm-loyalty','edit','Manage loyalty'),
  ('crm-loyalty','override','Adjust loyalty points'),
  ('crm-communications','view','View communications'),
  ('crm-communications','create','Send or log communications'),
  ('crm-feedback','view','View feedback and complaints'),
  ('crm-feedback','edit','Manage feedback and complaints'),
  ('crm-segments','view','View segments'),
  ('crm-segments','edit','Manage segments'),
  ('crm-ai','view','View AI customer insights'),
  ('crm-ai','create','Generate AI customer insights')
ON CONFLICT DO NOTHING;

INSERT INTO public.role_permissions (organization_id, role_id, permission_id)
SELECT r.organization_id, r.id, p.id
FROM public.roles r
JOIN public.permissions p ON p.module LIKE 'crm-%'
WHERE r.name IN ('Owner','General Manager')
  AND NOT EXISTS (
    SELECT 1 FROM public.role_permissions rp WHERE rp.role_id = r.id AND rp.permission_id = p.id
  );