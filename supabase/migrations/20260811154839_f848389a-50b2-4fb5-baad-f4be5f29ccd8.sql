
CREATE EXTENSION IF NOT EXISTS btree_gist;

-- ============ CONFIGURATION ============
CREATE TABLE public.room_types (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  branch_id uuid REFERENCES public.branches(id) ON DELETE CASCADE,
  name text NOT NULL,
  code text NOT NULL,
  description text NOT NULL DEFAULT '',
  max_adults integer NOT NULL DEFAULT 2,
  max_children integer NOT NULL DEFAULT 0,
  max_occupancy integer NOT NULL DEFAULT 2,
  bed_count integer NOT NULL DEFAULT 1,
  bed_configuration text NOT NULL DEFAULT '',
  base_occupancy integer NOT NULL DEFAULT 2,
  extra_bed_allowance integer NOT NULL DEFAULT 0,
  baby_cot_allowance integer NOT NULL DEFAULT 0,
  amenities text[] NOT NULL DEFAULT '{}',
  accessibility_features text[] NOT NULL DEFAULT '{}',
  smoking text NOT NULL DEFAULT 'non-smoking',
  images text[] NOT NULL DEFAULT '{}',
  status text NOT NULL DEFAULT 'active',
  sort_order integer NOT NULL DEFAULT 100,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, branch_id, code)
);

CREATE TABLE public.rooms (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  branch_id uuid NOT NULL REFERENCES public.branches(id) ON DELETE CASCADE,
  room_number text NOT NULL,
  room_type_id uuid REFERENCES public.room_types(id) ON DELETE SET NULL,
  floor text NOT NULL DEFAULT '',
  building text NOT NULL DEFAULT '',
  room_condition text NOT NULL DEFAULT 'vacant-clean',
  housekeeping_status text NOT NULL DEFAULT 'clean',
  maintenance_status text NOT NULL DEFAULT 'operational',
  occupancy_status text NOT NULL DEFAULT 'vacant',
  sellable boolean NOT NULL DEFAULT true,
  smoking text NOT NULL DEFAULT 'non-smoking',
  accessibility_features text[] NOT NULL DEFAULT '{}',
  connecting_room_id uuid REFERENCES public.rooms(id) ON DELETE SET NULL,
  last_cleaned_at timestamptz,
  last_inspected_at timestamptz,
  out_of_order_reason text,
  out_of_order_from date,
  out_of_order_to date,
  notes text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'active',
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (branch_id, room_number)
);
CREATE INDEX rooms_org_branch_idx ON public.rooms (organization_id, branch_id);

CREATE TABLE public.room_status_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  branch_id uuid REFERENCES public.branches(id) ON DELETE CASCADE,
  room_id uuid NOT NULL REFERENCES public.rooms(id) ON DELETE CASCADE,
  field text NOT NULL,
  previous_value text,
  new_value text,
  reason text,
  changed_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.room_blocks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  branch_id uuid REFERENCES public.branches(id) ON DELETE CASCADE,
  room_id uuid NOT NULL REFERENCES public.rooms(id) ON DELETE CASCADE,
  block_type text NOT NULL DEFAULT 'out-of-order',
  start_date date NOT NULL,
  end_date date NOT NULL,
  reason text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'active',
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX room_blocks_range_idx ON public.room_blocks (room_id, start_date, end_date);

CREATE TABLE public.meal_plans (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  branch_id uuid REFERENCES public.branches(id) ON DELETE CASCADE,
  code text NOT NULL,
  name text NOT NULL,
  description text NOT NULL DEFAULT '',
  includes text[] NOT NULL DEFAULT '{}',
  status text NOT NULL DEFAULT 'active',
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, code)
);

CREATE TABLE public.rate_plans (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  branch_id uuid REFERENCES public.branches(id) ON DELETE CASCADE,
  name text NOT NULL,
  code text NOT NULL,
  description text NOT NULL DEFAULT '',
  room_type_id uuid REFERENCES public.room_types(id) ON DELETE CASCADE,
  meal_plan_id uuid REFERENCES public.meal_plans(id) ON DELETE SET NULL,
  base_rate numeric(14,2) NOT NULL DEFAULT 0,
  currency text NOT NULL DEFAULT 'KES',
  tax_treatment text NOT NULL DEFAULT 'exclusive',
  tax_rate numeric(6,3) NOT NULL DEFAULT 0,
  service_charge_rate numeric(6,3) NOT NULL DEFAULT 0,
  included_occupancy integer NOT NULL DEFAULT 2,
  extra_adult_charge numeric(14,2) NOT NULL DEFAULT 0,
  child_pricing jsonb NOT NULL DEFAULT '{}'::jsonb,
  extra_bed_charge numeric(14,2) NOT NULL DEFAULT 0,
  min_stay integer NOT NULL DEFAULT 1,
  max_stay integer,
  advance_booking_days integer,
  cancellation_policy text NOT NULL DEFAULT '',
  deposit_policy text NOT NULL DEFAULT '',
  guarantee_policy text NOT NULL DEFAULT '',
  no_show_policy text NOT NULL DEFAULT '',
  valid_from date,
  valid_to date,
  days_of_week integer[] NOT NULL DEFAULT '{0,1,2,3,4,5,6}',
  booking_sources text[] NOT NULL DEFAULT '{}',
  corporate_only boolean NOT NULL DEFAULT false,
  loyalty_only boolean NOT NULL DEFAULT false,
  status text NOT NULL DEFAULT 'active',
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, code)
);

CREATE TABLE public.rate_plan_prices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  rate_plan_id uuid NOT NULL REFERENCES public.rate_plans(id) ON DELETE CASCADE,
  start_date date NOT NULL,
  end_date date NOT NULL,
  rate numeric(14,2) NOT NULL,
  label text NOT NULL DEFAULT '',
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- ============ GROUPS & RESERVATIONS ============
CREATE TABLE public.group_bookings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  branch_id uuid REFERENCES public.branches(id) ON DELETE CASCADE,
  reference text NOT NULL,
  name text NOT NULL,
  group_type text NOT NULL DEFAULT 'leisure',
  organizer text NOT NULL DEFAULT '',
  corporate_account_id uuid REFERENCES public.corporate_accounts(id) ON DELETE SET NULL,
  contact_customer_id uuid REFERENCES public.customers(id) ON DELETE SET NULL,
  arrival_date date NOT NULL,
  departure_date date NOT NULL,
  rooms_count integer NOT NULL DEFAULT 0,
  guests_count integer NOT NULL DEFAULT 0,
  cutoff_date date,
  rate_plan_id uuid REFERENCES public.rate_plans(id) ON DELETE SET NULL,
  meal_plan_id uuid REFERENCES public.meal_plans(id) ON DELETE SET NULL,
  deposit_policy text NOT NULL DEFAULT '',
  billing_instructions text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'tentative',
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, reference)
);

CREATE TABLE public.group_room_blocks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  group_booking_id uuid NOT NULL REFERENCES public.group_bookings(id) ON DELETE CASCADE,
  room_type_id uuid REFERENCES public.room_types(id) ON DELETE SET NULL,
  rooms_blocked integer NOT NULL DEFAULT 0,
  rooms_picked_up integer NOT NULL DEFAULT 0,
  start_date date NOT NULL,
  end_date date NOT NULL,
  status text NOT NULL DEFAULT 'active',
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.reservations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  branch_id uuid NOT NULL REFERENCES public.branches(id) ON DELETE CASCADE,
  confirmation_number text NOT NULL,
  customer_id uuid REFERENCES public.customers(id) ON DELETE SET NULL,
  corporate_account_id uuid REFERENCES public.corporate_accounts(id) ON DELETE SET NULL,
  group_booking_id uuid REFERENCES public.group_bookings(id) ON DELETE SET NULL,
  booking_source text NOT NULL DEFAULT 'direct',
  reservation_type text NOT NULL DEFAULT 'individual',
  external_reference text,
  arrival_date date NOT NULL,
  departure_date date NOT NULL,
  nights integer NOT NULL DEFAULT 1,
  adults integer NOT NULL DEFAULT 1,
  children integer NOT NULL DEFAULT 0,
  infants integer NOT NULL DEFAULT 0,
  room_type_id uuid REFERENCES public.room_types(id) ON DELETE SET NULL,
  room_id uuid REFERENCES public.rooms(id) ON DELETE SET NULL,
  rate_plan_id uuid REFERENCES public.rate_plans(id) ON DELETE SET NULL,
  meal_plan_id uuid REFERENCES public.meal_plans(id) ON DELETE SET NULL,
  nightly_rate numeric(14,2) NOT NULL DEFAULT 0,
  tax_amount numeric(14,2) NOT NULL DEFAULT 0,
  discount_amount numeric(14,2) NOT NULL DEFAULT 0,
  total_amount numeric(14,2) NOT NULL DEFAULT 0,
  deposit_required numeric(14,2) NOT NULL DEFAULT 0,
  deposit_paid numeric(14,2) NOT NULL DEFAULT 0,
  balance numeric(14,2) NOT NULL DEFAULT 0,
  guarantee_method text NOT NULL DEFAULT 'none',
  special_requests text NOT NULL DEFAULT '',
  eta time,
  etd time,
  is_vip boolean NOT NULL DEFAULT false,
  loyalty_account_id uuid REFERENCES public.loyalty_accounts(id) ON DELETE SET NULL,
  status text NOT NULL DEFAULT 'enquiry',
  payment_status text NOT NULL DEFAULT 'unpaid',
  cancellation_reason text,
  cancellation_fee numeric(14,2),
  cancelled_at timestamptz,
  cancelled_by uuid,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, confirmation_number),
  CONSTRAINT reservations_dates_check CHECK (departure_date > arrival_date)
);
CREATE INDEX reservations_org_dates_idx ON public.reservations (organization_id, arrival_date, departure_date);
CREATE INDEX reservations_status_idx ON public.reservations (organization_id, status);
CREATE UNIQUE INDEX reservations_external_ref_idx ON public.reservations (organization_id, booking_source, external_reference)
  WHERE external_reference IS NOT NULL;

CREATE TABLE public.reservation_rooms (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  reservation_id uuid NOT NULL REFERENCES public.reservations(id) ON DELETE CASCADE,
  room_type_id uuid REFERENCES public.room_types(id) ON DELETE SET NULL,
  room_id uuid REFERENCES public.rooms(id) ON DELETE SET NULL,
  rate_plan_id uuid REFERENCES public.rate_plans(id) ON DELETE SET NULL,
  adults integer NOT NULL DEFAULT 1,
  children integer NOT NULL DEFAULT 0,
  nightly_rate numeric(14,2) NOT NULL DEFAULT 0,
  arrival_date date NOT NULL,
  departure_date date NOT NULL,
  status text NOT NULL DEFAULT 'confirmed',
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.reservation_guests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  reservation_id uuid NOT NULL REFERENCES public.reservations(id) ON DELETE CASCADE,
  customer_id uuid REFERENCES public.customers(id) ON DELETE SET NULL,
  full_name text NOT NULL,
  guest_role text NOT NULL DEFAULT 'additional-adult',
  age_group text NOT NULL DEFAULT 'adult',
  is_primary boolean NOT NULL DEFAULT false,
  is_folio_payer boolean NOT NULL DEFAULT false,
  notes text NOT NULL DEFAULT '',
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.reservation_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  reservation_id uuid NOT NULL REFERENCES public.reservations(id) ON DELETE CASCADE,
  action text NOT NULL,
  field text,
  previous_value text,
  new_value text,
  reason text,
  changed_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.reservation_notes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  reservation_id uuid NOT NULL REFERENCES public.reservations(id) ON DELETE CASCADE,
  body text NOT NULL,
  visibility text NOT NULL DEFAULT 'internal',
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.reservation_holds (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  branch_id uuid REFERENCES public.branches(id) ON DELETE CASCADE,
  room_type_id uuid REFERENCES public.room_types(id) ON DELETE CASCADE,
  room_id uuid REFERENCES public.rooms(id) ON DELETE CASCADE,
  arrival_date date NOT NULL,
  departure_date date NOT NULL,
  session_key text NOT NULL DEFAULT '',
  hold_start timestamptz NOT NULL DEFAULT now(),
  hold_expires_at timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'active',
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX reservation_holds_active_idx ON public.reservation_holds (organization_id, status, hold_expires_at);

CREATE TABLE public.waitlist_entries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  branch_id uuid REFERENCES public.branches(id) ON DELETE CASCADE,
  customer_id uuid REFERENCES public.customers(id) ON DELETE SET NULL,
  arrival_date date NOT NULL,
  departure_date date NOT NULL,
  room_type_id uuid REFERENCES public.room_types(id) ON DELETE SET NULL,
  adults integer NOT NULL DEFAULT 1,
  children integer NOT NULL DEFAULT 0,
  rate_preference text NOT NULL DEFAULT '',
  contact_method text NOT NULL DEFAULT 'phone',
  priority text NOT NULL DEFAULT 'normal',
  expires_on date,
  notes text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'waiting',
  converted_reservation_id uuid REFERENCES public.reservations(id) ON DELETE SET NULL,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- ============ STAYS ============
CREATE TABLE public.stays (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  branch_id uuid NOT NULL REFERENCES public.branches(id) ON DELETE CASCADE,
  reservation_id uuid NOT NULL REFERENCES public.reservations(id) ON DELETE CASCADE,
  customer_id uuid REFERENCES public.customers(id) ON DELETE SET NULL,
  room_id uuid REFERENCES public.rooms(id) ON DELETE SET NULL,
  checked_in_at timestamptz NOT NULL DEFAULT now(),
  checked_in_by uuid,
  checked_out_at timestamptz,
  checked_out_by uuid,
  expected_departure date NOT NULL,
  status text NOT NULL DEFAULT 'in-house',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (reservation_id)
);

CREATE TABLE public.room_assignments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  branch_id uuid REFERENCES public.branches(id) ON DELETE CASCADE,
  reservation_id uuid NOT NULL REFERENCES public.reservations(id) ON DELETE CASCADE,
  stay_id uuid REFERENCES public.stays(id) ON DELETE SET NULL,
  room_id uuid NOT NULL REFERENCES public.rooms(id) ON DELETE CASCADE,
  start_date date NOT NULL,
  end_date date NOT NULL,
  status text NOT NULL DEFAULT 'active',
  assignment_type text NOT NULL DEFAULT 'standard',
  previous_room_id uuid REFERENCES public.rooms(id) ON DELETE SET NULL,
  reason text NOT NULL DEFAULT '',
  assigned_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT room_assignments_dates_check CHECK (end_date > start_date),
  CONSTRAINT room_assignments_no_overlap EXCLUDE USING gist (
    room_id WITH =,
    daterange(start_date, end_date, '[)') WITH &&
  ) WHERE (status = 'active')
);

CREATE TABLE public.room_move_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  reservation_id uuid NOT NULL REFERENCES public.reservations(id) ON DELETE CASCADE,
  stay_id uuid REFERENCES public.stays(id) ON DELETE SET NULL,
  from_room_id uuid REFERENCES public.rooms(id) ON DELETE SET NULL,
  to_room_id uuid REFERENCES public.rooms(id) ON DELETE SET NULL,
  move_type text NOT NULL DEFAULT 'transfer',
  rate_treatment text NOT NULL DEFAULT 'unchanged',
  rate_difference numeric(14,2) NOT NULL DEFAULT 0,
  reason text NOT NULL DEFAULT '',
  moved_at timestamptz NOT NULL DEFAULT now(),
  moved_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.registration_cards (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  branch_id uuid REFERENCES public.branches(id) ON DELETE CASCADE,
  reservation_id uuid NOT NULL REFERENCES public.reservations(id) ON DELETE CASCADE,
  stay_id uuid REFERENCES public.stays(id) ON DELETE SET NULL,
  customer_id uuid REFERENCES public.customers(id) ON DELETE SET NULL,
  document_number text NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  terms_version text NOT NULL DEFAULT 'v1',
  acknowledged_at timestamptz,
  signature_name text,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (reservation_id, document_number)
);

CREATE TABLE public.key_issuance_records (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  stay_id uuid REFERENCES public.stays(id) ON DELETE CASCADE,
  reservation_id uuid REFERENCES public.reservations(id) ON DELETE CASCADE,
  room_id uuid REFERENCES public.rooms(id) ON DELETE SET NULL,
  keys_issued integer NOT NULL DEFAULT 1,
  issued_to text NOT NULL DEFAULT '',
  issued_at timestamptz NOT NULL DEFAULT now(),
  returned_at timestamptz,
  issued_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.guest_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  branch_id uuid REFERENCES public.branches(id) ON DELETE CASCADE,
  reservation_id uuid REFERENCES public.reservations(id) ON DELETE CASCADE,
  stay_id uuid REFERENCES public.stays(id) ON DELETE SET NULL,
  customer_id uuid REFERENCES public.customers(id) ON DELETE SET NULL,
  room_id uuid REFERENCES public.rooms(id) ON DELETE SET NULL,
  category text NOT NULL DEFAULT 'housekeeping',
  description text NOT NULL DEFAULT '',
  priority text NOT NULL DEFAULT 'normal',
  department_id uuid REFERENCES public.departments(id) ON DELETE SET NULL,
  station_id uuid REFERENCES public.operational_stations(id) ON DELETE SET NULL,
  assignee_id uuid,
  task_id uuid REFERENCES public.tasks(id) ON DELETE SET NULL,
  due_at timestamptz,
  status text NOT NULL DEFAULT 'new',
  completed_at timestamptz,
  guest_confirmed boolean NOT NULL DEFAULT false,
  notes text NOT NULL DEFAULT '',
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- ============ FOLIOS & MONEY ============
CREATE TABLE public.folios (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  branch_id uuid REFERENCES public.branches(id) ON DELETE CASCADE,
  folio_number text NOT NULL,
  folio_type text NOT NULL DEFAULT 'guest',
  reservation_id uuid REFERENCES public.reservations(id) ON DELETE SET NULL,
  stay_id uuid REFERENCES public.stays(id) ON DELETE SET NULL,
  customer_id uuid REFERENCES public.customers(id) ON DELETE SET NULL,
  corporate_account_id uuid REFERENCES public.corporate_accounts(id) ON DELETE SET NULL,
  group_booking_id uuid REFERENCES public.group_bookings(id) ON DELETE SET NULL,
  parent_folio_id uuid REFERENCES public.folios(id) ON DELETE SET NULL,
  currency text NOT NULL DEFAULT 'KES',
  status text NOT NULL DEFAULT 'open',
  opened_at timestamptz NOT NULL DEFAULT now(),
  closed_at timestamptz,
  total_charges numeric(14,2) NOT NULL DEFAULT 0,
  total_discounts numeric(14,2) NOT NULL DEFAULT 0,
  total_taxes numeric(14,2) NOT NULL DEFAULT 0,
  total_payments numeric(14,2) NOT NULL DEFAULT 0,
  total_refunds numeric(14,2) NOT NULL DEFAULT 0,
  balance numeric(14,2) NOT NULL DEFAULT 0,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, folio_number)
);
CREATE UNIQUE INDEX folios_primary_per_stay_idx ON public.folios (stay_id)
  WHERE folio_type = 'guest' AND stay_id IS NOT NULL;

CREATE TABLE public.folio_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  branch_id uuid REFERENCES public.branches(id) ON DELETE CASCADE,
  folio_id uuid NOT NULL REFERENCES public.folios(id) ON DELETE CASCADE,
  reservation_id uuid REFERENCES public.reservations(id) ON DELETE SET NULL,
  line_type text NOT NULL DEFAULT 'charge',
  category text NOT NULL DEFAULT 'accommodation',
  reference text NOT NULL DEFAULT '',
  source_module text NOT NULL DEFAULT 'pms',
  source_record_id text,
  idempotency_key text,
  posting_date timestamptz NOT NULL DEFAULT now(),
  operational_date date NOT NULL DEFAULT current_date,
  description text NOT NULL DEFAULT '',
  quantity numeric(12,3) NOT NULL DEFAULT 1,
  unit_price numeric(14,2) NOT NULL DEFAULT 0,
  gross_amount numeric(14,2) NOT NULL DEFAULT 0,
  discount_amount numeric(14,2) NOT NULL DEFAULT 0,
  tax_amount numeric(14,2) NOT NULL DEFAULT 0,
  net_amount numeric(14,2) NOT NULL DEFAULT 0,
  reverses_line_id uuid REFERENCES public.folio_lines(id) ON DELETE SET NULL,
  status text NOT NULL DEFAULT 'posted',
  posted_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX folio_lines_idempotency_idx ON public.folio_lines (organization_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;
CREATE UNIQUE INDEX folio_lines_nightly_once_idx ON public.folio_lines (reservation_id, operational_date)
  WHERE category = 'accommodation' AND line_type = 'charge' AND status = 'posted';
CREATE INDEX folio_lines_folio_idx ON public.folio_lines (folio_id, posting_date);

CREATE TABLE public.folio_routing_rules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  folio_id uuid NOT NULL REFERENCES public.folios(id) ON DELETE CASCADE,
  target_folio_id uuid NOT NULL REFERENCES public.folios(id) ON DELETE CASCADE,
  rule_type text NOT NULL DEFAULT 'category',
  category text,
  percentage numeric(6,3),
  amount_cap numeric(14,2),
  start_date date,
  end_date date,
  status text NOT NULL DEFAULT 'active',
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.folio_allocations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  source_line_id uuid NOT NULL REFERENCES public.folio_lines(id) ON DELETE CASCADE,
  target_folio_id uuid NOT NULL REFERENCES public.folios(id) ON DELETE CASCADE,
  amount numeric(14,2) NOT NULL,
  reason text NOT NULL DEFAULT '',
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.payments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  branch_id uuid REFERENCES public.branches(id) ON DELETE CASCADE,
  receipt_number text NOT NULL,
  folio_id uuid REFERENCES public.folios(id) ON DELETE SET NULL,
  reservation_id uuid REFERENCES public.reservations(id) ON DELETE SET NULL,
  customer_id uuid REFERENCES public.customers(id) ON DELETE SET NULL,
  amount numeric(14,2) NOT NULL,
  currency text NOT NULL DEFAULT 'KES',
  method text NOT NULL DEFAULT 'cash',
  external_reference text,
  paid_at timestamptz NOT NULL DEFAULT now(),
  status text NOT NULL DEFAULT 'confirmed',
  received_by uuid,
  notes text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, receipt_number)
);
CREATE UNIQUE INDEX payments_external_ref_idx ON public.payments (organization_id, method, external_reference)
  WHERE external_reference IS NOT NULL;

CREATE TABLE public.payment_allocations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  payment_id uuid NOT NULL REFERENCES public.payments(id) ON DELETE CASCADE,
  folio_id uuid NOT NULL REFERENCES public.folios(id) ON DELETE CASCADE,
  amount numeric(14,2) NOT NULL,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.refunds (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  branch_id uuid REFERENCES public.branches(id) ON DELETE CASCADE,
  payment_id uuid NOT NULL REFERENCES public.payments(id) ON DELETE CASCADE,
  folio_id uuid REFERENCES public.folios(id) ON DELETE SET NULL,
  amount numeric(14,2) NOT NULL,
  reason text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'requested',
  approval_request_id uuid REFERENCES public.approval_requests(id) ON DELETE SET NULL,
  requested_by uuid,
  approved_by uuid,
  processed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- ============ OTA / WORKFLOW / SETTINGS ============
CREATE TABLE public.ota_connections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  branch_id uuid REFERENCES public.branches(id) ON DELETE CASCADE,
  channel text NOT NULL,
  display_name text NOT NULL,
  status text NOT NULL DEFAULT 'not-configured',
  commission_rate numeric(6,3) NOT NULL DEFAULT 0,
  property_reference text,
  last_sync_at timestamptz,
  notes text NOT NULL DEFAULT '',
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, branch_id, channel)
);

CREATE TABLE public.ota_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  branch_id uuid REFERENCES public.branches(id) ON DELETE CASCADE,
  connection_id uuid REFERENCES public.ota_connections(id) ON DELETE SET NULL,
  channel text NOT NULL,
  event_type text NOT NULL DEFAULT 'reservation',
  external_id text NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  reservation_id uuid REFERENCES public.reservations(id) ON DELETE SET NULL,
  status text NOT NULL DEFAULT 'pending',
  error_message text,
  received_at timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, channel, external_id, event_type)
);

CREATE TABLE public.pms_workflow_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  branch_id uuid REFERENCES public.branches(id) ON DELETE CASCADE,
  event_type text NOT NULL,
  reservation_id uuid REFERENCES public.reservations(id) ON DELETE CASCADE,
  stay_id uuid REFERENCES public.stays(id) ON DELETE SET NULL,
  folio_id uuid REFERENCES public.folios(id) ON DELETE SET NULL,
  idempotency_key text NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'completed',
  error_message text,
  attempts integer NOT NULL DEFAULT 1,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, idempotency_key)
);

CREATE TABLE public.pms_settings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  branch_id uuid REFERENCES public.branches(id) ON DELETE CASCADE,
  settings jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, branch_id)
);

-- ============ GRANTS, RLS, TRIGGERS ============
DO $$
DECLARE t text; guest_tables text[] := ARRAY['reservations','folios','folio_lines','payments','guest_requests','stays'];
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'room_types','rooms','room_status_history','room_blocks','meal_plans','rate_plans','rate_plan_prices',
    'group_bookings','group_room_blocks','reservations','reservation_rooms','reservation_guests',
    'reservation_history','reservation_notes','reservation_holds','waitlist_entries','stays',
    'room_assignments','room_move_history','registration_cards','key_issuance_records','guest_requests',
    'folios','folio_lines','folio_routing_rules','folio_allocations','payments','payment_allocations',
    'refunds','ota_connections','ota_events','pms_workflow_events','pms_settings'
  ] LOOP
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON public.%I TO authenticated', t);
    EXECUTE format('GRANT ALL ON public.%I TO service_role', t);
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format($f$CREATE TRIGGER %I BEFORE UPDATE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at()$f$, t || '_touch', t);

    EXECUTE format($f$CREATE POLICY "staff_read_%s" ON public.%I FOR SELECT TO authenticated
      USING (organization_id = public.current_org_id())$f$, t, t);
    EXECUTE format($f$CREATE POLICY "staff_insert_%s" ON public.%I FOR INSERT TO authenticated
      WITH CHECK (organization_id = public.current_org_id() AND public.has_permission('pms','write'))$f$, t, t);
    EXECUTE format($f$CREATE POLICY "staff_update_%s" ON public.%I FOR UPDATE TO authenticated
      USING (organization_id = public.current_org_id() AND public.has_permission('pms','write'))
      WITH CHECK (organization_id = public.current_org_id())$f$, t, t);
    EXECUTE format($f$CREATE POLICY "staff_delete_%s" ON public.%I FOR DELETE TO authenticated
      USING (organization_id = public.current_org_id() AND public.is_org_admin())$f$, t, t);
  END LOOP;

  -- Guests may read only their own records; they can never write PMS data.
  FOREACH t IN ARRAY guest_tables LOOP
    IF t = 'folio_lines' THEN
      EXECUTE $f$CREATE POLICY "guest_read_folio_lines" ON public.folio_lines FOR SELECT TO authenticated
        USING (folio_id IN (SELECT id FROM public.folios WHERE customer_id = public.my_customer_id()))$f$;
    ELSE
      EXECUTE format($f$CREATE POLICY "guest_read_%s" ON public.%I FOR SELECT TO authenticated
        USING (customer_id IS NOT NULL AND customer_id = public.my_customer_id())$f$, t, t);
    END IF;
  END LOOP;
END $$;

-- ============ PERMISSIONS ============
INSERT INTO public.permissions (module, action, label)
SELECT 'pms', v.action, v.label
FROM (VALUES
  ('write','PMS write access'),
  ('dashboard.view','View Front Office dashboard'),
  ('reservations.view','View reservations'),
  ('reservations.create','Create reservations'),
  ('reservations.edit','Edit reservations'),
  ('reservations.confirm','Confirm reservations'),
  ('reservations.cancel','Cancel reservations'),
  ('reservations.reinstate','Reinstate reservations'),
  ('reservations.mark_no_show','Mark reservation no-show'),
  ('availability.view','View availability'),
  ('rooms.view','View rooms'),
  ('rooms.assign','Assign rooms'),
  ('rooms.transfer','Transfer rooms'),
  ('rooms.upgrade','Upgrade or downgrade rooms'),
  ('rooms.block','Block rooms'),
  ('checkin.perform','Perform check-in'),
  ('checkout.perform','Perform checkout'),
  ('folios.view','View folios'),
  ('folios.create','Create folios'),
  ('folios.post_charge','Post folio charges'),
  ('folios.adjust','Adjust folio lines'),
  ('folios.split','Split folios'),
  ('folios.close','Close folios'),
  ('folios.reopen','Reopen folios'),
  ('payments.record','Record payments'),
  ('refunds.request','Request refunds'),
  ('refunds.approve','Approve refunds'),
  ('rate_override.request','Request rate override'),
  ('rate_override.approve','Approve rate override'),
  ('complimentary.request','Request complimentary stay'),
  ('complimentary.approve','Approve complimentary stay'),
  ('groups.manage','Manage group bookings'),
  ('corporate.manage','Manage corporate bookings'),
  ('ota.view','View OTA inbox'),
  ('reports.view','View Front Office reports'),
  ('reports.export','Export Front Office reports'),
  ('settings.manage','Manage PMS settings')
) AS v(action,label)
WHERE NOT EXISTS (SELECT 1 FROM public.permissions p WHERE p.module='pms' AND p.action=v.action);

INSERT INTO public.role_permissions (organization_id, role_id, permission_id)
SELECT r.organization_id, r.id, p.id
FROM public.roles r
CROSS JOIN public.permissions p
WHERE p.module='pms' AND r.name IN ('Owner','System Administrator')
  AND NOT EXISTS (SELECT 1 FROM public.role_permissions rp WHERE rp.role_id=r.id AND rp.permission_id=p.id);

INSERT INTO public.approval_types (organization_id, key, name)
SELECT o.id, v.key, v.name
FROM public.organizations o
CROSS JOIN (VALUES
  ('room-upgrade','Room upgrade'),
  ('early-check-in','Early check-in'),
  ('late-checkout','Late checkout'),
  ('folio-reopen','Folio reopen'),
  ('house-use','House-use room')
) AS v(key,name)
WHERE NOT EXISTS (SELECT 1 FROM public.approval_types a WHERE a.organization_id=o.id AND a.key=v.key);

-- ============ AVAILABILITY ENGINE ============
CREATE OR REPLACE FUNCTION public.pms_available_rooms(
  _branch uuid, _arrival date, _departure date,
  _room_type uuid DEFAULT NULL, _adults integer DEFAULT 1, _children integer DEFAULT 0
) RETURNS TABLE(room_id uuid, room_number text, room_type_id uuid, room_type_name text, floor text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
  SELECT r.id, r.room_number, r.room_type_id, rt.name, r.floor
  FROM public.rooms r
  LEFT JOIN public.room_types rt ON rt.id = r.room_type_id
  WHERE r.organization_id = public.current_org_id()
    AND (_branch IS NULL OR r.branch_id = _branch)
    AND r.status = 'active' AND r.sellable
    AND r.room_condition NOT IN ('out-of-order','out-of-service','maintenance','blocked')
    AND (_room_type IS NULL OR r.room_type_id = _room_type)
    AND (rt.id IS NULL OR rt.max_occupancy >= (_adults + _children))
    AND NOT EXISTS (
      SELECT 1 FROM public.room_assignments a
      WHERE a.room_id = r.id AND a.status = 'active'
        AND daterange(a.start_date, a.end_date, '[)') && daterange(_arrival, _departure, '[)'))
    AND NOT EXISTS (
      SELECT 1 FROM public.room_blocks b
      WHERE b.room_id = r.id AND b.status = 'active'
        AND daterange(b.start_date, b.end_date, '[]') && daterange(_arrival, _departure, '[)'))
    AND NOT EXISTS (
      SELECT 1 FROM public.reservation_holds h
      WHERE h.room_id = r.id AND h.status = 'active' AND h.hold_expires_at > now()
        AND daterange(h.arrival_date, h.departure_date, '[)') && daterange(_arrival, _departure, '[)'))
  ORDER BY r.room_number;
$$;

CREATE OR REPLACE FUNCTION public.pms_release_expired_holds()
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE _n integer;
BEGIN
  UPDATE public.reservation_holds SET status='expired', updated_at=now()
  WHERE status='active' AND hold_expires_at <= now()
    AND organization_id = public.current_org_id();
  GET DIAGNOSTICS _n = ROW_COUNT;
  RETURN _n;
END; $$;

-- ============ ROOM ASSIGNMENT ============
CREATE OR REPLACE FUNCTION public.pms_assign_room(_reservation uuid, _room uuid, _reason text DEFAULT '')
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE _org uuid := public.current_org_id(); _res public.reservations; _prev uuid; _id uuid;
BEGIN
  IF NOT public.has_permission('pms','rooms.assign') THEN RAISE EXCEPTION 'Not permitted to assign rooms'; END IF;
  SELECT * INTO _res FROM public.reservations WHERE id=_reservation AND organization_id=_org FOR UPDATE;
  IF _res.id IS NULL THEN RAISE EXCEPTION 'Reservation not found'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.rooms WHERE id=_room AND organization_id=_org AND branch_id=_res.branch_id) THEN
    RAISE EXCEPTION 'Room does not belong to this reservation branch';
  END IF;

  SELECT room_id INTO _prev FROM public.room_assignments
   WHERE reservation_id=_reservation AND status='active' LIMIT 1;

  UPDATE public.room_assignments SET status='released', updated_at=now()
   WHERE reservation_id=_reservation AND status='active';

  INSERT INTO public.room_assignments (organization_id, branch_id, reservation_id, stay_id, room_id,
    start_date, end_date, previous_room_id, reason, assigned_by)
  VALUES (_org, _res.branch_id, _reservation,
    (SELECT id FROM public.stays WHERE reservation_id=_reservation),
    _room, _res.arrival_date, _res.departure_date, _prev, COALESCE(_reason,''), auth.uid())
  RETURNING id INTO _id;

  UPDATE public.reservations SET room_id=_room, updated_at=now() WHERE id=_reservation;
  INSERT INTO public.reservation_history (organization_id, reservation_id, action, field, previous_value, new_value, reason, changed_by)
  VALUES (_org, _reservation, 'room.assign', 'room_id', _prev::text, _room::text, _reason, auth.uid());
  INSERT INTO public.audit_logs (organization_id, user_id, user_name, action, module, record_id, previous_value, new_value, reason)
  VALUES (_org, auth.uid(), '', 'pms.room.assign', 'front-office', _reservation::text,
          jsonb_build_object('room_id', _prev), jsonb_build_object('room_id', _room), _reason);
  RETURN _id;
END; $$;

-- ============ CHECK-IN ============
CREATE OR REPLACE FUNCTION public.pms_check_in(_reservation uuid, _keys integer DEFAULT 1, _notes text DEFAULT '')
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE _org uuid := public.current_org_id(); _res public.reservations; _stay uuid; _folio uuid;
  _room public.rooms; _key text; _folio_no text;
BEGIN
  IF NOT public.has_permission('pms','checkin.perform') THEN RAISE EXCEPTION 'Not permitted to check in guests'; END IF;
  SELECT * INTO _res FROM public.reservations WHERE id=_reservation AND organization_id=_org FOR UPDATE;
  IF _res.id IS NULL THEN RAISE EXCEPTION 'Reservation not found'; END IF;
  _key := 'checkin:' || _reservation::text;

  SELECT id INTO _stay FROM public.stays WHERE reservation_id=_reservation;
  IF _stay IS NOT NULL THEN
    SELECT id INTO _folio FROM public.folios WHERE stay_id=_stay AND folio_type='guest';
    RETURN jsonb_build_object('stay_id',_stay,'folio_id',_folio,'idempotent',true);
  END IF;

  IF _res.status NOT IN ('confirmed','guaranteed','tentative','pending-deposit') THEN
    RAISE EXCEPTION 'Reservation status % is not eligible for check-in', _res.status;
  END IF;
  IF _res.room_id IS NULL THEN RAISE EXCEPTION 'Assign a room before check-in'; END IF;
  SELECT * INTO _room FROM public.rooms WHERE id=_res.room_id FOR UPDATE;
  IF _room.room_condition IN ('out-of-order','out-of-service','maintenance','blocked') THEN
    RAISE EXCEPTION 'Room % is not available (%).', _room.room_number, _room.room_condition;
  END IF;
  IF _room.occupancy_status = 'occupied' THEN
    RAISE EXCEPTION 'Room % is already occupied', _room.room_number;
  END IF;

  INSERT INTO public.stays (organization_id, branch_id, reservation_id, customer_id, room_id,
    checked_in_by, expected_departure)
  VALUES (_org, _res.branch_id, _reservation, _res.customer_id, _res.room_id, auth.uid(), _res.departure_date)
  RETURNING id INTO _stay;

  _folio_no := public.next_document_number('invoice');
  INSERT INTO public.folios (organization_id, branch_id, folio_number, reservation_id, stay_id,
    customer_id, corporate_account_id, group_booking_id, created_by)
  VALUES (_org, _res.branch_id, _folio_no, _reservation, _stay, _res.customer_id,
          _res.corporate_account_id, _res.group_booking_id, auth.uid())
  RETURNING id INTO _folio;

  UPDATE public.reservations SET status='checked-in', updated_at=now() WHERE id=_reservation;
  UPDATE public.rooms SET occupancy_status='occupied', room_condition='occupied-clean',
    housekeeping_status='occupied', updated_at=now() WHERE id=_res.room_id;
  UPDATE public.room_assignments SET stay_id=_stay, updated_at=now()
    WHERE reservation_id=_reservation AND status='active';

  INSERT INTO public.room_status_history (organization_id, branch_id, room_id, field, previous_value, new_value, reason, changed_by)
  VALUES (_org, _res.branch_id, _res.room_id, 'occupancy_status', _room.occupancy_status, 'occupied', 'Guest checked in', auth.uid());

  INSERT INTO public.tasks (organization_id, branch_id, reference, title, description, created_by, priority, status)
  VALUES (_org, _res.branch_id, 'HK-IN-' || left(_reservation::text,8),
    'Room ' || _room.room_number || ' is now occupied',
    'Guest checked in. Service the room per housekeeping schedule.', auth.uid(), 'normal', 'open');

  INSERT INTO public.notifications (organization_id, branch_id, category, title, body, link)
  VALUES (_org, _res.branch_id, 'operations', 'Guest checked in',
    'Room ' || _room.room_number || ' — folio ' || _folio_no || ' is now active.', '/pms/in-house');

  INSERT INTO public.customer_timeline_events (organization_id, customer_id, event_type, title, description, created_by)
  SELECT _org, _res.customer_id, 'stay', 'Checked in',
    'Room ' || _room.room_number || ' · ' || _res.arrival_date::text || ' → ' || _res.departure_date::text, auth.uid()
  WHERE _res.customer_id IS NOT NULL;

  INSERT INTO public.pms_workflow_events (organization_id, branch_id, event_type, reservation_id, stay_id, folio_id, idempotency_key, created_by)
  VALUES (_org, _res.branch_id, 'guest.checked-in', _reservation, _stay, _folio, _key, auth.uid())
  ON CONFLICT DO NOTHING;

  INSERT INTO public.audit_logs (organization_id, user_id, user_name, action, module, record_id, new_value, reason)
  VALUES (_org, auth.uid(), '', 'pms.checkin', 'front-office', _reservation::text,
    jsonb_build_object('stay_id',_stay,'folio_id',_folio,'room',_room.room_number,'keys',_keys), _notes);

  RETURN jsonb_build_object('stay_id',_stay,'folio_id',_folio,'folio_number',_folio_no,'idempotent',false);
END; $$;

-- ============ ROOM CHARGE POSTING ============
CREATE OR REPLACE FUNCTION public.pms_post_room_charge(
  _folio uuid, _category text, _description text, _quantity numeric, _unit_price numeric,
  _tax numeric, _source_module text, _source_record_id text, _idempotency_key text
) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE _org uuid := public.current_org_id(); _f public.folios; _gross numeric; _id uuid;
BEGIN
  IF NOT public.has_permission('pms','folios.post_charge') THEN RAISE EXCEPTION 'Not permitted to post charges'; END IF;
  SELECT * INTO _f FROM public.folios WHERE id=_folio AND organization_id=_org FOR UPDATE;
  IF _f.id IS NULL THEN RAISE EXCEPTION 'Folio not found'; END IF;
  IF _f.status <> 'open' THEN RAISE EXCEPTION 'Folio is % and cannot accept charges', _f.status; END IF;

  SELECT id INTO _id FROM public.folio_lines
   WHERE organization_id=_org AND idempotency_key=_idempotency_key AND _idempotency_key IS NOT NULL;
  IF _id IS NOT NULL THEN RETURN _id; END IF;

  _gross := round(COALESCE(_quantity,1) * COALESCE(_unit_price,0), 2);
  INSERT INTO public.folio_lines (organization_id, branch_id, folio_id, reservation_id, line_type, category,
    reference, source_module, source_record_id, idempotency_key, description, quantity, unit_price,
    gross_amount, tax_amount, net_amount, posted_by)
  VALUES (_org, _f.branch_id, _folio, _f.reservation_id, 'charge', _category,
    COALESCE(_source_record_id,''), _source_module, _source_record_id, _idempotency_key, _description,
    COALESCE(_quantity,1), COALESCE(_unit_price,0), _gross, COALESCE(_tax,0), _gross + COALESCE(_tax,0), auth.uid())
  RETURNING id INTO _id;

  UPDATE public.folios SET
    total_charges = total_charges + _gross,
    total_taxes = total_taxes + COALESCE(_tax,0),
    balance = balance + _gross + COALESCE(_tax,0),
    updated_at = now()
  WHERE id=_folio;

  INSERT INTO public.audit_logs (organization_id, user_id, user_name, action, module, record_id, new_value)
  VALUES (_org, auth.uid(), '', 'pms.folio.post_charge', 'finance', _folio::text,
    jsonb_build_object('line_id',_id,'category',_category,'amount',_gross + COALESCE(_tax,0),'source',_source_module));
  RETURN _id;
END; $$;

-- ============ PAYMENT ============
CREATE OR REPLACE FUNCTION public.pms_record_payment(
  _folio uuid, _amount numeric, _method text, _reference text DEFAULT NULL, _notes text DEFAULT ''
) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE _org uuid := public.current_org_id(); _f public.folios; _id uuid; _receipt text; _status text;
BEGIN
  IF NOT public.has_permission('pms','payments.record') THEN RAISE EXCEPTION 'Not permitted to record payments'; END IF;
  IF _amount IS NULL OR _amount <= 0 THEN RAISE EXCEPTION 'Payment amount must be greater than zero'; END IF;
  SELECT * INTO _f FROM public.folios WHERE id=_folio AND organization_id=_org FOR UPDATE;
  IF _f.id IS NULL THEN RAISE EXCEPTION 'Folio not found'; END IF;
  IF _f.status NOT IN ('open','under-review') THEN RAISE EXCEPTION 'Folio is % and cannot accept payments', _f.status; END IF;

  -- External methods stay pending until a provider or authorised verification confirms them.
  _status := CASE WHEN _method IN ('cash','corporate-credit') THEN 'confirmed' ELSE 'pending' END;
  _receipt := public.next_document_number('receipt');

  INSERT INTO public.payments (organization_id, branch_id, receipt_number, folio_id, reservation_id,
    customer_id, amount, currency, method, external_reference, status, received_by, notes)
  VALUES (_org, _f.branch_id, _receipt, _folio, _f.reservation_id, _f.customer_id, _amount, _f.currency,
    _method, _reference, _status, auth.uid(), COALESCE(_notes,''))
  RETURNING id INTO _id;

  IF _status = 'confirmed' THEN
    INSERT INTO public.payment_allocations (organization_id, payment_id, folio_id, amount, created_by)
    VALUES (_org, _id, _folio, _amount, auth.uid());
    UPDATE public.folios SET total_payments = total_payments + _amount,
      balance = balance - _amount, updated_at = now() WHERE id=_folio;
  END IF;

  INSERT INTO public.audit_logs (organization_id, user_id, user_name, action, module, record_id, new_value, reason)
  VALUES (_org, auth.uid(), '', 'pms.payment.record', 'finance', _id::text,
    jsonb_build_object('folio_id',_folio,'amount',_amount,'method',_method,'status',_status), _notes);
  RETURN _id;
END; $$;

-- ============ NIGHTLY ACCOMMODATION POSTING ============
CREATE OR REPLACE FUNCTION public.pms_post_accommodation(_operational_date date DEFAULT current_date)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE _org uuid := public.current_org_id(); _r record; _n integer := 0; _tax numeric;
BEGIN
  IF NOT public.has_permission('pms','folios.post_charge') THEN RAISE EXCEPTION 'Not permitted to post charges'; END IF;
  FOR _r IN
    SELECT s.id AS stay_id, s.reservation_id, f.id AS folio_id, f.branch_id, res.nightly_rate,
           COALESCE(rp.tax_rate,0) AS tax_rate, rm.room_number
    FROM public.stays s
    JOIN public.reservations res ON res.id = s.reservation_id
    JOIN public.folios f ON f.stay_id = s.id AND f.folio_type='guest' AND f.status='open'
    LEFT JOIN public.rate_plans rp ON rp.id = res.rate_plan_id
    LEFT JOIN public.rooms rm ON rm.id = s.room_id
    WHERE s.organization_id=_org AND s.status='in-house'
      AND _operational_date >= res.arrival_date AND _operational_date < res.departure_date
  LOOP
    _tax := round(_r.nightly_rate * _r.tax_rate / 100, 2);
    BEGIN
      INSERT INTO public.folio_lines (organization_id, branch_id, folio_id, reservation_id, line_type,
        category, source_module, description, operational_date, quantity, unit_price,
        gross_amount, tax_amount, net_amount, posted_by)
      VALUES (_org, _r.branch_id, _r.folio_id, _r.reservation_id, 'charge', 'accommodation', 'pms',
        'Accommodation — room ' || COALESCE(_r.room_number,'') || ' · ' || _operational_date::text,
        _operational_date, 1, _r.nightly_rate, _r.nightly_rate, _tax, _r.nightly_rate + _tax, auth.uid());
      UPDATE public.folios SET total_charges = total_charges + _r.nightly_rate,
        total_taxes = total_taxes + _tax, balance = balance + _r.nightly_rate + _tax, updated_at=now()
      WHERE id=_r.folio_id;
      _n := _n + 1;
    EXCEPTION WHEN unique_violation THEN
      NULL; -- already posted for this reservation night
    END;
  END LOOP;
  RETURN _n;
END; $$;

-- ============ ROOM TRANSFER ============
CREATE OR REPLACE FUNCTION public.pms_transfer_room(_reservation uuid, _to_room uuid, _reason text, _move_type text DEFAULT 'transfer')
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE _org uuid := public.current_org_id(); _stay public.stays; _from uuid; _id uuid; _to public.rooms;
BEGIN
  IF NOT public.has_permission('pms','rooms.transfer') THEN RAISE EXCEPTION 'Not permitted to transfer rooms'; END IF;
  SELECT * INTO _stay FROM public.stays WHERE reservation_id=_reservation AND organization_id=_org FOR UPDATE;
  IF _stay.id IS NULL OR _stay.status <> 'in-house' THEN RAISE EXCEPTION 'No in-house stay for this reservation'; END IF;
  SELECT * INTO _to FROM public.rooms WHERE id=_to_room AND organization_id=_org FOR UPDATE;
  IF _to.id IS NULL THEN RAISE EXCEPTION 'Destination room not found'; END IF;
  IF _to.occupancy_status='occupied' OR _to.room_condition IN ('out-of-order','out-of-service','maintenance','blocked') THEN
    RAISE EXCEPTION 'Destination room % is not available', _to.room_number;
  END IF;
  _from := _stay.room_id;

  UPDATE public.room_assignments SET status='moved', end_date=GREATEST(start_date + 1, current_date), updated_at=now()
   WHERE reservation_id=_reservation AND status='active';

  INSERT INTO public.room_assignments (organization_id, branch_id, reservation_id, stay_id, room_id,
    start_date, end_date, previous_room_id, reason, assignment_type, assigned_by)
  VALUES (_org, _stay.branch_id, _reservation, _stay.id, _to_room, current_date,
    GREATEST(_stay.expected_departure, current_date + 1), _from, _reason, _move_type, auth.uid())
  RETURNING id INTO _id;

  UPDATE public.stays SET room_id=_to_room, updated_at=now() WHERE id=_stay.id;
  UPDATE public.reservations SET room_id=_to_room, updated_at=now() WHERE id=_reservation;
  UPDATE public.rooms SET occupancy_status='vacant', room_condition='vacant-dirty',
    housekeeping_status='dirty', updated_at=now() WHERE id=_from;
  UPDATE public.rooms SET occupancy_status='occupied', room_condition='occupied-clean',
    housekeeping_status='occupied', updated_at=now() WHERE id=_to_room;

  INSERT INTO public.room_move_history (organization_id, reservation_id, stay_id, from_room_id, to_room_id,
    move_type, reason, moved_by)
  VALUES (_org, _reservation, _stay.id, _from, _to_room, _move_type, _reason, auth.uid());

  INSERT INTO public.tasks (organization_id, branch_id, reference, title, description, created_by, priority, status)
  VALUES (_org, _stay.branch_id, 'HK-MV-' || left(_id::text,8), 'Clean vacated room',
    'Guest transferred out. Room requires cleaning.', auth.uid(), 'high', 'open');

  INSERT INTO public.notifications (organization_id, branch_id, category, title, body, link)
  VALUES (_org, _stay.branch_id, 'operations', 'Room transfer completed',
    'Guest moved to room ' || _to.room_number || '. Folio unchanged.', '/pms/room-rack');

  INSERT INTO public.audit_logs (organization_id, user_id, user_name, action, module, record_id, previous_value, new_value, reason)
  VALUES (_org, auth.uid(), '', 'pms.room.transfer', 'front-office', _reservation::text,
    jsonb_build_object('room_id',_from), jsonb_build_object('room_id',_to_room), _reason);
  RETURN _id;
END; $$;

-- ============ CHECKOUT ============
CREATE OR REPLACE FUNCTION public.pms_check_out(_reservation uuid, _force boolean DEFAULT false, _notes text DEFAULT '')
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE _org uuid := public.current_org_id(); _stay public.stays; _f public.folios; _room public.rooms; _key text;
BEGIN
  IF NOT public.has_permission('pms','checkout.perform') THEN RAISE EXCEPTION 'Not permitted to check out guests'; END IF;
  SELECT * INTO _stay FROM public.stays WHERE reservation_id=_reservation AND organization_id=_org FOR UPDATE;
  IF _stay.id IS NULL THEN RAISE EXCEPTION 'No stay found for this reservation'; END IF;
  IF _stay.status = 'checked-out' THEN
    RETURN jsonb_build_object('stay_id',_stay.id,'idempotent',true);
  END IF;

  SELECT * INTO _f FROM public.folios WHERE stay_id=_stay.id AND folio_type='guest' FOR UPDATE;
  IF _f.id IS NOT NULL AND _f.balance > 0 AND NOT _force THEN
    RAISE EXCEPTION 'Folio balance of % is outstanding', _f.balance;
  END IF;

  _key := 'checkout:' || _reservation::text;
  UPDATE public.stays SET status='checked-out', checked_out_at=now(), checked_out_by=auth.uid(), updated_at=now()
   WHERE id=_stay.id;
  UPDATE public.reservations SET status='checked-out', updated_at=now() WHERE id=_reservation;
  UPDATE public.room_assignments SET status='released', updated_at=now()
   WHERE reservation_id=_reservation AND status='active';
  IF _f.id IS NOT NULL THEN
    UPDATE public.folios SET status = CASE WHEN balance <= 0 THEN 'settled' ELSE 'under-review' END,
      closed_at = CASE WHEN balance <= 0 THEN now() ELSE NULL END, updated_at=now() WHERE id=_f.id;
  END IF;

  SELECT * INTO _room FROM public.rooms WHERE id=_stay.room_id FOR UPDATE;
  UPDATE public.rooms SET occupancy_status='vacant', room_condition='vacant-dirty',
    housekeeping_status='dirty', updated_at=now() WHERE id=_stay.room_id;

  INSERT INTO public.room_status_history (organization_id, branch_id, room_id, field, previous_value, new_value, reason, changed_by)
  VALUES (_org, _stay.branch_id, _stay.room_id, 'room_condition', _room.room_condition, 'vacant-dirty', 'Guest checked out', auth.uid());

  INSERT INTO public.pms_workflow_events (organization_id, branch_id, event_type, reservation_id, stay_id, folio_id, idempotency_key, created_by)
  VALUES (_org, _stay.branch_id, 'guest.checked-out', _reservation, _stay.id, _f.id, _key, auth.uid())
  ON CONFLICT DO NOTHING;

  INSERT INTO public.tasks (organization_id, branch_id, reference, title, description, created_by, priority, status)
  VALUES (_org, _stay.branch_id, 'HK-OUT-' || left(_stay.id::text,8),
    'Clean room ' || COALESCE(_room.room_number,''), 'Departure cleaning required.', auth.uid(), 'high', 'open');

  INSERT INTO public.notifications (organization_id, branch_id, category, title, body, link)
  VALUES (_org, _stay.branch_id, 'operations', 'Guest checked out',
    'Room ' || COALESCE(_room.room_number,'') || ' is now vacant dirty.', '/pms/departures');

  INSERT INTO public.customer_timeline_events (organization_id, customer_id, event_type, title, description, created_by)
  SELECT _org, _stay.customer_id, 'stay', 'Checked out',
    'Room ' || COALESCE(_room.room_number,'') || ' · folio ' || COALESCE(_f.folio_number,'—'), auth.uid()
  WHERE _stay.customer_id IS NOT NULL;

  INSERT INTO public.audit_logs (organization_id, user_id, user_name, action, module, record_id, new_value, reason)
  VALUES (_org, auth.uid(), '', 'pms.checkout', 'front-office', _reservation::text,
    jsonb_build_object('stay_id',_stay.id,'folio_id',_f.id,'balance',_f.balance), _notes);

  RETURN jsonb_build_object('stay_id',_stay.id,'folio_id',_f.id,'idempotent',false);
END; $$;

-- ============ FRONT OFFICE METRICS ============
CREATE OR REPLACE FUNCTION public.pms_front_office_metrics(_branch uuid DEFAULT NULL, _on date DEFAULT current_date)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
  SELECT jsonb_build_object(
    'date', _on,
    'rooms', (SELECT jsonb_build_object(
        'total', count(*),
        'sellable', count(*) FILTER (WHERE sellable AND status='active'),
        'vacant_clean', count(*) FILTER (WHERE room_condition='vacant-clean'),
        'vacant_dirty', count(*) FILTER (WHERE room_condition='vacant-dirty'),
        'occupied', count(*) FILTER (WHERE occupancy_status='occupied'),
        'out_of_order', count(*) FILTER (WHERE room_condition IN ('out-of-order','out-of-service')),
        'maintenance', count(*) FILTER (WHERE room_condition='maintenance'))
      FROM public.rooms WHERE organization_id=public.current_org_id() AND (_branch IS NULL OR branch_id=_branch)),
    'reservations', (SELECT jsonb_build_object(
        'arrivals_today', count(*) FILTER (WHERE arrival_date=_on AND status IN ('confirmed','guaranteed','tentative','pending-deposit')),
        'departures_today', count(*) FILTER (WHERE departure_date=_on AND status='checked-in'),
        'in_house', count(*) FILTER (WHERE status='checked-in'),
        'unassigned', count(*) FILTER (WHERE room_id IS NULL AND status IN ('confirmed','guaranteed') AND departure_date>=_on),
        'vip_arrivals', count(*) FILTER (WHERE arrival_date=_on AND is_vip),
        'corporate_arrivals', count(*) FILTER (WHERE arrival_date=_on AND corporate_account_id IS NOT NULL),
        'group_arrivals', count(*) FILTER (WHERE arrival_date=_on AND group_booking_id IS NOT NULL),
        'no_shows', count(*) FILTER (WHERE status='no-show' AND arrival_date=_on),
        'cancelled', count(*) FILTER (WHERE status='cancelled' AND cancelled_at::date=_on))
      FROM public.reservations WHERE organization_id=public.current_org_id() AND (_branch IS NULL OR branch_id=_branch)),
    'folios', (SELECT jsonb_build_object(
        'open', count(*) FILTER (WHERE status='open'),
        'attention', count(*) FILTER (WHERE status='under-review'),
        'outstanding_balance', COALESCE(sum(balance) FILTER (WHERE status IN ('open','under-review')),0))
      FROM public.folios WHERE organization_id=public.current_org_id() AND (_branch IS NULL OR branch_id=_branch)),
    'requests', (SELECT jsonb_build_object(
        'open', count(*) FILTER (WHERE status NOT IN ('completed','cancelled')),
        'overdue', count(*) FILTER (WHERE due_at < now() AND status NOT IN ('completed','cancelled')))
      FROM public.guest_requests WHERE organization_id=public.current_org_id() AND (_branch IS NULL OR branch_id=_branch)),
    'waitlist', (SELECT count(*) FROM public.waitlist_entries
      WHERE organization_id=public.current_org_id() AND status='waiting' AND (_branch IS NULL OR branch_id=_branch))
  );
$$;
