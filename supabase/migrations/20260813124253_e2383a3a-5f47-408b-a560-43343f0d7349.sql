CREATE EXTENSION IF NOT EXISTS btree_gist;

-- ============ configuration ============
CREATE TABLE public.event_types (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  key text NOT NULL,
  name text NOT NULL,
  category text NOT NULL DEFAULT 'general',
  description text NOT NULL DEFAULT '',
  default_service_style text NOT NULL DEFAULT 'buffet',
  milestone_template jsonb NOT NULL DEFAULT '[]'::jsonb,
  task_template jsonb NOT NULL DEFAULT '[]'::jsonb,
  active boolean NOT NULL DEFAULT true,
  sort_order integer NOT NULL DEFAULT 0,
  created_by uuid,
  updated_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, key)
);

CREATE TABLE public.event_venues (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  branch_id uuid REFERENCES public.branches(id) ON DELETE SET NULL,
  code text NOT NULL DEFAULT '',
  name text NOT NULL,
  description text NOT NULL DEFAULT '',
  location text NOT NULL DEFAULT '',
  is_outdoor boolean NOT NULL DEFAULT false,
  min_capacity integer NOT NULL DEFAULT 0,
  max_capacity integer NOT NULL DEFAULT 0,
  layouts text[] NOT NULL DEFAULT '{}',
  base_hire_price numeric(14,2) NOT NULL DEFAULT 0,
  tax_rate numeric(6,3) NOT NULL DEFAULT 0,
  setup_minutes integer NOT NULL DEFAULT 60,
  breakdown_minutes integer NOT NULL DEFAULT 60,
  opens_at time NOT NULL DEFAULT '06:00',
  closes_at time NOT NULL DEFAULT '23:00',
  facilities text[] NOT NULL DEFAULT '{}',
  accessibility text NOT NULL DEFAULT '',
  images text[] NOT NULL DEFAULT '{}',
  status text NOT NULL DEFAULT 'available',
  maintenance_note text NOT NULL DEFAULT '',
  created_by uuid,
  updated_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT event_venues_status_chk CHECK (status IN ('available','temporarily-unavailable','under-maintenance','inactive')),
  CONSTRAINT event_venues_capacity_chk CHECK (max_capacity >= min_capacity)
);
CREATE INDEX idx_event_venues_org ON public.event_venues(organization_id, branch_id);

CREATE TABLE public.event_resources (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  branch_id uuid REFERENCES public.branches(id) ON DELETE SET NULL,
  name text NOT NULL,
  category text NOT NULL DEFAULT 'equipment',
  quantity_owned integer NOT NULL DEFAULT 0,
  condition text NOT NULL DEFAULT 'good',
  location text NOT NULL DEFAULT '',
  hire_price numeric(14,2) NOT NULL DEFAULT 0,
  maintenance_status text NOT NULL DEFAULT 'ok',
  active boolean NOT NULL DEFAULT true,
  created_by uuid,
  updated_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT event_resources_qty_chk CHECK (quantity_owned >= 0)
);
CREATE INDEX idx_event_resources_org ON public.event_resources(organization_id, branch_id);

CREATE TABLE public.event_packages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  branch_id uuid REFERENCES public.branches(id) ON DELETE SET NULL,
  event_type_id uuid REFERENCES public.event_types(id) ON DELETE SET NULL,
  name text NOT NULL,
  description text NOT NULL DEFAULT '',
  price_basis text NOT NULL DEFAULT 'per-person',
  price numeric(14,2) NOT NULL DEFAULT 0,
  min_guests integer NOT NULL DEFAULT 0,
  max_guests integer NOT NULL DEFAULT 0,
  exclusions text NOT NULL DEFAULT '',
  tax_rate numeric(6,3) NOT NULL DEFAULT 0,
  valid_from date,
  valid_to date,
  active boolean NOT NULL DEFAULT true,
  created_by uuid,
  updated_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT event_packages_basis_chk CHECK (price_basis IN ('per-person','fixed','per-hour','per-day'))
);

CREATE TABLE public.event_package_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  package_id uuid NOT NULL REFERENCES public.event_packages(id) ON DELETE CASCADE,
  component text NOT NULL,
  description text NOT NULL DEFAULT '',
  quantity numeric(14,3) NOT NULL DEFAULT 1,
  unit_price numeric(14,2) NOT NULL DEFAULT 0,
  is_optional boolean NOT NULL DEFAULT false,
  sort_order integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_event_package_items_pkg ON public.event_package_items(package_id);

-- ============ enquiries & site visits ============
CREATE TABLE public.event_enquiries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  branch_id uuid REFERENCES public.branches(id) ON DELETE SET NULL,
  enquiry_number text NOT NULL,
  customer_id uuid REFERENCES public.customers(id) ON DELETE SET NULL,
  corporate_account_id uuid REFERENCES public.corporate_accounts(id) ON DELETE SET NULL,
  contact_name text NOT NULL DEFAULT '',
  phone text NOT NULL DEFAULT '',
  email text NOT NULL DEFAULT '',
  preferred_channel text NOT NULL DEFAULT 'email',
  event_type_id uuid REFERENCES public.event_types(id) ON DELETE SET NULL,
  event_type_label text NOT NULL DEFAULT '',
  proposed_date date,
  alternative_date date,
  start_time time,
  end_time time,
  expected_adults integer NOT NULL DEFAULT 0,
  expected_children integer NOT NULL DEFAULT 0,
  venue_id uuid REFERENCES public.event_venues(id) ON DELETE SET NULL,
  outdoor_preference text NOT NULL DEFAULT 'any',
  needs_accommodation boolean NOT NULL DEFAULT false,
  needs_catering boolean NOT NULL DEFAULT true,
  needs_decor boolean NOT NULL DEFAULT false,
  needs_equipment boolean NOT NULL DEFAULT false,
  needs_transport boolean NOT NULL DEFAULT false,
  needs_excursion boolean NOT NULL DEFAULT false,
  estimated_budget numeric(14,2) NOT NULL DEFAULT 0,
  requirements text NOT NULL DEFAULT '',
  internal_notes text NOT NULL DEFAULT '',
  lead_source text NOT NULL DEFAULT 'walk-in',
  coordinator_id uuid,
  next_followup_at timestamptz,
  probability integer NOT NULL DEFAULT 50,
  status text NOT NULL DEFAULT 'new',
  loss_reason text NOT NULL DEFAULT '',
  competitor text NOT NULL DEFAULT '',
  followup_eligible boolean NOT NULL DEFAULT true,
  created_by uuid,
  updated_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, enquiry_number),
  CONSTRAINT event_enquiries_status_chk CHECK (status IN ('new','contacted','qualified','site-visit-scheduled','quotation-in-preparation','quotation-sent','negotiation','awaiting-client','converted','lost','cancelled','archived')),
  CONSTRAINT event_enquiries_prob_chk CHECK (probability BETWEEN 0 AND 100)
);
CREATE INDEX idx_event_enquiries_org ON public.event_enquiries(organization_id, status);
CREATE INDEX idx_event_enquiries_customer ON public.event_enquiries(customer_id);

CREATE TABLE public.enquiry_followups (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  enquiry_id uuid NOT NULL REFERENCES public.event_enquiries(id) ON DELETE CASCADE,
  channel text NOT NULL DEFAULT 'phone',
  summary text NOT NULL DEFAULT '',
  outcome text NOT NULL DEFAULT '',
  next_followup_at timestamptz,
  performed_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_enquiry_followups_enq ON public.enquiry_followups(enquiry_id);

CREATE TABLE public.site_visits (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  branch_id uuid REFERENCES public.branches(id) ON DELETE SET NULL,
  enquiry_id uuid REFERENCES public.event_enquiries(id) ON DELETE CASCADE,
  customer_id uuid REFERENCES public.customers(id) ON DELETE SET NULL,
  venue_id uuid REFERENCES public.event_venues(id) ON DELETE SET NULL,
  visit_at timestamptz NOT NULL,
  assigned_to uuid,
  attendees text NOT NULL DEFAULT '',
  client_requirements text NOT NULL DEFAULT '',
  preparation_notes text NOT NULL DEFAULT '',
  outcome text NOT NULL DEFAULT '',
  next_action text NOT NULL DEFAULT '',
  followup_at timestamptz,
  status text NOT NULL DEFAULT 'scheduled',
  created_by uuid,
  updated_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT site_visits_status_chk CHECK (status IN ('scheduled','confirmed','completed','rescheduled','cancelled','no-show'))
);
CREATE INDEX idx_site_visits_org ON public.site_visits(organization_id, visit_at);

-- ============ quotations ============
CREATE TABLE public.event_quotations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  branch_id uuid REFERENCES public.branches(id) ON DELETE SET NULL,
  quotation_number text NOT NULL,
  version integer NOT NULL DEFAULT 1,
  supersedes_id uuid REFERENCES public.event_quotations(id) ON DELETE SET NULL,
  enquiry_id uuid REFERENCES public.event_enquiries(id) ON DELETE SET NULL,
  customer_id uuid REFERENCES public.customers(id) ON DELETE SET NULL,
  corporate_account_id uuid REFERENCES public.corporate_accounts(id) ON DELETE SET NULL,
  event_type_id uuid REFERENCES public.event_types(id) ON DELETE SET NULL,
  venue_id uuid REFERENCES public.event_venues(id) ON DELETE SET NULL,
  package_id uuid REFERENCES public.event_packages(id) ON DELETE SET NULL,
  title text NOT NULL DEFAULT '',
  event_date date,
  start_time time,
  end_time time,
  guest_count integer NOT NULL DEFAULT 0,
  currency text NOT NULL DEFAULT 'KES',
  subtotal numeric(14,2) NOT NULL DEFAULT 0,
  discount_amount numeric(14,2) NOT NULL DEFAULT 0,
  service_charge_rate numeric(6,3) NOT NULL DEFAULT 0,
  service_charge_amount numeric(14,2) NOT NULL DEFAULT 0,
  tax_rate numeric(6,3) NOT NULL DEFAULT 0,
  tax_amount numeric(14,2) NOT NULL DEFAULT 0,
  grand_total numeric(14,2) NOT NULL DEFAULT 0,
  deposit_percent numeric(6,3) NOT NULL DEFAULT 50,
  deposit_amount numeric(14,2) NOT NULL DEFAULT 0,
  balance_due numeric(14,2) NOT NULL DEFAULT 0,
  valid_until date,
  client_notes text NOT NULL DEFAULT '',
  internal_notes text NOT NULL DEFAULT '',
  terms text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'draft',
  sent_at timestamptz,
  viewed_at timestamptz,
  responded_at timestamptz,
  accepted_by_name text NOT NULL DEFAULT '',
  acceptance_note text NOT NULL DEFAULT '',
  approved_by uuid,
  approved_at timestamptz,
  created_by uuid,
  updated_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, quotation_number, version),
  CONSTRAINT event_quotations_status_chk CHECK (status IN ('draft','pending-approval','approved','sent','viewed','accepted','rejected','revision-requested','expired','cancelled','converted'))
);
CREATE INDEX idx_event_quotations_org ON public.event_quotations(organization_id, status);
CREATE INDEX idx_event_quotations_customer ON public.event_quotations(customer_id);

CREATE TABLE public.event_quotation_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  quotation_id uuid NOT NULL REFERENCES public.event_quotations(id) ON DELETE CASCADE,
  category text NOT NULL DEFAULT 'other',
  description text NOT NULL,
  quantity numeric(14,3) NOT NULL DEFAULT 1,
  unit text NOT NULL DEFAULT 'unit',
  unit_price numeric(14,2) NOT NULL DEFAULT 0,
  line_total numeric(14,2) NOT NULL DEFAULT 0,
  taxable boolean NOT NULL DEFAULT true,
  unit_cost numeric(14,2) NOT NULL DEFAULT 0,
  sort_order integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_event_quotation_items_q ON public.event_quotation_items(quotation_id);

-- ============ bookings & profile ============
CREATE TABLE public.event_bookings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  branch_id uuid REFERENCES public.branches(id) ON DELETE SET NULL,
  event_reference text NOT NULL,
  event_name text NOT NULL DEFAULT '',
  event_type_id uuid REFERENCES public.event_types(id) ON DELETE SET NULL,
  quotation_id uuid REFERENCES public.event_quotations(id) ON DELETE SET NULL,
  enquiry_id uuid REFERENCES public.event_enquiries(id) ON DELETE SET NULL,
  customer_id uuid REFERENCES public.customers(id) ON DELETE SET NULL,
  corporate_account_id uuid REFERENCES public.corporate_accounts(id) ON DELETE SET NULL,
  primary_contact text NOT NULL DEFAULT '',
  coordinator_id uuid,
  venue_id uuid REFERENCES public.event_venues(id) ON DELETE SET NULL,
  event_date date NOT NULL,
  start_at timestamptz NOT NULL,
  end_at timestamptz NOT NULL,
  setup_at timestamptz,
  breakdown_at timestamptz,
  expected_guests integer NOT NULL DEFAULT 0,
  guaranteed_guests integer NOT NULL DEFAULT 0,
  final_guests integer,
  adults integer NOT NULL DEFAULT 0,
  children integer NOT NULL DEFAULT 0,
  service_style text NOT NULL DEFAULT 'buffet',
  seating_layout text NOT NULL DEFAULT 'banquet',
  colour_theme text NOT NULL DEFAULT '',
  decor_plan text NOT NULL DEFAULT '',
  vip_details text NOT NULL DEFAULT '',
  accessibility_requirements text NOT NULL DEFAULT '',
  dietary_requirements text NOT NULL DEFAULT '',
  allergy_warnings text NOT NULL DEFAULT '',
  entertainment text NOT NULL DEFAULT '',
  transport_notes text NOT NULL DEFAULT '',
  security_notes text NOT NULL DEFAULT '',
  photography_consent boolean NOT NULL DEFAULT false,
  marketing_consent boolean NOT NULL DEFAULT false,
  internal_notes text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'provisional-hold',
  hold_expires_at timestamptz,
  payment_status text NOT NULL DEFAULT 'unpaid',
  deposit_required numeric(14,2) NOT NULL DEFAULT 0,
  deposit_paid numeric(14,2) NOT NULL DEFAULT 0,
  total_amount numeric(14,2) NOT NULL DEFAULT 0,
  paid_amount numeric(14,2) NOT NULL DEFAULT 0,
  confirmed_at timestamptz,
  confirmed_by uuid,
  cancelled_at timestamptz,
  cancellation_reason text NOT NULL DEFAULT '',
  cancellation_fee numeric(14,2) NOT NULL DEFAULT 0,
  created_by uuid,
  updated_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, event_reference),
  CONSTRAINT event_bookings_status_chk CHECK (status IN ('provisional-hold','awaiting-deposit','awaiting-credit-approval','confirmed','in-planning','ready','in-progress','completed','cancelled','postponed','closed')),
  CONSTRAINT event_bookings_pay_chk CHECK (payment_status IN ('unpaid','partially-paid','paid','overpaid','refunded','on-credit','disputed')),
  CONSTRAINT event_bookings_time_chk CHECK (end_at > start_at)
);
CREATE INDEX idx_event_bookings_org ON public.event_bookings(organization_id, event_date);
CREATE INDEX idx_event_bookings_customer ON public.event_bookings(customer_id);

CREATE TABLE public.venue_blocks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  branch_id uuid REFERENCES public.branches(id) ON DELETE SET NULL,
  venue_id uuid NOT NULL REFERENCES public.event_venues(id) ON DELETE CASCADE,
  booking_id uuid REFERENCES public.event_bookings(id) ON DELETE CASCADE,
  block_type text NOT NULL DEFAULT 'event',
  starts_at timestamptz NOT NULL,
  ends_at timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'confirmed',
  reason text NOT NULL DEFAULT '',
  override_reason text NOT NULL DEFAULT '',
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT venue_blocks_type_chk CHECK (block_type IN ('event','hold','maintenance','setup','breakdown')),
  CONSTRAINT venue_blocks_status_chk CHECK (status IN ('hold','confirmed','released')),
  CONSTRAINT venue_blocks_time_chk CHECK (ends_at > starts_at),
  CONSTRAINT venue_blocks_no_overlap EXCLUDE USING gist (
    venue_id WITH =,
    tstzrange(starts_at, ends_at) WITH &&
  ) WHERE (status <> 'released')
);
CREATE INDEX idx_venue_blocks_venue ON public.venue_blocks(venue_id, starts_at);

CREATE TABLE public.event_resource_reservations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  resource_id uuid NOT NULL REFERENCES public.event_resources(id) ON DELETE CASCADE,
  booking_id uuid REFERENCES public.event_bookings(id) ON DELETE CASCADE,
  quantity integer NOT NULL DEFAULT 1,
  starts_at timestamptz NOT NULL,
  ends_at timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'reserved',
  notes text NOT NULL DEFAULT '',
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT err_status_chk CHECK (status IN ('reserved','issued','returned','released')),
  CONSTRAINT err_time_chk CHECK (ends_at > starts_at),
  CONSTRAINT err_qty_chk CHECK (quantity > 0)
);
CREATE INDEX idx_err_resource ON public.event_resource_reservations(resource_id, starts_at);

CREATE TABLE public.event_milestones (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  booking_id uuid NOT NULL REFERENCES public.event_bookings(id) ON DELETE CASCADE,
  key text NOT NULL,
  label text NOT NULL,
  due_at timestamptz,
  completed_at timestamptz,
  responsible_id uuid,
  notes text NOT NULL DEFAULT '',
  sort_order integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (booking_id, key)
);

CREATE TABLE public.event_guest_counts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  booking_id uuid NOT NULL REFERENCES public.event_bookings(id) ON DELETE CASCADE,
  count_type text NOT NULL DEFAULT 'revised',
  adults integer NOT NULL DEFAULT 0,
  children integer NOT NULL DEFAULT 0,
  total integer NOT NULL DEFAULT 0,
  reason text NOT NULL DEFAULT '',
  recorded_by uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_event_guest_counts_b ON public.event_guest_counts(booking_id);

-- ============ BEO ============
CREATE TABLE public.banquet_event_orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  branch_id uuid REFERENCES public.branches(id) ON DELETE SET NULL,
  booking_id uuid NOT NULL REFERENCES public.event_bookings(id) ON DELETE CASCADE,
  beo_number text NOT NULL,
  revision integer NOT NULL DEFAULT 1,
  change_summary text NOT NULL DEFAULT '',
  setup_at timestamptz,
  guest_arrival_at timestamptz,
  start_at timestamptz,
  serving_times text NOT NULL DEFAULT '',
  end_at timestamptz,
  breakdown_at timestamptz,
  guaranteed_guests integer NOT NULL DEFAULT 0,
  final_guests integer,
  seating_layout text NOT NULL DEFAULT '',
  menu_summary text NOT NULL DEFAULT '',
  beverage_service text NOT NULL DEFAULT '',
  dietary_requirements text NOT NULL DEFAULT '',
  allergies text NOT NULL DEFAULT '',
  equipment text NOT NULL DEFAULT '',
  decor text NOT NULL DEFAULT '',
  entertainment text NOT NULL DEFAULT '',
  signage text NOT NULL DEFAULT '',
  accommodation text NOT NULL DEFAULT '',
  transport text NOT NULL DEFAULT '',
  security text NOT NULL DEFAULT '',
  billing_instructions text NOT NULL DEFAULT '',
  department_instructions jsonb NOT NULL DEFAULT '{}'::jsonb,
  emergency_contacts text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'draft',
  published_at timestamptz,
  approved_by uuid,
  approved_at timestamptz,
  locked boolean NOT NULL DEFAULT false,
  created_by uuid,
  updated_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, beo_number, revision),
  CONSTRAINT beo_status_chk CHECK (status IN ('draft','department-review','pending-approval','approved','published','superseded','cancelled'))
);
CREATE INDEX idx_beo_booking ON public.banquet_event_orders(booking_id, revision DESC);

CREATE TABLE public.beo_department_acknowledgments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  beo_id uuid NOT NULL REFERENCES public.banquet_event_orders(id) ON DELETE CASCADE,
  department_id uuid REFERENCES public.departments(id) ON DELETE CASCADE,
  acknowledged_by uuid,
  acknowledged_at timestamptz,
  notes text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (beo_id, department_id)
);

-- ============ department requirements / readiness ============
CREATE TABLE public.event_department_requirements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  branch_id uuid REFERENCES public.branches(id) ON DELETE SET NULL,
  booking_id uuid NOT NULL REFERENCES public.event_bookings(id) ON DELETE CASCADE,
  department_id uuid REFERENCES public.departments(id) ON DELETE SET NULL,
  department_key text NOT NULL DEFAULT '',
  requirement text NOT NULL,
  detail text NOT NULL DEFAULT '',
  required_by timestamptz,
  readiness text NOT NULL DEFAULT 'not-started',
  blocker text NOT NULL DEFAULT '',
  task_id uuid REFERENCES public.tasks(id) ON DELETE SET NULL,
  updated_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT edr_readiness_chk CHECK (readiness IN ('not-started','in-progress','at-risk','blocked','ready','completed'))
);
CREATE INDEX idx_edr_booking ON public.event_department_requirements(booking_id);

CREATE TABLE public.event_requirements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  booking_id uuid NOT NULL REFERENCES public.event_bookings(id) ON DELETE CASCADE,
  stock_item_id uuid REFERENCES public.stock_items(id) ON DELETE SET NULL,
  description text NOT NULL DEFAULT '',
  unit text NOT NULL DEFAULT 'unit',
  planned_qty numeric(14,3) NOT NULL DEFAULT 0,
  reserved_qty numeric(14,3) NOT NULL DEFAULT 0,
  issued_qty numeric(14,3) NOT NULL DEFAULT 0,
  consumed_qty numeric(14,3) NOT NULL DEFAULT 0,
  returned_qty numeric(14,3) NOT NULL DEFAULT 0,
  wasted_qty numeric(14,3) NOT NULL DEFAULT 0,
  required_at timestamptz,
  status text NOT NULL DEFAULT 'planned',
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT event_requirements_status_chk CHECK (status IN ('planned','reserved','shortage','requested','issued','returned','closed'))
);
CREATE INDEX idx_event_requirements_b ON public.event_requirements(booking_id);

-- ============ menus ============
CREATE TABLE public.event_menus (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  booking_id uuid NOT NULL REFERENCES public.event_bookings(id) ON DELETE CASCADE,
  name text NOT NULL,
  service_style text NOT NULL DEFAULT 'buffet',
  service_at timestamptz,
  guest_count integer NOT NULL DEFAULT 0,
  price_per_person numeric(14,2) NOT NULL DEFAULT 0,
  estimated_cost numeric(14,2) NOT NULL DEFAULT 0,
  dietary_substitutions text NOT NULL DEFAULT '',
  allergens text NOT NULL DEFAULT '',
  version integer NOT NULL DEFAULT 1,
  approved_at timestamptz,
  approved_by uuid,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_event_menus_b ON public.event_menus(booking_id);

CREATE TABLE public.event_menu_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  event_menu_id uuid NOT NULL REFERENCES public.event_menus(id) ON DELETE CASCADE,
  menu_item_id uuid REFERENCES public.menu_items(id) ON DELETE SET NULL,
  recipe_id uuid REFERENCES public.recipes(id) ON DELETE SET NULL,
  course text NOT NULL DEFAULT 'main',
  name text NOT NULL,
  portions numeric(14,3) NOT NULL DEFAULT 0,
  notes text NOT NULL DEFAULT '',
  sort_order integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_event_menu_items_m ON public.event_menu_items(event_menu_id);

-- ============ accommodation, vendors, billing, feedback ============
CREATE TABLE public.event_room_blocks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  branch_id uuid REFERENCES public.branches(id) ON DELETE SET NULL,
  booking_id uuid NOT NULL REFERENCES public.event_bookings(id) ON DELETE CASCADE,
  group_booking_id uuid REFERENCES public.group_bookings(id) ON DELETE SET NULL,
  room_type_id uuid REFERENCES public.room_types(id) ON DELETE SET NULL,
  rooms_blocked integer NOT NULL DEFAULT 0,
  rooms_picked_up integer NOT NULL DEFAULT 0,
  occupancy text NOT NULL DEFAULT 'single',
  arrival_date date,
  departure_date date,
  meal_plan text NOT NULL DEFAULT '',
  billing_route text NOT NULL DEFAULT 'master-folio',
  release_date date,
  notes text NOT NULL DEFAULT '',
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_event_room_blocks_b ON public.event_room_blocks(booking_id);

CREATE TABLE public.event_vendors (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  booking_id uuid NOT NULL REFERENCES public.event_bookings(id) ON DELETE CASCADE,
  supplier_id uuid REFERENCES public.suppliers(id) ON DELETE SET NULL,
  vendor_name text NOT NULL DEFAULT '',
  service text NOT NULL DEFAULT '',
  contact text NOT NULL DEFAULT '',
  arrival_at timestamptz,
  agreed_cost numeric(14,2) NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'pending',
  notes text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.event_billing_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  branch_id uuid REFERENCES public.branches(id) ON DELETE SET NULL,
  booking_id uuid NOT NULL REFERENCES public.event_bookings(id) ON DELETE CASCADE,
  folio_id uuid REFERENCES public.folios(id) ON DELETE SET NULL,
  category text NOT NULL DEFAULT 'other',
  description text NOT NULL,
  quantity numeric(14,3) NOT NULL DEFAULT 1,
  unit_price numeric(14,2) NOT NULL DEFAULT 0,
  line_total numeric(14,2) NOT NULL DEFAULT 0,
  unit_cost numeric(14,2) NOT NULL DEFAULT 0,
  tax_rate numeric(6,3) NOT NULL DEFAULT 0,
  is_complimentary boolean NOT NULL DEFAULT false,
  approval_request_id uuid REFERENCES public.approval_requests(id) ON DELETE SET NULL,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_event_billing_items_b ON public.event_billing_items(booking_id);

CREATE TABLE public.event_feedback (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  branch_id uuid REFERENCES public.branches(id) ON DELETE SET NULL,
  booking_id uuid NOT NULL REFERENCES public.event_bookings(id) ON DELETE CASCADE,
  customer_id uuid REFERENCES public.customers(id) ON DELETE SET NULL,
  rating_planning integer,
  rating_communication integer,
  rating_venue integer,
  rating_food integer,
  rating_beverages integer,
  rating_service integer,
  rating_cleanliness integer,
  rating_equipment integer,
  rating_staff integer,
  rating_accommodation integer,
  rating_overall integer,
  comments text NOT NULL DEFAULT '',
  sentiment text NOT NULL DEFAULT 'neutral',
  assigned_department_id uuid REFERENCES public.departments(id) ON DELETE SET NULL,
  resolution_status text NOT NULL DEFAULT 'open',
  response text NOT NULL DEFAULT '',
  responded_at timestamptz,
  followup_action text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT event_feedback_res_chk CHECK (resolution_status IN ('open','in-progress','resolved','escalated','closed'))
);
CREATE INDEX idx_event_feedback_b ON public.event_feedback(booking_id);

CREATE TABLE public.event_change_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  booking_id uuid NOT NULL REFERENCES public.event_bookings(id) ON DELETE CASCADE,
  change_type text NOT NULL DEFAULT 'other',
  reason text NOT NULL DEFAULT '',
  previous_value jsonb NOT NULL DEFAULT '{}'::jsonb,
  new_value jsonb NOT NULL DEFAULT '{}'::jsonb,
  financial_impact numeric(14,2) NOT NULL DEFAULT 0,
  inventory_impact text NOT NULL DEFAULT '',
  room_impact text NOT NULL DEFAULT '',
  resource_impact text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'pending',
  approval_request_id uuid REFERENCES public.approval_requests(id) ON DELETE SET NULL,
  requested_by uuid,
  decided_by uuid,
  decided_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ecr_status_chk CHECK (status IN ('pending','approved','rejected','applied','cancelled'))
);

CREATE TABLE public.event_documents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  booking_id uuid REFERENCES public.event_bookings(id) ON DELETE CASCADE,
  enquiry_id uuid REFERENCES public.event_enquiries(id) ON DELETE CASCADE,
  customer_id uuid REFERENCES public.customers(id) ON DELETE SET NULL,
  title text NOT NULL,
  doc_type text NOT NULL DEFAULT 'attachment',
  storage_path text NOT NULL,
  visible_to_client boolean NOT NULL DEFAULT false,
  uploaded_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.event_activity_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  booking_id uuid REFERENCES public.event_bookings(id) ON DELETE CASCADE,
  enquiry_id uuid REFERENCES public.event_enquiries(id) ON DELETE CASCADE,
  action text NOT NULL,
  detail jsonb NOT NULL DEFAULT '{}'::jsonb,
  actor_id uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_event_activity_b ON public.event_activity_logs(booking_id, created_at DESC);

-- ============ grants ============
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'event_types','event_venues','event_resources','event_packages','event_package_items',
    'event_enquiries','enquiry_followups','site_visits','event_quotations','event_quotation_items',
    'event_bookings','venue_blocks','event_resource_reservations','event_milestones','event_guest_counts',
    'banquet_event_orders','beo_department_acknowledgments','event_department_requirements','event_requirements',
    'event_menus','event_menu_items','event_room_blocks','event_vendors','event_billing_items',
    'event_feedback','event_change_requests','event_documents','event_activity_logs'
  ] LOOP
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON public.%I TO authenticated', t);
    EXECUTE format('GRANT ALL ON public.%I TO service_role', t);
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at()', t||'_touch', t);
  END LOOP;
END $$;

-- ============ RLS ============
-- staff: full org-scoped access; customers: ownership-scoped read on their own records
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'event_types','event_venues','event_resources','event_packages','event_package_items',
    'enquiry_followups','site_visits','event_quotation_items',
    'venue_blocks','event_resource_reservations','event_milestones','event_guest_counts',
    'banquet_event_orders','beo_department_acknowledgments','event_department_requirements','event_requirements',
    'event_menus','event_menu_items','event_room_blocks','event_vendors','event_billing_items',
    'event_change_requests','event_activity_logs'
  ] LOOP
    EXECUTE format($p$CREATE POLICY "%1$s staff read" ON public.%1$I FOR SELECT TO authenticated USING (organization_id = public.current_org_id())$p$, t);
    EXECUTE format($p$CREATE POLICY "%1$s staff write" ON public.%1$I FOR INSERT TO authenticated WITH CHECK (organization_id = public.current_org_id())$p$, t);
    EXECUTE format($p$CREATE POLICY "%1$s staff update" ON public.%1$I FOR UPDATE TO authenticated USING (organization_id = public.current_org_id()) WITH CHECK (organization_id = public.current_org_id())$p$, t);
    EXECUTE format($p$CREATE POLICY "%1$s admin delete" ON public.%1$I FOR DELETE TO authenticated USING (organization_id = public.current_org_id() AND public.is_org_admin())$p$, t);
  END LOOP;
END $$;

-- enquiries
CREATE POLICY "event_enquiries staff read" ON public.event_enquiries FOR SELECT TO authenticated
  USING (organization_id = public.current_org_id());
CREATE POLICY "event_enquiries owner read" ON public.event_enquiries FOR SELECT TO authenticated
  USING (customer_id IN (SELECT id FROM public.customers WHERE auth_user_id = auth.uid()));
CREATE POLICY "event_enquiries staff write" ON public.event_enquiries FOR INSERT TO authenticated
  WITH CHECK (organization_id = public.current_org_id()
    OR customer_id IN (SELECT id FROM public.customers WHERE auth_user_id = auth.uid()));
CREATE POLICY "event_enquiries staff update" ON public.event_enquiries FOR UPDATE TO authenticated
  USING (organization_id = public.current_org_id()) WITH CHECK (organization_id = public.current_org_id());
CREATE POLICY "event_enquiries admin delete" ON public.event_enquiries FOR DELETE TO authenticated
  USING (organization_id = public.current_org_id() AND public.is_org_admin());

-- quotations
CREATE POLICY "event_quotations staff read" ON public.event_quotations FOR SELECT TO authenticated
  USING (organization_id = public.current_org_id());
CREATE POLICY "event_quotations owner read" ON public.event_quotations FOR SELECT TO authenticated
  USING (status IN ('sent','viewed','accepted','rejected','revision-requested','expired','converted')
    AND customer_id IN (SELECT id FROM public.customers WHERE auth_user_id = auth.uid()));
CREATE POLICY "event_quotations staff write" ON public.event_quotations FOR INSERT TO authenticated
  WITH CHECK (organization_id = public.current_org_id());
CREATE POLICY "event_quotations staff update" ON public.event_quotations FOR UPDATE TO authenticated
  USING (organization_id = public.current_org_id()) WITH CHECK (organization_id = public.current_org_id());
CREATE POLICY "event_quotations admin delete" ON public.event_quotations FOR DELETE TO authenticated
  USING (organization_id = public.current_org_id() AND public.is_org_admin());

-- bookings
CREATE POLICY "event_bookings staff read" ON public.event_bookings FOR SELECT TO authenticated
  USING (organization_id = public.current_org_id());
CREATE POLICY "event_bookings owner read" ON public.event_bookings FOR SELECT TO authenticated
  USING (customer_id IN (SELECT id FROM public.customers WHERE auth_user_id = auth.uid()));
CREATE POLICY "event_bookings staff write" ON public.event_bookings FOR INSERT TO authenticated
  WITH CHECK (organization_id = public.current_org_id());
CREATE POLICY "event_bookings staff update" ON public.event_bookings FOR UPDATE TO authenticated
  USING (organization_id = public.current_org_id()) WITH CHECK (organization_id = public.current_org_id());
CREATE POLICY "event_bookings admin delete" ON public.event_bookings FOR DELETE TO authenticated
  USING (organization_id = public.current_org_id() AND public.is_org_admin());

-- feedback
CREATE POLICY "event_feedback staff read" ON public.event_feedback FOR SELECT TO authenticated
  USING (organization_id = public.current_org_id());
CREATE POLICY "event_feedback owner read" ON public.event_feedback FOR SELECT TO authenticated
  USING (customer_id IN (SELECT id FROM public.customers WHERE auth_user_id = auth.uid()));
CREATE POLICY "event_feedback write" ON public.event_feedback FOR INSERT TO authenticated
  WITH CHECK (organization_id = public.current_org_id()
    OR customer_id IN (SELECT id FROM public.customers WHERE auth_user_id = auth.uid()));
CREATE POLICY "event_feedback staff update" ON public.event_feedback FOR UPDATE TO authenticated
  USING (organization_id = public.current_org_id()) WITH CHECK (organization_id = public.current_org_id());
CREATE POLICY "event_feedback admin delete" ON public.event_feedback FOR DELETE TO authenticated
  USING (organization_id = public.current_org_id() AND public.is_org_admin());

-- documents (metadata; files live in private storage)
CREATE POLICY "event_documents staff read" ON public.event_documents FOR SELECT TO authenticated
  USING (organization_id = public.current_org_id());
CREATE POLICY "event_documents owner read" ON public.event_documents FOR SELECT TO authenticated
  USING (visible_to_client AND customer_id IN (SELECT id FROM public.customers WHERE auth_user_id = auth.uid()));
CREATE POLICY "event_documents staff write" ON public.event_documents FOR INSERT TO authenticated
  WITH CHECK (organization_id = public.current_org_id());
CREATE POLICY "event_documents staff update" ON public.event_documents FOR UPDATE TO authenticated
  USING (organization_id = public.current_org_id()) WITH CHECK (organization_id = public.current_org_id());
CREATE POLICY "event_documents admin delete" ON public.event_documents FOR DELETE TO authenticated
  USING (organization_id = public.current_org_id() AND public.is_org_admin());

-- ============ functions ============
-- resource over-reservation guard
CREATE OR REPLACE FUNCTION public.tg_event_resource_capacity()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE owned integer; taken integer;
BEGIN
  IF NEW.status = 'released' THEN RETURN NEW; END IF;
  SELECT quantity_owned INTO owned FROM public.event_resources WHERE id = NEW.resource_id;
  SELECT COALESCE(SUM(quantity),0) INTO taken
    FROM public.event_resource_reservations
   WHERE resource_id = NEW.resource_id
     AND id <> NEW.id
     AND status <> 'released'
     AND tstzrange(starts_at, ends_at) && tstzrange(NEW.starts_at, NEW.ends_at);
  IF taken + NEW.quantity > COALESCE(owned,0) THEN
    RAISE EXCEPTION 'Only % of this resource are available for the selected period (% already reserved)', owned, taken;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER event_resource_capacity BEFORE INSERT OR UPDATE ON public.event_resource_reservations
FOR EACH ROW EXECUTE FUNCTION public.tg_event_resource_capacity();

-- idempotent booking confirmation
CREATE OR REPLACE FUNCTION public.events_confirm_booking(_booking uuid, _override_reason text DEFAULT '')
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE b public.event_bookings; org uuid; created_tasks integer := 0; beo_id uuid; ms text[];
        dept record; s timestamptz; e timestamptz;
BEGIN
  org := public.current_org_id();
  SELECT * INTO b FROM public.event_bookings WHERE id = _booking AND organization_id = org;
  IF NOT FOUND THEN RAISE EXCEPTION 'Event booking not found'; END IF;
  IF b.status IN ('confirmed','in-planning','ready','in-progress','completed','closed') THEN
    RETURN jsonb_build_object('already_confirmed', true, 'booking_id', b.id);
  END IF;

  s := COALESCE(b.setup_at, b.start_at);
  e := COALESCE(b.breakdown_at, b.end_at);

  IF b.venue_id IS NOT NULL THEN
    UPDATE public.venue_blocks SET status = 'confirmed'
      WHERE booking_id = b.id AND status <> 'released';
    IF NOT EXISTS (SELECT 1 FROM public.venue_blocks WHERE booking_id = b.id AND status <> 'released') THEN
      INSERT INTO public.venue_blocks (organization_id, branch_id, venue_id, booking_id, block_type, starts_at, ends_at, status, reason, override_reason, created_by)
      VALUES (org, b.branch_id, b.venue_id, b.id, 'event', s, e, 'confirmed', b.event_name, _override_reason, auth.uid());
    END IF;
  END IF;

  UPDATE public.event_bookings
     SET status = 'confirmed', confirmed_at = now(), confirmed_by = auth.uid(), updated_by = auth.uid()
   WHERE id = b.id;

  -- milestones
  ms := ARRAY['booking-confirmed','menu-selected','guest-count-confirmed','beo-issued','final-payment-due','setup-started','event-started','event-completed','feedback-requested','event-closed'];
  INSERT INTO public.event_milestones (organization_id, booking_id, key, label, due_at, sort_order)
  SELECT org, b.id, k, initcap(replace(k,'-',' ')),
         CASE k WHEN 'booking-confirmed' THEN now()
                WHEN 'guest-count-confirmed' THEN b.start_at - interval '3 days'
                WHEN 'beo-issued' THEN b.start_at - interval '5 days'
                WHEN 'final-payment-due' THEN b.start_at - interval '1 day'
                WHEN 'setup-started' THEN s
                WHEN 'event-started' THEN b.start_at
                WHEN 'event-completed' THEN b.end_at
                ELSE NULL END,
         ord
  FROM unnest(ms) WITH ORDINALITY AS x(k, ord)
  ON CONFLICT (booking_id, key) DO NOTHING;
  UPDATE public.event_milestones SET completed_at = now()
   WHERE booking_id = b.id AND key = 'booking-confirmed' AND completed_at IS NULL;

  -- department tasks (one per department that has a requirement, else skip)
  FOR dept IN
    SELECT DISTINCT r.department_id, r.requirement, r.required_by, r.id AS req_id
      FROM public.event_department_requirements r
     WHERE r.booking_id = b.id AND r.task_id IS NULL
  LOOP
    WITH t AS (
      INSERT INTO public.tasks (organization_id, branch_id, department_id, reference, title, description, due_at, priority, status, created_by)
      VALUES (org, b.branch_id, dept.department_id, public.next_document_number('task'),
              b.event_reference || ' — ' || dept.requirement,
              'Auto-generated from event ' || b.event_reference,
              COALESCE(dept.required_by, b.start_at), 'high', 'new', auth.uid())
      RETURNING id
    )
    UPDATE public.event_department_requirements SET task_id = (SELECT id FROM t) WHERE id = dept.req_id;
    created_tasks := created_tasks + 1;
  END LOOP;

  -- BEO draft
  SELECT id INTO beo_id FROM public.banquet_event_orders WHERE booking_id = b.id ORDER BY revision DESC LIMIT 1;
  IF beo_id IS NULL THEN
    INSERT INTO public.banquet_event_orders (organization_id, branch_id, booking_id, beo_number, revision,
      setup_at, guest_arrival_at, start_at, end_at, breakdown_at, guaranteed_guests, seating_layout, status, created_by)
    VALUES (org, b.branch_id, b.id, 'BEO-' || b.event_reference, 1, b.setup_at, b.start_at, b.start_at, b.end_at,
      b.breakdown_at, GREATEST(b.guaranteed_guests, b.expected_guests), b.seating_layout, 'draft', auth.uid())
    RETURNING id INTO beo_id;
  END IF;

  -- notifications to coordinator + org admins channel
  INSERT INTO public.notifications (organization_id, branch_id, user_id, category, title, body, link, priority)
  VALUES (org, b.branch_id, b.coordinator_id, 'operations',
          'Event confirmed: ' || b.event_reference,
          COALESCE(NULLIF(b.event_name,''),'Event') || ' is confirmed for ' || to_char(b.event_date,'DD Mon YYYY'),
          '/events/bookings', 'high');

  INSERT INTO public.event_activity_logs (organization_id, booking_id, action, detail, actor_id)
  VALUES (org, b.id, 'booking.confirmed', jsonb_build_object('tasks', created_tasks, 'beo_id', beo_id, 'override', _override_reason), auth.uid());

  RETURN jsonb_build_object('booking_id', b.id, 'tasks_created', created_tasks, 'beo_id', beo_id, 'already_confirmed', false);
END $$;
REVOKE ALL ON FUNCTION public.events_confirm_booking(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.events_confirm_booking(uuid, text) TO authenticated;

-- dashboard metrics
CREATE OR REPLACE FUNCTION public.events_metrics(_branch uuid DEFAULT NULL)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT jsonb_build_object(
    'new_enquiries', (SELECT count(*) FROM event_enquiries WHERE organization_id = current_org_id() AND status = 'new' AND (_branch IS NULL OR branch_id = _branch)),
    'followups_due', (SELECT count(*) FROM event_enquiries WHERE organization_id = current_org_id() AND next_followup_at < now() AND status NOT IN ('converted','lost','cancelled','archived')),
    'site_visits_pending', (SELECT count(*) FROM site_visits WHERE organization_id = current_org_id() AND status IN ('scheduled','confirmed')),
    'quotations_pending', (SELECT count(*) FROM event_quotations WHERE organization_id = current_org_id() AND status IN ('draft','pending-approval','sent','viewed')),
    'quotations_accepted', (SELECT count(*) FROM event_quotations WHERE organization_id = current_org_id() AND status IN ('accepted','converted')),
    'quotations_total', (SELECT count(*) FROM event_quotations WHERE organization_id = current_org_id()),
    'provisional', (SELECT count(*) FROM event_bookings WHERE organization_id = current_org_id() AND status IN ('provisional-hold','awaiting-deposit','awaiting-credit-approval')),
    'confirmed', (SELECT count(*) FROM event_bookings WHERE organization_id = current_org_id() AND status IN ('confirmed','in-planning','ready')),
    'events_today', (SELECT count(*) FROM event_bookings WHERE organization_id = current_org_id() AND event_date = current_date AND status NOT IN ('cancelled')),
    'upcoming_30d', (SELECT count(*) FROM event_bookings WHERE organization_id = current_org_id() AND event_date BETWEEN current_date AND current_date + 30 AND status NOT IN ('cancelled')),
    'deposits_due', (SELECT COALESCE(SUM(GREATEST(deposit_required - deposit_paid,0)),0) FROM event_bookings WHERE organization_id = current_org_id() AND status NOT IN ('cancelled','closed')),
    'outstanding', (SELECT COALESCE(SUM(GREATEST(total_amount - paid_amount,0)),0) FROM event_bookings WHERE organization_id = current_org_id() AND status NOT IN ('cancelled')),
    'revenue_forecast', (SELECT COALESCE(SUM(total_amount),0) FROM event_bookings WHERE organization_id = current_org_id() AND event_date >= current_date AND status NOT IN ('cancelled')),
    'guest_forecast', (SELECT COALESCE(SUM(COALESCE(final_guests, guaranteed_guests, expected_guests)),0) FROM event_bookings WHERE organization_id = current_org_id() AND event_date BETWEEN current_date AND current_date + 30 AND status NOT IN ('cancelled')),
    'blocked_departments', (SELECT count(*) FROM event_department_requirements WHERE organization_id = current_org_id() AND readiness = 'blocked'),
    'venues', (SELECT count(*) FROM event_venues WHERE organization_id = current_org_id() AND status = 'available')
  )
$$;
REVOKE ALL ON FUNCTION public.events_metrics(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.events_metrics(uuid) TO authenticated;

-- department readiness rollup
CREATE OR REPLACE FUNCTION public.events_department_readiness(_booking uuid DEFAULT NULL)
RETURNS TABLE(department_id uuid, department text, booking_id uuid, event_reference text,
              total bigint, ready bigint, blocked bigint, at_risk bigint, in_progress bigint, not_started bigint)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT r.department_id,
         COALESCE(d.name, NULLIF(r.department_key,''), 'Unassigned') AS department,
         r.booking_id, b.event_reference,
         count(*) AS total,
         count(*) FILTER (WHERE r.readiness IN ('ready','completed')) AS ready,
         count(*) FILTER (WHERE r.readiness = 'blocked') AS blocked,
         count(*) FILTER (WHERE r.readiness = 'at-risk') AS at_risk,
         count(*) FILTER (WHERE r.readiness = 'in-progress') AS in_progress,
         count(*) FILTER (WHERE r.readiness = 'not-started') AS not_started
    FROM event_department_requirements r
    JOIN event_bookings b ON b.id = r.booking_id
    LEFT JOIN departments d ON d.id = r.department_id
   WHERE r.organization_id = current_org_id()
     AND (_booking IS NULL OR r.booking_id = _booking)
   GROUP BY r.department_id, d.name, r.department_key, r.booking_id, b.event_reference
$$;
REVOKE ALL ON FUNCTION public.events_department_readiness(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.events_department_readiness(uuid) TO authenticated;

-- ============ permissions & sequences ============
INSERT INTO public.permissions (module, action, label) VALUES
  ('events','view','Events — View'),
  ('events','create','Events — Create'),
  ('events','edit','Events — Edit'),
  ('events','delete','Events — Delete'),
  ('events','approve','Events — Approve'),
  ('events','reject','Events — Reject'),
  ('events','export','Events — Export'),
  ('events','print','Events — Print'),
  ('events','override','Events — Override conflict/price'),
  ('events','confirm','Events — Confirm booking'),
  ('events','quote','Events — Manage quotations'),
  ('events','beo','Events — Manage banquet event orders'),
  ('events','readiness','Events — Update department readiness'),
  ('events','financials','Events — View financials'),
  ('events','cost','Events — View cost & profit')
ON CONFLICT (module, action) DO NOTHING;

INSERT INTO public.number_sequences (organization_id, doc_type, prefix)
SELECT o.id, v.doc_type, v.prefix
  FROM public.organizations o
 CROSS JOIN (VALUES ('event-enquiry','ENQ'), ('event-quotation','EQT'), ('event-booking','EVT'), ('banquet-event-order','BEO')) AS v(doc_type, prefix)
ON CONFLICT (organization_id, doc_type) DO NOTHING;

INSERT INTO public.approval_types (organization_id, key, name, levels)
SELECT o.id, v.key, v.name, 1
  FROM public.organizations o
 CROSS JOIN (VALUES
   ('event-quotation','Event Quotation Approval'),
   ('event-discount','Event Discount Approval'),
   ('event-complimentary','Event Complimentary Service'),
   ('event-credit','Event Corporate Credit Approval'),
   ('event-venue-override','Venue Conflict Override'),
   ('event-refund','Event Refund Approval'),
   ('event-cancellation-fee-waiver','Event Cancellation Fee Waiver')
 ) AS v(key, name)
ON CONFLICT (organization_id, key) DO NOTHING;