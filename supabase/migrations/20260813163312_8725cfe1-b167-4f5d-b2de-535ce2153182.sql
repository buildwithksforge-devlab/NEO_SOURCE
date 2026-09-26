-- =========================================================
-- PHASE 14 — DELIVERY PLATFORM & CUSTOMER ORDERING
-- =========================================================

-- ---------- helper: rider identity ----------
CREATE OR REPLACE FUNCTION public.touch_updated_at()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END; $$;

-- ---------- delivery_settings ----------
CREATE TABLE public.delivery_settings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  branch_id uuid,
  delivery_enabled boolean NOT NULL DEFAULT true,
  pickup_enabled boolean NOT NULL DEFAULT true,
  scheduled_orders_enabled boolean NOT NULL DEFAULT true,
  cod_enabled boolean NOT NULL DEFAULT true,
  cod_limit numeric NOT NULL DEFAULT 5000,
  min_order numeric NOT NULL DEFAULT 0,
  order_lead_minutes integer NOT NULL DEFAULT 30,
  max_schedule_days integer NOT NULL DEFAULT 7,
  prep_buffer_minutes integer NOT NULL DEFAULT 10,
  cancellation_window_minutes integer NOT NULL DEFAULT 5,
  rider_capacity integer NOT NULL DEFAULT 3,
  pod_method text NOT NULL DEFAULT 'pin',
  gps_tracking_enabled boolean NOT NULL DEFAULT false,
  location_retention_days integer NOT NULL DEFAULT 7,
  stock_deduction_point text NOT NULL DEFAULT 'order-accepted',
  auto_accept_paid boolean NOT NULL DEFAULT false,
  feedback_delay_minutes integer NOT NULL DEFAULT 60,
  allowed_payment_methods text[] NOT NULL DEFAULT ARRAY['cash','mpesa'],
  failed_delivery_policy text NOT NULL DEFAULT 'dispatch-review',
  promotion_approval_required boolean NOT NULL DEFAULT true,
  settings jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT delivery_settings_scope_uq UNIQUE (organization_id, branch_id),
  CONSTRAINT delivery_settings_pod_chk CHECK (pod_method IN ('pin','confirmation','signature','photo')),
  CONSTRAINT delivery_settings_deduct_chk CHECK (stock_deduction_point IN ('order-accepted','kitchen-start','order-completed'))
);

-- ---------- delivery_zones ----------
CREATE TABLE public.delivery_zones (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  branch_id uuid,
  name text NOT NULL,
  description text NOT NULL DEFAULT '',
  areas text[] NOT NULL DEFAULT '{}',
  min_order numeric NOT NULL DEFAULT 0,
  base_fee numeric NOT NULL DEFAULT 0,
  distance_fee_per_km numeric NOT NULL DEFAULT 0,
  free_delivery_threshold numeric,
  eta_minutes integer NOT NULL DEFAULT 45,
  max_distance_km numeric,
  service_start time NOT NULL DEFAULT '08:00',
  service_end time NOT NULL DEFAULT '22:00',
  active boolean NOT NULL DEFAULT true,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT delivery_zones_name_uq UNIQUE (organization_id, branch_id, name)
);

-- ---------- carts ----------
CREATE TABLE public.carts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  branch_id uuid,
  customer_id uuid NOT NULL REFERENCES public.customers(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'active',
  fulfilment_type text NOT NULL DEFAULT 'delivery',
  address_id uuid REFERENCES public.customer_addresses(id) ON DELETE SET NULL,
  zone_id uuid REFERENCES public.delivery_zones(id) ON DELETE SET NULL,
  promo_code text,
  tip_amount numeric NOT NULL DEFAULT 0,
  scheduled_for timestamptz,
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT carts_status_chk CHECK (status IN ('active','converted','abandoned')),
  CONSTRAINT carts_fulfilment_chk CHECK (fulfilment_type IN ('delivery','pickup'))
);
CREATE UNIQUE INDEX carts_one_active_per_customer ON public.carts (customer_id) WHERE status = 'active';

CREATE TABLE public.cart_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  cart_id uuid NOT NULL REFERENCES public.carts(id) ON DELETE CASCADE,
  menu_item_id uuid NOT NULL REFERENCES public.menu_items(id) ON DELETE CASCADE,
  quantity numeric NOT NULL DEFAULT 1 CHECK (quantity > 0),
  special_instructions text,
  allergy_note text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX cart_items_cart_idx ON public.cart_items (cart_id);

CREATE TABLE public.cart_item_modifiers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  cart_item_id uuid NOT NULL REFERENCES public.cart_items(id) ON DELETE CASCADE,
  group_id uuid,
  option_id uuid,
  group_name text NOT NULL,
  option_name text NOT NULL,
  extra_charge numeric NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX cart_item_modifiers_item_idx ON public.cart_item_modifiers (cart_item_id);

-- ---------- rider profiles ----------
CREATE TABLE public.rider_profiles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  branch_id uuid,
  employee_id uuid REFERENCES public.employees(id) ON DELETE SET NULL,
  profile_id uuid,
  rider_code text NOT NULL,
  display_name text NOT NULL,
  work_phone text,
  vehicle_type text NOT NULL DEFAULT 'motorcycle',
  vehicle_registration text,
  licence_reference text,
  zone_ids uuid[] NOT NULL DEFAULT '{}',
  max_active_deliveries integer NOT NULL DEFAULT 3,
  cash_handling_allowed boolean NOT NULL DEFAULT true,
  availability_status text NOT NULL DEFAULT 'offline',
  active boolean NOT NULL DEFAULT true,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT rider_profiles_code_uq UNIQUE (organization_id, rider_code),
  CONSTRAINT rider_profiles_availability_chk CHECK (availability_status IN ('offline','available','reserved','assigned','collecting','delivering','on-break','unavailable','shift-ended'))
);

CREATE TABLE public.rider_availability_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  rider_id uuid NOT NULL REFERENCES public.rider_profiles(id) ON DELETE CASCADE,
  previous_status text,
  new_status text NOT NULL,
  reason text,
  changed_by uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- ---------- delivery orders ----------
CREATE TABLE public.delivery_orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  branch_id uuid,
  pos_order_id uuid NOT NULL REFERENCES public.pos_orders(id) ON DELETE CASCADE,
  customer_id uuid NOT NULL REFERENCES public.customers(id) ON DELETE RESTRICT,
  auth_user_id uuid,
  order_number text NOT NULL,
  order_channel text NOT NULL DEFAULT 'customer-web',
  fulfilment_type text NOT NULL DEFAULT 'delivery',
  contact_name text NOT NULL DEFAULT '',
  contact_phone text NOT NULL DEFAULT '',
  address_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
  zone_id uuid REFERENCES public.delivery_zones(id) ON DELETE SET NULL,
  latitude numeric,
  longitude numeric,
  subtotal numeric NOT NULL DEFAULT 0,
  tax_total numeric NOT NULL DEFAULT 0,
  discount_total numeric NOT NULL DEFAULT 0,
  delivery_fee numeric NOT NULL DEFAULT 0,
  tip_amount numeric NOT NULL DEFAULT 0,
  grand_total numeric NOT NULL DEFAULT 0,
  currency text NOT NULL DEFAULT 'KES',
  payment_method text NOT NULL DEFAULT 'cash',
  payment_status text NOT NULL DEFAULT 'unpaid',
  promo_code text,
  promotion_id uuid,
  scheduled_for timestamptz,
  requested_at timestamptz NOT NULL DEFAULT now(),
  estimated_prep_minutes integer NOT NULL DEFAULT 20,
  estimated_delivery_at timestamptz,
  order_status text NOT NULL DEFAULT 'pending-payment',
  kitchen_status text NOT NULL DEFAULT 'not-sent',
  dispatch_status text NOT NULL DEFAULT 'awaiting-kitchen',
  rider_id uuid REFERENCES public.rider_profiles(id) ON DELETE SET NULL,
  accepted_at timestamptz,
  ready_at timestamptz,
  collected_at timestamptz,
  delivered_at timestamptz,
  cancelled_at timestamptz,
  cancellation_reason text,
  rejection_reason text,
  packaging_checklist jsonb NOT NULL DEFAULT '{}'::jsonb,
  packaging_completed_at timestamptz,
  notes text,
  allergy_note text,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT delivery_orders_number_uq UNIQUE (organization_id, order_number),
  CONSTRAINT delivery_orders_pos_uq UNIQUE (pos_order_id),
  CONSTRAINT delivery_orders_fulfilment_chk CHECK (fulfilment_type IN ('delivery','pickup')),
  CONSTRAINT delivery_orders_status_chk CHECK (order_status IN ('draft','pending-payment','payment-verification','confirmed','rejected','in-preparation','ready-for-pickup','rider-assigned','collected','out-for-delivery','delivered','completion-disputed','cancelled','failed','refunded','closed')),
  CONSTRAINT delivery_orders_kitchen_chk CHECK (kitchen_status IN ('not-sent','new','accepted','preparing','ready','completed','cancelled')),
  CONSTRAINT delivery_orders_dispatch_chk CHECK (dispatch_status IN ('awaiting-kitchen','awaiting-rider','rider-assigned','pickup-pending','collected','en-route','delivered','delivery-failed','returned'))
);
CREATE INDEX delivery_orders_org_idx ON public.delivery_orders (organization_id, created_at DESC);
CREATE INDEX delivery_orders_customer_idx ON public.delivery_orders (customer_id, created_at DESC);
CREATE INDEX delivery_orders_rider_idx ON public.delivery_orders (rider_id);

CREATE TABLE public.delivery_order_status_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  delivery_order_id uuid NOT NULL REFERENCES public.delivery_orders(id) ON DELETE CASCADE,
  status_kind text NOT NULL DEFAULT 'order',
  previous_status text,
  new_status text NOT NULL,
  reason text,
  source text NOT NULL DEFAULT 'staff',
  latitude numeric,
  longitude numeric,
  changed_by uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX delivery_order_status_history_order_idx ON public.delivery_order_status_history (delivery_order_id, created_at);

-- private one-time PIN (never visible to riders)
CREATE TABLE public.delivery_order_pins (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  delivery_order_id uuid NOT NULL REFERENCES public.delivery_orders(id) ON DELETE CASCADE,
  customer_id uuid NOT NULL,
  pin text NOT NULL,
  consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT delivery_order_pins_uq UNIQUE (delivery_order_id)
);

-- ---------- dispatch ----------
CREATE TABLE public.rider_assignments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  branch_id uuid,
  delivery_order_id uuid NOT NULL REFERENCES public.delivery_orders(id) ON DELETE CASCADE,
  rider_id uuid NOT NULL REFERENCES public.rider_profiles(id) ON DELETE CASCADE,
  previous_rider_id uuid REFERENCES public.rider_profiles(id) ON DELETE SET NULL,
  status text NOT NULL DEFAULT 'offered',
  assigned_by uuid,
  assigned_at timestamptz NOT NULL DEFAULT now(),
  responded_at timestamptz,
  rejection_reason text,
  reassignment_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT rider_assignments_status_chk CHECK (status IN ('offered','accepted','rejected','reassigned','cancelled','completed'))
);
CREATE INDEX rider_assignments_order_idx ON public.rider_assignments (delivery_order_id);

CREATE TABLE public.rider_location_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  rider_id uuid NOT NULL REFERENCES public.rider_profiles(id) ON DELETE CASCADE,
  delivery_order_id uuid REFERENCES public.delivery_orders(id) ON DELETE CASCADE,
  latitude numeric NOT NULL,
  longitude numeric NOT NULL,
  accuracy numeric,
  heading numeric,
  speed numeric,
  source text NOT NULL DEFAULT 'rider-app',
  retention_expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX rider_location_events_order_idx ON public.rider_location_events (delivery_order_id, created_at DESC);

CREATE TABLE public.delivery_attempts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  delivery_order_id uuid NOT NULL REFERENCES public.delivery_orders(id) ON DELETE CASCADE,
  rider_id uuid REFERENCES public.rider_profiles(id) ON DELETE SET NULL,
  attempt_number integer NOT NULL DEFAULT 1,
  outcome text NOT NULL,
  reason text,
  notes text,
  latitude numeric,
  longitude numeric,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT delivery_attempts_outcome_chk CHECK (outcome IN ('delivered','customer-unavailable','incorrect-address','customer-unreachable','refused','safety-issue','vehicle-problem','payment-failure','damaged-order','excessive-delay','other'))
);

CREATE TABLE public.delivery_proofs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  delivery_order_id uuid NOT NULL REFERENCES public.delivery_orders(id) ON DELETE CASCADE,
  rider_id uuid REFERENCES public.rider_profiles(id) ON DELETE SET NULL,
  method text NOT NULL DEFAULT 'pin',
  recipient_name text,
  pin_verified boolean NOT NULL DEFAULT false,
  signature_path text,
  photo_path text,
  photo_consent boolean NOT NULL DEFAULT false,
  latitude numeric,
  longitude numeric,
  confirmed_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT delivery_proofs_uq UNIQUE (delivery_order_id)
);

CREATE TABLE public.delivery_issues (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  branch_id uuid,
  delivery_order_id uuid REFERENCES public.delivery_orders(id) ON DELETE CASCADE,
  rider_id uuid REFERENCES public.rider_profiles(id) ON DELETE SET NULL,
  category text NOT NULL DEFAULT 'other',
  severity text NOT NULL DEFAULT 'normal',
  description text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'open',
  resolution text,
  food_safety_disposition text,
  reported_by uuid,
  resolved_by uuid,
  resolved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT delivery_issues_status_chk CHECK (status IN ('open','investigating','escalated','resolved','closed'))
);

-- ---------- cash on delivery ----------
CREATE TABLE public.rider_cash_collections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  branch_id uuid,
  delivery_order_id uuid NOT NULL REFERENCES public.delivery_orders(id) ON DELETE CASCADE,
  rider_id uuid NOT NULL REFERENCES public.rider_profiles(id) ON DELETE RESTRICT,
  expected_amount numeric NOT NULL DEFAULT 0,
  collected_amount numeric NOT NULL DEFAULT 0,
  currency text NOT NULL DEFAULT 'KES',
  collected_at timestamptz NOT NULL DEFAULT now(),
  remittance_id uuid,
  status text NOT NULL DEFAULT 'collected',
  variance_reason text,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT rider_cash_collections_uq UNIQUE (delivery_order_id),
  CONSTRAINT rider_cash_collections_status_chk CHECK (status IN ('collected','remitted','reconciled','disputed'))
);

CREATE TABLE public.rider_cash_remittances (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  branch_id uuid,
  rider_id uuid NOT NULL REFERENCES public.rider_profiles(id) ON DELETE RESTRICT,
  reference text NOT NULL,
  expected_amount numeric NOT NULL DEFAULT 0,
  declared_amount numeric NOT NULL DEFAULT 0,
  counted_amount numeric,
  variance numeric NOT NULL DEFAULT 0,
  variance_reason text,
  shift_id uuid,
  status text NOT NULL DEFAULT 'submitted',
  submitted_at timestamptz NOT NULL DEFAULT now(),
  received_by uuid,
  received_at timestamptz,
  reconciled_by uuid,
  reconciled_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT rider_cash_remittances_status_chk CHECK (status IN ('submitted','received','reconciled','disputed'))
);
ALTER TABLE public.rider_cash_collections
  ADD CONSTRAINT rider_cash_collections_remittance_fk
  FOREIGN KEY (remittance_id) REFERENCES public.rider_cash_remittances(id) ON DELETE SET NULL;

-- ---------- promotions ----------
CREATE TABLE public.promotion_codes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  code text NOT NULL,
  description text NOT NULL DEFAULT '',
  discount_type text NOT NULL DEFAULT 'percentage',
  discount_value numeric NOT NULL DEFAULT 0,
  free_delivery boolean NOT NULL DEFAULT false,
  branch_ids uuid[] NOT NULL DEFAULT '{}',
  zone_ids uuid[] NOT NULL DEFAULT '{}',
  category_ids uuid[] NOT NULL DEFAULT '{}',
  menu_item_ids uuid[] NOT NULL DEFAULT '{}',
  min_order numeric NOT NULL DEFAULT 0,
  max_discount numeric,
  first_order_only boolean NOT NULL DEFAULT false,
  per_customer_limit integer NOT NULL DEFAULT 1,
  total_usage_limit integer,
  usage_count integer NOT NULL DEFAULT 0,
  starts_at timestamptz,
  ends_at timestamptz,
  approval_status text NOT NULL DEFAULT 'draft',
  active boolean NOT NULL DEFAULT false,
  funding_cost_centre text,
  created_by uuid,
  approved_by uuid,
  approved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT promotion_codes_uq UNIQUE (organization_id, code),
  CONSTRAINT promotion_codes_type_chk CHECK (discount_type IN ('percentage','fixed','free-delivery')),
  CONSTRAINT promotion_codes_approval_chk CHECK (approval_status IN ('draft','pending-approval','approved','rejected'))
);

CREATE TABLE public.promotion_redemptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  promotion_id uuid NOT NULL REFERENCES public.promotion_codes(id) ON DELETE CASCADE,
  customer_id uuid NOT NULL,
  delivery_order_id uuid REFERENCES public.delivery_orders(id) ON DELETE CASCADE,
  discount_amount numeric NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT promotion_redemptions_order_uq UNIQUE (promotion_id, delivery_order_id)
);

-- ---------- favourites & batches ----------
CREATE TABLE public.customer_favourites (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  customer_id uuid NOT NULL REFERENCES public.customers(id) ON DELETE CASCADE,
  menu_item_id uuid NOT NULL REFERENCES public.menu_items(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT customer_favourites_uq UNIQUE (customer_id, menu_item_id)
);

CREATE TABLE public.delivery_batches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  branch_id uuid,
  reference text NOT NULL,
  rider_id uuid REFERENCES public.rider_profiles(id) ON DELETE SET NULL,
  status text NOT NULL DEFAULT 'draft',
  notes text,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.delivery_batch_orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  batch_id uuid NOT NULL REFERENCES public.delivery_batches(id) ON DELETE CASCADE,
  delivery_order_id uuid NOT NULL REFERENCES public.delivery_orders(id) ON DELETE CASCADE,
  sequence integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT delivery_batch_orders_uq UNIQUE (batch_id, delivery_order_id)
);

-- extend customer_addresses with delivery detail
ALTER TABLE public.customer_addresses
  ADD COLUMN IF NOT EXISTS recipient_name text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS phone text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS county text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS building text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS house_number text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS landmark text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS delivery_instructions text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS latitude numeric,
  ADD COLUMN IF NOT EXISTS longitude numeric,
  ADD COLUMN IF NOT EXISTS zone_id uuid REFERENCES public.delivery_zones(id) ON DELETE SET NULL;

-- =========================================================
-- GRANTS
-- =========================================================
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'delivery_settings','delivery_zones','carts','cart_items','cart_item_modifiers',
    'rider_profiles','rider_availability_history','delivery_orders','delivery_order_status_history',
    'delivery_order_pins','rider_assignments','rider_location_events','delivery_attempts',
    'delivery_proofs','delivery_issues','rider_cash_collections','rider_cash_remittances',
    'promotion_codes','promotion_redemptions','customer_favourites','delivery_batches','delivery_batch_orders'
  ] LOOP
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON public.%I TO authenticated', t);
    EXECUTE format('GRANT ALL ON public.%I TO service_role', t);
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at()', 'trg_touch_'||t, t);
  END LOOP;
END $$;

-- =========================================================
-- SECURITY HELPERS
-- =========================================================
CREATE OR REPLACE FUNCTION public.my_rider_id()
RETURNS uuid LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT id FROM public.rider_profiles
  WHERE profile_id = auth.uid() AND active AND organization_id = public.current_org_id()
  LIMIT 1;
$$;
REVOKE EXECUTE ON FUNCTION public.my_rider_id() FROM public, anon;
GRANT EXECUTE ON FUNCTION public.my_rider_id() TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.rider_owns_delivery(_order uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.delivery_orders d
    WHERE d.id = _order AND d.rider_id = public.my_rider_id()
  );
$$;
REVOKE EXECUTE ON FUNCTION public.rider_owns_delivery(uuid) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.rider_owns_delivery(uuid) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.customer_owns_delivery(_order uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.delivery_orders d
    WHERE d.id = _order AND d.customer_id = public.my_customer_id()
  );
$$;
REVOKE EXECUTE ON FUNCTION public.customer_owns_delivery(uuid) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.customer_owns_delivery(uuid) TO authenticated, service_role;

-- =========================================================
-- RLS POLICIES
-- =========================================================

-- settings & zones: staff read within org; manage requires permission. Customers read zones/settings for ordering.
CREATE POLICY delivery_settings_staff_read ON public.delivery_settings FOR SELECT TO authenticated
  USING (organization_id = public.current_org_id());
CREATE POLICY delivery_settings_manage ON public.delivery_settings FOR ALL TO authenticated
  USING (organization_id = public.current_org_id() AND public.has_permission('delivery','settings.manage'))
  WITH CHECK (organization_id = public.current_org_id() AND public.has_permission('delivery','settings.manage'));

CREATE POLICY delivery_zones_read ON public.delivery_zones FOR SELECT TO authenticated
  USING (organization_id = public.current_org_id());
CREATE POLICY delivery_zones_manage ON public.delivery_zones FOR ALL TO authenticated
  USING (organization_id = public.current_org_id() AND public.has_permission('delivery','zones.manage'))
  WITH CHECK (organization_id = public.current_org_id() AND public.has_permission('delivery','zones.manage'));

-- carts: customer only
CREATE POLICY carts_customer ON public.carts FOR ALL TO authenticated
  USING (customer_id = public.my_customer_id())
  WITH CHECK (customer_id = public.my_customer_id() AND organization_id = public.current_org_id());

CREATE POLICY cart_items_customer ON public.cart_items FOR ALL TO authenticated
  USING (EXISTS (SELECT 1 FROM public.carts c WHERE c.id = cart_id AND c.customer_id = public.my_customer_id()))
  WITH CHECK (EXISTS (SELECT 1 FROM public.carts c WHERE c.id = cart_id AND c.customer_id = public.my_customer_id()));

CREATE POLICY cart_item_modifiers_customer ON public.cart_item_modifiers FOR ALL TO authenticated
  USING (EXISTS (SELECT 1 FROM public.cart_items ci JOIN public.carts c ON c.id = ci.cart_id
                 WHERE ci.id = cart_item_id AND c.customer_id = public.my_customer_id()))
  WITH CHECK (EXISTS (SELECT 1 FROM public.cart_items ci JOIN public.carts c ON c.id = ci.cart_id
                 WHERE ci.id = cart_item_id AND c.customer_id = public.my_customer_id()));

-- favourites: customer only
CREATE POLICY customer_favourites_customer ON public.customer_favourites FOR ALL TO authenticated
  USING (customer_id = public.my_customer_id())
  WITH CHECK (customer_id = public.my_customer_id() AND organization_id = public.current_org_id());

-- rider profiles
CREATE POLICY rider_profiles_staff_read ON public.rider_profiles FOR SELECT TO authenticated
  USING (organization_id = public.current_org_id() AND public.is_staff());
CREATE POLICY rider_profiles_manage ON public.rider_profiles FOR ALL TO authenticated
  USING (organization_id = public.current_org_id() AND public.has_permission('delivery','riders.manage'))
  WITH CHECK (organization_id = public.current_org_id() AND public.has_permission('delivery','riders.manage'));
CREATE POLICY rider_profiles_self_update ON public.rider_profiles FOR UPDATE TO authenticated
  USING (profile_id = auth.uid() AND public.has_permission('delivery','rider.availability'))
  WITH CHECK (profile_id = auth.uid());

CREATE POLICY rider_availability_history_read ON public.rider_availability_history FOR SELECT TO authenticated
  USING (organization_id = public.current_org_id() AND (public.has_permission('delivery','dispatch.view') OR rider_id = public.my_rider_id()));
CREATE POLICY rider_availability_history_write ON public.rider_availability_history FOR INSERT TO authenticated
  WITH CHECK (organization_id = public.current_org_id() AND (public.has_permission('delivery','dispatch.assign') OR rider_id = public.my_rider_id()));

-- delivery orders
CREATE POLICY delivery_orders_customer_read ON public.delivery_orders FOR SELECT TO authenticated
  USING (customer_id = public.my_customer_id());
CREATE POLICY delivery_orders_staff_read ON public.delivery_orders FOR SELECT TO authenticated
  USING (organization_id = public.current_org_id() AND public.is_staff() AND public.has_permission('delivery','orders.view'));
CREATE POLICY delivery_orders_rider_read ON public.delivery_orders FOR SELECT TO authenticated
  USING (rider_id = public.my_rider_id()
         AND (dispatch_status NOT IN ('delivered','delivery-failed','returned') OR updated_at > now() - interval '24 hours'));
CREATE POLICY delivery_orders_staff_update ON public.delivery_orders FOR UPDATE TO authenticated
  USING (organization_id = public.current_org_id() AND public.has_permission('delivery','orders.update'))
  WITH CHECK (organization_id = public.current_org_id() AND public.has_permission('delivery','orders.update'));

CREATE POLICY delivery_status_history_read ON public.delivery_order_status_history FOR SELECT TO authenticated
  USING (public.customer_owns_delivery(delivery_order_id)
         OR public.rider_owns_delivery(delivery_order_id)
         OR (organization_id = public.current_org_id() AND public.has_permission('delivery','orders.view')));
CREATE POLICY delivery_status_history_write ON public.delivery_order_status_history FOR INSERT TO authenticated
  WITH CHECK (organization_id = public.current_org_id()
         AND (public.rider_owns_delivery(delivery_order_id) OR public.has_permission('delivery','orders.update')));

-- PIN: customer sees it, nobody else through the API
CREATE POLICY delivery_order_pins_customer ON public.delivery_order_pins FOR SELECT TO authenticated
  USING (customer_id = public.my_customer_id());

-- assignments
CREATE POLICY rider_assignments_read ON public.rider_assignments FOR SELECT TO authenticated
  USING ((organization_id = public.current_org_id() AND public.has_permission('delivery','dispatch.view'))
         OR rider_id = public.my_rider_id());
CREATE POLICY rider_assignments_dispatch ON public.rider_assignments FOR ALL TO authenticated
  USING (organization_id = public.current_org_id() AND public.has_permission('delivery','dispatch.assign'))
  WITH CHECK (organization_id = public.current_org_id() AND public.has_permission('delivery','dispatch.assign'));
CREATE POLICY rider_assignments_rider_respond ON public.rider_assignments FOR UPDATE TO authenticated
  USING (rider_id = public.my_rider_id())
  WITH CHECK (rider_id = public.my_rider_id());

-- location events: rider writes own, dispatch + assigned customer read
CREATE POLICY rider_location_rider_write ON public.rider_location_events FOR INSERT TO authenticated
  WITH CHECK (rider_id = public.my_rider_id() AND organization_id = public.current_org_id());
CREATE POLICY rider_location_read ON public.rider_location_events FOR SELECT TO authenticated
  USING (rider_id = public.my_rider_id()
         OR (organization_id = public.current_org_id() AND public.has_permission('delivery','dispatch.rider-location'))
         OR (delivery_order_id IS NOT NULL AND public.customer_owns_delivery(delivery_order_id)));

-- attempts / proofs / issues
CREATE POLICY delivery_attempts_read ON public.delivery_attempts FOR SELECT TO authenticated
  USING (public.rider_owns_delivery(delivery_order_id)
         OR public.customer_owns_delivery(delivery_order_id)
         OR (organization_id = public.current_org_id() AND public.has_permission('delivery','orders.view')));
CREATE POLICY delivery_attempts_write ON public.delivery_attempts FOR INSERT TO authenticated
  WITH CHECK (organization_id = public.current_org_id()
         AND (public.rider_owns_delivery(delivery_order_id) OR public.has_permission('delivery','dispatch.issue-record')));

CREATE POLICY delivery_proofs_read ON public.delivery_proofs FOR SELECT TO authenticated
  USING (public.rider_owns_delivery(delivery_order_id)
         OR public.customer_owns_delivery(delivery_order_id)
         OR (organization_id = public.current_org_id() AND public.has_permission('delivery','orders.view')));

CREATE POLICY delivery_issues_read ON public.delivery_issues FOR SELECT TO authenticated
  USING (public.rider_owns_delivery(delivery_order_id)
         OR (organization_id = public.current_org_id() AND public.has_permission('delivery','dispatch.view')));
CREATE POLICY delivery_issues_write ON public.delivery_issues FOR INSERT TO authenticated
  WITH CHECK (organization_id = public.current_org_id()
         AND (public.rider_owns_delivery(delivery_order_id) OR public.has_permission('delivery','dispatch.issue-record')));
CREATE POLICY delivery_issues_resolve ON public.delivery_issues FOR UPDATE TO authenticated
  USING (organization_id = public.current_org_id() AND public.has_permission('delivery','dispatch.issue-resolve'))
  WITH CHECK (organization_id = public.current_org_id() AND public.has_permission('delivery','dispatch.issue-resolve'));

-- cash
CREATE POLICY rider_cash_collections_read ON public.rider_cash_collections FOR SELECT TO authenticated
  USING (rider_id = public.my_rider_id()
         OR (organization_id = public.current_org_id() AND public.has_permission('delivery','payments.view')));
CREATE POLICY rider_cash_collections_finance ON public.rider_cash_collections FOR ALL TO authenticated
  USING (organization_id = public.current_org_id() AND public.has_permission('delivery','payments.reconcile'))
  WITH CHECK (organization_id = public.current_org_id() AND public.has_permission('delivery','payments.reconcile'));

CREATE POLICY rider_cash_remittances_read ON public.rider_cash_remittances FOR SELECT TO authenticated
  USING (rider_id = public.my_rider_id()
         OR (organization_id = public.current_org_id() AND public.has_permission('delivery','payments.view')));
CREATE POLICY rider_cash_remittances_rider_submit ON public.rider_cash_remittances FOR INSERT TO authenticated
  WITH CHECK (organization_id = public.current_org_id() AND rider_id = public.my_rider_id() AND status = 'submitted');
CREATE POLICY rider_cash_remittances_finance ON public.rider_cash_remittances FOR UPDATE TO authenticated
  USING (organization_id = public.current_org_id() AND public.has_permission('delivery','payments.reconcile'))
  WITH CHECK (organization_id = public.current_org_id() AND public.has_permission('delivery','payments.reconcile'));

-- promotions
CREATE POLICY promotion_codes_staff_read ON public.promotion_codes FOR SELECT TO authenticated
  USING (organization_id = public.current_org_id() AND public.has_permission('delivery','promotions.view'));
CREATE POLICY promotion_codes_manage ON public.promotion_codes FOR ALL TO authenticated
  USING (organization_id = public.current_org_id() AND public.has_permission('delivery','promotions.manage'))
  WITH CHECK (organization_id = public.current_org_id() AND public.has_permission('delivery','promotions.manage'));

CREATE POLICY promotion_redemptions_read ON public.promotion_redemptions FOR SELECT TO authenticated
  USING (customer_id = public.my_customer_id()
         OR (organization_id = public.current_org_id() AND public.has_permission('delivery','promotions.view')));

-- batches
CREATE POLICY delivery_batches_read ON public.delivery_batches FOR SELECT TO authenticated
  USING ((organization_id = public.current_org_id() AND public.has_permission('delivery','dispatch.view')) OR rider_id = public.my_rider_id());
CREATE POLICY delivery_batches_manage ON public.delivery_batches FOR ALL TO authenticated
  USING (organization_id = public.current_org_id() AND public.has_permission('delivery','dispatch.assign'))
  WITH CHECK (organization_id = public.current_org_id() AND public.has_permission('delivery','dispatch.assign'));
CREATE POLICY delivery_batch_orders_read ON public.delivery_batch_orders FOR SELECT TO authenticated
  USING (organization_id = public.current_org_id() AND (public.has_permission('delivery','dispatch.view') OR public.rider_owns_delivery(delivery_order_id)));
CREATE POLICY delivery_batch_orders_manage ON public.delivery_batch_orders FOR ALL TO authenticated
  USING (organization_id = public.current_org_id() AND public.has_permission('delivery','dispatch.assign'))
  WITH CHECK (organization_id = public.current_org_id() AND public.has_permission('delivery','dispatch.assign'));

-- =========================================================
-- PERMISSIONS CATALOGUE
-- =========================================================
INSERT INTO public.permissions (module, action, label) VALUES
  ('delivery','access','Delivery Access'),
  ('delivery','orders.view-own','View Own Orders'),
  ('delivery','orders.view','View Delivery Orders'),
  ('delivery','orders.create-assisted','Create Staff-Assisted Order'),
  ('delivery','orders.accept','Accept Order'),
  ('delivery','orders.reject','Reject Order'),
  ('delivery','orders.update','Update Order'),
  ('delivery','orders.cancel','Cancel Order'),
  ('delivery','orders.override','Override Order'),
  ('delivery','orders.contact','View Customer Contact'),
  ('delivery','orders.financials','View Order Financials'),
  ('delivery','dispatch.view','View Dispatch'),
  ('delivery','dispatch.assign','Assign Rider'),
  ('delivery','dispatch.reassign','Reassign Rider'),
  ('delivery','dispatch.eta','Update ETA'),
  ('delivery','dispatch.issue-record','Record Delivery Issue'),
  ('delivery','dispatch.issue-resolve','Resolve Delivery Issue'),
  ('delivery','dispatch.rider-location','View Rider Location'),
  ('delivery','dispatch.contact-customer','Contact Customer'),
  ('delivery','dispatch.contact-rider','Contact Rider'),
  ('delivery','rider.availability','Manage Own Availability'),
  ('delivery','rider.assignment.view','View Assigned Delivery'),
  ('delivery','rider.assignment.accept','Accept Assignment'),
  ('delivery','rider.assignment.reject','Reject Assignment'),
  ('delivery','rider.pickup','Confirm Pickup'),
  ('delivery','rider.start','Start Delivery'),
  ('delivery','rider.attempt','Record Delivery Attempt'),
  ('delivery','rider.confirm','Confirm Delivery'),
  ('delivery','rider.cash','Record Cash Collection'),
  ('delivery','rider.proof','Submit Proof of Delivery'),
  ('delivery','rider.issue','Report Issue'),
  ('delivery','riders.manage','Manage Riders'),
  ('delivery','zones.view','View Zones'),
  ('delivery','zones.manage','Manage Zones'),
  ('delivery','fees.manage','Manage Delivery Fees'),
  ('delivery','settings.manage','Manage Delivery Settings'),
  ('delivery','area.override','Override Delivery Area'),
  ('delivery','payments.view','View Delivery Payments'),
  ('delivery','payments.cod','Record Cash on Delivery'),
  ('delivery','payments.reconcile','Reconcile Rider Cash'),
  ('delivery','payments.refund-request','Request Refund'),
  ('delivery','payments.refund-approve','Approve Refund'),
  ('delivery','payments.revenue','View Delivery Revenue'),
  ('delivery','promotions.view','View Promotions'),
  ('delivery','promotions.manage','Create Promotion'),
  ('delivery','promotions.approve','Approve Promotion'),
  ('delivery','promotions.activate','Activate Promotion'),
  ('delivery','promotions.performance','View Promotion Performance'),
  ('delivery','reports.view','View Delivery Reports'),
  ('delivery','reports.export','Export Delivery Reports'),
  ('delivery','reports.print','Print Delivery Reports')
ON CONFLICT DO NOTHING;

-- grant the full delivery set to leadership roles
INSERT INTO public.role_permissions (organization_id, role_id, permission_id)
SELECT r.organization_id, r.id, p.id
FROM public.roles r
JOIN public.permissions p ON p.module = 'delivery'
WHERE r.name IN ('Owner','General Manager','System Administrator')
ON CONFLICT DO NOTHING;

-- =========================================================
-- SERVER-SIDE PRICING & ORDER FUNCTIONS
-- =========================================================

CREATE OR REPLACE FUNCTION public.delivery_get_settings(_branch uuid)
RETURNS public.delivery_settings LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT * FROM public.delivery_settings
  WHERE organization_id = public.current_org_id()
    AND (branch_id = _branch OR branch_id IS NULL)
  ORDER BY branch_id NULLS LAST LIMIT 1;
$$;
REVOKE EXECUTE ON FUNCTION public.delivery_get_settings(uuid) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.delivery_get_settings(uuid) TO authenticated, service_role;

-- authoritative cart quote: prices, taxes, fees and promo are computed here only
CREATE OR REPLACE FUNCTION public.delivery_quote_cart(_cart uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  _c public.carts; _s public.delivery_settings; _z public.delivery_zones;
  _sub numeric := 0; _tax numeric := 0; _mods numeric := 0;
  _fee numeric := 0; _disc numeric := 0; _promo public.promotion_codes;
  _issues text[] := '{}'; _lines jsonb := '[]'::jsonb; _uses int;
BEGIN
  SELECT * INTO _c FROM public.carts WHERE id = _cart;
  IF _c.id IS NULL OR _c.customer_id <> public.my_customer_id() THEN
    RAISE EXCEPTION 'Cart not found';
  END IF;
  _s := public.delivery_get_settings(_c.branch_id);

  SELECT
    coalesce(sum(ci.quantity * mi.base_price), 0),
    coalesce(sum(ci.quantity * mi.base_price * mi.tax_rate / 100), 0),
    coalesce(jsonb_agg(jsonb_build_object(
      'cart_item_id', ci.id, 'menu_item_id', mi.id, 'name', mi.name,
      'quantity', ci.quantity, 'unit_price', mi.base_price, 'tax_rate', mi.tax_rate,
      'station_id', mi.station_id, 'availability', mi.availability,
      'delivery_eligible', mi.available_delivery,
      'special_instructions', ci.special_instructions, 'allergy_note', ci.allergy_note
    ) ORDER BY ci.created_at), '[]'::jsonb)
  INTO _sub, _tax, _lines
  FROM public.cart_items ci JOIN public.menu_items mi ON mi.id = ci.menu_item_id
  WHERE ci.cart_id = _cart;

  SELECT coalesce(sum(cim.extra_charge * ci.quantity), 0) INTO _mods
  FROM public.cart_item_modifiers cim
  JOIN public.cart_items ci ON ci.id = cim.cart_item_id
  WHERE ci.cart_id = _cart;
  _sub := _sub + _mods;

  IF EXISTS (SELECT 1 FROM public.cart_items ci JOIN public.menu_items mi ON mi.id = ci.menu_item_id
             WHERE ci.cart_id = _cart AND (mi.availability <> 'available' OR NOT mi.available_delivery)) THEN
    _issues := _issues || 'Some items are unavailable for delivery and must be removed.';
  END IF;

  IF _c.fulfilment_type = 'delivery' THEN
    SELECT * INTO _z FROM public.delivery_zones WHERE id = _c.zone_id AND active;
    IF _z.id IS NULL THEN
      _issues := _issues || 'Select a delivery address inside a served zone.';
    ELSE
      _fee := _z.base_fee;
      IF _z.free_delivery_threshold IS NOT NULL AND _sub >= _z.free_delivery_threshold THEN _fee := 0; END IF;
      IF _sub < greatest(_z.min_order, coalesce(_s.min_order, 0)) THEN
        _issues := _issues || format('Minimum order for this zone is %s.', greatest(_z.min_order, coalesce(_s.min_order,0)));
      END IF;
      IF localtime NOT BETWEEN _z.service_start AND _z.service_end AND _c.scheduled_for IS NULL THEN
        _issues := _issues || 'This zone is outside its service hours right now — schedule the order instead.';
      END IF;
    END IF;
  ELSIF coalesce(_s.pickup_enabled, true) = false THEN
    _issues := _issues || 'Pickup is not enabled for this branch.';
  END IF;

  IF _c.promo_code IS NOT NULL AND length(trim(_c.promo_code)) > 0 THEN
    SELECT * INTO _promo FROM public.promotion_codes
    WHERE organization_id = _c.organization_id AND upper(code) = upper(trim(_c.promo_code))
      AND active AND approval_status = 'approved';
    IF _promo.id IS NULL THEN
      _issues := _issues || 'Promo code is not valid.';
    ELSIF (_promo.starts_at IS NOT NULL AND now() < _promo.starts_at)
       OR (_promo.ends_at IS NOT NULL AND now() > _promo.ends_at) THEN
      _issues := _issues || 'Promo code is outside its validity period.';
    ELSIF _sub < _promo.min_order THEN
      _issues := _issues || 'Order value is below the promo minimum.';
    ELSE
      SELECT count(*) INTO _uses FROM public.promotion_redemptions
      WHERE promotion_id = _promo.id AND customer_id = _c.customer_id;
      IF _uses >= _promo.per_customer_limit THEN
        _issues := _issues || 'Promo usage limit reached for this customer.';
      ELSIF _promo.total_usage_limit IS NOT NULL AND _promo.usage_count >= _promo.total_usage_limit THEN
        _issues := _issues || 'Promo code is fully redeemed.';
      ELSE
        IF _promo.discount_type = 'percentage' THEN _disc := _sub * _promo.discount_value / 100;
        ELSIF _promo.discount_type = 'fixed' THEN _disc := _promo.discount_value;
        END IF;
        IF _promo.max_discount IS NOT NULL THEN _disc := least(_disc, _promo.max_discount); END IF;
        IF _promo.free_delivery OR _promo.discount_type = 'free-delivery' THEN _fee := 0; END IF;
        _disc := least(_disc, _sub);
      END IF;
    END IF;
  END IF;

  RETURN jsonb_build_object(
    'cart_id', _c.id,
    'branch_id', _c.branch_id,
    'fulfilment_type', _c.fulfilment_type,
    'lines', _lines,
    'subtotal', round(_sub, 2),
    'tax_total', round(_tax, 2),
    'discount_total', round(_disc, 2),
    'delivery_fee', round(_fee, 2),
    'tip_amount', round(coalesce(_c.tip_amount, 0), 2),
    'grand_total', round(greatest(_sub + _tax + _fee + coalesce(_c.tip_amount,0) - _disc, 0), 2),
    'promotion_id', _promo.id,
    'zone_id', _z.id,
    'eta_minutes', coalesce(_z.eta_minutes, 45),
    'issues', to_jsonb(_issues),
    'can_checkout', (cardinality(_issues) = 0 AND jsonb_array_length(_lines) > 0)
  );
END; $$;
REVOKE EXECUTE ON FUNCTION public.delivery_quote_cart(uuid) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.delivery_quote_cart(uuid) TO authenticated, service_role;

-- place order: creates the POS order + items (single source of truth) and the delivery record
CREATE OR REPLACE FUNCTION public.delivery_place_order(_cart uuid, _payment_method text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  _c public.carts; _q jsonb; _s public.delivery_settings; _addr public.customer_addresses;
  _pos uuid; _del uuid; _num text; _line jsonb; _item uuid; _cust public.customers;
  _pin text; _pay_status text;
BEGIN
  SELECT * INTO _c FROM public.carts WHERE id = _cart AND status = 'active';
  IF _c.id IS NULL OR _c.customer_id <> public.my_customer_id() THEN RAISE EXCEPTION 'Cart not found'; END IF;
  _q := public.delivery_quote_cart(_cart);
  IF NOT (_q->>'can_checkout')::boolean THEN RAISE EXCEPTION 'Cart cannot be checked out: %', _q->>'issues'; END IF;

  _s := public.delivery_get_settings(_c.branch_id);
  IF _payment_method <> ALL (coalesce(_s.allowed_payment_methods, ARRAY['cash'])) THEN
    RAISE EXCEPTION 'Payment method not allowed';
  END IF;
  IF _payment_method = 'cash' AND (_q->>'grand_total')::numeric > coalesce(_s.cod_limit, 0) THEN
    RAISE EXCEPTION 'Cash on delivery limit exceeded';
  END IF;

  SELECT * INTO _cust FROM public.customers WHERE id = _c.customer_id;
  SELECT * INTO _addr FROM public.customer_addresses WHERE id = _c.address_id;
  _num := public.next_document_number('delivery_order');
  _pay_status := CASE WHEN _payment_method = 'cash' THEN 'unpaid' ELSE 'pending' END;

  INSERT INTO public.pos_orders (
    organization_id, branch_id, order_number, order_type, order_source,
    customer_id, guest_count, guest_name, contact_phone, status, payment_status,
    subtotal, discount_total, tax_total, grand_total, currency, notes, created_by
  ) VALUES (
    _c.organization_id, _c.branch_id, _num,
    CASE WHEN _c.fulfilment_type = 'pickup' THEN 'takeaway' ELSE 'delivery' END,
    'customer-app', _c.customer_id, 1, _cust.full_name, coalesce(_addr.phone, _cust.phone),
    'confirmed', _pay_status,
    (_q->>'subtotal')::numeric, (_q->>'discount_total')::numeric, (_q->>'tax_total')::numeric,
    (_q->>'grand_total')::numeric, coalesce(_cust.preferred_language, 'KES'), _c.notes, auth.uid()
  ) RETURNING id INTO _pos;
  UPDATE public.pos_orders SET currency = 'KES' WHERE id = _pos;

  FOR _line IN SELECT * FROM jsonb_array_elements(_q->'lines') LOOP
    INSERT INTO public.pos_order_items (
      organization_id, order_id, menu_item_id, station_id, item_name, quantity,
      unit_price, tax_rate, tax_amount, line_total, status, special_instructions, allergy_note, created_by
    ) VALUES (
      _c.organization_id, _pos, (_line->>'menu_item_id')::uuid, nullif(_line->>'station_id','')::uuid,
      _line->>'name', (_line->>'quantity')::numeric, (_line->>'unit_price')::numeric,
      (_line->>'tax_rate')::numeric,
      round((_line->>'quantity')::numeric * (_line->>'unit_price')::numeric * (_line->>'tax_rate')::numeric / 100, 2),
      round((_line->>'quantity')::numeric * (_line->>'unit_price')::numeric, 2),
      'draft', _line->>'special_instructions', _line->>'allergy_note', auth.uid()
    ) RETURNING id INTO _item;

    INSERT INTO public.pos_order_item_modifiers (organization_id, order_item_id, group_id, option_id, group_name, option_name, extra_charge)
    SELECT _c.organization_id, _item, cim.group_id, cim.option_id, cim.group_name, cim.option_name, cim.extra_charge
    FROM public.cart_item_modifiers cim
    WHERE cim.cart_item_id = (_line->>'cart_item_id')::uuid;
  END LOOP;

  INSERT INTO public.delivery_orders (
    organization_id, branch_id, pos_order_id, customer_id, auth_user_id, order_number,
    fulfilment_type, contact_name, contact_phone, address_snapshot, zone_id, latitude, longitude,
    subtotal, tax_total, discount_total, delivery_fee, tip_amount, grand_total,
    payment_method, payment_status, promo_code, promotion_id, scheduled_for,
    estimated_prep_minutes, estimated_delivery_at, order_status, notes, created_by
  ) VALUES (
    _c.organization_id, _c.branch_id, _pos, _c.customer_id, auth.uid(), _num,
    _c.fulfilment_type, coalesce(_addr.recipient_name, _cust.full_name), coalesce(_addr.phone, _cust.phone),
    CASE WHEN _addr.id IS NULL THEN '{}'::jsonb ELSE to_jsonb(_addr) - 'created_by' END,
    (_q->>'zone_id')::uuid, _addr.latitude, _addr.longitude,
    (_q->>'subtotal')::numeric, (_q->>'tax_total')::numeric, (_q->>'discount_total')::numeric,
    (_q->>'delivery_fee')::numeric, (_q->>'tip_amount')::numeric, (_q->>'grand_total')::numeric,
    _payment_method, _pay_status, _c.promo_code, (_q->>'promotion_id')::uuid, _c.scheduled_for,
    coalesce((_q->>'eta_minutes')::int, 45),
    now() + make_interval(mins => coalesce((_q->>'eta_minutes')::int, 45)),
    CASE WHEN _payment_method = 'cash' THEN 'confirmed' ELSE 'pending-payment' END,
    _c.notes, auth.uid()
  ) RETURNING id INTO _del;

  _pin := lpad((floor(random() * 10000))::int::text, 4, '0');
  INSERT INTO public.delivery_order_pins (organization_id, delivery_order_id, customer_id, pin)
  VALUES (_c.organization_id, _del, _c.customer_id, _pin);

  IF (_q->>'promotion_id') IS NOT NULL THEN
    INSERT INTO public.promotion_redemptions (organization_id, promotion_id, customer_id, delivery_order_id, discount_amount)
    VALUES (_c.organization_id, (_q->>'promotion_id')::uuid, _c.customer_id, _del, (_q->>'discount_total')::numeric)
    ON CONFLICT DO NOTHING;
    UPDATE public.promotion_codes SET usage_count = usage_count + 1 WHERE id = (_q->>'promotion_id')::uuid;
  END IF;

  INSERT INTO public.delivery_order_status_history (organization_id, delivery_order_id, status_kind, new_status, source, changed_by)
  VALUES (_c.organization_id, _del, 'order',
          CASE WHEN _payment_method = 'cash' THEN 'confirmed' ELSE 'pending-payment' END, 'customer', auth.uid());

  UPDATE public.carts SET status = 'converted' WHERE id = _cart;

  RETURN jsonb_build_object('delivery_order_id', _del, 'pos_order_id', _pos, 'order_number', _num, 'pin', _pin);
END; $$;
REVOKE EXECUTE ON FUNCTION public.delivery_place_order(uuid, text) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.delivery_place_order(uuid, text) TO authenticated, service_role;

-- accept the order: fires kitchen tickets exactly once
CREATE OR REPLACE FUNCTION public.delivery_accept_order(_order uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE _d public.delivery_orders;
BEGIN
  IF NOT public.has_permission('delivery','orders.accept') THEN RAISE EXCEPTION 'Not permitted'; END IF;
  SELECT * INTO _d FROM public.delivery_orders WHERE id = _order AND organization_id = public.current_org_id();
  IF _d.id IS NULL THEN RAISE EXCEPTION 'Order not found'; END IF;
  IF _d.kitchen_status <> 'not-sent' THEN RETURN jsonb_build_object('ok', true, 'already_sent', true); END IF;
  IF _d.order_status NOT IN ('confirmed','payment-verification') THEN RAISE EXCEPTION 'Order is not ready for acceptance'; END IF;

  UPDATE public.pos_order_items SET status = 'sent', sent_at = now()
  WHERE order_id = _d.pos_order_id AND status = 'draft';
  UPDATE public.pos_orders SET status = 'sent', sent_at = now() WHERE id = _d.pos_order_id;
  UPDATE public.delivery_orders
    SET order_status = 'in-preparation', kitchen_status = 'new', dispatch_status = 'awaiting-kitchen', accepted_at = now()
  WHERE id = _order;

  INSERT INTO public.delivery_order_status_history (organization_id, delivery_order_id, status_kind, previous_status, new_status, changed_by)
  VALUES (_d.organization_id, _order, 'order', _d.order_status, 'in-preparation', auth.uid());
  RETURN jsonb_build_object('ok', true);
END; $$;
REVOKE EXECUTE ON FUNCTION public.delivery_accept_order(uuid) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.delivery_accept_order(uuid) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.delivery_reject_order(_order uuid, _reason text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE _d public.delivery_orders;
BEGIN
  IF NOT public.has_permission('delivery','orders.reject') THEN RAISE EXCEPTION 'Not permitted'; END IF;
  SELECT * INTO _d FROM public.delivery_orders WHERE id = _order AND organization_id = public.current_org_id();
  IF _d.id IS NULL THEN RAISE EXCEPTION 'Order not found'; END IF;
  IF _d.kitchen_status <> 'not-sent' THEN RAISE EXCEPTION 'Kitchen has already started this order'; END IF;
  UPDATE public.pos_order_items SET status = 'cancelled' WHERE order_id = _d.pos_order_id;
  UPDATE public.pos_orders SET status = 'cancelled' WHERE id = _d.pos_order_id;
  UPDATE public.delivery_orders SET order_status = 'rejected', kitchen_status = 'cancelled',
    dispatch_status = 'awaiting-kitchen', rejection_reason = _reason WHERE id = _order;
  INSERT INTO public.delivery_order_status_history (organization_id, delivery_order_id, status_kind, previous_status, new_status, reason, changed_by)
  VALUES (_d.organization_id, _order, 'order', _d.order_status, 'rejected', _reason, auth.uid());
  RETURN jsonb_build_object('ok', true);
END; $$;
REVOKE EXECUTE ON FUNCTION public.delivery_reject_order(uuid, text) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.delivery_reject_order(uuid, text) TO authenticated, service_role;

-- dispatch: assign / reassign a rider with validation
CREATE OR REPLACE FUNCTION public.delivery_assign_rider(_order uuid, _rider uuid, _reason text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE _d public.delivery_orders; _r public.rider_profiles; _active int;
BEGIN
  IF NOT public.has_permission('delivery','dispatch.assign') THEN RAISE EXCEPTION 'Not permitted'; END IF;
  SELECT * INTO _d FROM public.delivery_orders WHERE id = _order AND organization_id = public.current_org_id();
  SELECT * INTO _r FROM public.rider_profiles WHERE id = _rider AND organization_id = public.current_org_id();
  IF _d.id IS NULL OR _r.id IS NULL THEN RAISE EXCEPTION 'Order or rider not found'; END IF;
  IF NOT _r.active OR _r.availability_status IN ('offline','unavailable','shift-ended','on-break') THEN
    RAISE EXCEPTION 'Rider is not available';
  END IF;
  SELECT count(*) INTO _active FROM public.delivery_orders
   WHERE rider_id = _rider AND dispatch_status IN ('rider-assigned','pickup-pending','collected','en-route');
  IF _active >= _r.max_active_deliveries THEN RAISE EXCEPTION 'Rider is at capacity'; END IF;

  IF _d.rider_id IS NOT NULL AND _d.rider_id <> _rider THEN
    UPDATE public.rider_assignments SET status = 'reassigned', reassignment_reason = _reason
      WHERE delivery_order_id = _order AND status IN ('offered','accepted');
  END IF;

  INSERT INTO public.rider_assignments (organization_id, branch_id, delivery_order_id, rider_id, previous_rider_id, assigned_by, reassignment_reason)
  VALUES (_d.organization_id, _d.branch_id, _order, _rider, _d.rider_id, auth.uid(), _reason);

  UPDATE public.delivery_orders SET rider_id = _rider, dispatch_status = 'rider-assigned',
    order_status = CASE WHEN order_status IN ('confirmed','in-preparation','ready-for-pickup') THEN 'rider-assigned' ELSE order_status END
  WHERE id = _order;
  UPDATE public.rider_profiles SET availability_status = 'assigned' WHERE id = _rider;

  INSERT INTO public.delivery_order_status_history (organization_id, delivery_order_id, status_kind, previous_status, new_status, reason, changed_by)
  VALUES (_d.organization_id, _order, 'dispatch', _d.dispatch_status, 'rider-assigned', _reason, auth.uid());
  RETURN jsonb_build_object('ok', true);
END; $$;
REVOKE EXECUTE ON FUNCTION public.delivery_assign_rider(uuid, uuid, text) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.delivery_assign_rider(uuid, uuid, text) TO authenticated, service_role;

-- rider progresses their own delivery
CREATE OR REPLACE FUNCTION public.delivery_rider_advance(_order uuid, _to text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE _d public.delivery_orders; _rider uuid := public.my_rider_id();
BEGIN
  SELECT * INTO _d FROM public.delivery_orders WHERE id = _order;
  IF _d.id IS NULL OR _d.rider_id IS NULL OR _d.rider_id <> _rider THEN RAISE EXCEPTION 'Delivery not assigned to you'; END IF;
  IF _to NOT IN ('pickup-pending','collected','en-route') THEN RAISE EXCEPTION 'Invalid transition'; END IF;
  IF _to = 'collected' AND _d.dispatch_status NOT IN ('rider-assigned','pickup-pending') THEN RAISE EXCEPTION 'Invalid transition'; END IF;
  IF _to = 'en-route' AND _d.dispatch_status <> 'collected' THEN RAISE EXCEPTION 'Collect the order first'; END IF;

  UPDATE public.delivery_orders SET dispatch_status = _to,
    collected_at = CASE WHEN _to = 'collected' THEN now() ELSE collected_at END,
    order_status = CASE WHEN _to = 'collected' THEN 'collected' WHEN _to = 'en-route' THEN 'out-for-delivery' ELSE order_status END
  WHERE id = _order;
  UPDATE public.rider_profiles SET availability_status = CASE WHEN _to = 'en-route' THEN 'delivering' ELSE 'collecting' END WHERE id = _rider;
  INSERT INTO public.delivery_order_status_history (organization_id, delivery_order_id, status_kind, previous_status, new_status, source, changed_by)
  VALUES (_d.organization_id, _order, 'dispatch', _d.dispatch_status, _to, 'rider', auth.uid());
  RETURN jsonb_build_object('ok', true);
END; $$;
REVOKE EXECUTE ON FUNCTION public.delivery_rider_advance(uuid, text) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.delivery_rider_advance(uuid, text) TO authenticated, service_role;

-- proof of delivery: PIN verified server-side; rider never reads the PIN
CREATE OR REPLACE FUNCTION public.delivery_confirm_delivery(
  _order uuid, _pin text, _recipient text, _cash_collected numeric DEFAULT NULL,
  _lat numeric DEFAULT NULL, _lng numeric DEFAULT NULL
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE _d public.delivery_orders; _rider uuid := public.my_rider_id(); _s public.delivery_settings; _ok boolean := true;
BEGIN
  SELECT * INTO _d FROM public.delivery_orders WHERE id = _order;
  IF _d.id IS NULL OR _d.rider_id IS NULL OR _d.rider_id <> _rider THEN RAISE EXCEPTION 'Delivery not assigned to you'; END IF;
  IF _d.dispatch_status NOT IN ('collected','en-route') THEN RAISE EXCEPTION 'Delivery is not in progress'; END IF;
  _s := public.delivery_get_settings(_d.branch_id);

  IF coalesce(_s.pod_method, 'pin') = 'pin' THEN
    SELECT EXISTS (SELECT 1 FROM public.delivery_order_pins p WHERE p.delivery_order_id = _order AND p.pin = _pin) INTO _ok;
    IF NOT _ok THEN RAISE EXCEPTION 'Incorrect delivery PIN'; END IF;
    UPDATE public.delivery_order_pins SET consumed_at = now() WHERE delivery_order_id = _order;
  END IF;

  INSERT INTO public.delivery_proofs (organization_id, delivery_order_id, rider_id, method, recipient_name, pin_verified, latitude, longitude, created_by)
  VALUES (_d.organization_id, _order, _rider, coalesce(_s.pod_method,'pin'), _recipient, _ok, _lat, _lng, auth.uid())
  ON CONFLICT (delivery_order_id) DO NOTHING;

  INSERT INTO public.delivery_attempts (organization_id, delivery_order_id, rider_id, outcome, latitude, longitude, created_by)
  VALUES (_d.organization_id, _order, _rider, 'delivered', _lat, _lng, auth.uid());

  IF _d.payment_method = 'cash' AND _cash_collected IS NOT NULL THEN
    INSERT INTO public.rider_cash_collections (organization_id, branch_id, delivery_order_id, rider_id, expected_amount, collected_amount, created_by)
    VALUES (_d.organization_id, _d.branch_id, _order, _rider, _d.grand_total, _cash_collected, auth.uid())
    ON CONFLICT (delivery_order_id) DO NOTHING;
  END IF;

  UPDATE public.delivery_orders SET dispatch_status = 'delivered', order_status = 'delivered', delivered_at = now() WHERE id = _order;
  UPDATE public.rider_profiles SET availability_status = 'available' WHERE id = _rider;
  UPDATE public.rider_assignments SET status = 'completed' WHERE delivery_order_id = _order AND status IN ('offered','accepted');
  INSERT INTO public.delivery_order_status_history (organization_id, delivery_order_id, status_kind, previous_status, new_status, source, latitude, longitude, changed_by)
  VALUES (_d.organization_id, _order, 'order', _d.order_status, 'delivered', 'rider', _lat, _lng, auth.uid());
  RETURN jsonb_build_object('ok', true);
END; $$;
REVOKE EXECUTE ON FUNCTION public.delivery_confirm_delivery(uuid, text, text, numeric, numeric, numeric) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.delivery_confirm_delivery(uuid, text, text, numeric, numeric, numeric) TO authenticated, service_role;

-- delivery metrics for dashboards
CREATE OR REPLACE FUNCTION public.delivery_metrics(_branch uuid DEFAULT NULL, _from date DEFAULT NULL, _to date DEFAULT NULL)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  WITH scoped AS (
    SELECT * FROM public.delivery_orders d
    WHERE d.organization_id = public.current_org_id()
      AND public.has_permission('delivery','orders.view')
      AND (_branch IS NULL OR d.branch_id = _branch)
      AND d.created_at::date BETWEEN coalesce(_from, current_date - 30) AND coalesce(_to, current_date)
  )
  SELECT jsonb_build_object(
    'orders', (SELECT count(*) FROM scoped),
    'revenue', (SELECT coalesce(sum(grand_total),0) FROM scoped WHERE order_status NOT IN ('cancelled','rejected','failed')),
    'delivery_fees', (SELECT coalesce(sum(delivery_fee),0) FROM scoped WHERE order_status NOT IN ('cancelled','rejected','failed')),
    'delivered', (SELECT count(*) FROM scoped WHERE order_status = 'delivered'),
    'failed', (SELECT count(*) FROM scoped WHERE order_status IN ('failed','cancelled','rejected')),
    'in_flight', (SELECT count(*) FROM scoped WHERE dispatch_status IN ('awaiting-kitchen','awaiting-rider','rider-assigned','pickup-pending','collected','en-route')),
    'awaiting_rider', (SELECT count(*) FROM scoped WHERE dispatch_status = 'awaiting-rider'),
    'avg_prep_minutes', (SELECT coalesce(round(avg(extract(epoch FROM (ready_at - accepted_at))/60)::numeric,1),0) FROM scoped WHERE ready_at IS NOT NULL AND accepted_at IS NOT NULL),
    'avg_delivery_minutes', (SELECT coalesce(round(avg(extract(epoch FROM (delivered_at - collected_at))/60)::numeric,1),0) FROM scoped WHERE delivered_at IS NOT NULL AND collected_at IS NOT NULL),
    'cash_pending', (SELECT coalesce(sum(collected_amount),0) FROM public.rider_cash_collections
                     WHERE organization_id = public.current_org_id() AND status IN ('collected','remitted')),
    'active_riders', (SELECT count(*) FROM public.rider_profiles WHERE organization_id = public.current_org_id() AND active AND availability_status <> 'offline')
  );
$$;
REVOKE EXECUTE ON FUNCTION public.delivery_metrics(uuid, date, date) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.delivery_metrics(uuid, date, date) TO authenticated, service_role;

-- number sequence + default settings for every existing organization
INSERT INTO public.number_sequences (organization_id, doc_type, prefix, padding)
SELECT o.id, 'delivery_order', 'DEL', 6 FROM public.organizations o
ON CONFLICT DO NOTHING;

INSERT INTO public.delivery_settings (organization_id)
SELECT o.id FROM public.organizations o
ON CONFLICT (organization_id, branch_id) DO NOTHING;