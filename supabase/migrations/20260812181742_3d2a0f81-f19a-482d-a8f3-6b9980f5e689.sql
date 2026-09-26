-- =========================================================
-- PHASE 7 — RESTAURANT, BAR & POINT OF SALE
-- =========================================================

-- ---------- reference / configuration ----------
CREATE TABLE public.restaurant_areas (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  branch_id uuid REFERENCES public.branches(id) ON DELETE CASCADE,
  name text NOT NULL,
  description text,
  display_order integer NOT NULL DEFAULT 0,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL
);

CREATE TABLE public.restaurant_tables (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  branch_id uuid REFERENCES public.branches(id) ON DELETE CASCADE,
  area_id uuid REFERENCES public.restaurant_areas(id) ON DELETE SET NULL,
  code text NOT NULL,
  name text,
  capacity integer NOT NULL DEFAULT 2,
  shape text NOT NULL DEFAULT 'square',
  pos_x integer NOT NULL DEFAULT 0,
  pos_y integer NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'available',
  assigned_waiter_id uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  notes text,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  UNIQUE (organization_id, branch_id, code),
  CONSTRAINT restaurant_tables_status_chk CHECK (status IN
    ('available','reserved','seated','ordering','in-preparation','partially-served','awaiting-payment','needs-cleaning','blocked','out-of-service'))
);

CREATE TABLE public.table_reservations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  branch_id uuid REFERENCES public.branches(id) ON DELETE CASCADE,
  reference text,
  customer_id uuid REFERENCES public.customers(id) ON DELETE SET NULL,
  contact_name text,
  contact_phone text,
  reserved_from timestamptz NOT NULL,
  reserved_to timestamptz NOT NULL,
  guest_count integer NOT NULL DEFAULT 2,
  area_id uuid REFERENCES public.restaurant_areas(id) ON DELETE SET NULL,
  table_id uuid REFERENCES public.restaurant_tables(id) ON DELETE SET NULL,
  occasion text,
  special_requests text,
  dietary_requirements text,
  status text NOT NULL DEFAULT 'confirmed',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  CONSTRAINT table_reservations_status_chk CHECK (status IN
    ('enquiry','tentative','confirmed','seated','completed','cancelled','no-show'))
);

CREATE TABLE public.menus (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  branch_id uuid REFERENCES public.branches(id) ON DELETE CASCADE,
  name text NOT NULL,
  description text,
  service_type text NOT NULL DEFAULT 'all-day',
  valid_from date,
  valid_to date,
  valid_days integer[] NOT NULL DEFAULT '{0,1,2,3,4,5,6}',
  valid_time_from time,
  valid_time_to time,
  status text NOT NULL DEFAULT 'active',
  display_order integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL
);

CREATE TABLE public.menu_categories (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  menu_id uuid REFERENCES public.menus(id) ON DELETE CASCADE,
  name text NOT NULL,
  description text,
  station_id uuid REFERENCES public.operational_stations(id) ON DELETE SET NULL,
  display_order integer NOT NULL DEFAULT 0,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.menu_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  branch_id uuid REFERENCES public.branches(id) ON DELETE CASCADE,
  category_id uuid REFERENCES public.menu_categories(id) ON DELETE SET NULL,
  name text NOT NULL,
  short_name text,
  description text,
  sku text,
  barcode text,
  base_price numeric(12,2) NOT NULL DEFAULT 0,
  currency text NOT NULL DEFAULT 'KES',
  tax_category text NOT NULL DEFAULT 'standard',
  tax_rate numeric(6,3) NOT NULL DEFAULT 16,
  service_charge_applies boolean NOT NULL DEFAULT true,
  station_id uuid REFERENCES public.operational_stations(id) ON DELETE SET NULL,
  prep_minutes integer NOT NULL DEFAULT 15,
  image_url text,
  availability text NOT NULL DEFAULT 'available',
  available_dine_in boolean NOT NULL DEFAULT true,
  available_room_service boolean NOT NULL DEFAULT true,
  available_takeaway boolean NOT NULL DEFAULT true,
  available_delivery boolean NOT NULL DEFAULT false,
  loyalty_eligible boolean NOT NULL DEFAULT true,
  active_from date,
  active_to date,
  display_order integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  CONSTRAINT menu_items_availability_chk CHECK (availability IN ('available','temporarily-unavailable','sold-out','disabled'))
);

CREATE TABLE public.menu_item_prices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  menu_item_id uuid NOT NULL REFERENCES public.menu_items(id) ON DELETE CASCADE,
  branch_id uuid REFERENCES public.branches(id) ON DELETE CASCADE,
  menu_id uuid REFERENCES public.menus(id) ON DELETE CASCADE,
  order_type text,
  portion text,
  price numeric(12,2) NOT NULL,
  valid_from date,
  valid_to date,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.modifier_groups (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  name text NOT NULL,
  description text,
  required boolean NOT NULL DEFAULT false,
  multi_select boolean NOT NULL DEFAULT false,
  min_select integer NOT NULL DEFAULT 0,
  max_select integer NOT NULL DEFAULT 1,
  station_id uuid REFERENCES public.operational_stations(id) ON DELETE SET NULL,
  display_order integer NOT NULL DEFAULT 0,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.modifier_options (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  group_id uuid NOT NULL REFERENCES public.modifier_groups(id) ON DELETE CASCADE,
  name text NOT NULL,
  extra_charge numeric(12,2) NOT NULL DEFAULT 0,
  display_order integer NOT NULL DEFAULT 0,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.menu_item_modifier_groups (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  menu_item_id uuid NOT NULL REFERENCES public.menu_items(id) ON DELETE CASCADE,
  group_id uuid NOT NULL REFERENCES public.modifier_groups(id) ON DELETE CASCADE,
  display_order integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (menu_item_id, group_id)
);

-- ---------- shifts & cash ----------
CREATE TABLE public.pos_shifts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  branch_id uuid REFERENCES public.branches(id) ON DELETE CASCADE,
  station_id uuid REFERENCES public.operational_stations(id) ON DELETE SET NULL,
  cashier_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  opened_at timestamptz NOT NULL DEFAULT now(),
  opening_float numeric(12,2) NOT NULL DEFAULT 0,
  expected_cash numeric(12,2) NOT NULL DEFAULT 0,
  counted_cash numeric(12,2),
  variance numeric(12,2),
  variance_reason text,
  closed_at timestamptz,
  status text NOT NULL DEFAULT 'open',
  reviewed_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  reviewed_at timestamptz,
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pos_shifts_status_chk CHECK (status IN ('open','pending-closure','closed','variance-review','reopened'))
);

CREATE TABLE public.cash_movements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  shift_id uuid NOT NULL REFERENCES public.pos_shifts(id) ON DELETE CASCADE,
  movement_type text NOT NULL,
  amount numeric(12,2) NOT NULL,
  reason text,
  reference text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  CONSTRAINT cash_movements_type_chk CHECK (movement_type IN ('float-in','cash-sale','paid-out','petty-cash','drop','count','adjustment'))
);

-- ---------- orders ----------
CREATE TABLE public.pos_orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  branch_id uuid REFERENCES public.branches(id) ON DELETE CASCADE,
  order_number text NOT NULL,
  order_type text NOT NULL DEFAULT 'dine-in',
  order_source text NOT NULL DEFAULT 'waiter-pos',
  station_id uuid REFERENCES public.operational_stations(id) ON DELETE SET NULL,
  department_id uuid REFERENCES public.departments(id) ON DELETE SET NULL,
  table_id uuid REFERENCES public.restaurant_tables(id) ON DELETE SET NULL,
  stay_id uuid REFERENCES public.stays(id) ON DELETE SET NULL,
  folio_id uuid REFERENCES public.folios(id) ON DELETE SET NULL,
  room_id uuid REFERENCES public.rooms(id) ON DELETE SET NULL,
  customer_id uuid REFERENCES public.customers(id) ON DELETE SET NULL,
  corporate_account_id uuid REFERENCES public.corporate_accounts(id) ON DELETE SET NULL,
  waiter_id uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  shift_id uuid REFERENCES public.pos_shifts(id) ON DELETE SET NULL,
  guest_count integer NOT NULL DEFAULT 1,
  guest_name text,
  contact_phone text,
  status text NOT NULL DEFAULT 'draft',
  payment_status text NOT NULL DEFAULT 'unpaid',
  folio_post_status text NOT NULL DEFAULT 'not-posted',
  subtotal numeric(12,2) NOT NULL DEFAULT 0,
  discount_total numeric(12,2) NOT NULL DEFAULT 0,
  tax_total numeric(12,2) NOT NULL DEFAULT 0,
  service_charge_total numeric(12,2) NOT NULL DEFAULT 0,
  grand_total numeric(12,2) NOT NULL DEFAULT 0,
  paid_total numeric(12,2) NOT NULL DEFAULT 0,
  currency text NOT NULL DEFAULT 'KES',
  dietary_notes text,
  allergy_alert text,
  notes text,
  sent_at timestamptz,
  served_at timestamptz,
  closed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  UNIQUE (organization_id, order_number),
  CONSTRAINT pos_orders_status_chk CHECK (status IN
    ('draft','held','confirmed','sent','accepted','in-preparation','partially-ready','ready','partially-served','served','awaiting-payment','paid','charged-to-room','credit','closed','cancelled','void-pending','voided')),
  CONSTRAINT pos_orders_payment_status_chk CHECK (payment_status IN ('unpaid','partial','pending','paid','refunded','comp','credit')),
  CONSTRAINT pos_orders_folio_status_chk CHECK (folio_post_status IN ('not-posted','pending','posted','rejected'))
);

CREATE TABLE public.pos_order_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  order_id uuid NOT NULL REFERENCES public.pos_orders(id) ON DELETE CASCADE,
  menu_item_id uuid REFERENCES public.menu_items(id) ON DELETE SET NULL,
  station_id uuid REFERENCES public.operational_stations(id) ON DELETE SET NULL,
  item_name text NOT NULL,
  item_description text,
  course text NOT NULL DEFAULT 'main',
  quantity numeric(10,3) NOT NULL DEFAULT 1,
  unit_price numeric(12,2) NOT NULL DEFAULT 0,
  modifier_total numeric(12,2) NOT NULL DEFAULT 0,
  discount_amount numeric(12,2) NOT NULL DEFAULT 0,
  tax_rate numeric(6,3) NOT NULL DEFAULT 0,
  tax_amount numeric(12,2) NOT NULL DEFAULT 0,
  line_total numeric(12,2) NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'draft',
  special_instructions text,
  allergy_note text,
  held boolean NOT NULL DEFAULT false,
  sent_at timestamptz,
  ready_at timestamptz,
  served_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  CONSTRAINT pos_order_items_status_chk CHECK (status IN
    ('draft','sent','accepted','preparing','ready','served','cancel-pending','cancelled','voided'))
);

CREATE TABLE public.pos_order_item_modifiers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  order_item_id uuid NOT NULL REFERENCES public.pos_order_items(id) ON DELETE CASCADE,
  group_id uuid REFERENCES public.modifier_groups(id) ON DELETE SET NULL,
  option_id uuid REFERENCES public.modifier_options(id) ON DELETE SET NULL,
  group_name text NOT NULL,
  option_name text NOT NULL,
  extra_charge numeric(12,2) NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.pos_order_status_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  order_id uuid REFERENCES public.pos_orders(id) ON DELETE CASCADE,
  order_item_id uuid REFERENCES public.pos_order_items(id) ON DELETE CASCADE,
  previous_status text,
  new_status text NOT NULL,
  station_id uuid REFERENCES public.operational_stations(id) ON DELETE SET NULL,
  reason text,
  changed_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.station_tickets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  branch_id uuid REFERENCES public.branches(id) ON DELETE CASCADE,
  order_id uuid NOT NULL REFERENCES public.pos_orders(id) ON DELETE CASCADE,
  station_id uuid REFERENCES public.operational_stations(id) ON DELETE SET NULL,
  ticket_number text,
  course text NOT NULL DEFAULT 'main',
  priority text NOT NULL DEFAULT 'normal',
  status text NOT NULL DEFAULT 'new',
  target_minutes integer NOT NULL DEFAULT 15,
  delay_reason text,
  accepted_at timestamptz,
  started_at timestamptz,
  ready_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT station_tickets_status_chk CHECK (status IN ('new','accepted','preparing','ready','delayed','cancelled','served'))
);

CREATE TABLE public.station_ticket_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  ticket_id uuid NOT NULL REFERENCES public.station_tickets(id) ON DELETE CASCADE,
  order_item_id uuid NOT NULL REFERENCES public.pos_order_items(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (ticket_id, order_item_id)
);

-- ---------- money ----------
CREATE TABLE public.pos_payments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  branch_id uuid REFERENCES public.branches(id) ON DELETE CASCADE,
  order_id uuid NOT NULL REFERENCES public.pos_orders(id) ON DELETE CASCADE,
  receipt_number text,
  customer_id uuid REFERENCES public.customers(id) ON DELETE SET NULL,
  amount numeric(12,2) NOT NULL,
  tendered numeric(12,2),
  change_due numeric(12,2) NOT NULL DEFAULT 0,
  currency text NOT NULL DEFAULT 'KES',
  method text NOT NULL,
  external_reference text,
  provider_status text,
  provider_payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'initiated',
  paid_at timestamptz,
  cashier_id uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  shift_id uuid REFERENCES public.pos_shifts(id) ON DELETE SET NULL,
  verified_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  verification_note text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  CONSTRAINT pos_payments_status_chk CHECK (status IN ('initiated','pending','confirmed','failed','cancelled','reversed','refunded')),
  CONSTRAINT pos_payments_method_chk CHECK (method IN ('cash','mpesa','debit-card','credit-card','bank-transfer','corporate-credit','room-charge','complimentary','other'))
);
CREATE UNIQUE INDEX pos_payments_external_ref_uidx
  ON public.pos_payments (organization_id, method, external_reference)
  WHERE external_reference IS NOT NULL;

CREATE TABLE public.pos_void_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  branch_id uuid REFERENCES public.branches(id) ON DELETE CASCADE,
  order_id uuid NOT NULL REFERENCES public.pos_orders(id) ON DELETE CASCADE,
  order_item_id uuid REFERENCES public.pos_order_items(id) ON DELETE CASCADE,
  request_kind text NOT NULL DEFAULT 'item',
  amount numeric(12,2) NOT NULL DEFAULT 0,
  reason text NOT NULL,
  preparation_status text,
  inventory_effect text NOT NULL DEFAULT 'none',
  status text NOT NULL DEFAULT 'pending',
  requested_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  decided_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  decided_at timestamptz,
  decision_note text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pos_void_status_chk CHECK (status IN ('pending','approved','rejected','applied','cancelled')),
  CONSTRAINT pos_void_kind_chk CHECK (request_kind IN ('item','bill','complimentary','discount'))
);

CREATE TABLE public.pos_refund_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  branch_id uuid REFERENCES public.branches(id) ON DELETE CASCADE,
  order_id uuid NOT NULL REFERENCES public.pos_orders(id) ON DELETE CASCADE,
  payment_id uuid NOT NULL REFERENCES public.pos_payments(id) ON DELETE CASCADE,
  amount numeric(12,2) NOT NULL,
  method text,
  reason text NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  requested_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  decided_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  decided_at timestamptz,
  decision_note text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pos_refund_status_chk CHECK (status IN ('pending','approved','rejected','processed'))
);

CREATE TABLE public.pos_discounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  branch_id uuid REFERENCES public.branches(id) ON DELETE CASCADE,
  name text NOT NULL,
  scope text NOT NULL DEFAULT 'bill',
  discount_type text NOT NULL DEFAULT 'percentage',
  value numeric(12,2) NOT NULL DEFAULT 0,
  max_value numeric(12,2),
  order_types text[] NOT NULL DEFAULT '{}',
  valid_from date,
  valid_to date,
  valid_time_from time,
  valid_time_to time,
  requires_approval boolean NOT NULL DEFAULT true,
  combinable boolean NOT NULL DEFAULT false,
  customer_eligibility text NOT NULL DEFAULT 'all',
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pos_discounts_type_chk CHECK (discount_type IN ('percentage','fixed','promotional-price','happy-hour','loyalty','complimentary'))
);

CREATE TABLE public.bar_tabs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  branch_id uuid REFERENCES public.branches(id) ON DELETE CASCADE,
  station_id uuid REFERENCES public.operational_stations(id) ON DELETE SET NULL,
  tab_number text,
  customer_id uuid REFERENCES public.customers(id) ON DELETE SET NULL,
  table_id uuid REFERENCES public.restaurant_tables(id) ON DELETE SET NULL,
  stay_id uuid REFERENCES public.stays(id) ON DELETE SET NULL,
  display_name text,
  responsible_staff_id uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  opened_at timestamptz NOT NULL DEFAULT now(),
  closed_at timestamptz,
  running_balance numeric(12,2) NOT NULL DEFAULT 0,
  credit_limit numeric(12,2),
  status text NOT NULL DEFAULT 'open',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  CONSTRAINT bar_tabs_status_chk CHECK (status IN ('open','awaiting-payment','closed','void'))
);

-- ---------- support ----------
CREATE TABLE public.printer_profiles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  branch_id uuid REFERENCES public.branches(id) ON DELETE CASCADE,
  name text NOT NULL,
  printer_role text NOT NULL DEFAULT 'receipt',
  station_id uuid REFERENCES public.operational_stations(id) ON DELETE SET NULL,
  connection_type text NOT NULL DEFAULT 'browser',
  address text,
  status text NOT NULL DEFAULT 'not-configured',
  last_checked_at timestamptz,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT printer_profiles_status_chk CHECK (status IN ('connected','not-configured','offline','error'))
);

CREATE TABLE public.print_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  printer_id uuid REFERENCES public.printer_profiles(id) ON DELETE SET NULL,
  order_id uuid REFERENCES public.pos_orders(id) ON DELETE CASCADE,
  document_type text NOT NULL,
  is_duplicate boolean NOT NULL DEFAULT false,
  status text NOT NULL DEFAULT 'queued',
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL
);

CREATE TABLE public.recipes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  menu_item_id uuid NOT NULL REFERENCES public.menu_items(id) ON DELETE CASCADE,
  version integer NOT NULL DEFAULT 1,
  yield_quantity numeric(10,3) NOT NULL DEFAULT 1,
  waste_allowance numeric(6,3) NOT NULL DEFAULT 0,
  station_id uuid REFERENCES public.operational_stations(id) ON DELETE SET NULL,
  effective_from date NOT NULL DEFAULT CURRENT_DATE,
  status text NOT NULL DEFAULT 'active',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  UNIQUE (menu_item_id, version)
);

CREATE TABLE public.recipe_ingredients (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  recipe_id uuid NOT NULL REFERENCES public.recipes(id) ON DELETE CASCADE,
  ingredient_name text NOT NULL,
  quantity numeric(12,4) NOT NULL,
  unit text NOT NULL DEFAULT 'g',
  unit_cost numeric(12,4),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.inventory_posting_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  branch_id uuid REFERENCES public.branches(id) ON DELETE CASCADE,
  order_id uuid REFERENCES public.pos_orders(id) ON DELETE CASCADE,
  order_item_id uuid REFERENCES public.pos_order_items(id) ON DELETE CASCADE,
  recipe_id uuid REFERENCES public.recipes(id) ON DELETE SET NULL,
  recipe_version integer,
  posting_type text NOT NULL DEFAULT 'deduction',
  idempotency_key text NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  cost_snapshot numeric(12,4),
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, idempotency_key),
  CONSTRAINT inventory_posting_status_chk CHECK (status IN ('pending','posted','reversed','skipped','failed'))
);

CREATE TABLE public.pos_settings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  branch_id uuid REFERENCES public.branches(id) ON DELETE CASCADE,
  settings jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, branch_id)
);

-- ---------- indexes ----------
CREATE INDEX pos_orders_org_branch_idx ON public.pos_orders (organization_id, branch_id, created_at DESC);
CREATE INDEX pos_orders_status_idx ON public.pos_orders (organization_id, status);
CREATE INDEX pos_order_items_order_idx ON public.pos_order_items (order_id);
CREATE INDEX pos_order_items_station_idx ON public.pos_order_items (organization_id, station_id, status);
CREATE INDEX station_tickets_queue_idx ON public.station_tickets (organization_id, station_id, status, created_at);
CREATE INDEX pos_payments_order_idx ON public.pos_payments (order_id);
CREATE INDEX restaurant_tables_branch_idx ON public.restaurant_tables (organization_id, branch_id, status);
CREATE INDEX menu_items_org_cat_idx ON public.menu_items (organization_id, category_id, availability);
CREATE INDEX table_reservations_window_idx ON public.table_reservations (organization_id, table_id, reserved_from, reserved_to);

-- ---------- updated_at triggers ----------
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'restaurant_areas','restaurant_tables','table_reservations','menus','menu_categories','menu_items',
    'menu_item_prices','modifier_groups','modifier_options','menu_item_modifier_groups','pos_shifts',
    'cash_movements','pos_orders','pos_order_items','pos_order_item_modifiers','station_tickets',
    'pos_payments','pos_void_requests','pos_refund_requests','pos_discounts','bar_tabs','printer_profiles',
    'print_jobs','recipes','recipe_ingredients','inventory_posting_events','pos_settings'
  ] LOOP
    EXECUTE format(
      'CREATE TRIGGER %I BEFORE UPDATE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at()',
      'set_updated_at_' || t, t);
  END LOOP;
END $$;

-- ---------- grants + RLS ----------
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'restaurant_areas','restaurant_tables','table_reservations','menus','menu_categories','menu_items',
    'menu_item_prices','modifier_groups','modifier_options','menu_item_modifier_groups','pos_shifts',
    'cash_movements','pos_orders','pos_order_items','pos_order_item_modifiers','pos_order_status_history',
    'station_tickets','station_ticket_items','pos_payments','pos_void_requests','pos_refund_requests',
    'pos_discounts','bar_tabs','printer_profiles','print_jobs','recipes','recipe_ingredients',
    'inventory_posting_events','pos_settings'
  ] LOOP
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON public.%I TO authenticated', t);
    EXECUTE format('GRANT ALL ON public.%I TO service_role', t);
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY %I ON public.%I FOR SELECT TO authenticated USING (organization_id = public.current_org_id())',
      t || '_select', t);
  END LOOP;
END $$;

-- write policies: catalogue/config requires pos manage permissions
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'restaurant_areas','restaurant_tables','menus','menu_categories','menu_items','menu_item_prices',
    'modifier_groups','modifier_options','menu_item_modifier_groups','pos_discounts','printer_profiles',
    'recipes','recipe_ingredients','pos_settings'
  ] LOOP
    EXECUTE format(
      'CREATE POLICY %I ON public.%I FOR ALL TO authenticated USING (organization_id = public.current_org_id() AND (public.has_permission(''pos'',''menu.manage'') OR public.has_permission(''pos'',''settings.manage'') OR public.has_permission(''pos'',''tables.manage''))) WITH CHECK (organization_id = public.current_org_id() AND (public.has_permission(''pos'',''menu.manage'') OR public.has_permission(''pos'',''settings.manage'') OR public.has_permission(''pos'',''tables.manage'')))',
      t || '_manage', t);
  END LOOP;
END $$;

-- operational write policies
CREATE POLICY table_reservations_write ON public.table_reservations FOR ALL TO authenticated
  USING (organization_id = public.current_org_id() AND public.has_permission('pos','tables.view'))
  WITH CHECK (organization_id = public.current_org_id() AND public.has_permission('pos','tables.view'));

CREATE POLICY pos_orders_write ON public.pos_orders FOR ALL TO authenticated
  USING (organization_id = public.current_org_id() AND public.has_permission('pos','orders.create'))
  WITH CHECK (organization_id = public.current_org_id() AND public.has_permission('pos','orders.create'));

CREATE POLICY pos_order_items_write ON public.pos_order_items FOR ALL TO authenticated
  USING (organization_id = public.current_org_id() AND (public.has_permission('pos','orders.create') OR public.has_permission('pos','kds.view')))
  WITH CHECK (organization_id = public.current_org_id() AND (public.has_permission('pos','orders.create') OR public.has_permission('pos','kds.view')));

CREATE POLICY pos_order_item_modifiers_write ON public.pos_order_item_modifiers FOR ALL TO authenticated
  USING (organization_id = public.current_org_id() AND public.has_permission('pos','orders.create'))
  WITH CHECK (organization_id = public.current_org_id() AND public.has_permission('pos','orders.create'));

CREATE POLICY pos_order_status_history_insert ON public.pos_order_status_history FOR INSERT TO authenticated
  WITH CHECK (organization_id = public.current_org_id());

CREATE POLICY station_tickets_write ON public.station_tickets FOR ALL TO authenticated
  USING (organization_id = public.current_org_id() AND (public.has_permission('pos','kds.view') OR public.has_permission('pos','orders.create')))
  WITH CHECK (organization_id = public.current_org_id() AND (public.has_permission('pos','kds.view') OR public.has_permission('pos','orders.create')));

CREATE POLICY station_ticket_items_write ON public.station_ticket_items FOR ALL TO authenticated
  USING (organization_id = public.current_org_id() AND (public.has_permission('pos','kds.view') OR public.has_permission('pos','orders.create')))
  WITH CHECK (organization_id = public.current_org_id() AND (public.has_permission('pos','kds.view') OR public.has_permission('pos','orders.create')));

CREATE POLICY pos_payments_write ON public.pos_payments FOR ALL TO authenticated
  USING (organization_id = public.current_org_id() AND public.has_permission('pos','payments.process'))
  WITH CHECK (organization_id = public.current_org_id() AND public.has_permission('pos','payments.process'));

CREATE POLICY pos_void_requests_insert ON public.pos_void_requests FOR INSERT TO authenticated
  WITH CHECK (organization_id = public.current_org_id() AND public.has_permission('pos','voids.request') AND requested_by = auth.uid());
CREATE POLICY pos_void_requests_decide ON public.pos_void_requests FOR UPDATE TO authenticated
  USING (organization_id = public.current_org_id() AND public.has_permission('pos','voids.approve') AND requested_by IS DISTINCT FROM auth.uid())
  WITH CHECK (organization_id = public.current_org_id() AND requested_by IS DISTINCT FROM auth.uid());

CREATE POLICY pos_refund_requests_insert ON public.pos_refund_requests FOR INSERT TO authenticated
  WITH CHECK (organization_id = public.current_org_id() AND public.has_permission('pos','refunds.request') AND requested_by = auth.uid());
CREATE POLICY pos_refund_requests_decide ON public.pos_refund_requests FOR UPDATE TO authenticated
  USING (organization_id = public.current_org_id() AND public.has_permission('pos','refunds.approve') AND requested_by IS DISTINCT FROM auth.uid())
  WITH CHECK (organization_id = public.current_org_id() AND requested_by IS DISTINCT FROM auth.uid());

CREATE POLICY bar_tabs_write ON public.bar_tabs FOR ALL TO authenticated
  USING (organization_id = public.current_org_id() AND public.has_permission('pos','orders.create'))
  WITH CHECK (organization_id = public.current_org_id() AND public.has_permission('pos','orders.create'));

CREATE POLICY pos_shifts_open ON public.pos_shifts FOR INSERT TO authenticated
  WITH CHECK (organization_id = public.current_org_id() AND public.has_permission('pos','shifts.open') AND cashier_id = auth.uid());
CREATE POLICY pos_shifts_update ON public.pos_shifts FOR UPDATE TO authenticated
  USING (organization_id = public.current_org_id() AND (public.has_permission('pos','shifts.close') OR public.has_permission('pos','shifts.review')))
  WITH CHECK (organization_id = public.current_org_id());

CREATE POLICY cash_movements_write ON public.cash_movements FOR ALL TO authenticated
  USING (organization_id = public.current_org_id() AND public.has_permission('pos','shifts.open'))
  WITH CHECK (organization_id = public.current_org_id() AND public.has_permission('pos','shifts.open'));

CREATE POLICY print_jobs_write ON public.print_jobs FOR ALL TO authenticated
  USING (organization_id = public.current_org_id() AND public.has_permission('pos','receipts.print'))
  WITH CHECK (organization_id = public.current_org_id() AND public.has_permission('pos','receipts.print'));

CREATE POLICY inventory_posting_events_insert ON public.inventory_posting_events FOR INSERT TO authenticated
  WITH CHECK (organization_id = public.current_org_id());

-- ---------- POS permissions catalogue ----------
INSERT INTO public.permissions (module, action, label) VALUES
  ('pos','access','POS Access'),
  ('pos','orders.view','View Orders'),
  ('pos','orders.create','Create Orders'),
  ('pos','orders.edit_draft','Edit Draft Orders'),
  ('pos','orders.send','Send Orders to Stations'),
  ('pos','orders.hold','Hold Orders'),
  ('pos','orders.transfer','Transfer Orders'),
  ('pos','orders.cancel_item','Cancel Order Item'),
  ('pos','tables.view','View Tables'),
  ('pos','tables.manage','Manage Tables'),
  ('pos','bills.view','View Bills'),
  ('pos','bills.split','Split Bills'),
  ('pos','bills.merge','Merge Bills'),
  ('pos','bills.transfer','Transfer Bills'),
  ('pos','bills.reopen','Reopen Bills'),
  ('pos','room_charge.post','Post Room Charges'),
  ('pos','payments.view','View Payments'),
  ('pos','payments.process','Process Payments'),
  ('pos','payments.verify','Verify Payments'),
  ('pos','discounts.request','Request Discounts'),
  ('pos','discounts.approve','Approve Discounts'),
  ('pos','complimentary.request','Request Complimentary'),
  ('pos','complimentary.approve','Approve Complimentary'),
  ('pos','voids.request','Request Voids'),
  ('pos','voids.approve','Approve Voids'),
  ('pos','refunds.request','Request Refunds'),
  ('pos','refunds.approve','Approve Refunds'),
  ('pos','menu.view','View Menu'),
  ('pos','menu.manage','Manage Menu'),
  ('pos','pricing.manage','Manage Pricing'),
  ('pos','kds.view','View Kitchen Display'),
  ('pos','kds.manage','Manage Kitchen Display'),
  ('pos','shifts.open','Open Cashier Shift'),
  ('pos','shifts.close','Close Cashier Shift'),
  ('pos','shifts.review','Review Cashier Shift'),
  ('pos','receipts.print','Print Receipts'),
  ('pos','receipts.reprint','Reprint Receipts'),
  ('pos','reports.view','View POS Reports'),
  ('pos','reports.export','Export POS Reports'),
  ('pos','settings.manage','Manage POS Settings')
ON CONFLICT (module, action) DO NOTHING;

-- ---------- server-side status transition guard ----------
CREATE OR REPLACE FUNCTION public.pos_enforce_order_status()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE allowed text[];
BEGIN
  IF NEW.status = OLD.status THEN RETURN NEW; END IF;
  allowed := CASE OLD.status
    WHEN 'draft' THEN ARRAY['held','confirmed','cancelled']
    WHEN 'held' THEN ARRAY['draft','confirmed','cancelled']
    WHEN 'confirmed' THEN ARRAY['sent','cancelled']
    WHEN 'sent' THEN ARRAY['accepted','in-preparation','partially-ready','ready','cancelled','void-pending']
    WHEN 'accepted' THEN ARRAY['in-preparation','partially-ready','ready','void-pending']
    WHEN 'in-preparation' THEN ARRAY['partially-ready','ready','void-pending']
    WHEN 'partially-ready' THEN ARRAY['ready','partially-served','void-pending']
    WHEN 'ready' THEN ARRAY['partially-served','served','void-pending']
    WHEN 'partially-served' THEN ARRAY['served','awaiting-payment','void-pending']
    WHEN 'served' THEN ARRAY['awaiting-payment','void-pending']
    WHEN 'awaiting-payment' THEN ARRAY['paid','charged-to-room','credit','void-pending']
    WHEN 'paid' THEN ARRAY['closed','void-pending']
    WHEN 'charged-to-room' THEN ARRAY['closed','void-pending']
    WHEN 'credit' THEN ARRAY['closed','void-pending']
    WHEN 'closed' THEN ARRAY['awaiting-payment']
    WHEN 'void-pending' THEN ARRAY['voided','served','awaiting-payment']
    ELSE ARRAY[]::text[]
  END;
  IF NOT (NEW.status = ANY(allowed)) THEN
    RAISE EXCEPTION 'Invalid order status transition % -> %', OLD.status, NEW.status;
  END IF;
  INSERT INTO public.pos_order_status_history (organization_id, order_id, previous_status, new_status, station_id, changed_by)
  VALUES (NEW.organization_id, NEW.id, OLD.status, NEW.status, NEW.station_id, auth.uid());
  RETURN NEW;
END; $$;
CREATE TRIGGER pos_orders_status_guard BEFORE UPDATE OF status ON public.pos_orders
  FOR EACH ROW EXECUTE FUNCTION public.pos_enforce_order_status();

CREATE OR REPLACE FUNCTION public.pos_enforce_item_status()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE allowed text[];
BEGIN
  IF NEW.status = OLD.status THEN RETURN NEW; END IF;
  allowed := CASE OLD.status
    WHEN 'draft' THEN ARRAY['sent','cancelled']
    WHEN 'sent' THEN ARRAY['accepted','preparing','ready','cancel-pending']
    WHEN 'accepted' THEN ARRAY['preparing','ready','cancel-pending']
    WHEN 'preparing' THEN ARRAY['ready','cancel-pending']
    WHEN 'ready' THEN ARRAY['served','cancel-pending']
    WHEN 'served' THEN ARRAY['cancel-pending']
    WHEN 'cancel-pending' THEN ARRAY['cancelled','voided','served','ready']
    ELSE ARRAY[]::text[]
  END;
  IF NOT (NEW.status = ANY(allowed)) THEN
    RAISE EXCEPTION 'Invalid item status transition % -> %', OLD.status, NEW.status;
  END IF;
  IF NEW.status = 'ready' AND NEW.ready_at IS NULL THEN NEW.ready_at := now(); END IF;
  IF NEW.status = 'served' AND NEW.served_at IS NULL THEN NEW.served_at := now(); END IF;
  INSERT INTO public.pos_order_status_history (organization_id, order_id, order_item_id, previous_status, new_status, station_id, changed_by)
  VALUES (NEW.organization_id, NEW.order_id, NEW.id, OLD.status, NEW.status, NEW.station_id, auth.uid());
  RETURN NEW;
END; $$;
CREATE TRIGGER pos_order_items_status_guard BEFORE UPDATE OF status ON public.pos_order_items
  FOR EACH ROW EXECUTE FUNCTION public.pos_enforce_item_status();

-- roll order readiness up from its items
CREATE OR REPLACE FUNCTION public.pos_rollup_order_status()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE _total int; _ready int; _served int; _order public.pos_orders; _target text;
BEGIN
  SELECT * INTO _order FROM public.pos_orders WHERE id = NEW.order_id;
  IF _order.id IS NULL THEN RETURN NEW; END IF;
  SELECT count(*) FILTER (WHERE status NOT IN ('cancelled','voided','draft')),
         count(*) FILTER (WHERE status IN ('ready','served')),
         count(*) FILTER (WHERE status = 'served')
    INTO _total, _ready, _served
  FROM public.pos_order_items WHERE order_id = NEW.order_id;
  IF _total = 0 THEN RETURN NEW; END IF;
  _target := CASE
    WHEN _served = _total THEN 'served'
    WHEN _served > 0 THEN 'partially-served'
    WHEN _ready = _total THEN 'ready'
    WHEN _ready > 0 THEN 'partially-ready'
    ELSE NULL END;
  IF _target IS NOT NULL AND _target <> _order.status
     AND _order.status IN ('sent','accepted','in-preparation','partially-ready','ready','partially-served') THEN
    UPDATE public.pos_orders SET status = _target,
      served_at = CASE WHEN _target = 'served' THEN now() ELSE served_at END
    WHERE id = _order.id;
  END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER pos_order_items_rollup AFTER UPDATE OF status ON public.pos_order_items
  FOR EACH ROW EXECUTE FUNCTION public.pos_rollup_order_status();

-- prevent overlapping confirmed reservations on the same table
CREATE OR REPLACE FUNCTION public.pos_check_table_reservation_overlap()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NEW.table_id IS NULL OR NEW.status IN ('cancelled','no-show','completed') THEN RETURN NEW; END IF;
  IF EXISTS (
    SELECT 1 FROM public.table_reservations r
    WHERE r.table_id = NEW.table_id AND r.id <> NEW.id
      AND r.status IN ('tentative','confirmed','seated')
      AND tstzrange(r.reserved_from, r.reserved_to, '[)') && tstzrange(NEW.reserved_from, NEW.reserved_to, '[)')
  ) THEN
    RAISE EXCEPTION 'Table already reserved for an overlapping period';
  END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER table_reservations_overlap BEFORE INSERT OR UPDATE ON public.table_reservations
  FOR EACH ROW EXECUTE FUNCTION public.pos_check_table_reservation_overlap();

-- ---------- secure room-charge posting (idempotent) ----------
CREATE OR REPLACE FUNCTION public.pos_post_room_charge(_order_id uuid, _folio_id uuid, _idempotency_key text)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE _org uuid := public.current_org_id(); _order public.pos_orders; _folio public.folios; _line uuid;
BEGIN
  IF NOT public.has_permission('pos','room_charge.post') THEN
    RAISE EXCEPTION 'Not permitted to post room charges';
  END IF;
  SELECT * INTO _order FROM public.pos_orders WHERE id = _order_id AND organization_id = _org;
  IF _order.id IS NULL THEN RAISE EXCEPTION 'Order not found'; END IF;
  IF _order.folio_post_status = 'posted' THEN RAISE EXCEPTION 'Order already posted to a folio'; END IF;
  IF _order.status NOT IN ('served','awaiting-payment','partially-served') THEN
    RAISE EXCEPTION 'Bill is not finalised for posting';
  END IF;

  SELECT * INTO _folio FROM public.folios WHERE id = _folio_id AND organization_id = _org;
  IF _folio.id IS NULL THEN RAISE EXCEPTION 'Folio not found'; END IF;
  IF _folio.status <> 'open' THEN RAISE EXCEPTION 'Folio is not open'; END IF;

  IF EXISTS (SELECT 1 FROM public.folio_lines WHERE organization_id = _org AND idempotency_key = _idempotency_key) THEN
    RAISE EXCEPTION 'Duplicate room charge blocked';
  END IF;

  INSERT INTO public.folio_lines (organization_id, branch_id, folio_id, line_type, category, source_module,
                                  source_record_id, idempotency_key, description, quantity, unit_price,
                                  gross_amount, tax_amount, net_amount, posted_by)
  VALUES (_org, _order.branch_id, _folio_id, 'charge', 'food-beverage', 'pos',
          _order_id, _idempotency_key,
          'POS ' || _order.order_number || ' (' || _order.order_type || ')',
          1, _order.grand_total, _order.grand_total, _order.tax_total, _order.grand_total, auth.uid())
  RETURNING id INTO _line;

  UPDATE public.pos_orders
     SET folio_post_status = 'posted', folio_id = _folio_id, payment_status = 'paid',
         status = 'charged-to-room', closed_at = now()
   WHERE id = _order_id;

  PERFORM public.emit_domain_event(_org, _order.branch_id, 'pos.room_charge.posted', 'pos', _order_id,
    jsonb_build_object('orderId', _order_id, 'folioId', _folio_id, 'amount', _order.grand_total),
    _idempotency_key, _order.customer_id);

  INSERT INTO public.audit_logs (organization_id, branch_id, user_id, action, module, record_id, new_value)
  VALUES (_org, _order.branch_id, auth.uid(), 'pos.room_charge.post', 'pos', _order_id,
          jsonb_build_object('folioId', _folio_id, 'amount', _order.grand_total));

  RETURN _line;
END; $$;
GRANT EXECUTE ON FUNCTION public.pos_post_room_charge(uuid, uuid, text) TO authenticated;

-- ---------- realtime ----------
ALTER PUBLICATION supabase_realtime ADD TABLE public.pos_orders;
ALTER PUBLICATION supabase_realtime ADD TABLE public.pos_order_items;
ALTER PUBLICATION supabase_realtime ADD TABLE public.station_tickets;
ALTER PUBLICATION supabase_realtime ADD TABLE public.restaurant_tables;