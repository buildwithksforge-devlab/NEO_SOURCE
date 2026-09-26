
-- =====================================================================
-- PHASE 12 — Housekeeping, Laundry, Maintenance & Internal Requisitions
-- =====================================================================

-- ---------- shared helper ----------
CREATE OR REPLACE FUNCTION public.ops_touch_updated_at()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END; $$;

-- ---------- 1. HOUSEKEEPING CHECKLISTS ----------
CREATE TABLE public.housekeeping_checklist_templates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  branch_id uuid REFERENCES public.branches(id) ON DELETE CASCADE,
  name text NOT NULL,
  cleaning_type text NOT NULL DEFAULT 'checkout',
  room_type_id uuid REFERENCES public.room_types(id) ON DELETE SET NULL,
  area_scope text NOT NULL DEFAULT 'room',
  requires_inspection boolean NOT NULL DEFAULT true,
  active boolean NOT NULL DEFAULT true,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.housekeeping_checklist_templates TO authenticated;
GRANT ALL ON public.housekeeping_checklist_templates TO service_role;
ALTER TABLE public.housekeeping_checklist_templates ENABLE ROW LEVEL SECURITY;

CREATE TABLE public.housekeeping_checklist_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  template_id uuid NOT NULL REFERENCES public.housekeeping_checklist_templates(id) ON DELETE CASCADE,
  label text NOT NULL,
  response_type text NOT NULL DEFAULT 'pass-fail',
  requires_photo boolean NOT NULL DEFAULT false,
  requires_comment boolean NOT NULL DEFAULT false,
  allows_defect boolean NOT NULL DEFAULT true,
  mandatory boolean NOT NULL DEFAULT true,
  sort_order integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.housekeeping_checklist_items TO authenticated;
GRANT ALL ON public.housekeeping_checklist_items TO service_role;
ALTER TABLE public.housekeeping_checklist_items ENABLE ROW LEVEL SECURITY;

-- ---------- 2. HOUSEKEEPING JOBS ----------
CREATE TABLE public.housekeeping_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  branch_id uuid REFERENCES public.branches(id) ON DELETE CASCADE,
  job_number text,
  task_id uuid REFERENCES public.tasks(id) ON DELETE SET NULL,
  room_id uuid REFERENCES public.rooms(id) ON DELETE CASCADE,
  location_label text,
  job_type text NOT NULL DEFAULT 'checkout-cleaning',
  reservation_id uuid REFERENCES public.reservations(id) ON DELETE SET NULL,
  guest_request_id uuid REFERENCES public.guest_requests(id) ON DELETE SET NULL,
  template_id uuid REFERENCES public.housekeeping_checklist_templates(id) ON DELETE SET NULL,
  department_id uuid REFERENCES public.departments(id) ON DELETE SET NULL,
  assignee_id uuid,
  priority text NOT NULL DEFAULT 'normal',
  status text NOT NULL DEFAULT 'pending',
  due_at timestamptz,
  estimated_minutes integer,
  started_at timestamptz,
  completed_at timestamptz,
  inspection_required boolean NOT NULL DEFAULT true,
  inspection_status text NOT NULL DEFAULT 'not-required',
  rework_count integer NOT NULL DEFAULT 0,
  dnd boolean NOT NULL DEFAULT false,
  skipped_reason text,
  notes text,
  attachments jsonb NOT NULL DEFAULT '[]'::jsonb,
  idempotency_key text,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT housekeeping_jobs_priority_chk CHECK (priority IN ('low','normal','high','urgent')),
  CONSTRAINT housekeeping_jobs_idem_uniq UNIQUE (organization_id, idempotency_key)
);
CREATE INDEX idx_hk_jobs_org_status ON public.housekeeping_jobs(organization_id, status);
CREATE INDEX idx_hk_jobs_room ON public.housekeeping_jobs(room_id);
CREATE INDEX idx_hk_jobs_assignee ON public.housekeeping_jobs(assignee_id);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.housekeeping_jobs TO authenticated;
GRANT ALL ON public.housekeeping_jobs TO service_role;
ALTER TABLE public.housekeeping_jobs ENABLE ROW LEVEL SECURITY;

CREATE TABLE public.housekeeping_job_results (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  job_id uuid NOT NULL REFERENCES public.housekeeping_jobs(id) ON DELETE CASCADE,
  checklist_item_id uuid REFERENCES public.housekeeping_checklist_items(id) ON DELETE SET NULL,
  label text NOT NULL,
  result text,
  quantity numeric,
  comment text,
  photo_url text,
  defect_reported boolean NOT NULL DEFAULT false,
  work_order_id uuid,
  recorded_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (job_id, checklist_item_id)
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.housekeeping_job_results TO authenticated;
GRANT ALL ON public.housekeeping_job_results TO service_role;
ALTER TABLE public.housekeeping_job_results ENABLE ROW LEVEL SECURITY;

-- ---------- 3. ROOM INSPECTIONS ----------
CREATE TABLE public.room_inspections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  branch_id uuid REFERENCES public.branches(id) ON DELETE CASCADE,
  room_id uuid REFERENCES public.rooms(id) ON DELETE CASCADE,
  location_label text,
  job_id uuid REFERENCES public.housekeeping_jobs(id) ON DELETE SET NULL,
  inspection_type text NOT NULL DEFAULT 'standard',
  inspector_id uuid,
  result text,
  defects jsonb NOT NULL DEFAULT '[]'::jsonb,
  photos jsonb NOT NULL DEFAULT '[]'::jsonb,
  notes text,
  rework_required boolean NOT NULL DEFAULT false,
  work_order_id uuid,
  inspected_at timestamptz NOT NULL DEFAULT now(),
  released_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT room_inspections_result_chk CHECK (result IS NULL OR result IN ('passed','passed-with-notes','failed','reinspection-required'))
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.room_inspections TO authenticated;
GRANT ALL ON public.room_inspections TO service_role;
ALTER TABLE public.room_inspections ENABLE ROW LEVEL SECURITY;

-- ---------- 4. DEEP CLEAN / TURNDOWN SCHEDULES ----------
CREATE TABLE public.deep_cleaning_schedules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  branch_id uuid REFERENCES public.branches(id) ON DELETE CASCADE,
  room_id uuid REFERENCES public.rooms(id) ON DELETE CASCADE,
  location_label text,
  schedule_type text NOT NULL DEFAULT 'deep-clean',
  frequency text NOT NULL DEFAULT 'monthly',
  after_stays integer,
  last_done_on date,
  next_due_on date,
  assigned_team text,
  template_id uuid REFERENCES public.housekeeping_checklist_templates(id) ON DELETE SET NULL,
  active boolean NOT NULL DEFAULT true,
  notes text,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.deep_cleaning_schedules TO authenticated;
GRANT ALL ON public.deep_cleaning_schedules TO service_role;
ALTER TABLE public.deep_cleaning_schedules ENABLE ROW LEVEL SECURITY;

-- ---------- 5. LOST & FOUND ----------
CREATE TABLE public.lost_found_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  branch_id uuid REFERENCES public.branches(id) ON DELETE CASCADE,
  reference text,
  room_id uuid REFERENCES public.rooms(id) ON DELETE SET NULL,
  location_found text,
  found_at timestamptz NOT NULL DEFAULT now(),
  category text NOT NULL DEFAULT 'general',
  sensitive boolean NOT NULL DEFAULT false,
  description text NOT NULL,
  photo_url text,
  found_by uuid,
  customer_id uuid REFERENCES public.customers(id) ON DELETE SET NULL,
  reservation_id uuid REFERENCES public.reservations(id) ON DELETE SET NULL,
  storage_location text,
  custodian_id uuid,
  status text NOT NULL DEFAULT 'reported',
  claimant_name text,
  identity_verification text,
  released_at timestamptz,
  released_by uuid,
  disposal_at timestamptz,
  supervisor_ack_by uuid,
  supervisor_ack_at timestamptz,
  notes text,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT lost_found_status_chk CHECK (status IN ('reported','in-custody','potential-owner-identified','contacted','claimed','returned','disposed','donated','transferred-to-authorities'))
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.lost_found_items TO authenticated;
GRANT ALL ON public.lost_found_items TO service_role;
ALTER TABLE public.lost_found_items ENABLE ROW LEVEL SECURITY;

CREATE TABLE public.lost_found_custody_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  item_id uuid NOT NULL REFERENCES public.lost_found_items(id) ON DELETE CASCADE,
  previous_status text,
  new_status text,
  previous_custodian uuid,
  new_custodian uuid,
  action text NOT NULL,
  reason text,
  performed_by uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT ON public.lost_found_custody_history TO authenticated;
GRANT ALL ON public.lost_found_custody_history TO service_role;
ALTER TABLE public.lost_found_custody_history ENABLE ROW LEVEL SECURITY;

-- ---------- 6. LAUNDRY ----------
CREATE TABLE public.laundry_price_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  branch_id uuid REFERENCES public.branches(id) ON DELETE CASCADE,
  name text NOT NULL,
  service_type text NOT NULL DEFAULT 'wash-iron',
  normal_price numeric NOT NULL DEFAULT 0,
  express_price numeric NOT NULL DEFAULT 0,
  turnaround_hours integer NOT NULL DEFAULT 24,
  tax_code text,
  tax_rate numeric NOT NULL DEFAULT 0,
  active boolean NOT NULL DEFAULT true,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.laundry_price_items TO authenticated;
GRANT ALL ON public.laundry_price_items TO service_role;
ALTER TABLE public.laundry_price_items ENABLE ROW LEVEL SECURITY;

CREATE TABLE public.guest_laundry_orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  branch_id uuid REFERENCES public.branches(id) ON DELETE CASCADE,
  laundry_number text,
  customer_id uuid REFERENCES public.customers(id) ON DELETE SET NULL,
  reservation_id uuid REFERENCES public.reservations(id) ON DELETE SET NULL,
  folio_id uuid REFERENCES public.folios(id) ON DELETE SET NULL,
  room_id uuid REFERENCES public.rooms(id) ON DELETE SET NULL,
  requested_at timestamptz NOT NULL DEFAULT now(),
  collected_at timestamptz,
  required_delivery_at timestamptz,
  delivered_at timestamptz,
  service_type text NOT NULL DEFAULT 'normal',
  express boolean NOT NULL DEFAULT false,
  express_charge numeric NOT NULL DEFAULT 0,
  special_instructions text,
  discrepancy_notes text,
  status text NOT NULL DEFAULT 'requested',
  assignee_id uuid,
  subtotal numeric NOT NULL DEFAULT 0,
  tax_amount numeric NOT NULL DEFAULT 0,
  total numeric NOT NULL DEFAULT 0,
  posting_status text NOT NULL DEFAULT 'unposted',
  folio_line_id uuid,
  posted_at timestamptz,
  delivery_confirmed_by text,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT guest_laundry_status_chk CHECK (status IN ('requested','awaiting-collection','collected','received','washing','drying','ironing','quality-check','packaged','ready-for-delivery','delivered','completed','on-hold','disputed','cancelled'))
);
CREATE INDEX idx_guest_laundry_org_status ON public.guest_laundry_orders(organization_id, status);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.guest_laundry_orders TO authenticated;
GRANT ALL ON public.guest_laundry_orders TO service_role;
ALTER TABLE public.guest_laundry_orders ENABLE ROW LEVEL SECURITY;

CREATE TABLE public.guest_laundry_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  order_id uuid NOT NULL REFERENCES public.guest_laundry_orders(id) ON DELETE CASCADE,
  price_item_id uuid REFERENCES public.laundry_price_items(id) ON DELETE SET NULL,
  description text NOT NULL,
  service_type text NOT NULL DEFAULT 'wash-iron',
  quantity numeric NOT NULL DEFAULT 1,
  counted_quantity numeric,
  unit_price numeric NOT NULL DEFAULT 0,
  tax_rate numeric NOT NULL DEFAULT 0,
  line_total numeric NOT NULL DEFAULT 0,
  condition_notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.guest_laundry_items TO authenticated;
GRANT ALL ON public.guest_laundry_items TO service_role;
ALTER TABLE public.guest_laundry_items ENABLE ROW LEVEL SECURITY;

CREATE TABLE public.linen_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  branch_id uuid REFERENCES public.branches(id) ON DELETE CASCADE,
  name text NOT NULL,
  category text NOT NULL DEFAULT 'bed-linen',
  unit text NOT NULL DEFAULT 'pc',
  par_level numeric NOT NULL DEFAULT 0,
  replacement_cost numeric NOT NULL DEFAULT 0,
  stock_item_id uuid REFERENCES public.stock_items(id) ON DELETE SET NULL,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.linen_items TO authenticated;
GRANT ALL ON public.linen_items TO service_role;
ALTER TABLE public.linen_items ENABLE ROW LEVEL SECURITY;

CREATE TABLE public.linen_movements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  branch_id uuid REFERENCES public.branches(id) ON DELETE CASCADE,
  linen_item_id uuid NOT NULL REFERENCES public.linen_items(id) ON DELETE CASCADE,
  from_state text NOT NULL DEFAULT 'clean',
  to_state text NOT NULL DEFAULT 'soiled',
  from_department_id uuid REFERENCES public.departments(id) ON DELETE SET NULL,
  to_department_id uuid REFERENCES public.departments(id) ON DELETE SET NULL,
  batch_id uuid,
  quantity numeric NOT NULL,
  received_quantity numeric,
  discrepancy numeric NOT NULL DEFAULT 0,
  reason text,
  performed_by uuid,
  confirmed_by uuid,
  confirmed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.linen_movements TO authenticated;
GRANT ALL ON public.linen_movements TO service_role;
ALTER TABLE public.linen_movements ENABLE ROW LEVEL SECURITY;

CREATE TABLE public.linen_incidents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  branch_id uuid REFERENCES public.branches(id) ON DELETE CASCADE,
  linen_item_id uuid NOT NULL REFERENCES public.linen_items(id) ON DELETE CASCADE,
  quantity numeric NOT NULL DEFAULT 1,
  department_id uuid REFERENCES public.departments(id) ON DELETE SET NULL,
  last_known_location text,
  reason text NOT NULL DEFAULT 'unknown',
  condition text,
  responsible_process text,
  photo_url text,
  reported_by uuid,
  reviewed_by uuid,
  reviewed_at timestamptz,
  replacement_recommended boolean NOT NULL DEFAULT false,
  cost numeric NOT NULL DEFAULT 0,
  charge_folio_id uuid REFERENCES public.folios(id) ON DELETE SET NULL,
  approval_request_id uuid,
  status text NOT NULL DEFAULT 'reported',
  final_action text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.linen_incidents TO authenticated;
GRANT ALL ON public.linen_incidents TO service_role;
ALTER TABLE public.linen_incidents ENABLE ROW LEVEL SECURITY;

CREATE TABLE public.laundry_batches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  branch_id uuid REFERENCES public.branches(id) ON DELETE CASCADE,
  batch_number text,
  source_department_id uuid REFERENCES public.departments(id) ON DELETE SET NULL,
  batch_kind text NOT NULL DEFAULT 'hotel-linen',
  guest_order_id uuid REFERENCES public.guest_laundry_orders(id) ON DELETE SET NULL,
  cycle_type text NOT NULL DEFAULT 'normal',
  machine text,
  weight_kg numeric,
  detergent_usage numeric,
  attendant_id uuid,
  received_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  completed_at timestamptz,
  quality_result text,
  rewash_reason text,
  status text NOT NULL DEFAULT 'received',
  notes text,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.laundry_batches TO authenticated;
GRANT ALL ON public.laundry_batches TO service_role;
ALTER TABLE public.laundry_batches ENABLE ROW LEVEL SECURITY;

CREATE TABLE public.laundry_batch_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  batch_id uuid NOT NULL REFERENCES public.laundry_batches(id) ON DELETE CASCADE,
  linen_item_id uuid REFERENCES public.linen_items(id) ON DELETE SET NULL,
  description text,
  quantity numeric NOT NULL DEFAULT 0,
  returned_quantity numeric NOT NULL DEFAULT 0,
  damaged_quantity numeric NOT NULL DEFAULT 0,
  missing_quantity numeric NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.laundry_batch_items TO authenticated;
GRANT ALL ON public.laundry_batch_items TO service_role;
ALTER TABLE public.laundry_batch_items ENABLE ROW LEVEL SECURITY;

-- ---------- 7. MAINTENANCE ----------
CREATE TABLE public.maintenance_categories (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  name text NOT NULL,
  code text,
  default_priority text NOT NULL DEFAULT 'normal',
  response_target_minutes integer NOT NULL DEFAULT 120,
  resolution_target_minutes integer NOT NULL DEFAULT 1440,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.maintenance_categories TO authenticated;
GRANT ALL ON public.maintenance_categories TO service_role;
ALTER TABLE public.maintenance_categories ENABLE ROW LEVEL SECURITY;

CREATE TABLE public.asset_categories (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  name text NOT NULL,
  code text,
  useful_life_months integer,
  finance_account_id uuid REFERENCES public.chart_of_accounts(id) ON DELETE SET NULL,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.asset_categories TO authenticated;
GRANT ALL ON public.asset_categories TO service_role;
ALTER TABLE public.asset_categories ENABLE ROW LEVEL SECURITY;

CREATE TABLE public.assets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  branch_id uuid REFERENCES public.branches(id) ON DELETE CASCADE,
  asset_tag text,
  name text NOT NULL,
  category_id uuid REFERENCES public.asset_categories(id) ON DELETE SET NULL,
  description text,
  serial_number text,
  model text,
  manufacturer text,
  purchase_date date,
  purchase_cost numeric NOT NULL DEFAULT 0,
  supplier_id uuid REFERENCES public.suppliers(id) ON DELETE SET NULL,
  purchase_reference text,
  warranty_start date,
  warranty_expiry date,
  department_id uuid REFERENCES public.departments(id) ON DELETE SET NULL,
  location_label text,
  room_id uuid REFERENCES public.rooms(id) ON DELETE SET NULL,
  custodian_id uuid,
  condition text NOT NULL DEFAULT 'good',
  status text NOT NULL DEFAULT 'active',
  criticality text NOT NULL DEFAULT 'normal',
  last_service_date date,
  next_service_date date,
  useful_life_months integer,
  finance_account_id uuid REFERENCES public.chart_of_accounts(id) ON DELETE SET NULL,
  disposal_status text,
  attachments jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT assets_status_chk CHECK (status IN ('active','in-storage','assigned','under-maintenance','out-of-service','lost','disposed','sold','retired'))
);
CREATE UNIQUE INDEX idx_assets_tag ON public.assets(organization_id, asset_tag) WHERE asset_tag IS NOT NULL;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.assets TO authenticated;
GRANT ALL ON public.assets TO service_role;
ALTER TABLE public.assets ENABLE ROW LEVEL SECURITY;

CREATE TABLE public.maintenance_work_orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  branch_id uuid REFERENCES public.branches(id) ON DELETE CASCADE,
  work_order_number text,
  requesting_department_id uuid REFERENCES public.departments(id) ON DELETE SET NULL,
  requested_by uuid,
  room_id uuid REFERENCES public.rooms(id) ON DELETE SET NULL,
  location_label text,
  asset_id uuid REFERENCES public.assets(id) ON DELETE SET NULL,
  category_id uuid REFERENCES public.maintenance_categories(id) ON DELETE SET NULL,
  fault_category text NOT NULL DEFAULT 'other',
  description text NOT NULL,
  priority text NOT NULL DEFAULT 'normal',
  operational_impact text,
  guest_impact boolean NOT NULL DEFAULT false,
  attachments jsonb NOT NULL DEFAULT '[]'::jsonb,
  reported_at timestamptz NOT NULL DEFAULT now(),
  assigned_to uuid,
  accepted_at timestamptz,
  estimated_completion timestamptz,
  diagnosis text,
  status text NOT NULL DEFAULT 'new',
  parts_required text,
  cost_estimate numeric NOT NULL DEFAULT 0,
  actual_cost numeric NOT NULL DEFAULT 0,
  completion_notes text,
  completed_at timestamptz,
  verified_by uuid,
  verified_at timestamptz,
  closed_at timestamptz,
  blocks_room boolean NOT NULL DEFAULT false,
  block_status text,
  expected_release_at timestamptz,
  downtime_minutes integer,
  source_module text NOT NULL DEFAULT 'maintenance',
  source_record_id uuid,
  idempotency_key text,
  task_id uuid REFERENCES public.tasks(id) ON DELETE SET NULL,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT wo_priority_chk CHECK (priority IN ('low','normal','high','urgent','emergency')),
  CONSTRAINT wo_status_chk CHECK (status IN ('new','assigned','accepted','diagnosis','waiting-parts','waiting-supplier','in-progress','completed','awaiting-verification','reopened','closed','cancelled')),
  CONSTRAINT wo_idem_uniq UNIQUE (organization_id, idempotency_key)
);
CREATE INDEX idx_wo_org_status ON public.maintenance_work_orders(organization_id, status);
CREATE INDEX idx_wo_assigned ON public.maintenance_work_orders(assigned_to);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.maintenance_work_orders TO authenticated;
GRANT ALL ON public.maintenance_work_orders TO service_role;
ALTER TABLE public.maintenance_work_orders ENABLE ROW LEVEL SECURITY;

CREATE TABLE public.work_order_status_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  work_order_id uuid NOT NULL REFERENCES public.maintenance_work_orders(id) ON DELETE CASCADE,
  previous_status text,
  new_status text NOT NULL,
  reason text,
  changed_by uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT ON public.work_order_status_history TO authenticated;
GRANT ALL ON public.work_order_status_history TO service_role;
ALTER TABLE public.work_order_status_history ENABLE ROW LEVEL SECURITY;

CREATE TABLE public.work_order_parts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  work_order_id uuid NOT NULL REFERENCES public.maintenance_work_orders(id) ON DELETE CASCADE,
  stock_item_id uuid REFERENCES public.stock_items(id) ON DELETE SET NULL,
  description text,
  quantity numeric NOT NULL DEFAULT 1,
  unit text,
  unit_cost numeric NOT NULL DEFAULT 0,
  requisition_id uuid,
  status text NOT NULL DEFAULT 'requested',
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.work_order_parts TO authenticated;
GRANT ALL ON public.work_order_parts TO service_role;
ALTER TABLE public.work_order_parts ENABLE ROW LEVEL SECURITY;

CREATE TABLE public.preventive_maintenance_plans (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  branch_id uuid REFERENCES public.branches(id) ON DELETE CASCADE,
  name text NOT NULL,
  asset_id uuid REFERENCES public.assets(id) ON DELETE CASCADE,
  location_label text,
  maintenance_type text NOT NULL DEFAULT 'service',
  frequency text NOT NULL DEFAULT 'monthly',
  interval_days integer NOT NULL DEFAULT 30,
  last_service_date date,
  next_due_date date,
  lead_time_days integer NOT NULL DEFAULT 3,
  assigned_team text,
  assigned_to uuid,
  checklist jsonb NOT NULL DEFAULT '[]'::jsonb,
  required_parts jsonb NOT NULL DEFAULT '[]'::jsonb,
  expected_downtime_minutes integer,
  estimated_cost numeric NOT NULL DEFAULT 0,
  vendor text,
  status text NOT NULL DEFAULT 'active',
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.preventive_maintenance_plans TO authenticated;
GRANT ALL ON public.preventive_maintenance_plans TO service_role;
ALTER TABLE public.preventive_maintenance_plans ENABLE ROW LEVEL SECURITY;

CREATE TABLE public.preventive_maintenance_occurrences (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  plan_id uuid NOT NULL REFERENCES public.preventive_maintenance_plans(id) ON DELETE CASCADE,
  due_date date NOT NULL,
  work_order_id uuid REFERENCES public.maintenance_work_orders(id) ON DELETE SET NULL,
  status text NOT NULL DEFAULT 'scheduled',
  completed_at timestamptz,
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (plan_id, due_date)
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.preventive_maintenance_occurrences TO authenticated;
GRANT ALL ON public.preventive_maintenance_occurrences TO service_role;
ALTER TABLE public.preventive_maintenance_occurrences ENABLE ROW LEVEL SECURITY;

CREATE TABLE public.asset_movements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  asset_id uuid NOT NULL REFERENCES public.assets(id) ON DELETE CASCADE,
  movement_type text NOT NULL DEFAULT 'transfer',
  previous_location text,
  new_location text,
  previous_custodian uuid,
  new_custodian uuid,
  previous_department_id uuid REFERENCES public.departments(id) ON DELETE SET NULL,
  new_department_id uuid REFERENCES public.departments(id) ON DELETE SET NULL,
  reason text,
  confirmed_by uuid,
  confirmed_at timestamptz,
  approved_by uuid,
  performed_by uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE ON public.asset_movements TO authenticated;
GRANT ALL ON public.asset_movements TO service_role;
ALTER TABLE public.asset_movements ENABLE ROW LEVEL SECURITY;

CREATE TABLE public.asset_service_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  asset_id uuid NOT NULL REFERENCES public.assets(id) ON DELETE CASCADE,
  work_order_id uuid REFERENCES public.maintenance_work_orders(id) ON DELETE SET NULL,
  service_date date NOT NULL DEFAULT CURRENT_DATE,
  service_type text NOT NULL DEFAULT 'corrective',
  performed_by text,
  description text,
  cost numeric NOT NULL DEFAULT 0,
  next_service_date date,
  condition_after text,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.asset_service_history TO authenticated;
GRANT ALL ON public.asset_service_history TO service_role;
ALTER TABLE public.asset_service_history ENABLE ROW LEVEL SECURITY;

-- ---------- 8. INTERNAL REQUISITIONS ----------
ALTER TABLE public.stock_locations
  ADD COLUMN IF NOT EXISTS is_mini_store boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS custodian_id uuid,
  ADD COLUMN IF NOT EXISTS allowed_categories jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS parent_location_id uuid;

CREATE TABLE public.internal_requisitions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  branch_id uuid REFERENCES public.branches(id) ON DELETE CASCADE,
  request_number text,
  department_id uuid REFERENCES public.departments(id) ON DELETE SET NULL,
  destination_location_id uuid REFERENCES public.stock_locations(id) ON DELETE SET NULL,
  source_location_id uuid REFERENCES public.stock_locations(id) ON DELETE SET NULL,
  fulfilment_model text NOT NULL DEFAULT 'direct-issue',
  requested_by uuid,
  request_date date NOT NULL DEFAULT CURRENT_DATE,
  required_date date,
  priority text NOT NULL DEFAULT 'normal',
  reason text,
  room_id uuid REFERENCES public.rooms(id) ON DELETE SET NULL,
  task_id uuid REFERENCES public.tasks(id) ON DELETE SET NULL,
  event_booking_id uuid REFERENCES public.event_bookings(id) ON DELETE SET NULL,
  work_order_id uuid REFERENCES public.maintenance_work_orders(id) ON DELETE SET NULL,
  status text NOT NULL DEFAULT 'draft',
  supervisor_approved_by uuid,
  supervisor_approved_at timestamptz,
  store_reviewed_by uuid,
  store_reviewed_at timestamptz,
  issued_by uuid,
  issued_at timestamptz,
  received_by uuid,
  received_at timestamptz,
  purchase_request_id uuid REFERENCES public.purchase_requests(id) ON DELETE SET NULL,
  shortage_notes text,
  notes text,
  attachments jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT req_status_chk CHECK (status IN ('draft','submitted','pending-supervisor','awaiting-stores','approved','partially-approved','ready-for-issue','partially-issued','issued','partially-received','received','closed','sent-back','rejected','cancelled'))
);
CREATE INDEX idx_req_org_status ON public.internal_requisitions(organization_id, status);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.internal_requisitions TO authenticated;
GRANT ALL ON public.internal_requisitions TO service_role;
ALTER TABLE public.internal_requisitions ENABLE ROW LEVEL SECURITY;

CREATE TABLE public.internal_requisition_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  requisition_id uuid NOT NULL REFERENCES public.internal_requisitions(id) ON DELETE CASCADE,
  stock_item_id uuid REFERENCES public.stock_items(id) ON DELETE SET NULL,
  description text,
  unit text,
  quantity_requested numeric NOT NULL DEFAULT 0,
  quantity_approved numeric,
  quantity_issued numeric NOT NULL DEFAULT 0,
  quantity_received numeric NOT NULL DEFAULT 0,
  quantity_rejected numeric NOT NULL DEFAULT 0,
  batch_reference text,
  controlled boolean NOT NULL DEFAULT false,
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT req_line_qty_chk CHECK (quantity_requested >= 0 AND quantity_issued >= 0 AND quantity_received >= 0)
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.internal_requisition_lines TO authenticated;
GRANT ALL ON public.internal_requisition_lines TO service_role;
ALTER TABLE public.internal_requisition_lines ENABLE ROW LEVEL SECURITY;

CREATE TABLE public.requisition_receipt_confirmations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  requisition_id uuid NOT NULL REFERENCES public.internal_requisitions(id) ON DELETE CASCADE,
  line_id uuid REFERENCES public.internal_requisition_lines(id) ON DELETE CASCADE,
  quantity_received numeric NOT NULL DEFAULT 0,
  condition text,
  discrepancy numeric NOT NULL DEFAULT 0,
  discrepancy_notes text,
  received_by uuid,
  received_at timestamptz NOT NULL DEFAULT now(),
  resolved boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE ON public.requisition_receipt_confirmations TO authenticated;
GRANT ALL ON public.requisition_receipt_confirmations TO service_role;
ALTER TABLE public.requisition_receipt_confirmations ENABLE ROW LEVEL SECURITY;

CREATE TABLE public.department_consumption (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  branch_id uuid REFERENCES public.branches(id) ON DELETE CASCADE,
  department_id uuid REFERENCES public.departments(id) ON DELETE SET NULL,
  location_id uuid REFERENCES public.stock_locations(id) ON DELETE SET NULL,
  stock_item_id uuid REFERENCES public.stock_items(id) ON DELETE SET NULL,
  quantity numeric NOT NULL DEFAULT 0,
  unit text,
  value numeric NOT NULL DEFAULT 0,
  room_id uuid REFERENCES public.rooms(id) ON DELETE SET NULL,
  task_id uuid REFERENCES public.tasks(id) ON DELETE SET NULL,
  work_order_id uuid REFERENCES public.maintenance_work_orders(id) ON DELETE SET NULL,
  event_booking_id uuid REFERENCES public.event_bookings(id) ON DELETE SET NULL,
  reason text,
  consumed_on date NOT NULL DEFAULT CURRENT_DATE,
  recorded_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.department_consumption TO authenticated;
GRANT ALL ON public.department_consumption TO service_role;
ALTER TABLE public.department_consumption ENABLE ROW LEVEL SECURITY;

-- ---------- RLS POLICIES ----------
DO $$
DECLARE
  t text;
  spec text[][] := ARRAY[
    ARRAY['housekeeping_checklist_templates','housekeeping'],
    ARRAY['housekeeping_checklist_items','housekeeping'],
    ARRAY['housekeeping_jobs','housekeeping'],
    ARRAY['housekeeping_job_results','housekeeping'],
    ARRAY['room_inspections','housekeeping'],
    ARRAY['deep_cleaning_schedules','housekeeping'],
    ARRAY['lost_found_items','housekeeping'],
    ARRAY['lost_found_custody_history','housekeeping'],
    ARRAY['laundry_price_items','laundry'],
    ARRAY['guest_laundry_orders','laundry'],
    ARRAY['guest_laundry_items','laundry'],
    ARRAY['linen_items','laundry'],
    ARRAY['linen_movements','laundry'],
    ARRAY['linen_incidents','laundry'],
    ARRAY['laundry_batches','laundry'],
    ARRAY['laundry_batch_items','laundry'],
    ARRAY['maintenance_categories','maintenance'],
    ARRAY['maintenance_work_orders','maintenance'],
    ARRAY['work_order_status_history','maintenance'],
    ARRAY['work_order_parts','maintenance'],
    ARRAY['preventive_maintenance_plans','maintenance'],
    ARRAY['preventive_maintenance_occurrences','maintenance'],
    ARRAY['asset_categories','maintenance'],
    ARRAY['assets','maintenance'],
    ARRAY['asset_movements','maintenance'],
    ARRAY['asset_service_history','maintenance'],
    ARRAY['internal_requisitions','stores'],
    ARRAY['internal_requisition_lines','stores'],
    ARRAY['requisition_receipt_confirmations','stores'],
    ARRAY['department_consumption','stores']
  ];
  i int;
  tbl text; mod text;
BEGIN
  FOR i IN 1..array_length(spec,1) LOOP
    tbl := spec[i][1]; mod := spec[i][2];
    EXECUTE format('CREATE POLICY %I ON public.%I FOR SELECT TO authenticated USING (organization_id = current_org_id())', tbl||'_select', tbl);
    EXECUTE format('CREATE POLICY %I ON public.%I FOR INSERT TO authenticated WITH CHECK (organization_id = current_org_id() AND (has_permission(%L,''create'') OR has_permission(%L,''edit'') OR is_org_admin()))', tbl||'_insert', tbl, mod, mod);
    EXECUTE format('CREATE POLICY %I ON public.%I FOR UPDATE TO authenticated USING (organization_id = current_org_id() AND (has_permission(%L,''edit'') OR has_permission(%L,''approve'') OR is_org_admin())) WITH CHECK (organization_id = current_org_id())', tbl||'_update', tbl, mod, mod);
    EXECUTE format('CREATE POLICY %I ON public.%I FOR DELETE TO authenticated USING (organization_id = current_org_id() AND (has_permission(%L,''delete'') OR is_org_admin()))', tbl||'_delete', tbl, mod);
  END LOOP;
END $$;

-- updated_at triggers
DO $$
DECLARE t text;
BEGIN
  FOR t IN SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    JOIN information_schema.columns col ON col.table_name=c.relname AND col.table_schema='public' AND col.column_name='updated_at'
    WHERE n.nspname='public' AND c.relkind='r' AND c.relname IN (
      'housekeeping_checklist_templates','housekeeping_checklist_items','housekeeping_jobs','housekeeping_job_results',
      'room_inspections','deep_cleaning_schedules','lost_found_items','laundry_price_items','guest_laundry_orders',
      'guest_laundry_items','linen_items','linen_movements','linen_incidents','laundry_batches','laundry_batch_items',
      'maintenance_categories','maintenance_work_orders','work_order_parts','preventive_maintenance_plans',
      'preventive_maintenance_occurrences','asset_categories','assets','asset_service_history',
      'internal_requisitions','internal_requisition_lines','department_consumption')
  LOOP
    EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.ops_touch_updated_at()', 'trg_touch_'||t, t);
  END LOOP;
END $$;

-- ---------- 9. OPERATIONAL FUNCTIONS ----------

-- Authoritative room status change + immutable history
CREATE OR REPLACE FUNCTION public.ops_set_room_status(
  _room uuid, _housekeeping_status text DEFAULT NULL, _maintenance_status text DEFAULT NULL,
  _reason text DEFAULT NULL, _source_module text DEFAULT 'housekeeping', _reference uuid DEFAULT NULL
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_org uuid := current_org_id(); v_room record;
BEGIN
  IF v_org IS NULL THEN RAISE EXCEPTION 'No active organization'; END IF;
  SELECT * INTO v_room FROM rooms WHERE id = _room AND organization_id = v_org FOR UPDATE;
  IF v_room IS NULL THEN RAISE EXCEPTION 'Unknown room'; END IF;
  IF NOT (has_permission('housekeeping','edit') OR has_permission('maintenance','edit') OR has_permission('pms','rooms.manage') OR is_org_admin()) THEN
    RAISE EXCEPTION 'Not permitted to change room status';
  END IF;

  IF _housekeeping_status IS NOT NULL AND _housekeeping_status IS DISTINCT FROM v_room.housekeeping_status THEN
    INSERT INTO room_status_history (organization_id, branch_id, room_id, field, previous_value, new_value, reason, changed_by)
    VALUES (v_org, v_room.branch_id, _room, 'housekeeping_status', v_room.housekeeping_status, _housekeeping_status,
            COALESCE(_reason,'') || ' [' || _source_module || COALESCE(':'||_reference::text,'') || ']', auth.uid());
    UPDATE rooms SET housekeeping_status = _housekeeping_status,
      last_cleaned_at = CASE WHEN _housekeeping_status IN ('clean','inspected') THEN now() ELSE last_cleaned_at END,
      last_inspected_at = CASE WHEN _housekeeping_status = 'inspected' THEN now() ELSE last_inspected_at END,
      updated_at = now()
    WHERE id = _room;
  END IF;

  IF _maintenance_status IS NOT NULL AND _maintenance_status IS DISTINCT FROM v_room.maintenance_status THEN
    INSERT INTO room_status_history (organization_id, branch_id, room_id, field, previous_value, new_value, reason, changed_by)
    VALUES (v_org, v_room.branch_id, _room, 'maintenance_status', v_room.maintenance_status, _maintenance_status,
            COALESCE(_reason,'') || ' [' || _source_module || COALESCE(':'||_reference::text,'') || ']', auth.uid());
    UPDATE rooms SET maintenance_status = _maintenance_status,
      sellable = CASE WHEN _maintenance_status IN ('out-of-order','out-of-service','under-maintenance') THEN false
                      WHEN _maintenance_status IN ('operational','ok','none') THEN true ELSE sellable END,
      out_of_order_reason = CASE WHEN _maintenance_status IN ('out-of-order','out-of-service') THEN _reason ELSE NULL END,
      updated_at = now()
    WHERE id = _room;
  END IF;

  RETURN jsonb_build_object('room_id', _room, 'ok', true);
END $$;
REVOKE ALL ON FUNCTION public.ops_set_room_status(uuid,text,text,text,text,uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.ops_set_room_status(uuid,text,text,text,text,uuid) TO authenticated;

-- Idempotent housekeeping job creation (checkout / stayover / arrival prep / etc.)
CREATE OR REPLACE FUNCTION public.hk_create_job(
  _room uuid, _job_type text, _reservation uuid DEFAULT NULL, _priority text DEFAULT 'normal',
  _due_at timestamptz DEFAULT NULL, _idempotency_key text DEFAULT NULL, _notes text DEFAULT NULL
) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_org uuid := current_org_id(); v_room record; v_existing uuid; v_job uuid; v_task uuid;
  v_template uuid; v_requires boolean := true; v_key text;
BEGIN
  IF v_org IS NULL THEN RAISE EXCEPTION 'No active organization'; END IF;
  IF NOT (has_permission('housekeeping','create') OR has_permission('housekeeping','edit') OR has_permission('pms','reservations.manage') OR is_org_admin()) THEN
    RAISE EXCEPTION 'Not permitted to create housekeeping work';
  END IF;
  SELECT * INTO v_room FROM rooms WHERE id = _room AND organization_id = v_org;
  IF v_room IS NULL THEN RAISE EXCEPTION 'Unknown room'; END IF;

  v_key := COALESCE(_idempotency_key, _job_type || ':' || _room::text || ':' || COALESCE(_reservation::text, to_char(now(),'YYYY-MM-DD')));
  SELECT id INTO v_existing FROM housekeeping_jobs
   WHERE organization_id = v_org AND idempotency_key = v_key;
  IF v_existing IS NOT NULL THEN RETURN v_existing; END IF;

  SELECT id, requires_inspection INTO v_template, v_requires FROM housekeeping_checklist_templates
   WHERE organization_id = v_org AND active
     AND cleaning_type = CASE WHEN _job_type LIKE '%deep%' THEN 'deep-clean'
                              WHEN _job_type LIKE '%stayover%' THEN 'stayover' ELSE 'checkout' END
     AND (branch_id IS NULL OR branch_id = v_room.branch_id)
   ORDER BY branch_id NULLS LAST LIMIT 1;

  INSERT INTO tasks (organization_id, branch_id, title, description, priority, status, due_at, created_by)
  VALUES (v_org, v_room.branch_id, initcap(replace(_job_type,'-',' ')) || ' — Room ' || v_room.room_number,
          COALESCE(_notes,''), _priority, 'open', _due_at, auth.uid())
  RETURNING id INTO v_task;

  INSERT INTO housekeeping_jobs (
    organization_id, branch_id, job_number, task_id, room_id, job_type, reservation_id, template_id,
    priority, status, due_at, inspection_required, inspection_status, notes, idempotency_key, created_by
  ) VALUES (
    v_org, v_room.branch_id, next_document_number('housekeeping-job'), v_task, _room, _job_type, _reservation, v_template,
    _priority, 'pending', _due_at, COALESCE(v_requires,true), CASE WHEN COALESCE(v_requires,true) THEN 'pending' ELSE 'not-required' END,
    _notes, v_key, auth.uid()
  ) RETURNING id INTO v_job;

  PERFORM ops_set_room_status(_room, CASE WHEN _job_type = 'checkout-cleaning' THEN 'dirty' ELSE NULL END,
                              NULL, 'Housekeeping job created', 'housekeeping', v_job);

  INSERT INTO notifications (organization_id, branch_id, user_id, category, title, body, link, priority)
  SELECT v_org, v_room.branch_id, p.id, 'housekeeping',
         'New cleaning task — Room ' || v_room.room_number,
         initcap(replace(_job_type,'-',' ')), '/housekeeping/board', _priority
    FROM profiles p WHERE p.organization_id = v_org AND p.account_status = 'active'
      AND p.department_id IN (SELECT id FROM departments WHERE organization_id = v_org AND name ILIKE 'housekeeping%');

  RETURN v_job;
END $$;
REVOKE ALL ON FUNCTION public.hk_create_job(uuid,text,uuid,text,timestamptz,text,text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.hk_create_job(uuid,text,uuid,text,timestamptz,text,text) TO authenticated;

-- Complete a cleaning job -> awaiting inspection or ready
CREATE OR REPLACE FUNCTION public.hk_complete_job(_job uuid, _notes text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_org uuid := current_org_id(); v_job record;
BEGIN
  SELECT * INTO v_job FROM housekeeping_jobs WHERE id = _job AND organization_id = v_org FOR UPDATE;
  IF v_job IS NULL THEN RAISE EXCEPTION 'Unknown job'; END IF;
  IF NOT (v_job.assignee_id = auth.uid() OR has_permission('housekeeping','edit') OR is_org_admin()) THEN
    RAISE EXCEPTION 'Not permitted to complete this job';
  END IF;

  UPDATE housekeeping_jobs
     SET status = CASE WHEN inspection_required THEN 'awaiting-inspection' ELSE 'completed' END,
         inspection_status = CASE WHEN inspection_required THEN 'pending' ELSE 'not-required' END,
         completed_at = now(), notes = COALESCE(_notes, notes)
   WHERE id = _job;

  UPDATE tasks SET status = CASE WHEN v_job.inspection_required THEN 'in-progress' ELSE 'completed' END,
                   completed_at = CASE WHEN v_job.inspection_required THEN NULL ELSE now() END
   WHERE id = v_job.task_id;

  IF v_job.room_id IS NOT NULL THEN
    PERFORM ops_set_room_status(v_job.room_id,
      CASE WHEN v_job.inspection_required THEN 'awaiting-inspection' ELSE 'clean' END,
      NULL, 'Cleaning completed', 'housekeeping', _job);
  END IF;
  RETURN jsonb_build_object('ok', true, 'inspection_required', v_job.inspection_required);
END $$;
REVOKE ALL ON FUNCTION public.hk_complete_job(uuid,text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.hk_complete_job(uuid,text) TO authenticated;

-- Record an inspection outcome; only authorised supervisors release a room
CREATE OR REPLACE FUNCTION public.hk_record_inspection(
  _job uuid, _result text, _notes text DEFAULT NULL, _defects jsonb DEFAULT '[]'::jsonb, _inspection_type text DEFAULT 'standard'
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_org uuid := current_org_id(); v_job record; v_insp uuid;
BEGIN
  IF NOT (has_permission('housekeeping','approve') OR is_org_admin()) THEN
    RAISE EXCEPTION 'Only a housekeeping supervisor may inspect and release rooms';
  END IF;
  SELECT * INTO v_job FROM housekeeping_jobs WHERE id = _job AND organization_id = v_org FOR UPDATE;
  IF v_job IS NULL THEN RAISE EXCEPTION 'Unknown job'; END IF;

  INSERT INTO room_inspections (organization_id, branch_id, room_id, job_id, inspection_type, inspector_id,
                                result, defects, notes, rework_required, released_at)
  VALUES (v_org, v_job.branch_id, v_job.room_id, _job, _inspection_type, auth.uid(), _result, _defects, _notes,
          _result IN ('failed','reinspection-required'),
          CASE WHEN _result IN ('passed','passed-with-notes') THEN now() ELSE NULL END)
  RETURNING id INTO v_insp;

  IF _result IN ('passed','passed-with-notes') THEN
    UPDATE housekeeping_jobs SET status='completed', inspection_status='passed' WHERE id=_job;
    UPDATE tasks SET status='completed', completed_at=now() WHERE id=v_job.task_id;
    IF v_job.room_id IS NOT NULL THEN
      PERFORM ops_set_room_status(v_job.room_id,'inspected',NULL,'Inspection passed','housekeeping',_job);
      INSERT INTO notifications (organization_id, branch_id, user_id, category, title, body, link, priority)
      SELECT v_org, v_job.branch_id, p.id, 'front-office', 'Room ready',
             'Room released by housekeeping inspection.', '/pms/rack', 'normal'
        FROM profiles p WHERE p.organization_id = v_org AND p.account_status='active'
          AND p.department_id IN (SELECT id FROM departments WHERE organization_id=v_org AND name ILIKE 'front office%');
    END IF;
  ELSE
    UPDATE housekeeping_jobs SET status='rework', inspection_status='failed', rework_count = rework_count + 1 WHERE id=_job;
    UPDATE tasks SET status='in-progress' WHERE id=v_job.task_id;
    IF v_job.room_id IS NOT NULL THEN
      PERFORM ops_set_room_status(v_job.room_id,'dirty',NULL,'Inspection failed — rework required','housekeeping',_job);
    END IF;
  END IF;
  RETURN jsonb_build_object('inspection_id', v_insp, 'result', _result);
END $$;
REVOKE ALL ON FUNCTION public.hk_record_inspection(uuid,text,text,jsonb,text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.hk_record_inspection(uuid,text,text,jsonb,text) TO authenticated;

-- Post a guest laundry charge exactly once
CREATE OR REPLACE FUNCTION public.laundry_post_charge(_order uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_org uuid := current_org_id(); v_order record; v_folio uuid; v_line uuid; v_key text;
BEGIN
  IF NOT (has_permission('laundry','edit') OR has_permission('laundry','approve') OR is_org_admin()) THEN
    RAISE EXCEPTION 'Not permitted to post laundry charges';
  END IF;
  SELECT * INTO v_order FROM guest_laundry_orders WHERE id=_order AND organization_id=v_org FOR UPDATE;
  IF v_order IS NULL THEN RAISE EXCEPTION 'Unknown laundry order'; END IF;
  IF v_order.posting_status = 'posted' THEN
    RETURN jsonb_build_object('ok', true, 'already_posted', true, 'folio_line_id', v_order.folio_line_id);
  END IF;

  v_folio := v_order.folio_id;
  IF v_folio IS NULL AND v_order.reservation_id IS NOT NULL THEN
    SELECT id INTO v_folio FROM folios
      WHERE organization_id=v_org AND reservation_id=v_order.reservation_id AND status='open'
      ORDER BY created_at LIMIT 1;
  END IF;
  IF v_folio IS NULL THEN RAISE EXCEPTION 'No open guest folio for this laundry order'; END IF;

  v_key := 'laundry:' || _order::text;
  SELECT pms_post_room_charge(v_folio, 'laundry',
           'Guest laundry ' || COALESCE(v_order.laundry_number,''), 1,
           COALESCE(v_order.total,0) - COALESCE(v_order.tax_amount,0), COALESCE(v_order.tax_amount,0),
           'laundry', _order::text, v_key) INTO v_line;

  UPDATE guest_laundry_orders
     SET posting_status='posted', folio_id=v_folio, folio_line_id=v_line, posted_at=now()
   WHERE id=_order;
  RETURN jsonb_build_object('ok', true, 'folio_line_id', v_line);
END $$;
REVOKE ALL ON FUNCTION public.laundry_post_charge(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.laundry_post_charge(uuid) TO authenticated;

-- Requisition: submit
CREATE OR REPLACE FUNCTION public.req_submit(_requisition uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_org uuid := current_org_id(); v_req record;
BEGIN
  SELECT * INTO v_req FROM internal_requisitions WHERE id=_requisition AND organization_id=v_org FOR UPDATE;
  IF v_req IS NULL THEN RAISE EXCEPTION 'Unknown requisition'; END IF;
  IF NOT (v_req.requested_by = auth.uid() OR has_permission('stores','create') OR is_org_admin()) THEN
    RAISE EXCEPTION 'Not permitted';
  END IF;
  UPDATE internal_requisitions SET status='pending-supervisor' WHERE id=_requisition;
  RETURN jsonb_build_object('ok', true);
END $$;
REVOKE ALL ON FUNCTION public.req_submit(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.req_submit(uuid) TO authenticated;

-- Requisition: supervisor / stores approval with per-line approved quantities
CREATE OR REPLACE FUNCTION public.req_approve(_requisition uuid, _lines jsonb DEFAULT '[]'::jsonb, _stage text DEFAULT 'supervisor')
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_org uuid := current_org_id(); v_req record; v_line jsonb; v_partial boolean := false;
BEGIN
  IF NOT (has_permission('stores','approve') OR has_permission('housekeeping','approve') OR has_permission('maintenance','approve') OR is_org_admin()) THEN
    RAISE EXCEPTION 'Not permitted to approve requisitions';
  END IF;
  SELECT * INTO v_req FROM internal_requisitions WHERE id=_requisition AND organization_id=v_org FOR UPDATE;
  IF v_req IS NULL THEN RAISE EXCEPTION 'Unknown requisition'; END IF;

  FOR v_line IN SELECT * FROM jsonb_array_elements(COALESCE(_lines,'[]'::jsonb)) LOOP
    UPDATE internal_requisition_lines
       SET quantity_approved = (v_line->>'quantity_approved')::numeric
     WHERE id = (v_line->>'id')::uuid AND requisition_id = _requisition;
  END LOOP;

  UPDATE internal_requisition_lines
     SET quantity_approved = COALESCE(quantity_approved, quantity_requested)
   WHERE requisition_id = _requisition;

  SELECT EXISTS (SELECT 1 FROM internal_requisition_lines
                  WHERE requisition_id=_requisition AND quantity_approved < quantity_requested)
    INTO v_partial;

  IF _stage = 'supervisor' THEN
    UPDATE internal_requisitions
       SET status='awaiting-stores', supervisor_approved_by=auth.uid(), supervisor_approved_at=now()
     WHERE id=_requisition;
  ELSE
    UPDATE internal_requisitions
       SET status = CASE WHEN v_partial THEN 'partially-approved' ELSE 'ready-for-issue' END,
           store_reviewed_by=auth.uid(), store_reviewed_at=now()
     WHERE id=_requisition;
  END IF;
  RETURN jsonb_build_object('ok', true, 'partial', v_partial);
END $$;
REVOKE ALL ON FUNCTION public.req_approve(uuid,jsonb,text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.req_approve(uuid,jsonb,text) TO authenticated;

-- Requisition: stores issues stock through the Phase 9 ledger
CREATE OR REPLACE FUNCTION public.req_issue(_requisition uuid, _lines jsonb DEFAULT '[]'::jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_org uuid := current_org_id(); v_req record; v_line jsonb; v_row record;
  v_qty numeric; v_issued int := 0; v_partial boolean := false; v_dest uuid;
BEGIN
  IF NOT (has_permission('stores','edit') OR has_permission('stores','approve') OR is_org_admin()) THEN
    RAISE EXCEPTION 'Only Stores may issue requisition items';
  END IF;
  SELECT * INTO v_req FROM internal_requisitions WHERE id=_requisition AND organization_id=v_org FOR UPDATE;
  IF v_req IS NULL THEN RAISE EXCEPTION 'Unknown requisition'; END IF;
  IF v_req.source_location_id IS NULL THEN RAISE EXCEPTION 'Set the issuing store before issuing'; END IF;

  v_dest := v_req.destination_location_id;

  FOR v_line IN SELECT * FROM jsonb_array_elements(COALESCE(_lines,'[]'::jsonb)) LOOP
    SELECT * INTO v_row FROM internal_requisition_lines
      WHERE id=(v_line->>'id')::uuid AND requisition_id=_requisition FOR UPDATE;
    CONTINUE WHEN v_row IS NULL;
    v_qty := COALESCE((v_line->>'quantity_issued')::numeric, 0);
    IF v_qty <= 0 THEN CONTINUE; END IF;
    IF v_qty > COALESCE(v_row.quantity_approved, v_row.quantity_requested) - v_row.quantity_issued THEN
      RAISE EXCEPTION 'Cannot issue more than the approved quantity';
    END IF;

    IF v_row.stock_item_id IS NOT NULL THEN
      PERFORM inventory_apply_movement(v_row.stock_item_id, v_req.source_location_id, -v_qty, v_row.unit,
        CASE WHEN v_dest IS NULL THEN 'issue' ELSE 'transfer-out' END, NULL, 'internal-requisition', _requisition,
        'Requisition issue', 'req-out:'||v_row.id::text||':'||v_qty::text);
      IF v_dest IS NOT NULL THEN
        PERFORM inventory_apply_movement(v_row.stock_item_id, v_dest, v_qty, v_row.unit, 'transfer-in', NULL,
          'internal-requisition', _requisition, 'Requisition transfer to mini-store', 'req-in:'||v_row.id::text||':'||v_qty::text);
      END IF;
    END IF;

    UPDATE internal_requisition_lines SET quantity_issued = quantity_issued + v_qty WHERE id = v_row.id;
    v_issued := v_issued + 1;
  END LOOP;

  SELECT EXISTS (SELECT 1 FROM internal_requisition_lines
                  WHERE requisition_id=_requisition
                    AND quantity_issued < COALESCE(quantity_approved, quantity_requested))
    INTO v_partial;

  UPDATE internal_requisitions
     SET status = CASE WHEN v_partial THEN 'partially-issued' ELSE 'issued' END,
         issued_by = auth.uid(), issued_at = now()
   WHERE id=_requisition;

  RETURN jsonb_build_object('ok', true, 'lines_issued', v_issued, 'partial', v_partial);
END $$;
REVOKE ALL ON FUNCTION public.req_issue(uuid,jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.req_issue(uuid,jsonb) TO authenticated;

-- Requisition: department confirms receipt, discrepancies stay open
CREATE OR REPLACE FUNCTION public.req_confirm_receipt(_requisition uuid, _lines jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_org uuid := current_org_id(); v_req record; v_line jsonb; v_row record;
  v_qty numeric; v_disc numeric; v_any_disc boolean := false; v_all boolean;
BEGIN
  SELECT * INTO v_req FROM internal_requisitions WHERE id=_requisition AND organization_id=v_org FOR UPDATE;
  IF v_req IS NULL THEN RAISE EXCEPTION 'Unknown requisition'; END IF;
  IF NOT (has_permission('stores','edit') OR has_permission('housekeeping','edit') OR has_permission('maintenance','edit')
          OR has_permission('laundry','edit') OR is_org_admin()) THEN
    RAISE EXCEPTION 'Not permitted to confirm receipt';
  END IF;

  FOR v_line IN SELECT * FROM jsonb_array_elements(_lines) LOOP
    SELECT * INTO v_row FROM internal_requisition_lines WHERE id=(v_line->>'id')::uuid AND requisition_id=_requisition FOR UPDATE;
    CONTINUE WHEN v_row IS NULL;
    v_qty := COALESCE((v_line->>'quantity_received')::numeric, 0);
    v_disc := v_row.quantity_issued - (v_row.quantity_received + v_qty);
    IF v_disc <> 0 THEN v_any_disc := true; END IF;

    INSERT INTO requisition_receipt_confirmations (organization_id, requisition_id, line_id, quantity_received,
      condition, discrepancy, discrepancy_notes, received_by, resolved)
    VALUES (v_org, _requisition, v_row.id, v_qty, v_line->>'condition', v_disc, v_line->>'notes', auth.uid(), v_disc = 0);

    UPDATE internal_requisition_lines SET quantity_received = quantity_received + v_qty WHERE id=v_row.id;
  END LOOP;

  SELECT NOT EXISTS (SELECT 1 FROM internal_requisition_lines
                      WHERE requisition_id=_requisition AND quantity_received < quantity_issued)
    INTO v_all;

  UPDATE internal_requisitions
     SET status = CASE WHEN v_all AND NOT v_any_disc THEN 'received' ELSE 'partially-received' END,
         received_by = auth.uid(), received_at = now()
   WHERE id=_requisition;

  RETURN jsonb_build_object('ok', true, 'discrepancy', v_any_disc);
END $$;
REVOKE ALL ON FUNCTION public.req_confirm_receipt(uuid,jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.req_confirm_receipt(uuid,jsonb) TO authenticated;

-- Record department consumption out of a mini-store
CREATE OR REPLACE FUNCTION public.req_record_consumption(
  _location uuid, _item uuid, _quantity numeric, _unit text DEFAULT NULL,
  _reason text DEFAULT NULL, _room uuid DEFAULT NULL, _work_order uuid DEFAULT NULL
) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_org uuid := current_org_id(); v_loc record; v_cost numeric; v_id uuid;
BEGIN
  IF NOT (has_permission('stores','edit') OR has_permission('housekeeping','edit') OR has_permission('maintenance','edit')
          OR has_permission('laundry','edit') OR is_org_admin()) THEN
    RAISE EXCEPTION 'Not permitted to record consumption';
  END IF;
  IF _quantity <= 0 THEN RAISE EXCEPTION 'Quantity must be positive'; END IF;
  SELECT * INTO v_loc FROM stock_locations WHERE id=_location AND organization_id=v_org;
  IF v_loc IS NULL THEN RAISE EXCEPTION 'Unknown store'; END IF;

  PERFORM inventory_apply_movement(_item, _location, -_quantity, _unit, 'consumption', NULL,
    'department-consumption', NULL, COALESCE(_reason,'Department consumption'), NULL);

  SELECT average_cost INTO v_cost FROM stock_items WHERE id=_item;

  INSERT INTO department_consumption (organization_id, branch_id, department_id, location_id, stock_item_id,
    quantity, unit, value, room_id, work_order_id, reason, recorded_by)
  VALUES (v_org, v_loc.branch_id, v_loc.department_id, _location, _item, _quantity, _unit,
          _quantity * COALESCE(v_cost,0), _room, _work_order, _reason, auth.uid())
  RETURNING id INTO v_id;
  RETURN v_id;
END $$;
REVOKE ALL ON FUNCTION public.req_record_consumption(uuid,uuid,numeric,text,text,uuid,uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.req_record_consumption(uuid,uuid,numeric,text,text,uuid,uuid) TO authenticated;

-- Maintenance: block / release a room from a work order
CREATE OR REPLACE FUNCTION public.wo_set_block(_work_order uuid, _block boolean, _severity text DEFAULT 'out-of-order', _reason text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_org uuid := current_org_id(); v_wo record;
BEGIN
  IF NOT (has_permission('maintenance','approve') OR has_permission('maintenance','edit') OR is_org_admin()) THEN
    RAISE EXCEPTION 'Not permitted to block or release rooms';
  END IF;
  SELECT * INTO v_wo FROM maintenance_work_orders WHERE id=_work_order AND organization_id=v_org FOR UPDATE;
  IF v_wo IS NULL THEN RAISE EXCEPTION 'Unknown work order'; END IF;
  IF v_wo.room_id IS NULL THEN RAISE EXCEPTION 'This work order is not linked to a room'; END IF;

  IF _block THEN
    PERFORM ops_set_room_status(v_wo.room_id, NULL, _severity, COALESCE(_reason, v_wo.description), 'maintenance', _work_order);
    UPDATE maintenance_work_orders SET blocks_room=true, block_status=_severity WHERE id=_work_order;
  ELSE
    PERFORM ops_set_room_status(v_wo.room_id, 'dirty', 'operational', COALESCE(_reason,'Repair verified'), 'maintenance', _work_order);
    UPDATE maintenance_work_orders SET blocks_room=false, block_status=NULL WHERE id=_work_order;
  END IF;
  RETURN jsonb_build_object('ok', true, 'blocked', _block);
END $$;
REVOKE ALL ON FUNCTION public.wo_set_block(uuid,boolean,text,text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.wo_set_block(uuid,boolean,text,text) TO authenticated;

-- Work order status history trigger
CREATE OR REPLACE FUNCTION public.wo_track_status()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF TG_OP = 'INSERT' OR NEW.status IS DISTINCT FROM OLD.status THEN
    INSERT INTO work_order_status_history (organization_id, work_order_id, previous_status, new_status, changed_by)
    VALUES (NEW.organization_id, NEW.id, CASE WHEN TG_OP='INSERT' THEN NULL ELSE OLD.status END, NEW.status, auth.uid());
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_wo_status AFTER INSERT OR UPDATE ON public.maintenance_work_orders
FOR EACH ROW EXECUTE FUNCTION public.wo_track_status();

-- Lost & found custody trail
CREATE OR REPLACE FUNCTION public.lf_track_custody()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF TG_OP='INSERT' OR NEW.status IS DISTINCT FROM OLD.status OR NEW.custodian_id IS DISTINCT FROM OLD.custodian_id THEN
    INSERT INTO lost_found_custody_history (organization_id, item_id, previous_status, new_status,
      previous_custodian, new_custodian, action, performed_by)
    VALUES (NEW.organization_id, NEW.id,
      CASE WHEN TG_OP='INSERT' THEN NULL ELSE OLD.status END, NEW.status,
      CASE WHEN TG_OP='INSERT' THEN NULL ELSE OLD.custodian_id END, NEW.custodian_id,
      CASE WHEN TG_OP='INSERT' THEN 'registered' ELSE 'updated' END, auth.uid());
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_lf_custody AFTER INSERT OR UPDATE ON public.lost_found_items
FOR EACH ROW EXECUTE FUNCTION public.lf_track_custody();

-- Preventive maintenance generation (no duplicate work orders per due date)
CREATE OR REPLACE FUNCTION public.pm_generate_due(_horizon_days integer DEFAULT 14)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_org uuid := current_org_id(); v_plan record; v_wo uuid; v_count int := 0; v_occ uuid;
BEGIN
  IF NOT (has_permission('maintenance','edit') OR has_permission('maintenance','approve') OR is_org_admin()) THEN
    RAISE EXCEPTION 'Not permitted';
  END IF;
  FOR v_plan IN
    SELECT * FROM preventive_maintenance_plans
     WHERE organization_id=v_org AND status='active' AND next_due_date IS NOT NULL
       AND next_due_date <= CURRENT_DATE + _horizon_days
  LOOP
    IF EXISTS (SELECT 1 FROM preventive_maintenance_occurrences
                WHERE plan_id=v_plan.id AND due_date=v_plan.next_due_date) THEN CONTINUE; END IF;

    INSERT INTO maintenance_work_orders (organization_id, branch_id, work_order_number, asset_id,
      location_label, fault_category, description, priority, status, source_module, source_record_id,
      idempotency_key, assigned_to, estimated_completion, cost_estimate, created_by)
    VALUES (v_org, v_plan.branch_id, next_document_number('work-order'), v_plan.asset_id, v_plan.location_label,
      'preventive', v_plan.name || ' — scheduled ' || v_plan.maintenance_type, 'normal', 'new',
      'preventive-maintenance', v_plan.id, 'pm:'||v_plan.id::text||':'||v_plan.next_due_date::text,
      v_plan.assigned_to, (v_plan.next_due_date)::timestamptz, v_plan.estimated_cost, auth.uid())
    RETURNING id INTO v_wo;

    INSERT INTO preventive_maintenance_occurrences (organization_id, plan_id, due_date, work_order_id, status)
    VALUES (v_org, v_plan.id, v_plan.next_due_date, v_wo, 'scheduled') RETURNING id INTO v_occ;

    UPDATE preventive_maintenance_plans
       SET last_service_date = next_due_date,
           next_due_date = next_due_date + (GREATEST(interval_days,1) || ' days')::interval
     WHERE id = v_plan.id;
    v_count := v_count + 1;
  END LOOP;
  RETURN v_count;
END $$;
REVOKE ALL ON FUNCTION public.pm_generate_due(integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.pm_generate_due(integer) TO authenticated;

-- Operations metrics for the Phase 12 dashboards
CREATE OR REPLACE FUNCTION public.ops_metrics(_branch uuid DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE v_org uuid := current_org_id();
BEGIN
  IF v_org IS NULL THEN RETURN '{}'::jsonb; END IF;
  RETURN jsonb_build_object(
    'rooms_dirty', (SELECT count(*) FROM rooms WHERE organization_id=v_org AND (_branch IS NULL OR branch_id=_branch) AND housekeeping_status='dirty'),
    'rooms_cleaning', (SELECT count(*) FROM housekeeping_jobs WHERE organization_id=v_org AND status='in-progress'),
    'rooms_awaiting_inspection', (SELECT count(*) FROM housekeeping_jobs WHERE organization_id=v_org AND status='awaiting-inspection'),
    'rooms_ready', (SELECT count(*) FROM rooms WHERE organization_id=v_org AND (_branch IS NULL OR branch_id=_branch) AND housekeeping_status='inspected'),
    'rooms_out_of_order', (SELECT count(*) FROM rooms WHERE organization_id=v_org AND (_branch IS NULL OR branch_id=_branch) AND maintenance_status IN ('out-of-order','out-of-service','under-maintenance')),
    'jobs_open', (SELECT count(*) FROM housekeeping_jobs WHERE organization_id=v_org AND status NOT IN ('completed','cancelled')),
    'jobs_rework', (SELECT count(*) FROM housekeeping_jobs WHERE organization_id=v_org AND status='rework'),
    'failed_inspections', (SELECT count(*) FROM room_inspections WHERE organization_id=v_org AND result IN ('failed','reinspection-required')),
    'lost_found_open', (SELECT count(*) FROM lost_found_items WHERE organization_id=v_org AND status IN ('reported','in-custody','potential-owner-identified','contacted')),
    'laundry_active', (SELECT count(*) FROM guest_laundry_orders WHERE organization_id=v_org AND status NOT IN ('completed','cancelled')),
    'laundry_unposted', (SELECT count(*) FROM guest_laundry_orders WHERE organization_id=v_org AND status IN ('delivered','completed') AND posting_status<>'posted'),
    'laundry_revenue', (SELECT COALESCE(sum(total),0) FROM guest_laundry_orders WHERE organization_id=v_org AND posting_status='posted'),
    'linen_incidents', (SELECT count(*) FROM linen_incidents WHERE organization_id=v_org AND status='reported'),
    'wo_new', (SELECT count(*) FROM maintenance_work_orders WHERE organization_id=v_org AND status='new'),
    'wo_open', (SELECT count(*) FROM maintenance_work_orders WHERE organization_id=v_org AND status NOT IN ('closed','cancelled')),
    'wo_emergency', (SELECT count(*) FROM maintenance_work_orders WHERE organization_id=v_org AND priority='emergency' AND status NOT IN ('closed','cancelled')),
    'wo_waiting_parts', (SELECT count(*) FROM maintenance_work_orders WHERE organization_id=v_org AND status IN ('waiting-parts','waiting-supplier')),
    'wo_cost', (SELECT COALESCE(sum(actual_cost),0) FROM maintenance_work_orders WHERE organization_id=v_org),
    'pm_due', (SELECT count(*) FROM preventive_maintenance_plans WHERE organization_id=v_org AND status='active' AND next_due_date <= CURRENT_DATE + 14),
    'assets_total', (SELECT count(*) FROM assets WHERE organization_id=v_org),
    'assets_alert', (SELECT count(*) FROM assets WHERE organization_id=v_org AND (status IN ('under-maintenance','out-of-service') OR (warranty_expiry IS NOT NULL AND warranty_expiry <= CURRENT_DATE + 60))),
    'req_awaiting_approval', (SELECT count(*) FROM internal_requisitions WHERE organization_id=v_org AND status IN ('submitted','pending-supervisor')),
    'req_awaiting_stores', (SELECT count(*) FROM internal_requisitions WHERE organization_id=v_org AND status='awaiting-stores'),
    'req_ready_issue', (SELECT count(*) FROM internal_requisitions WHERE organization_id=v_org AND status IN ('ready-for-issue','partially-approved')),
    'req_awaiting_receipt', (SELECT count(*) FROM internal_requisitions WHERE organization_id=v_org AND status IN ('issued','partially-issued','partially-received')),
    'consumption_value', (SELECT COALESCE(sum(value),0) FROM department_consumption WHERE organization_id=v_org AND consumed_on >= CURRENT_DATE - 30)
  );
END $$;
REVOKE ALL ON FUNCTION public.ops_metrics(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.ops_metrics(uuid) TO authenticated;

-- ---------- 10. PERMISSIONS ----------
INSERT INTO public.permissions (module, action, label) VALUES
  ('housekeeping','board.view','View Room Board'),
  ('housekeeping','assigned.view','View Assigned Rooms'),
  ('housekeeping','assign','Assign Rooms'),
  ('housekeeping','cleaning.start','Start Cleaning'),
  ('housekeeping','cleaning.complete','Complete Cleaning'),
  ('housekeeping','inspect','Inspect Room'),
  ('housekeeping','room.ready','Mark Room Ready'),
  ('housekeeping','inspection.fail','Fail Inspection'),
  ('housekeeping','deep-clean.manage','Manage Deep Cleaning'),
  ('housekeeping','turndown.manage','Manage Turndown'),
  ('housekeeping','guest-requests.manage','Manage Guest Requests'),
  ('housekeeping','lost-found.manage','Manage Lost and Found'),
  ('housekeeping','reports.view','View Housekeeping Reports'),
  ('housekeeping','reports.export','Export Housekeeping Reports'),
  ('laundry','orders.create','Create Guest Laundry Request'),
  ('laundry','collect','Collect Laundry'),
  ('laundry','status.update','Update Laundry Status'),
  ('laundry','complete','Complete Laundry'),
  ('laundry','deliver','Deliver Laundry'),
  ('laundry','charge.post','Post Laundry Charge'),
  ('laundry','hotel.manage','Manage Hotel Laundry'),
  ('laundry','linen.manage','Manage Linen'),
  ('laundry','damage.report','Report Damage'),
  ('laundry','linen.approve','Approve Linen Adjustment'),
  ('laundry','reports.view','View Laundry Reports'),
  ('maintenance','work-orders.view','View Work Orders'),
  ('maintenance','work-orders.create','Create Work Order'),
  ('maintenance','work-orders.assign','Assign Work Order'),
  ('maintenance','work-orders.accept','Accept Work Order'),
  ('maintenance','work-orders.update','Update Work Order'),
  ('maintenance','work-orders.complete','Complete Work Order'),
  ('maintenance','work-orders.verify','Verify Work Order'),
  ('maintenance','work-orders.reopen','Reopen Work Order'),
  ('maintenance','room.block','Block Room'),
  ('maintenance','room.release','Release Technical Block'),
  ('maintenance','preventive.manage','Manage Preventive Maintenance'),
  ('maintenance','assets.manage','Manage Assets'),
  ('maintenance','assets.transfer','Transfer Asset'),
  ('maintenance','parts.request','Request Parts'),
  ('maintenance','costs.view','View Maintenance Costs'),
  ('maintenance','reports.view','View Maintenance Reports'),
  ('stores','requisition.create','Create Requisition'),
  ('stores','requisition.submit','Submit Requisition'),
  ('stores','requisition.approve','Approve Department Requisition'),
  ('stores','requisition.review','Review Store Requisition'),
  ('stores','requisition.partial','Partially Approve'),
  ('stores','requisition.issue','Issue Stock'),
  ('stores','requisition.receive','Confirm Receipt'),
  ('stores','requisition.discrepancy','Record Discrepancy'),
  ('stores','requisition.cancel','Cancel Requisition'),
  ('stores','mini-store.manage','Manage Mini-Store'),
  ('stores','consumption.record','Record Department Consumption'),
  ('stores','consumption.view','View Department Consumption'),
  ('stores','requisition.view-all','View All Requisitions'),
  ('stores','requisition.export','Export Requisition Reports')
ON CONFLICT DO NOTHING;

-- Grant the new permissions to Owner and System Administrator roles in every organisation
INSERT INTO public.role_permissions (organization_id, role_id, permission_id)
SELECT r.organization_id, r.id, p.id
  FROM public.roles r
  CROSS JOIN public.permissions p
 WHERE r.name IN ('Owner','System Administrator')
   AND p.module IN ('housekeeping','laundry','maintenance','stores')
   AND NOT EXISTS (
     SELECT 1 FROM public.role_permissions rp WHERE rp.role_id = r.id AND rp.permission_id = p.id
   );
