
-- =========================================================
-- PHASE 9 — Inventory, Stores & Procurement
-- =========================================================

-- ---------- Units of measure ----------
CREATE TABLE public.uom_units (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid REFERENCES public.organizations(id) ON DELETE CASCADE,
  code text NOT NULL,
  label text NOT NULL,
  dimension text NOT NULL,
  base_code text NOT NULL,
  factor_to_base numeric NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, code)
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.uom_units TO authenticated;
GRANT ALL ON public.uom_units TO service_role;
ALTER TABLE public.uom_units ENABLE ROW LEVEL SECURITY;
CREATE POLICY uom_units_select ON public.uom_units FOR SELECT TO authenticated
  USING (organization_id IS NULL OR organization_id = current_org_id());
CREATE POLICY uom_units_write ON public.uom_units FOR ALL TO authenticated
  USING (organization_id = current_org_id() AND has_permission('inventory','settings.manage'))
  WITH CHECK (organization_id = current_org_id() AND has_permission('inventory','settings.manage'));
CREATE TRIGGER uom_units_touch BEFORE UPDATE ON public.uom_units FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

INSERT INTO public.uom_units (organization_id, code, label, dimension, base_code, factor_to_base) VALUES
 (NULL,'kg','Kilograms','mass','g',1000),
 (NULL,'g','Grams','mass','g',1),
 (NULL,'mg','Milligrams','mass','g',0.001),
 (NULL,'l','Litres','volume','ml',1000),
 (NULL,'ml','Millilitres','volume','ml',1),
 (NULL,'cup','Cups','volume','ml',250),
 (NULL,'tbsp','Tablespoons','volume','ml',15),
 (NULL,'tsp','Teaspoons','volume','ml',5),
 (NULL,'pinch','Pinches','mass','g',0.35),
 (NULL,'pc','Pieces','count','pc',1),
 (NULL,'portion','Portions','count','pc',1),
 (NULL,'bottle','Bottles','count','pc',1),
 (NULL,'pack','Packs','count','pc',1),
 (NULL,'crate','Crates','count','pc',1),
 (NULL,'box','Boxes','count','pc',1),
 (NULL,'bag','Bags','count','pc',1),
 (NULL,'roll','Rolls','count','pc',1);

-- ---------- Stock categories ----------
CREATE TABLE public.stock_categories (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  name text NOT NULL,
  code text,
  kind text NOT NULL DEFAULT 'food',
  description text,
  sort_order integer NOT NULL DEFAULT 0,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, name)
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.stock_categories TO authenticated;
GRANT ALL ON public.stock_categories TO service_role;
ALTER TABLE public.stock_categories ENABLE ROW LEVEL SECURITY;
CREATE POLICY stock_categories_select ON public.stock_categories FOR SELECT TO authenticated USING (organization_id = current_org_id());
CREATE POLICY stock_categories_write ON public.stock_categories FOR ALL TO authenticated
  USING (organization_id = current_org_id() AND has_permission('inventory','items.manage'))
  WITH CHECK (organization_id = current_org_id() AND has_permission('inventory','items.manage'));
CREATE TRIGGER stock_categories_touch BEFORE UPDATE ON public.stock_categories FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

-- ---------- Stock locations (stores) ----------
CREATE TABLE public.stock_locations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  branch_id uuid REFERENCES public.branches(id) ON DELETE SET NULL,
  department_id uuid REFERENCES public.departments(id) ON DELETE SET NULL,
  name text NOT NULL,
  code text,
  location_type text NOT NULL DEFAULT 'store',
  is_main boolean NOT NULL DEFAULT false,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, name)
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.stock_locations TO authenticated;
GRANT ALL ON public.stock_locations TO service_role;
ALTER TABLE public.stock_locations ENABLE ROW LEVEL SECURITY;
CREATE POLICY stock_locations_select ON public.stock_locations FOR SELECT TO authenticated USING (organization_id = current_org_id());
CREATE POLICY stock_locations_write ON public.stock_locations FOR ALL TO authenticated
  USING (organization_id = current_org_id() AND has_permission('inventory','settings.manage'))
  WITH CHECK (organization_id = current_org_id() AND has_permission('inventory','settings.manage'));
CREATE TRIGGER stock_locations_touch BEFORE UPDATE ON public.stock_locations FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

-- ---------- Suppliers ----------
CREATE TABLE public.suppliers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  branch_id uuid REFERENCES public.branches(id) ON DELETE SET NULL,
  name text NOT NULL,
  code text,
  contact_person text,
  phone text,
  email text,
  address text,
  tax_id text,
  categories text[] NOT NULL DEFAULT '{}',
  credit_terms_days integer NOT NULL DEFAULT 0,
  payment_terms text,
  currency text NOT NULL DEFAULT 'KES',
  outstanding_balance numeric NOT NULL DEFAULT 0,
  rating numeric,
  on_time_deliveries integer NOT NULL DEFAULT 0,
  late_deliveries integer NOT NULL DEFAULT 0,
  notes text,
  active boolean NOT NULL DEFAULT true,
  created_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, name)
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.suppliers TO authenticated;
GRANT ALL ON public.suppliers TO service_role;
ALTER TABLE public.suppliers ENABLE ROW LEVEL SECURITY;
CREATE POLICY suppliers_select ON public.suppliers FOR SELECT TO authenticated USING (organization_id = current_org_id());
CREATE POLICY suppliers_write ON public.suppliers FOR ALL TO authenticated
  USING (organization_id = current_org_id() AND has_permission('procurement','suppliers.manage'))
  WITH CHECK (organization_id = current_org_id() AND has_permission('procurement','suppliers.manage'));
CREATE TRIGGER suppliers_touch BEFORE UPDATE ON public.suppliers FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

-- ---------- Stock items ----------
CREATE TABLE public.stock_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  branch_id uuid REFERENCES public.branches(id) ON DELETE SET NULL,
  category_id uuid REFERENCES public.stock_categories(id) ON DELETE SET NULL,
  name text NOT NULL,
  sku text,
  barcode text,
  description text,
  base_unit text NOT NULL DEFAULT 'g',
  purchase_unit text NOT NULL DEFAULT 'kg',
  purchase_to_base numeric NOT NULL DEFAULT 1000,
  min_level numeric NOT NULL DEFAULT 0,
  max_level numeric,
  reorder_quantity numeric NOT NULL DEFAULT 0,
  shelf_life_days integer,
  track_batches boolean NOT NULL DEFAULT false,
  track_expiry boolean NOT NULL DEFAULT false,
  average_cost numeric NOT NULL DEFAULT 0,
  last_cost numeric NOT NULL DEFAULT 0,
  preferred_supplier_id uuid REFERENCES public.suppliers(id) ON DELETE SET NULL,
  default_location_id uuid REFERENCES public.stock_locations(id) ON DELETE SET NULL,
  active boolean NOT NULL DEFAULT true,
  created_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, name)
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.stock_items TO authenticated;
GRANT ALL ON public.stock_items TO service_role;
ALTER TABLE public.stock_items ENABLE ROW LEVEL SECURITY;
CREATE POLICY stock_items_select ON public.stock_items FOR SELECT TO authenticated USING (organization_id = current_org_id());
CREATE POLICY stock_items_write ON public.stock_items FOR ALL TO authenticated
  USING (organization_id = current_org_id() AND has_permission('inventory','items.manage'))
  WITH CHECK (organization_id = current_org_id() AND has_permission('inventory','items.manage'));
CREATE TRIGGER stock_items_touch BEFORE UPDATE ON public.stock_items FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();
CREATE INDEX stock_items_category_idx ON public.stock_items (organization_id, category_id);

-- ---------- Supplier price list ----------
CREATE TABLE public.supplier_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  supplier_id uuid NOT NULL REFERENCES public.suppliers(id) ON DELETE CASCADE,
  stock_item_id uuid NOT NULL REFERENCES public.stock_items(id) ON DELETE CASCADE,
  supplier_sku text,
  pack_unit text NOT NULL DEFAULT 'kg',
  pack_size numeric NOT NULL DEFAULT 1,
  unit_price numeric NOT NULL DEFAULT 0,
  previous_price numeric,
  lead_time_days integer NOT NULL DEFAULT 1,
  last_quoted_at timestamptz,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (supplier_id, stock_item_id)
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.supplier_items TO authenticated;
GRANT ALL ON public.supplier_items TO service_role;
ALTER TABLE public.supplier_items ENABLE ROW LEVEL SECURITY;
CREATE POLICY supplier_items_select ON public.supplier_items FOR SELECT TO authenticated USING (organization_id = current_org_id());
CREATE POLICY supplier_items_write ON public.supplier_items FOR ALL TO authenticated
  USING (organization_id = current_org_id() AND has_permission('procurement','suppliers.manage'))
  WITH CHECK (organization_id = current_org_id() AND has_permission('procurement','suppliers.manage'));
CREATE TRIGGER supplier_items_touch BEFORE UPDATE ON public.supplier_items FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

-- ---------- Batches ----------
CREATE TABLE public.stock_batches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  stock_item_id uuid NOT NULL REFERENCES public.stock_items(id) ON DELETE CASCADE,
  location_id uuid NOT NULL REFERENCES public.stock_locations(id) ON DELETE CASCADE,
  batch_number text,
  expiry_date date,
  quantity numeric NOT NULL DEFAULT 0,
  unit_cost numeric NOT NULL DEFAULT 0,
  received_at timestamptz NOT NULL DEFAULT now(),
  status text NOT NULL DEFAULT 'active',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.stock_batches TO authenticated;
GRANT ALL ON public.stock_batches TO service_role;
ALTER TABLE public.stock_batches ENABLE ROW LEVEL SECURITY;
CREATE POLICY stock_batches_select ON public.stock_batches FOR SELECT TO authenticated USING (organization_id = current_org_id());
CREATE POLICY stock_batches_write ON public.stock_batches FOR ALL TO authenticated
  USING (organization_id = current_org_id() AND has_permission('inventory','stock.manage'))
  WITH CHECK (organization_id = current_org_id() AND has_permission('inventory','stock.manage'));
CREATE TRIGGER stock_batches_touch BEFORE UPDATE ON public.stock_batches FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();
CREATE INDEX stock_batches_item_idx ON public.stock_batches (stock_item_id, location_id, expiry_date);

-- ---------- Stock levels ----------
CREATE TABLE public.stock_levels (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  stock_item_id uuid NOT NULL REFERENCES public.stock_items(id) ON DELETE CASCADE,
  location_id uuid NOT NULL REFERENCES public.stock_locations(id) ON DELETE CASCADE,
  quantity_on_hand numeric NOT NULL DEFAULT 0,
  quantity_reserved numeric NOT NULL DEFAULT 0,
  quantity_damaged numeric NOT NULL DEFAULT 0,
  quantity_expired numeric NOT NULL DEFAULT 0,
  opening_balance numeric NOT NULL DEFAULT 0,
  last_movement_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (stock_item_id, location_id)
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.stock_levels TO authenticated;
GRANT ALL ON public.stock_levels TO service_role;
ALTER TABLE public.stock_levels ENABLE ROW LEVEL SECURITY;
CREATE POLICY stock_levels_select ON public.stock_levels FOR SELECT TO authenticated USING (organization_id = current_org_id());
CREATE POLICY stock_levels_write ON public.stock_levels FOR ALL TO authenticated
  USING (organization_id = current_org_id() AND has_permission('inventory','stock.manage'))
  WITH CHECK (organization_id = current_org_id() AND has_permission('inventory','stock.manage'));
CREATE TRIGGER stock_levels_touch BEFORE UPDATE ON public.stock_levels FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

-- ---------- Movement ledger ----------
CREATE TABLE public.stock_movements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  branch_id uuid REFERENCES public.branches(id) ON DELETE SET NULL,
  stock_item_id uuid NOT NULL REFERENCES public.stock_items(id) ON DELETE CASCADE,
  location_id uuid REFERENCES public.stock_locations(id) ON DELETE SET NULL,
  counterparty_location_id uuid REFERENCES public.stock_locations(id) ON DELETE SET NULL,
  batch_id uuid REFERENCES public.stock_batches(id) ON DELETE SET NULL,
  movement_type text NOT NULL,
  quantity numeric NOT NULL,
  unit text,
  unit_cost numeric NOT NULL DEFAULT 0,
  value numeric NOT NULL DEFAULT 0,
  balance_after numeric,
  reference_type text,
  reference_id uuid,
  reason text,
  notes text,
  idempotency_key text,
  performed_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, idempotency_key)
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.stock_movements TO authenticated;
GRANT ALL ON public.stock_movements TO service_role;
ALTER TABLE public.stock_movements ENABLE ROW LEVEL SECURITY;
CREATE POLICY stock_movements_select ON public.stock_movements FOR SELECT TO authenticated USING (organization_id = current_org_id());
CREATE POLICY stock_movements_write ON public.stock_movements FOR ALL TO authenticated
  USING (organization_id = current_org_id() AND has_permission('inventory','stock.manage'))
  WITH CHECK (organization_id = current_org_id() AND has_permission('inventory','stock.manage'));
CREATE INDEX stock_movements_item_idx ON public.stock_movements (organization_id, stock_item_id, created_at DESC);

-- ---------- Transfers ----------
CREATE TABLE public.stock_transfers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  branch_id uuid REFERENCES public.branches(id) ON DELETE SET NULL,
  transfer_number text,
  from_location_id uuid NOT NULL REFERENCES public.stock_locations(id) ON DELETE RESTRICT,
  to_location_id uuid NOT NULL REFERENCES public.stock_locations(id) ON DELETE RESTRICT,
  status text NOT NULL DEFAULT 'draft',
  reason text,
  notes text,
  requested_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  dispatched_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  received_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  dispatched_at timestamptz,
  received_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.stock_transfers TO authenticated;
GRANT ALL ON public.stock_transfers TO service_role;
ALTER TABLE public.stock_transfers ENABLE ROW LEVEL SECURITY;
CREATE POLICY stock_transfers_select ON public.stock_transfers FOR SELECT TO authenticated USING (organization_id = current_org_id());
CREATE POLICY stock_transfers_write ON public.stock_transfers FOR ALL TO authenticated
  USING (organization_id = current_org_id() AND has_permission('inventory','transfers.manage'))
  WITH CHECK (organization_id = current_org_id() AND has_permission('inventory','transfers.manage'));
CREATE TRIGGER stock_transfers_touch BEFORE UPDATE ON public.stock_transfers FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

CREATE TABLE public.stock_transfer_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  transfer_id uuid NOT NULL REFERENCES public.stock_transfers(id) ON DELETE CASCADE,
  stock_item_id uuid NOT NULL REFERENCES public.stock_items(id) ON DELETE RESTRICT,
  quantity numeric NOT NULL DEFAULT 0,
  unit text NOT NULL DEFAULT 'g',
  received_quantity numeric NOT NULL DEFAULT 0,
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.stock_transfer_lines TO authenticated;
GRANT ALL ON public.stock_transfer_lines TO service_role;
ALTER TABLE public.stock_transfer_lines ENABLE ROW LEVEL SECURITY;
CREATE POLICY stock_transfer_lines_select ON public.stock_transfer_lines FOR SELECT TO authenticated USING (organization_id = current_org_id());
CREATE POLICY stock_transfer_lines_write ON public.stock_transfer_lines FOR ALL TO authenticated
  USING (organization_id = current_org_id() AND has_permission('inventory','transfers.manage'))
  WITH CHECK (organization_id = current_org_id() AND has_permission('inventory','transfers.manage'));
CREATE TRIGGER stock_transfer_lines_touch BEFORE UPDATE ON public.stock_transfer_lines FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

-- ---------- Adjustments ----------
CREATE TABLE public.stock_adjustments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  branch_id uuid REFERENCES public.branches(id) ON DELETE SET NULL,
  adjustment_number text,
  location_id uuid NOT NULL REFERENCES public.stock_locations(id) ON DELETE RESTRICT,
  reason text NOT NULL DEFAULT 'data-correction',
  status text NOT NULL DEFAULT 'pending',
  notes text,
  total_value numeric NOT NULL DEFAULT 0,
  approval_request_id uuid REFERENCES public.approval_requests(id) ON DELETE SET NULL,
  requested_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  approved_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  approved_at timestamptz,
  posted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.stock_adjustments TO authenticated;
GRANT ALL ON public.stock_adjustments TO service_role;
ALTER TABLE public.stock_adjustments ENABLE ROW LEVEL SECURITY;
CREATE POLICY stock_adjustments_select ON public.stock_adjustments FOR SELECT TO authenticated USING (organization_id = current_org_id());
CREATE POLICY stock_adjustments_write ON public.stock_adjustments FOR ALL TO authenticated
  USING (organization_id = current_org_id() AND has_permission('inventory','adjustments.manage'))
  WITH CHECK (organization_id = current_org_id() AND has_permission('inventory','adjustments.manage'));
CREATE TRIGGER stock_adjustments_touch BEFORE UPDATE ON public.stock_adjustments FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

CREATE TABLE public.stock_adjustment_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  adjustment_id uuid NOT NULL REFERENCES public.stock_adjustments(id) ON DELETE CASCADE,
  stock_item_id uuid NOT NULL REFERENCES public.stock_items(id) ON DELETE RESTRICT,
  quantity numeric NOT NULL DEFAULT 0,
  unit text NOT NULL DEFAULT 'g',
  unit_cost numeric NOT NULL DEFAULT 0,
  reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.stock_adjustment_lines TO authenticated;
GRANT ALL ON public.stock_adjustment_lines TO service_role;
ALTER TABLE public.stock_adjustment_lines ENABLE ROW LEVEL SECURITY;
CREATE POLICY stock_adjustment_lines_select ON public.stock_adjustment_lines FOR SELECT TO authenticated USING (organization_id = current_org_id());
CREATE POLICY stock_adjustment_lines_write ON public.stock_adjustment_lines FOR ALL TO authenticated
  USING (organization_id = current_org_id() AND has_permission('inventory','adjustments.manage'))
  WITH CHECK (organization_id = current_org_id() AND has_permission('inventory','adjustments.manage'));
CREATE TRIGGER stock_adjustment_lines_touch BEFORE UPDATE ON public.stock_adjustment_lines FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

-- ---------- Stock takes ----------
CREATE TABLE public.stock_takes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  branch_id uuid REFERENCES public.branches(id) ON DELETE SET NULL,
  reference text,
  location_id uuid NOT NULL REFERENCES public.stock_locations(id) ON DELETE RESTRICT,
  count_type text NOT NULL DEFAULT 'scheduled',
  status text NOT NULL DEFAULT 'open',
  scheduled_for date,
  started_at timestamptz,
  completed_at timestamptz,
  variance_value numeric NOT NULL DEFAULT 0,
  counted_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  approved_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.stock_takes TO authenticated;
GRANT ALL ON public.stock_takes TO service_role;
ALTER TABLE public.stock_takes ENABLE ROW LEVEL SECURITY;
CREATE POLICY stock_takes_select ON public.stock_takes FOR SELECT TO authenticated USING (organization_id = current_org_id());
CREATE POLICY stock_takes_write ON public.stock_takes FOR ALL TO authenticated
  USING (organization_id = current_org_id() AND has_permission('inventory','stocktake.manage'))
  WITH CHECK (organization_id = current_org_id() AND has_permission('inventory','stocktake.manage'));
CREATE TRIGGER stock_takes_touch BEFORE UPDATE ON public.stock_takes FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

CREATE TABLE public.stock_take_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  stock_take_id uuid NOT NULL REFERENCES public.stock_takes(id) ON DELETE CASCADE,
  stock_item_id uuid NOT NULL REFERENCES public.stock_items(id) ON DELETE RESTRICT,
  system_quantity numeric NOT NULL DEFAULT 0,
  counted_quantity numeric,
  variance numeric NOT NULL DEFAULT 0,
  unit text NOT NULL DEFAULT 'g',
  unit_cost numeric NOT NULL DEFAULT 0,
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.stock_take_lines TO authenticated;
GRANT ALL ON public.stock_take_lines TO service_role;
ALTER TABLE public.stock_take_lines ENABLE ROW LEVEL SECURITY;
CREATE POLICY stock_take_lines_select ON public.stock_take_lines FOR SELECT TO authenticated USING (organization_id = current_org_id());
CREATE POLICY stock_take_lines_write ON public.stock_take_lines FOR ALL TO authenticated
  USING (organization_id = current_org_id() AND has_permission('inventory','stocktake.manage'))
  WITH CHECK (organization_id = current_org_id() AND has_permission('inventory','stocktake.manage'));
CREATE TRIGGER stock_take_lines_touch BEFORE UPDATE ON public.stock_take_lines FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

-- ---------- Purchase requests ----------
CREATE TABLE public.purchase_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  branch_id uuid REFERENCES public.branches(id) ON DELETE SET NULL,
  department_id uuid REFERENCES public.departments(id) ON DELETE SET NULL,
  request_number text,
  title text,
  status text NOT NULL DEFAULT 'draft',
  priority text NOT NULL DEFAULT 'normal',
  source text NOT NULL DEFAULT 'manual',
  needed_by date,
  justification text,
  estimated_total numeric NOT NULL DEFAULT 0,
  approval_request_id uuid REFERENCES public.approval_requests(id) ON DELETE SET NULL,
  requested_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  approved_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  approved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.purchase_requests TO authenticated;
GRANT ALL ON public.purchase_requests TO service_role;
ALTER TABLE public.purchase_requests ENABLE ROW LEVEL SECURITY;
CREATE POLICY purchase_requests_select ON public.purchase_requests FOR SELECT TO authenticated USING (organization_id = current_org_id());
CREATE POLICY purchase_requests_write ON public.purchase_requests FOR ALL TO authenticated
  USING (organization_id = current_org_id() AND has_permission('procurement','requests.manage'))
  WITH CHECK (organization_id = current_org_id() AND has_permission('procurement','requests.manage'));
CREATE TRIGGER purchase_requests_touch BEFORE UPDATE ON public.purchase_requests FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

CREATE TABLE public.purchase_request_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  request_id uuid NOT NULL REFERENCES public.purchase_requests(id) ON DELETE CASCADE,
  stock_item_id uuid REFERENCES public.stock_items(id) ON DELETE SET NULL,
  description text,
  quantity numeric NOT NULL DEFAULT 0,
  unit text NOT NULL DEFAULT 'kg',
  estimated_unit_price numeric NOT NULL DEFAULT 0,
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.purchase_request_lines TO authenticated;
GRANT ALL ON public.purchase_request_lines TO service_role;
ALTER TABLE public.purchase_request_lines ENABLE ROW LEVEL SECURITY;
CREATE POLICY purchase_request_lines_select ON public.purchase_request_lines FOR SELECT TO authenticated USING (organization_id = current_org_id());
CREATE POLICY purchase_request_lines_write ON public.purchase_request_lines FOR ALL TO authenticated
  USING (organization_id = current_org_id() AND has_permission('procurement','requests.manage'))
  WITH CHECK (organization_id = current_org_id() AND has_permission('procurement','requests.manage'));
CREATE TRIGGER purchase_request_lines_touch BEFORE UPDATE ON public.purchase_request_lines FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

-- ---------- Supplier quotations ----------
CREATE TABLE public.supplier_quotations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  supplier_id uuid NOT NULL REFERENCES public.suppliers(id) ON DELETE CASCADE,
  request_id uuid REFERENCES public.purchase_requests(id) ON DELETE SET NULL,
  quotation_number text,
  status text NOT NULL DEFAULT 'received',
  valid_until date,
  total_amount numeric NOT NULL DEFAULT 0,
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.supplier_quotations TO authenticated;
GRANT ALL ON public.supplier_quotations TO service_role;
ALTER TABLE public.supplier_quotations ENABLE ROW LEVEL SECURITY;
CREATE POLICY supplier_quotations_select ON public.supplier_quotations FOR SELECT TO authenticated USING (organization_id = current_org_id());
CREATE POLICY supplier_quotations_write ON public.supplier_quotations FOR ALL TO authenticated
  USING (organization_id = current_org_id() AND has_permission('procurement','orders.manage'))
  WITH CHECK (organization_id = current_org_id() AND has_permission('procurement','orders.manage'));
CREATE TRIGGER supplier_quotations_touch BEFORE UPDATE ON public.supplier_quotations FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

CREATE TABLE public.supplier_quotation_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  quotation_id uuid NOT NULL REFERENCES public.supplier_quotations(id) ON DELETE CASCADE,
  stock_item_id uuid REFERENCES public.stock_items(id) ON DELETE SET NULL,
  description text,
  quantity numeric NOT NULL DEFAULT 0,
  unit text NOT NULL DEFAULT 'kg',
  unit_price numeric NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.supplier_quotation_lines TO authenticated;
GRANT ALL ON public.supplier_quotation_lines TO service_role;
ALTER TABLE public.supplier_quotation_lines ENABLE ROW LEVEL SECURITY;
CREATE POLICY supplier_quotation_lines_select ON public.supplier_quotation_lines FOR SELECT TO authenticated USING (organization_id = current_org_id());
CREATE POLICY supplier_quotation_lines_write ON public.supplier_quotation_lines FOR ALL TO authenticated
  USING (organization_id = current_org_id() AND has_permission('procurement','orders.manage'))
  WITH CHECK (organization_id = current_org_id() AND has_permission('procurement','orders.manage'));
CREATE TRIGGER supplier_quotation_lines_touch BEFORE UPDATE ON public.supplier_quotation_lines FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

-- ---------- Purchase orders ----------
CREATE TABLE public.purchase_orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  branch_id uuid REFERENCES public.branches(id) ON DELETE SET NULL,
  supplier_id uuid NOT NULL REFERENCES public.suppliers(id) ON DELETE RESTRICT,
  request_id uuid REFERENCES public.purchase_requests(id) ON DELETE SET NULL,
  quotation_id uuid REFERENCES public.supplier_quotations(id) ON DELETE SET NULL,
  order_number text,
  status text NOT NULL DEFAULT 'draft',
  expected_date date,
  deliver_to_location_id uuid REFERENCES public.stock_locations(id) ON DELETE SET NULL,
  subtotal numeric NOT NULL DEFAULT 0,
  tax_amount numeric NOT NULL DEFAULT 0,
  total_amount numeric NOT NULL DEFAULT 0,
  currency text NOT NULL DEFAULT 'KES',
  notes text,
  approval_request_id uuid REFERENCES public.approval_requests(id) ON DELETE SET NULL,
  created_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  approved_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  approved_at timestamptz,
  sent_at timestamptz,
  closed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.purchase_orders TO authenticated;
GRANT ALL ON public.purchase_orders TO service_role;
ALTER TABLE public.purchase_orders ENABLE ROW LEVEL SECURITY;
CREATE POLICY purchase_orders_select ON public.purchase_orders FOR SELECT TO authenticated USING (organization_id = current_org_id());
CREATE POLICY purchase_orders_write ON public.purchase_orders FOR ALL TO authenticated
  USING (organization_id = current_org_id() AND has_permission('procurement','orders.manage'))
  WITH CHECK (organization_id = current_org_id() AND has_permission('procurement','orders.manage'));
CREATE TRIGGER purchase_orders_touch BEFORE UPDATE ON public.purchase_orders FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

CREATE TABLE public.purchase_order_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  order_id uuid NOT NULL REFERENCES public.purchase_orders(id) ON DELETE CASCADE,
  stock_item_id uuid REFERENCES public.stock_items(id) ON DELETE SET NULL,
  description text,
  quantity numeric NOT NULL DEFAULT 0,
  unit text NOT NULL DEFAULT 'kg',
  unit_price numeric NOT NULL DEFAULT 0,
  received_quantity numeric NOT NULL DEFAULT 0,
  line_total numeric NOT NULL DEFAULT 0,
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.purchase_order_lines TO authenticated;
GRANT ALL ON public.purchase_order_lines TO service_role;
ALTER TABLE public.purchase_order_lines ENABLE ROW LEVEL SECURITY;
CREATE POLICY purchase_order_lines_select ON public.purchase_order_lines FOR SELECT TO authenticated USING (organization_id = current_org_id());
CREATE POLICY purchase_order_lines_write ON public.purchase_order_lines FOR ALL TO authenticated
  USING (organization_id = current_org_id() AND has_permission('procurement','orders.manage'))
  WITH CHECK (organization_id = current_org_id() AND has_permission('procurement','orders.manage'));
CREATE TRIGGER purchase_order_lines_touch BEFORE UPDATE ON public.purchase_order_lines FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

-- ---------- Goods received notes ----------
CREATE TABLE public.goods_receipts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  branch_id uuid REFERENCES public.branches(id) ON DELETE SET NULL,
  order_id uuid REFERENCES public.purchase_orders(id) ON DELETE SET NULL,
  supplier_id uuid NOT NULL REFERENCES public.suppliers(id) ON DELETE RESTRICT,
  location_id uuid NOT NULL REFERENCES public.stock_locations(id) ON DELETE RESTRICT,
  grn_number text,
  status text NOT NULL DEFAULT 'draft',
  delivery_note_number text,
  supplier_invoice_number text,
  received_at timestamptz NOT NULL DEFAULT now(),
  is_partial boolean NOT NULL DEFAULT false,
  total_value numeric NOT NULL DEFAULT 0,
  notes text,
  received_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  posted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.goods_receipts TO authenticated;
GRANT ALL ON public.goods_receipts TO service_role;
ALTER TABLE public.goods_receipts ENABLE ROW LEVEL SECURITY;
CREATE POLICY goods_receipts_select ON public.goods_receipts FOR SELECT TO authenticated USING (organization_id = current_org_id());
CREATE POLICY goods_receipts_write ON public.goods_receipts FOR ALL TO authenticated
  USING (organization_id = current_org_id() AND has_permission('procurement','receiving.manage'))
  WITH CHECK (organization_id = current_org_id() AND has_permission('procurement','receiving.manage'));
CREATE TRIGGER goods_receipts_touch BEFORE UPDATE ON public.goods_receipts FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

CREATE TABLE public.goods_receipt_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  receipt_id uuid NOT NULL REFERENCES public.goods_receipts(id) ON DELETE CASCADE,
  order_line_id uuid REFERENCES public.purchase_order_lines(id) ON DELETE SET NULL,
  stock_item_id uuid NOT NULL REFERENCES public.stock_items(id) ON DELETE RESTRICT,
  quantity_ordered numeric NOT NULL DEFAULT 0,
  quantity_received numeric NOT NULL DEFAULT 0,
  quantity_damaged numeric NOT NULL DEFAULT 0,
  unit text NOT NULL DEFAULT 'kg',
  unit_price numeric NOT NULL DEFAULT 0,
  batch_number text,
  expiry_date date,
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.goods_receipt_lines TO authenticated;
GRANT ALL ON public.goods_receipt_lines TO service_role;
ALTER TABLE public.goods_receipt_lines ENABLE ROW LEVEL SECURITY;
CREATE POLICY goods_receipt_lines_select ON public.goods_receipt_lines FOR SELECT TO authenticated USING (organization_id = current_org_id());
CREATE POLICY goods_receipt_lines_write ON public.goods_receipt_lines FOR ALL TO authenticated
  USING (organization_id = current_org_id() AND has_permission('procurement','receiving.manage'))
  WITH CHECK (organization_id = current_org_id() AND has_permission('procurement','receiving.manage'));
CREATE TRIGGER goods_receipt_lines_touch BEFORE UPDATE ON public.goods_receipt_lines FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

-- ---------- Supplier invoices & returns ----------
CREATE TABLE public.supplier_invoices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  supplier_id uuid NOT NULL REFERENCES public.suppliers(id) ON DELETE RESTRICT,
  order_id uuid REFERENCES public.purchase_orders(id) ON DELETE SET NULL,
  receipt_id uuid REFERENCES public.goods_receipts(id) ON DELETE SET NULL,
  invoice_number text NOT NULL,
  invoice_date date,
  due_date date,
  amount numeric NOT NULL DEFAULT 0,
  matched_amount numeric NOT NULL DEFAULT 0,
  variance numeric NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'pending',
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.supplier_invoices TO authenticated;
GRANT ALL ON public.supplier_invoices TO service_role;
ALTER TABLE public.supplier_invoices ENABLE ROW LEVEL SECURITY;
CREATE POLICY supplier_invoices_select ON public.supplier_invoices FOR SELECT TO authenticated USING (organization_id = current_org_id());
CREATE POLICY supplier_invoices_write ON public.supplier_invoices FOR ALL TO authenticated
  USING (organization_id = current_org_id() AND has_permission('procurement','invoices.manage'))
  WITH CHECK (organization_id = current_org_id() AND has_permission('procurement','invoices.manage'));
CREATE TRIGGER supplier_invoices_touch BEFORE UPDATE ON public.supplier_invoices FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

CREATE TABLE public.supplier_returns (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  supplier_id uuid NOT NULL REFERENCES public.suppliers(id) ON DELETE RESTRICT,
  receipt_id uuid REFERENCES public.goods_receipts(id) ON DELETE SET NULL,
  location_id uuid REFERENCES public.stock_locations(id) ON DELETE SET NULL,
  return_number text,
  reason text,
  status text NOT NULL DEFAULT 'draft',
  total_value numeric NOT NULL DEFAULT 0,
  notes text,
  created_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  posted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.supplier_returns TO authenticated;
GRANT ALL ON public.supplier_returns TO service_role;
ALTER TABLE public.supplier_returns ENABLE ROW LEVEL SECURITY;
CREATE POLICY supplier_returns_select ON public.supplier_returns FOR SELECT TO authenticated USING (organization_id = current_org_id());
CREATE POLICY supplier_returns_write ON public.supplier_returns FOR ALL TO authenticated
  USING (organization_id = current_org_id() AND has_permission('procurement','receiving.manage'))
  WITH CHECK (organization_id = current_org_id() AND has_permission('procurement','receiving.manage'));
CREATE TRIGGER supplier_returns_touch BEFORE UPDATE ON public.supplier_returns FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

CREATE TABLE public.supplier_return_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  return_id uuid NOT NULL REFERENCES public.supplier_returns(id) ON DELETE CASCADE,
  stock_item_id uuid NOT NULL REFERENCES public.stock_items(id) ON DELETE RESTRICT,
  quantity numeric NOT NULL DEFAULT 0,
  unit text NOT NULL DEFAULT 'kg',
  unit_cost numeric NOT NULL DEFAULT 0,
  reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.supplier_return_lines TO authenticated;
GRANT ALL ON public.supplier_return_lines TO service_role;
ALTER TABLE public.supplier_return_lines ENABLE ROW LEVEL SECURITY;
CREATE POLICY supplier_return_lines_select ON public.supplier_return_lines FOR SELECT TO authenticated USING (organization_id = current_org_id());
CREATE POLICY supplier_return_lines_write ON public.supplier_return_lines FOR ALL TO authenticated
  USING (organization_id = current_org_id() AND has_permission('procurement','receiving.manage'))
  WITH CHECK (organization_id = current_org_id() AND has_permission('procurement','receiving.manage'));
CREATE TRIGGER supplier_return_lines_touch BEFORE UPDATE ON public.supplier_return_lines FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

-- ---------- Inventory AI insights ----------
CREATE TABLE public.inventory_ai_insights (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  branch_id uuid REFERENCES public.branches(id) ON DELETE SET NULL,
  stock_item_id uuid REFERENCES public.stock_items(id) ON DELETE CASCADE,
  supplier_id uuid REFERENCES public.suppliers(id) ON DELETE SET NULL,
  insight_type text NOT NULL,
  title text NOT NULL,
  body text,
  severity text NOT NULL DEFAULT 'info',
  recommendation text,
  metrics jsonb NOT NULL DEFAULT '{}'::jsonb,
  acknowledged_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  acknowledged_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.inventory_ai_insights TO authenticated;
GRANT ALL ON public.inventory_ai_insights TO service_role;
ALTER TABLE public.inventory_ai_insights ENABLE ROW LEVEL SECURITY;
CREATE POLICY inventory_ai_insights_select ON public.inventory_ai_insights FOR SELECT TO authenticated USING (organization_id = current_org_id());
CREATE POLICY inventory_ai_insights_write ON public.inventory_ai_insights FOR ALL TO authenticated
  USING (organization_id = current_org_id() AND has_permission('inventory','stock.manage'))
  WITH CHECK (organization_id = current_org_id() AND has_permission('inventory','stock.manage'));
CREATE TRIGGER inventory_ai_insights_touch BEFORE UPDATE ON public.inventory_ai_insights FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

-- =========================================================
-- Functions
-- =========================================================

-- Convert a quantity between two units (same dimension), falling back to 1:1.
CREATE OR REPLACE FUNCTION public.inventory_convert(_qty numeric, _from text, _to text)
RETURNS numeric
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  f record;
  t record;
BEGIN
  IF _from IS NULL OR _to IS NULL OR lower(_from) = lower(_to) THEN RETURN _qty; END IF;
  SELECT * INTO f FROM uom_units WHERE lower(code) = lower(_from) AND (organization_id IS NULL OR organization_id = current_org_id())
    ORDER BY organization_id NULLS LAST LIMIT 1;
  SELECT * INTO t FROM uom_units WHERE lower(code) = lower(_to) AND (organization_id IS NULL OR organization_id = current_org_id())
    ORDER BY organization_id NULLS LAST LIMIT 1;
  IF f IS NULL OR t IS NULL OR f.base_code <> t.base_code THEN RETURN _qty; END IF;
  RETURN _qty * f.factor_to_base / NULLIF(t.factor_to_base, 0);
END;
$$;
REVOKE EXECUTE ON FUNCTION public.inventory_convert(numeric, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.inventory_convert(numeric, text, text) TO authenticated;

-- Post a single stock movement and keep levels, batches and average cost in sync.
CREATE OR REPLACE FUNCTION public.inventory_apply_movement(
  _item uuid,
  _location uuid,
  _quantity numeric,
  _unit text,
  _movement_type text,
  _unit_cost numeric DEFAULT NULL,
  _reference_type text DEFAULT NULL,
  _reference_id uuid DEFAULT NULL,
  _reason text DEFAULT NULL,
  _idempotency_key text DEFAULT NULL,
  _batch_number text DEFAULT NULL,
  _expiry date DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_org uuid := current_org_id();
  v_item record;
  v_qty_base numeric;
  v_cost numeric;
  v_level record;
  v_batch uuid;
  v_movement uuid;
  v_existing uuid;
BEGIN
  IF v_org IS NULL THEN RAISE EXCEPTION 'No active organization'; END IF;
  IF NOT (has_permission('inventory','stock.manage') OR has_permission('procurement','receiving.manage')) THEN
    RAISE EXCEPTION 'Not permitted to move stock';
  END IF;

  IF _idempotency_key IS NOT NULL THEN
    SELECT id INTO v_existing FROM stock_movements WHERE organization_id = v_org AND idempotency_key = _idempotency_key;
    IF v_existing IS NOT NULL THEN RETURN v_existing; END IF;
  END IF;

  SELECT * INTO v_item FROM stock_items WHERE id = _item AND organization_id = v_org;
  IF v_item IS NULL THEN RAISE EXCEPTION 'Unknown stock item'; END IF;

  v_qty_base := inventory_convert(_quantity, COALESCE(_unit, v_item.base_unit), v_item.base_unit);
  v_cost := COALESCE(_unit_cost, v_item.average_cost);

  INSERT INTO stock_levels (organization_id, stock_item_id, location_id, quantity_on_hand, last_movement_at)
  VALUES (v_org, _item, _location, 0, now())
  ON CONFLICT (stock_item_id, location_id) DO NOTHING;

  SELECT * INTO v_level FROM stock_levels WHERE stock_item_id = _item AND location_id = _location FOR UPDATE;

  IF v_qty_base > 0 AND (v_item.track_batches OR _batch_number IS NOT NULL OR _expiry IS NOT NULL) THEN
    INSERT INTO stock_batches (organization_id, stock_item_id, location_id, batch_number, expiry_date, quantity, unit_cost)
    VALUES (v_org, _item, _location, _batch_number, _expiry, v_qty_base, v_cost)
    RETURNING id INTO v_batch;
  ELSIF v_qty_base < 0 THEN
    SELECT id INTO v_batch FROM stock_batches
      WHERE stock_item_id = _item AND location_id = _location AND quantity > 0 AND status = 'active'
      ORDER BY expiry_date NULLS LAST, received_at LIMIT 1;
    IF v_batch IS NOT NULL THEN
      UPDATE stock_batches SET quantity = GREATEST(0, quantity + v_qty_base) WHERE id = v_batch;
    END IF;
  END IF;

  UPDATE stock_levels
     SET quantity_on_hand = quantity_on_hand + v_qty_base,
         quantity_damaged = quantity_damaged + CASE WHEN _movement_type = 'damage' THEN abs(v_qty_base) ELSE 0 END,
         quantity_expired = quantity_expired + CASE WHEN _movement_type = 'expiry' THEN abs(v_qty_base) ELSE 0 END,
         last_movement_at = now()
   WHERE id = v_level.id;

  IF v_qty_base > 0 AND _unit_cost IS NOT NULL THEN
    UPDATE stock_items
       SET last_cost = v_cost,
           average_cost = CASE
             WHEN COALESCE(v_level.quantity_on_hand, 0) + v_qty_base <= 0 THEN v_cost
             ELSE ((GREATEST(v_level.quantity_on_hand, 0) * average_cost) + (v_qty_base * v_cost))
                  / (GREATEST(v_level.quantity_on_hand, 0) + v_qty_base)
           END
     WHERE id = _item;
  END IF;

  INSERT INTO stock_movements (
    organization_id, branch_id, stock_item_id, location_id, batch_id, movement_type,
    quantity, unit, unit_cost, value, balance_after, reference_type, reference_id,
    reason, idempotency_key, performed_by
  ) VALUES (
    v_org, v_item.branch_id, _item, _location, v_batch, _movement_type,
    v_qty_base, v_item.base_unit, v_cost, v_qty_base * v_cost,
    (SELECT quantity_on_hand FROM stock_levels WHERE id = v_level.id),
    _reference_type, _reference_id, _reason, _idempotency_key, auth.uid()
  ) RETURNING id INTO v_movement;

  RETURN v_movement;
END;
$$;
REVOKE EXECUTE ON FUNCTION public.inventory_apply_movement(uuid,uuid,numeric,text,text,numeric,text,uuid,text,text,text,date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.inventory_apply_movement(uuid,uuid,numeric,text,text,numeric,text,uuid,text,text,text,date) TO authenticated;

-- Post a goods received note: increases stock, updates PO progress and supplier prices.
CREATE OR REPLACE FUNCTION public.inventory_post_receipt(_receipt uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_org uuid := current_org_id();
  r record;
  l record;
  v_total numeric := 0;
  v_lines integer := 0;
BEGIN
  IF NOT has_permission('procurement','receiving.manage') THEN RAISE EXCEPTION 'Not permitted to receive stock'; END IF;
  SELECT * INTO r FROM goods_receipts WHERE id = _receipt AND organization_id = v_org;
  IF r IS NULL THEN RAISE EXCEPTION 'Receipt not found'; END IF;
  IF r.status = 'posted' THEN RETURN jsonb_build_object('status','already-posted'); END IF;

  FOR l IN SELECT * FROM goods_receipt_lines WHERE receipt_id = _receipt LOOP
    IF COALESCE(l.quantity_received, 0) > 0 THEN
      PERFORM inventory_apply_movement(
        l.stock_item_id, r.location_id, l.quantity_received, l.unit, 'receipt',
        CASE WHEN l.unit_price > 0 THEN l.unit_price / NULLIF(inventory_convert(1, l.unit, (SELECT base_unit FROM stock_items WHERE id = l.stock_item_id)), 0) ELSE NULL END,
        'goods_receipt', _receipt, 'Goods received', 'grn:' || _receipt::text || ':' || l.id::text,
        l.batch_number, l.expiry_date
      );
      v_total := v_total + (l.quantity_received * l.unit_price);
      v_lines := v_lines + 1;
    END IF;
    IF COALESCE(l.quantity_damaged, 0) > 0 THEN
      PERFORM inventory_apply_movement(
        l.stock_item_id, r.location_id, -l.quantity_damaged, l.unit, 'damage', NULL,
        'goods_receipt', _receipt, 'Damaged on delivery', 'grn-damage:' || _receipt::text || ':' || l.id::text, NULL, NULL
      );
    END IF;
    IF l.order_line_id IS NOT NULL THEN
      UPDATE purchase_order_lines SET received_quantity = received_quantity + COALESCE(l.quantity_received, 0)
        WHERE id = l.order_line_id;
    END IF;
    UPDATE supplier_items
       SET previous_price = unit_price, unit_price = l.unit_price, last_quoted_at = now()
     WHERE supplier_id = r.supplier_id AND stock_item_id = l.stock_item_id AND l.unit_price > 0;
  END LOOP;

  UPDATE goods_receipts SET status = 'posted', posted_at = now(), total_value = v_total WHERE id = _receipt;

  IF r.order_id IS NOT NULL THEN
    UPDATE purchase_orders po SET status = CASE
      WHEN NOT EXISTS (SELECT 1 FROM purchase_order_lines pl WHERE pl.order_id = po.id AND pl.received_quantity < pl.quantity) THEN 'received'
      ELSE 'partially-received' END,
      closed_at = CASE WHEN NOT EXISTS (SELECT 1 FROM purchase_order_lines pl WHERE pl.order_id = po.id AND pl.received_quantity < pl.quantity) THEN now() ELSE NULL END
    WHERE po.id = r.order_id;
  END IF;

  RETURN jsonb_build_object('status','posted','lines',v_lines,'value',v_total);
END;
$$;
REVOKE EXECUTE ON FUNCTION public.inventory_post_receipt(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.inventory_post_receipt(uuid) TO authenticated;

-- Post a stock transfer between two locations.
CREATE OR REPLACE FUNCTION public.inventory_post_transfer(_transfer uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_org uuid := current_org_id();
  t record;
  l record;
  v_lines integer := 0;
BEGIN
  IF NOT has_permission('inventory','transfers.manage') THEN RAISE EXCEPTION 'Not permitted to transfer stock'; END IF;
  SELECT * INTO t FROM stock_transfers WHERE id = _transfer AND organization_id = v_org;
  IF t IS NULL THEN RAISE EXCEPTION 'Transfer not found'; END IF;
  IF t.status = 'completed' THEN RETURN jsonb_build_object('status','already-posted'); END IF;

  FOR l IN SELECT * FROM stock_transfer_lines WHERE transfer_id = _transfer LOOP
    PERFORM inventory_apply_movement(l.stock_item_id, t.from_location_id, -l.quantity, l.unit, 'transfer-out', NULL,
      'stock_transfer', _transfer, t.reason, 'transfer-out:' || _transfer::text || ':' || l.id::text, NULL, NULL);
    PERFORM inventory_apply_movement(l.stock_item_id, t.to_location_id, l.quantity, l.unit, 'transfer-in', NULL,
      'stock_transfer', _transfer, t.reason, 'transfer-in:' || _transfer::text || ':' || l.id::text, NULL, NULL);
    UPDATE stock_transfer_lines SET received_quantity = l.quantity WHERE id = l.id;
    v_lines := v_lines + 1;
  END LOOP;

  UPDATE stock_transfers SET status = 'completed', received_at = now(), received_by = auth.uid() WHERE id = _transfer;
  RETURN jsonb_build_object('status','completed','lines',v_lines);
END;
$$;
REVOKE EXECUTE ON FUNCTION public.inventory_post_transfer(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.inventory_post_transfer(uuid) TO authenticated;

-- Post an approved stock adjustment.
CREATE OR REPLACE FUNCTION public.inventory_post_adjustment(_adjustment uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_org uuid := current_org_id();
  a record;
  l record;
  v_value numeric := 0;
BEGIN
  IF NOT has_permission('inventory','adjustments.approve') THEN RAISE EXCEPTION 'Not permitted to approve adjustments'; END IF;
  SELECT * INTO a FROM stock_adjustments WHERE id = _adjustment AND organization_id = v_org;
  IF a IS NULL THEN RAISE EXCEPTION 'Adjustment not found'; END IF;
  IF a.status = 'posted' THEN RETURN jsonb_build_object('status','already-posted'); END IF;

  FOR l IN SELECT * FROM stock_adjustment_lines WHERE adjustment_id = _adjustment LOOP
    PERFORM inventory_apply_movement(l.stock_item_id, a.location_id, l.quantity, l.unit,
      CASE a.reason WHEN 'damaged' THEN 'damage' WHEN 'expired' THEN 'expiry' ELSE 'adjustment' END,
      NULLIF(l.unit_cost, 0), 'stock_adjustment', _adjustment, COALESCE(l.reason, a.reason),
      'adjustment:' || _adjustment::text || ':' || l.id::text, NULL, NULL);
    v_value := v_value + abs(l.quantity * COALESCE(NULLIF(l.unit_cost, 0), 0));
  END LOOP;

  UPDATE stock_adjustments SET status = 'posted', approved_by = auth.uid(), approved_at = now(),
    posted_at = now(), total_value = v_value WHERE id = _adjustment;
  RETURN jsonb_build_object('status','posted','value',v_value);
END;
$$;
REVOKE EXECUTE ON FUNCTION public.inventory_post_adjustment(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.inventory_post_adjustment(uuid) TO authenticated;

-- Close a stock take: writes variance movements for every counted line.
CREATE OR REPLACE FUNCTION public.inventory_post_stock_take(_take uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_org uuid := current_org_id();
  s record;
  l record;
  v_value numeric := 0;
BEGIN
  IF NOT has_permission('inventory','stocktake.manage') THEN RAISE EXCEPTION 'Not permitted to close stock takes'; END IF;
  SELECT * INTO s FROM stock_takes WHERE id = _take AND organization_id = v_org;
  IF s IS NULL THEN RAISE EXCEPTION 'Stock take not found'; END IF;
  IF s.status = 'closed' THEN RETURN jsonb_build_object('status','already-closed'); END IF;

  FOR l IN SELECT * FROM stock_take_lines WHERE stock_take_id = _take AND counted_quantity IS NOT NULL LOOP
    UPDATE stock_take_lines SET variance = l.counted_quantity - l.system_quantity WHERE id = l.id;
    IF l.counted_quantity <> l.system_quantity THEN
      PERFORM inventory_apply_movement(l.stock_item_id, s.location_id, l.counted_quantity - l.system_quantity, l.unit,
        'stock-take', NULL, 'stock_take', _take, 'Stock count variance',
        'stocktake:' || _take::text || ':' || l.id::text, NULL, NULL);
      v_value := v_value + ((l.counted_quantity - l.system_quantity) * COALESCE(NULLIF(l.unit_cost, 0), 0));
    END IF;
  END LOOP;

  UPDATE stock_takes SET status = 'closed', completed_at = now(), variance_value = v_value, approved_by = auth.uid() WHERE id = _take;
  RETURN jsonb_build_object('status','closed','variance',v_value);
END;
$$;
REVOKE EXECUTE ON FUNCTION public.inventory_post_stock_take(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.inventory_post_stock_take(uuid) TO authenticated;

-- Recipe-based deduction for one sold POS order item. Idempotent per order item.
CREATE OR REPLACE FUNCTION public.inventory_consume_order_item(_order_item uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_item record;
  v_recipe record;
  v_ing record;
  v_location uuid;
  v_stock uuid;
  v_qty numeric;
  v_cost numeric := 0;
  v_lines integer := 0;
  v_org uuid;
BEGIN
  SELECT oi.*, o.branch_id, o.organization_id AS org
    INTO v_item
    FROM pos_order_items oi JOIN pos_orders o ON o.id = oi.order_id
   WHERE oi.id = _order_item;
  IF v_item IS NULL THEN RETURN jsonb_build_object('status','no-item'); END IF;
  v_org := v_item.org;

  IF EXISTS (SELECT 1 FROM inventory_posting_events WHERE order_item_id = _order_item AND status = 'posted') THEN
    RETURN jsonb_build_object('status','already-posted');
  END IF;

  SELECT * INTO v_recipe FROM recipes
   WHERE organization_id = v_org AND menu_item_id = v_item.menu_item_id AND status = 'active'
   ORDER BY version DESC LIMIT 1;
  IF v_recipe IS NULL THEN RETURN jsonb_build_object('status','no-recipe'); END IF;

  SELECT id INTO v_location FROM stock_locations
   WHERE organization_id = v_org AND active
   ORDER BY (location_type = 'kitchen') DESC, is_main DESC, created_at LIMIT 1;
  IF v_location IS NULL THEN RETURN jsonb_build_object('status','no-location'); END IF;

  FOR v_ing IN SELECT * FROM recipe_ingredients WHERE recipe_id = v_recipe.id LOOP
    SELECT id INTO v_stock FROM stock_items
     WHERE organization_id = v_org
       AND (id::text = v_ing.inventory_item_ref OR lower(name) = lower(v_ing.ingredient_name))
     LIMIT 1;
    IF v_stock IS NULL THEN CONTINUE; END IF;
    v_qty := v_ing.quantity * COALESCE(v_item.quantity, 1) * (1 + COALESCE(v_ing.waste_allowance, 0) / 100.0);
    PERFORM inventory_apply_movement(v_stock, v_location, -v_qty, v_ing.unit, 'consumption', NULL,
      'pos_order_item', _order_item, 'Recipe consumption',
      'consume:' || _order_item::text || ':' || v_ing.id::text, NULL, NULL);
    v_cost := v_cost + (v_qty * COALESCE(v_ing.unit_cost, 0));
    v_lines := v_lines + 1;
  END LOOP;

  INSERT INTO inventory_posting_events (organization_id, branch_id, order_id, order_item_id, recipe_id,
    recipe_version, posting_type, idempotency_key, status, cost_snapshot, payload)
  VALUES (v_org, v_item.branch_id, v_item.order_id, _order_item, v_recipe.id, v_recipe.version,
    'consumption', 'consume:' || _order_item::text, 'posted', v_cost,
    jsonb_build_object('lines', v_lines))
  ON CONFLICT DO NOTHING;

  RETURN jsonb_build_object('status','posted','lines',v_lines,'cost',v_cost);
END;
$$;
REVOKE EXECUTE ON FUNCTION public.inventory_consume_order_item(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.inventory_consume_order_item(uuid) TO authenticated;

-- Deduct automatically once an ordered item is served/completed.
CREATE OR REPLACE FUNCTION public.inventory_order_item_consumption_trigger()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.status IN ('served','completed') AND COALESCE(OLD.status,'') <> NEW.status THEN
    BEGIN
      PERFORM inventory_consume_order_item(NEW.id);
    EXCEPTION WHEN OTHERS THEN
      NULL;
    END;
  END IF;
  RETURN NEW;
END;
$$;
REVOKE EXECUTE ON FUNCTION public.inventory_order_item_consumption_trigger() FROM PUBLIC, anon, authenticated;
CREATE TRIGGER pos_order_items_inventory_consumption
  AFTER UPDATE ON public.pos_order_items
  FOR EACH ROW EXECUTE FUNCTION public.inventory_order_item_consumption_trigger();

-- Reorder suggestions from live levels and minimum thresholds.
CREATE OR REPLACE FUNCTION public.inventory_reorder_suggestions()
RETURNS TABLE (
  stock_item_id uuid,
  name text,
  base_unit text,
  on_hand numeric,
  min_level numeric,
  suggested_quantity numeric,
  average_cost numeric,
  preferred_supplier_id uuid,
  supplier_name text
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT i.id, i.name, i.base_unit,
         COALESCE(SUM(l.quantity_on_hand), 0) AS on_hand,
         i.min_level,
         GREATEST(COALESCE(NULLIF(i.reorder_quantity, 0), i.min_level * 2) - COALESCE(SUM(l.quantity_on_hand), 0), 0) AS suggested_quantity,
         i.average_cost, i.preferred_supplier_id, s.name
    FROM stock_items i
    LEFT JOIN stock_levels l ON l.stock_item_id = i.id
    LEFT JOIN suppliers s ON s.id = i.preferred_supplier_id
   WHERE i.organization_id = current_org_id() AND i.active AND i.min_level > 0
   GROUP BY i.id, s.name
  HAVING COALESCE(SUM(l.quantity_on_hand), 0) <= i.min_level
   ORDER BY (COALESCE(SUM(l.quantity_on_hand), 0) / NULLIF(i.min_level, 0));
$$;
REVOKE EXECUTE ON FUNCTION public.inventory_reorder_suggestions() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.inventory_reorder_suggestions() TO authenticated;

-- Dashboard metrics.
CREATE OR REPLACE FUNCTION public.inventory_metrics(_branch uuid DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_org uuid := current_org_id();
  v jsonb;
BEGIN
  IF v_org IS NULL THEN RETURN '{}'::jsonb; END IF;
  SELECT jsonb_build_object(
    'stock_value', (SELECT COALESCE(SUM(l.quantity_on_hand * i.average_cost), 0)
                      FROM stock_levels l JOIN stock_items i ON i.id = l.stock_item_id
                     WHERE l.organization_id = v_org),
    'item_count', (SELECT COUNT(*) FROM stock_items WHERE organization_id = v_org AND active),
    'low_stock', (SELECT COUNT(*) FROM (
        SELECT i.id FROM stock_items i LEFT JOIN stock_levels l ON l.stock_item_id = i.id
         WHERE i.organization_id = v_org AND i.active AND i.min_level > 0
         GROUP BY i.id HAVING COALESCE(SUM(l.quantity_on_hand),0) <= i.min_level) q),
    'out_of_stock', (SELECT COUNT(*) FROM (
        SELECT i.id FROM stock_items i LEFT JOIN stock_levels l ON l.stock_item_id = i.id
         WHERE i.organization_id = v_org AND i.active
         GROUP BY i.id HAVING COALESCE(SUM(l.quantity_on_hand),0) <= 0) q),
    'expiring_soon', (SELECT COUNT(*) FROM stock_batches
                       WHERE organization_id = v_org AND status = 'active' AND quantity > 0
                         AND expiry_date IS NOT NULL AND expiry_date <= current_date + 7),
    'expired', (SELECT COUNT(*) FROM stock_batches
                 WHERE organization_id = v_org AND quantity > 0 AND expiry_date < current_date),
    'open_requests', (SELECT COUNT(*) FROM purchase_requests WHERE organization_id = v_org AND status IN ('draft','submitted','pending-approval')),
    'pending_approvals', (SELECT COUNT(*) FROM purchase_requests WHERE organization_id = v_org AND status = 'pending-approval')
      + (SELECT COUNT(*) FROM stock_adjustments WHERE organization_id = v_org AND status = 'pending'),
    'open_orders', (SELECT COUNT(*) FROM purchase_orders WHERE organization_id = v_org AND status IN ('draft','approved','sent','partially-received')),
    'supplier_count', (SELECT COUNT(*) FROM suppliers WHERE organization_id = v_org AND active),
    'consumption_today', (SELECT COALESCE(SUM(abs(value)), 0) FROM stock_movements
                           WHERE organization_id = v_org AND movement_type = 'consumption' AND created_at >= current_date),
    'receipts_today', (SELECT COALESCE(SUM(value), 0) FROM stock_movements
                        WHERE organization_id = v_org AND movement_type = 'receipt' AND created_at >= current_date),
    'variance_30d', (SELECT COALESCE(SUM(value), 0) FROM stock_movements
                      WHERE organization_id = v_org AND movement_type IN ('adjustment','stock-take','damage','expiry')
                        AND created_at >= now() - interval '30 days')
  ) INTO v;
  RETURN v;
END;
$$;
REVOKE EXECUTE ON FUNCTION public.inventory_metrics(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.inventory_metrics(uuid) TO authenticated;

-- Menu profitability / food cost.
CREATE OR REPLACE FUNCTION public.inventory_menu_profitability()
RETURNS TABLE (
  menu_item_id uuid,
  menu_item text,
  recipe_cost numeric,
  sale_price numeric,
  gross_profit numeric,
  margin_pct numeric,
  units_sold numeric
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH costs AS (
    SELECT r.menu_item_id, MAX(r.version) AS v
      FROM recipes r WHERE r.organization_id = current_org_id() AND r.status = 'active'
     GROUP BY r.menu_item_id
  ), rc AS (
    SELECT r.menu_item_id,
           COALESCE(SUM(ri.quantity * COALESCE(ri.unit_cost, 0)), 0) / GREATEST(COALESCE(r.yield_quantity, 1), 1) AS cost
      FROM recipes r
      JOIN costs c ON c.menu_item_id = r.menu_item_id AND c.v = r.version
      LEFT JOIN recipe_ingredients ri ON ri.recipe_id = r.id
     WHERE r.organization_id = current_org_id()
     GROUP BY r.menu_item_id, r.yield_quantity
  )
  SELECT m.id, m.name, COALESCE(rc.cost, 0),
         COALESCE(m.base_price, 0),
         COALESCE(m.base_price, 0) - COALESCE(rc.cost, 0),
         CASE WHEN COALESCE(m.base_price, 0) > 0
              THEN ((COALESCE(m.base_price, 0) - COALESCE(rc.cost, 0)) / m.base_price) * 100 ELSE 0 END,
         COALESCE((SELECT SUM(oi.quantity) FROM pos_order_items oi
                    WHERE oi.menu_item_id = m.id AND oi.created_at >= now() - interval '30 days'), 0)
    FROM menu_items m
    LEFT JOIN rc ON rc.menu_item_id = m.id
   WHERE m.organization_id = current_org_id()
   ORDER BY 7 DESC NULLS LAST;
$$;
REVOKE EXECUTE ON FUNCTION public.inventory_menu_profitability() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.inventory_menu_profitability() TO authenticated;

-- =========================================================
-- Permissions
-- =========================================================
INSERT INTO public.permissions (module, action, label)
SELECT m, a, l FROM (VALUES
  ('inventory','dashboard.view','View inventory dashboard'),
  ('inventory','items.manage','Manage stock items and categories'),
  ('inventory','stock.manage','Record stock movements'),
  ('inventory','transfers.manage','Create and post stock transfers'),
  ('inventory','adjustments.manage','Raise stock adjustments'),
  ('inventory','adjustments.approve','Approve and post stock adjustments'),
  ('inventory','stocktake.manage','Run stock takes'),
  ('inventory','reports.view','View inventory reports'),
  ('inventory','costing.view','View food cost and profitability'),
  ('inventory','settings.manage','Manage inventory settings and locations'),
  ('procurement','dashboard.view','View procurement dashboard'),
  ('procurement','suppliers.manage','Manage suppliers and price lists'),
  ('procurement','requests.manage','Raise purchase requests'),
  ('procurement','requests.approve','Approve purchase requests'),
  ('procurement','orders.manage','Create and manage purchase orders'),
  ('procurement','orders.approve','Approve purchase orders'),
  ('procurement','receiving.manage','Receive deliveries and post GRNs'),
  ('procurement','invoices.manage','Match supplier invoices'),
  ('procurement','reports.view','View procurement reports')
) AS t(m,a,l)
WHERE NOT EXISTS (SELECT 1 FROM public.permissions p WHERE p.module = t.m AND p.action = t.a);

INSERT INTO public.role_permissions (organization_id, role_id, permission_id)
SELECT r.organization_id, r.id, p.id
  FROM public.roles r
  JOIN public.permissions p ON p.module IN ('inventory','procurement')
 WHERE (
   r.name IN ('Owner','System Administrator','General Manager','Operations Manager')
   OR (r.name = 'Procurement Officer' AND p.module = 'procurement')
   OR (r.name = 'Procurement Officer' AND p.action IN ('dashboard.view','items.manage','reports.view','costing.view','stock.manage'))
   OR (r.name = 'Storekeeper' AND p.action IN ('dashboard.view','items.manage','stock.manage','transfers.manage','adjustments.manage','stocktake.manage','reports.view','receiving.manage','requests.manage','suppliers.manage'))
   OR (r.name IN ('Kitchen Manager','Restaurant Manager','Bar Manager') AND p.action IN ('dashboard.view','stock.manage','transfers.manage','requests.manage','reports.view','costing.view','stocktake.manage'))
   OR (r.name IN ('Finance Manager','Accountant') AND p.action IN ('dashboard.view','reports.view','costing.view','invoices.manage','orders.approve','requests.approve','adjustments.approve'))
   OR (r.name = 'Housekeeping Supervisor' AND p.action IN ('dashboard.view','requests.manage','transfers.manage','reports.view'))
 )
   AND NOT EXISTS (
     SELECT 1 FROM public.role_permissions rp WHERE rp.role_id = r.id AND rp.permission_id = p.id
   );
