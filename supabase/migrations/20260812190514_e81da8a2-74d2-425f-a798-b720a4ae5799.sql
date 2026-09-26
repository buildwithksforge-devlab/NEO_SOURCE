-- =========================================================
-- PHASE 8: KITCHEN MANAGEMENT SYSTEM
-- Extends Phase 7 POS/KDS foundations. No POS/CRM/PMS tables duplicated.
-- =========================================================

-- ---------- 1. Extend existing ticket tables ----------
ALTER TABLE public.station_tickets
  ADD COLUMN IF NOT EXISTS department_id uuid REFERENCES public.departments(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS received_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS completed_at timestamptz,
  ADD COLUMN IF NOT EXISTS cancelled_at timestamptz,
  ADD COLUMN IF NOT EXISTS assigned_chef_id uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS priority_reason text,
  ADD COLUMN IF NOT EXISTS prioritized_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS created_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS routing_note text;

ALTER TABLE public.station_tickets DROP CONSTRAINT IF EXISTS station_tickets_status_chk;
ALTER TABLE public.station_tickets ADD CONSTRAINT station_tickets_status_chk CHECK (status = ANY (ARRAY[
  'new','accepted','preparing','partially-ready','ready','served','cancel-pending','cancelled','completed','delayed']));

CREATE UNIQUE INDEX IF NOT EXISTS station_tickets_order_station_course_uidx
  ON public.station_tickets (order_id, COALESCE(station_id, '00000000-0000-0000-0000-000000000000'::uuid), course);
CREATE INDEX IF NOT EXISTS station_tickets_queue_idx ON public.station_tickets (organization_id, branch_id, station_id, status, received_at);

ALTER TABLE public.station_ticket_items
  ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'new',
  ADD COLUMN IF NOT EXISTS chef_id uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS accepted_at timestamptz,
  ADD COLUMN IF NOT EXISTS started_at timestamptz,
  ADD COLUMN IF NOT EXISTS ready_at timestamptz,
  ADD COLUMN IF NOT EXISTS collected_at timestamptz,
  ADD COLUMN IF NOT EXISTS served_at timestamptz,
  ADD COLUMN IF NOT EXISTS cancelled_at timestamptz,
  ADD COLUMN IF NOT EXISTS completed_at timestamptz,
  ADD COLUMN IF NOT EXISTS remake_of_id uuid REFERENCES public.station_ticket_items(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS production_note text,
  ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();

ALTER TABLE public.station_ticket_items DROP CONSTRAINT IF EXISTS station_ticket_items_status_chk;
ALTER TABLE public.station_ticket_items ADD CONSTRAINT station_ticket_items_status_chk CHECK (status = ANY (ARRAY[
  'new','accepted','preparing','ready','collected','served','cancel-pending','cancelled','remake-requested','remaking','completed']));

DROP TRIGGER IF EXISTS set_updated_at_station_ticket_items ON public.station_ticket_items;
CREATE TRIGGER set_updated_at_station_ticket_items BEFORE UPDATE ON public.station_ticket_items
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

-- ---------- 2. Extend recipes for versioning / portions ----------
ALTER TABLE public.recipes
  ADD COLUMN IF NOT EXISTS branch_id uuid REFERENCES public.branches(id) ON DELETE CASCADE,
  ADD COLUMN IF NOT EXISTS name text,
  ADD COLUMN IF NOT EXISTS yield_unit text NOT NULL DEFAULT 'portion',
  ADD COLUMN IF NOT EXISTS portion_size numeric,
  ADD COLUMN IF NOT EXISTS portion_unit text,
  ADD COLUMN IF NOT EXISTS prep_target_minutes integer,
  ADD COLUMN IF NOT EXISTS preparation_steps text,
  ADD COLUMN IF NOT EXISTS cost_snapshot numeric,
  ADD COLUMN IF NOT EXISTS portion_cost numeric,
  ADD COLUMN IF NOT EXISTS effective_to date,
  ADD COLUMN IF NOT EXISTS approved_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS approved_at timestamptz,
  ADD COLUMN IF NOT EXISTS supersedes_id uuid REFERENCES public.recipes(id) ON DELETE SET NULL;

ALTER TABLE public.recipes DROP CONSTRAINT IF EXISTS recipes_status_chk;
ALTER TABLE public.recipes ADD CONSTRAINT recipes_status_chk CHECK (status = ANY (ARRAY[
  'draft','under-review','approved','active','superseded','archived']));

ALTER TABLE public.recipe_ingredients
  ADD COLUMN IF NOT EXISTS inventory_item_ref text,
  ADD COLUMN IF NOT EXISTS waste_allowance numeric NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS is_substitutable boolean NOT NULL DEFAULT false;

-- ---------- 3. New kitchen tables ----------
CREATE TABLE IF NOT EXISTS public.station_routing_rules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  branch_id uuid REFERENCES public.branches(id) ON DELETE CASCADE,
  menu_item_id uuid REFERENCES public.menu_items(id) ON DELETE CASCADE,
  category_id uuid REFERENCES public.menu_categories(id) ON DELETE CASCADE,
  modifier_option_id uuid REFERENCES public.modifier_options(id) ON DELETE CASCADE,
  order_type text,
  station_id uuid NOT NULL REFERENCES public.operational_stations(id) ON DELETE CASCADE,
  secondary_station_id uuid REFERENCES public.operational_stations(id) ON DELETE SET NULL,
  priority integer NOT NULL DEFAULT 100,
  active boolean NOT NULL DEFAULT true,
  created_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.station_ticket_status_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  ticket_id uuid REFERENCES public.station_tickets(id) ON DELETE CASCADE,
  ticket_item_id uuid REFERENCES public.station_ticket_items(id) ON DELETE CASCADE,
  from_status text,
  to_status text NOT NULL,
  reason text,
  changed_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS station_ticket_status_history_ticket_idx ON public.station_ticket_status_history (ticket_id, created_at DESC);

CREATE TABLE IF NOT EXISTS public.ticket_assignments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  branch_id uuid REFERENCES public.branches(id) ON DELETE CASCADE,
  ticket_id uuid REFERENCES public.station_tickets(id) ON DELETE CASCADE,
  ticket_item_id uuid REFERENCES public.station_ticket_items(id) ON DELETE CASCADE,
  station_id uuid REFERENCES public.operational_stations(id) ON DELETE SET NULL,
  chef_id uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  assigned_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  method text NOT NULL DEFAULT 'manual',
  reason text,
  released_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ticket_assignments_chef_idx ON public.ticket_assignments (organization_id, chef_id, created_at DESC);

CREATE TABLE IF NOT EXISTS public.ticket_clarifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  branch_id uuid REFERENCES public.branches(id) ON DELETE CASCADE,
  ticket_id uuid REFERENCES public.station_tickets(id) ON DELETE CASCADE,
  ticket_item_id uuid REFERENCES public.station_ticket_items(id) ON DELETE CASCADE,
  order_item_id uuid REFERENCES public.pos_order_items(id) ON DELETE SET NULL,
  question text NOT NULL,
  answer text,
  asked_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  answered_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  answered_at timestamptz,
  status text NOT NULL DEFAULT 'open' CHECK (status = ANY (ARRAY['open','answered','closed'])),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.preparation_targets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  branch_id uuid REFERENCES public.branches(id) ON DELETE CASCADE,
  scope text NOT NULL CHECK (scope = ANY (ARRAY['menu-item','category','station','order-type','priority','branch'])),
  menu_item_id uuid REFERENCES public.menu_items(id) ON DELETE CASCADE,
  category_id uuid REFERENCES public.menu_categories(id) ON DELETE CASCADE,
  station_id uuid REFERENCES public.operational_stations(id) ON DELETE CASCADE,
  order_type text,
  priority text,
  target_minutes integer NOT NULL CHECK (target_minutes > 0),
  warning_minutes integer,
  critical_minutes integer,
  active boolean NOT NULL DEFAULT true,
  created_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.kitchen_settings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  branch_id uuid REFERENCES public.branches(id) ON DELETE CASCADE,
  settings jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS kitchen_settings_scope_uidx
  ON public.kitchen_settings (organization_id, COALESCE(branch_id, '00000000-0000-0000-0000-000000000000'::uuid));

CREATE TABLE IF NOT EXISTS public.portion_standards (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  branch_id uuid REFERENCES public.branches(id) ON DELETE CASCADE,
  menu_item_id uuid REFERENCES public.menu_items(id) ON DELETE CASCADE,
  recipe_id uuid REFERENCES public.recipes(id) ON DELETE SET NULL,
  serving_quantity numeric,
  unit text,
  piece_count integer,
  weight_grams numeric,
  scoop_guide text,
  accompaniment text,
  garnish text,
  serving_vessel text,
  variance_percent numeric NOT NULL DEFAULT 5,
  image_url text,
  notes text,
  created_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.production_batches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  branch_id uuid REFERENCES public.branches(id) ON DELETE CASCADE,
  station_id uuid REFERENCES public.operational_stations(id) ON DELETE SET NULL,
  recipe_id uuid REFERENCES public.recipes(id) ON DELETE SET NULL,
  batch_number text NOT NULL,
  planned_quantity numeric NOT NULL CHECK (planned_quantity > 0),
  actual_quantity numeric,
  unit text NOT NULL DEFAULT 'portion',
  prepared_at timestamptz,
  use_by timestamptz,
  chef_id uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  yield_variance numeric,
  waste_quantity numeric,
  status text NOT NULL DEFAULT 'planned' CHECK (status = ANY (ARRAY['planned','in-preparation','completed','partially-used','fully-used','discarded','closed'])),
  notes text,
  created_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, batch_number)
);

CREATE TABLE IF NOT EXISTS public.batch_ingredient_usage (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  batch_id uuid NOT NULL REFERENCES public.production_batches(id) ON DELETE CASCADE,
  ingredient_name text NOT NULL,
  quantity numeric NOT NULL,
  unit text NOT NULL,
  unit_cost numeric,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.kitchen_ingredient_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  branch_id uuid REFERENCES public.branches(id) ON DELETE CASCADE,
  department_id uuid REFERENCES public.departments(id) ON DELETE SET NULL,
  station_id uuid REFERENCES public.operational_stations(id) ON DELETE SET NULL,
  request_number text NOT NULL,
  ingredient_name text NOT NULL,
  quantity numeric NOT NULL CHECK (quantity > 0),
  unit text NOT NULL,
  required_by timestamptz,
  priority text NOT NULL DEFAULT 'normal' CHECK (priority = ANY (ARRAY['low','normal','high','urgent'])),
  reason text,
  batch_id uuid REFERENCES public.production_batches(id) ON DELETE SET NULL,
  order_id uuid REFERENCES public.pos_orders(id) ON DELETE SET NULL,
  status text NOT NULL DEFAULT 'draft' CHECK (status = ANY (ARRAY['draft','submitted','stores-reviewing','available','partially-available','issued','collected','not-available','escalated-to-procurement','cancelled','closed'])),
  issued_quantity numeric,
  stores_note text,
  procurement_reference text,
  requested_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  handled_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, request_number)
);

CREATE TABLE IF NOT EXISTS public.ingredient_shortage_alerts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  branch_id uuid REFERENCES public.branches(id) ON DELETE CASCADE,
  station_id uuid REFERENCES public.operational_stations(id) ON DELETE SET NULL,
  ingredient_name text NOT NULL,
  available_quantity numeric,
  minimum_level numeric,
  reorder_level numeric,
  unit text,
  severity text NOT NULL DEFAULT 'medium' CHECK (severity = ANY (ARRAY['low','medium','high','critical'])),
  affected_menu_items text,
  request_id uuid REFERENCES public.kitchen_ingredient_requests(id) ON DELETE SET NULL,
  status text NOT NULL DEFAULT 'open' CHECK (status = ANY (ARRAY['open','stores-notified','request-created','escalated','resolved','closed'])),
  reported_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  resolved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.waste_records (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  branch_id uuid REFERENCES public.branches(id) ON DELETE CASCADE,
  station_id uuid REFERENCES public.operational_stations(id) ON DELETE SET NULL,
  waste_number text NOT NULL,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  ingredient_name text,
  menu_item_id uuid REFERENCES public.menu_items(id) ON DELETE SET NULL,
  batch_id uuid REFERENCES public.production_batches(id) ON DELETE SET NULL,
  order_item_id uuid REFERENCES public.pos_order_items(id) ON DELETE SET NULL,
  quantity numeric NOT NULL CHECK (quantity > 0),
  unit text NOT NULL,
  estimated_cost numeric,
  category text NOT NULL,
  reason text,
  status text NOT NULL DEFAULT 'recorded' CHECK (status = ANY (ARRAY['recorded','pending-review','approved','rejected','posted','cancelled'])),
  inventory_adjustment_status text NOT NULL DEFAULT 'not-posted' CHECK (inventory_adjustment_status = ANY (ARRAY['not-posted','posted','failed','not-applicable'])),
  attachment_url text,
  approval_request_id uuid REFERENCES public.approval_requests(id) ON DELETE SET NULL,
  recorded_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  reviewed_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  reviewed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, waste_number)
);

CREATE TABLE IF NOT EXISTS public.waste_approval_actions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  waste_record_id uuid NOT NULL REFERENCES public.waste_records(id) ON DELETE CASCADE,
  action text NOT NULL CHECK (action = ANY (ARRAY['submitted','approved','rejected','posted','cancelled'])),
  comment text,
  acted_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.returned_meal_records (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  branch_id uuid REFERENCES public.branches(id) ON DELETE CASCADE,
  station_id uuid REFERENCES public.operational_stations(id) ON DELETE SET NULL,
  order_id uuid REFERENCES public.pos_orders(id) ON DELETE SET NULL,
  order_item_id uuid REFERENCES public.pos_order_items(id) ON DELETE SET NULL,
  ticket_item_id uuid REFERENCES public.station_ticket_items(id) ON DELETE SET NULL,
  reason_category text NOT NULL,
  reason text,
  feedback_id uuid REFERENCES public.customer_feedback(id) ON DELETE SET NULL,
  kitchen_review text,
  manager_decision text CHECK (manager_decision IS NULL OR manager_decision = ANY (ARRAY['remake','refund-requested','no-action','discard'])),
  remake_ticket_item_id uuid REFERENCES public.station_ticket_items(id) ON DELETE SET NULL,
  waste_record_id uuid REFERENCES public.waste_records(id) ON DELETE SET NULL,
  financial_treatment text,
  status text NOT NULL DEFAULT 'reported' CHECK (status = ANY (ARRAY['reported','under-review','remaking','resolved','closed'])),
  reported_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  decided_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.quality_checklists (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  branch_id uuid REFERENCES public.branches(id) ON DELETE CASCADE,
  station_id uuid REFERENCES public.operational_stations(id) ON DELETE SET NULL,
  name text NOT NULL,
  checklist_type text NOT NULL,
  menu_item_id uuid REFERENCES public.menu_items(id) ON DELETE SET NULL,
  category_id uuid REFERENCES public.menu_categories(id) ON DELETE SET NULL,
  frequency text NOT NULL DEFAULT 'per-item',
  requires_supervisor boolean NOT NULL DEFAULT false,
  active boolean NOT NULL DEFAULT true,
  created_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.quality_checklist_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  checklist_id uuid NOT NULL REFERENCES public.quality_checklists(id) ON DELETE CASCADE,
  label text NOT NULL,
  required boolean NOT NULL DEFAULT true,
  display_order integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.quality_check_records (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  branch_id uuid REFERENCES public.branches(id) ON DELETE CASCADE,
  checklist_id uuid REFERENCES public.quality_checklists(id) ON DELETE SET NULL,
  station_id uuid REFERENCES public.operational_stations(id) ON DELETE SET NULL,
  ticket_item_id uuid REFERENCES public.station_ticket_items(id) ON DELETE SET NULL,
  order_item_id uuid REFERENCES public.pos_order_items(id) ON DELETE SET NULL,
  batch_id uuid REFERENCES public.production_batches(id) ON DELETE SET NULL,
  result text NOT NULL DEFAULT 'pass' CHECK (result = ANY (ARRAY['pass','fail','partial'])),
  responses jsonb NOT NULL DEFAULT '[]'::jsonb,
  exceptions text,
  corrective_action text,
  completed_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  reviewed_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  reviewed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.quality_holds (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  branch_id uuid REFERENCES public.branches(id) ON DELETE CASCADE,
  scope text NOT NULL CHECK (scope = ANY (ARRAY['ticket-item','batch','station','menu-item'])),
  ticket_item_id uuid REFERENCES public.station_ticket_items(id) ON DELETE CASCADE,
  batch_id uuid REFERENCES public.production_batches(id) ON DELETE CASCADE,
  station_id uuid REFERENCES public.operational_stations(id) ON DELETE CASCADE,
  menu_item_id uuid REFERENCES public.menu_items(id) ON DELETE CASCADE,
  reason text NOT NULL,
  blocks_release boolean NOT NULL DEFAULT true,
  status text NOT NULL DEFAULT 'active' CHECK (status = ANY (ARRAY['active','released','cancelled'])),
  created_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  released_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  released_at timestamptz,
  release_note text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.kitchen_equipment_issues (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  branch_id uuid REFERENCES public.branches(id) ON DELETE CASCADE,
  station_id uuid REFERENCES public.operational_stations(id) ON DELETE SET NULL,
  issue_type text NOT NULL,
  equipment_reference text,
  description text NOT NULL,
  priority text NOT NULL DEFAULT 'normal' CHECK (priority = ANY (ARRAY['low','normal','high','urgent'])),
  operational_impact text,
  affected_menu_items text,
  task_id uuid REFERENCES public.tasks(id) ON DELETE SET NULL,
  status text NOT NULL DEFAULT 'reported' CHECK (status = ANY (ARRAY['reported','acknowledged','in-progress','resolved','closed'])),
  reported_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  resolved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.kitchen_shifts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  branch_id uuid REFERENCES public.branches(id) ON DELETE CASCADE,
  station_id uuid REFERENCES public.operational_stations(id) ON DELETE SET NULL,
  name text NOT NULL,
  starts_at timestamptz NOT NULL,
  ends_at timestamptz,
  supervisor_id uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  status text NOT NULL DEFAULT 'open' CHECK (status = ANY (ARRAY['open','closed'])),
  created_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.kitchen_handovers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  branch_id uuid REFERENCES public.branches(id) ON DELETE CASCADE,
  shift_id uuid REFERENCES public.kitchen_shifts(id) ON DELETE SET NULL,
  station_id uuid REFERENCES public.operational_stations(id) ON DELETE SET NULL,
  open_tickets integer NOT NULL DEFAULT 0,
  pending_batches integer NOT NULL DEFAULT 0,
  shortages text,
  equipment_issues text,
  unavailable_items text,
  quality_holds text,
  pending_tasks text,
  notes text,
  completed_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  accepted_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  accepted_at timestamptz,
  status text NOT NULL DEFAULT 'draft' CHECK (status = ANY (ARRAY['draft','submitted','accepted'])),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.kitchen_ai_insights (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  branch_id uuid REFERENCES public.branches(id) ON DELETE CASCADE,
  insight_type text NOT NULL,
  title text NOT NULL,
  body text NOT NULL,
  period_start timestamptz,
  period_end timestamptz,
  data_sources jsonb NOT NULL DEFAULT '[]'::jsonb,
  model text,
  confidence text,
  generated_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- ---------- 4. Grants, RLS, policies, updated_at triggers ----------
DO $$
DECLARE t record;
BEGIN
  FOR t IN SELECT * FROM (VALUES
    ('station_routing_rules','station.manage'),
    ('station_ticket_status_history','item.prepare'),
    ('ticket_assignments','chef.assign'),
    ('ticket_clarifications','clarification.request'),
    ('preparation_targets','settings.manage'),
    ('kitchen_settings','settings.manage'),
    ('portion_standards','recipes.edit'),
    ('production_batches','production.manage'),
    ('batch_ingredient_usage','production.manage'),
    ('kitchen_ingredient_requests','ingredient_request.create'),
    ('ingredient_shortage_alerts','ingredient_request.create'),
    ('waste_records','waste.record'),
    ('waste_approval_actions','waste.approve'),
    ('returned_meal_records','item.prepare'),
    ('quality_checklists','quality.approve'),
    ('quality_checklist_items','quality.approve'),
    ('quality_check_records','quality.complete'),
    ('quality_holds','quality_hold.create'),
    ('kitchen_equipment_issues','access'),
    ('kitchen_shifts','settings.manage'),
    ('kitchen_handovers','access'),
    ('kitchen_ai_insights','ai.generate')
  ) AS v(tbl, act)
  LOOP
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON public.%I TO authenticated', t.tbl);
    EXECUTE format('GRANT ALL ON public.%I TO service_role', t.tbl);
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t.tbl);
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', t.tbl || '_select', t.tbl);
    EXECUTE format('CREATE POLICY %I ON public.%I FOR SELECT TO authenticated USING (organization_id = public.current_org_id())', t.tbl || '_select', t.tbl);
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', t.tbl || '_write', t.tbl);
    EXECUTE format('CREATE POLICY %I ON public.%I FOR ALL TO authenticated USING (organization_id = public.current_org_id() AND public.has_permission(%L, %L)) WITH CHECK (organization_id = public.current_org_id() AND public.has_permission(%L, %L))',
      t.tbl || '_write', t.tbl, 'kitchen', t.act, 'kitchen', t.act);
    EXECUTE format('DROP TRIGGER IF EXISTS %I ON public.%I', 'set_updated_at_' || t.tbl, t.tbl);
    EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at()', 'set_updated_at_' || t.tbl, t.tbl);
  END LOOP;
END $$;

-- ---------- 5. Kitchen permissions ----------
INSERT INTO public.permissions (module, action, label)
SELECT 'kitchen', a.action, a.label FROM (VALUES
  ('access','Access kitchen system'),
  ('queue.view','View live kitchen queue'),
  ('all_stations.view','View all kitchen stations'),
  ('ticket.accept','Accept station tickets'),
  ('item.prepare','Start preparing items'),
  ('item.ready','Mark items ready'),
  ('item.cancel_request','Request item cancellation'),
  ('item.reassign','Reassign items between stations'),
  ('ticket.prioritize','Change ticket priority'),
  ('delay.report','Report preparation delays'),
  ('clarification.request','Request clarification from service'),
  ('station.manage','Manage kitchen stations and routing'),
  ('chef.assign','Assign chefs to tickets'),
  ('menu_availability.manage','Manage menu item availability'),
  ('recipes.view','View recipes'),
  ('recipes.create','Create recipes'),
  ('recipes.edit','Edit recipes'),
  ('recipes.approve','Approve recipes'),
  ('portions.view','View portion standards'),
  ('quality.complete','Complete quality checks'),
  ('quality.approve','Approve quality checks'),
  ('quality_hold.create','Create quality holds'),
  ('quality_hold.release','Release quality holds'),
  ('waste.view','View waste records'),
  ('waste.record','Record waste and spoilage'),
  ('waste.approve','Approve waste adjustments'),
  ('ingredient_request.create','Create ingredient requests'),
  ('ingredient_request.view','View ingredient requests'),
  ('production.manage','Manage production batches'),
  ('reports.view','View kitchen reports'),
  ('reports.export','Export kitchen reports'),
  ('settings.manage','Manage kitchen settings'),
  ('ai.view','View AI kitchen insights'),
  ('ai.generate','Generate AI kitchen insights')
) AS a(action, label)
WHERE NOT EXISTS (SELECT 1 FROM public.permissions p WHERE p.module = 'kitchen' AND p.action = a.action);

-- Grant the full kitchen set to owner/admin/kitchen-manager style roles, and a chef subset to chef roles.
INSERT INTO public.role_permissions (organization_id, role_id, permission_id)
SELECT r.organization_id, r.id, p.id
FROM public.roles r
JOIN public.permissions p ON p.module = 'kitchen'
WHERE (r.name ILIKE '%kitchen manager%' OR r.name ILIKE '%executive chef%' OR r.name IN ('Owner','System Administrator','General Manager'))
  AND NOT EXISTS (SELECT 1 FROM public.role_permissions rp WHERE rp.role_id = r.id AND rp.permission_id = p.id);

INSERT INTO public.role_permissions (organization_id, role_id, permission_id)
SELECT r.organization_id, r.id, p.id
FROM public.roles r
JOIN public.permissions p ON p.module = 'kitchen'
  AND p.action IN ('access','queue.view','ticket.accept','item.prepare','item.ready','item.cancel_request',
                   'delay.report','clarification.request','recipes.view','portions.view','quality.complete',
                   'waste.record','ingredient_request.create','ingredient_request.view')
WHERE (r.name ILIKE '%chef%' OR r.name ILIKE '%pastry%' OR r.name ILIKE '%kitchen%' OR r.name ILIKE '%cook%')
  AND r.name NOT ILIKE '%kitchen manager%'
  AND NOT EXISTS (SELECT 1 FROM public.role_permissions rp WHERE rp.role_id = r.id AND rp.permission_id = p.id);

-- Supervisor extras for kitchen supervisors
INSERT INTO public.role_permissions (organization_id, role_id, permission_id)
SELECT r.organization_id, r.id, p.id
FROM public.roles r
JOIN public.permissions p ON p.module = 'kitchen'
  AND p.action IN ('all_stations.view','chef.assign','item.reassign','ticket.prioritize','quality.approve',
                   'quality_hold.create','quality_hold.release','waste.view','waste.approve','production.manage',
                   'menu_availability.manage','reports.view','ai.view')
WHERE (r.name ILIKE '%supervisor%' AND (r.name ILIKE '%kitchen%' OR r.name ILIKE '%pastry%' OR r.name ILIKE '%grill%' OR r.name ILIKE '%hot%'))
  AND NOT EXISTS (SELECT 1 FROM public.role_permissions rp WHERE rp.role_id = r.id AND rp.permission_id = p.id);

-- ---------- 6. Secure kitchen routines ----------

-- Resolve the station for a POS order item using configurable routing rules.
CREATE OR REPLACE FUNCTION public.kitchen_resolve_station(_org uuid, _branch uuid, _order_item_id uuid)
RETURNS uuid LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE _station uuid; _menu_item uuid; _category uuid; _order_type text;
BEGIN
  SELECT oi.station_id, oi.menu_item_id, mi.category_id, o.order_type
    INTO _station, _menu_item, _category, _order_type
  FROM public.pos_order_items oi
  JOIN public.pos_orders o ON o.id = oi.order_id
  LEFT JOIN public.menu_items mi ON mi.id = oi.menu_item_id
  WHERE oi.id = _order_item_id AND oi.organization_id = _org;

  IF _station IS NOT NULL THEN RETURN _station; END IF;

  SELECT r.station_id INTO _station
  FROM public.station_routing_rules r
  WHERE r.organization_id = _org AND r.active
    AND (r.branch_id IS NULL OR r.branch_id = _branch)
    AND (r.menu_item_id IS NULL OR r.menu_item_id = _menu_item)
    AND (r.category_id IS NULL OR r.category_id = _category)
    AND (r.order_type IS NULL OR r.order_type = _order_type)
    AND (r.menu_item_id IS NOT NULL OR r.category_id IS NOT NULL OR r.order_type IS NOT NULL)
  ORDER BY (r.menu_item_id IS NOT NULL) DESC, (r.category_id IS NOT NULL) DESC, r.priority
  LIMIT 1;

  IF _station IS NOT NULL THEN RETURN _station; END IF;

  SELECT mi.station_id INTO _station FROM public.menu_items mi WHERE mi.id = _menu_item;
  IF _station IS NOT NULL THEN RETURN _station; END IF;
  SELECT mc.station_id INTO _station FROM public.menu_categories mc WHERE mc.id = _category;
  RETURN _station;
END $$;
REVOKE ALL ON FUNCTION public.kitchen_resolve_station(uuid, uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.kitchen_resolve_station(uuid, uuid, uuid) TO authenticated;

-- Route confirmed (sent, unheld) POS items into station tickets exactly once.
CREATE OR REPLACE FUNCTION public.kitchen_route_order(_order_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  _org uuid; _branch uuid; _o record; _it record;
  _station uuid; _ticket uuid; _tickets int := 0; _items int := 0; _unrouted int := 0;
  _target int;
BEGIN
  _org := public.current_org_id();
  IF _org IS NULL THEN RAISE EXCEPTION 'No active organization'; END IF;

  SELECT * INTO _o FROM public.pos_orders WHERE id = _order_id AND organization_id = _org;
  IF _o.id IS NULL THEN RAISE EXCEPTION 'Order not found'; END IF;
  IF _o.status IN ('draft','held') THEN RAISE EXCEPTION 'Draft or held orders are not routed to the kitchen'; END IF;
  _branch := _o.branch_id;

  FOR _it IN
    SELECT oi.* FROM public.pos_order_items oi
    WHERE oi.order_id = _order_id AND oi.organization_id = _org
      AND oi.held = false
      AND oi.status IN ('sent','accepted','preparing')
      AND NOT EXISTS (SELECT 1 FROM public.station_ticket_items sti WHERE sti.order_item_id = oi.id)
  LOOP
    _station := public.kitchen_resolve_station(_org, _branch, _it.id);
    IF _station IS NULL THEN _unrouted := _unrouted + 1; END IF;

    SELECT COALESCE(
      (SELECT pt.target_minutes FROM public.preparation_targets pt
        WHERE pt.organization_id = _org AND pt.active
          AND (pt.branch_id IS NULL OR pt.branch_id = _branch)
          AND ((pt.scope='menu-item' AND pt.menu_item_id = _it.menu_item_id)
            OR (pt.scope='station' AND pt.station_id = _station)
            OR (pt.scope='order-type' AND pt.order_type = _o.order_type)
            OR (pt.scope='branch'))
        ORDER BY CASE pt.scope WHEN 'menu-item' THEN 1 WHEN 'station' THEN 2 WHEN 'order-type' THEN 3 ELSE 4 END
        LIMIT 1),
      (SELECT mi.prep_minutes FROM public.menu_items mi WHERE mi.id = _it.menu_item_id),
      15) INTO _target;

    INSERT INTO public.station_tickets (
      organization_id, branch_id, department_id, order_id, station_id, ticket_number, course,
      priority, status, target_minutes, received_at, created_by)
    VALUES (_org, _branch,
      (SELECT s.department_id FROM public.operational_stations s WHERE s.id = _station),
      _order_id, _station,
      'KT-' || upper(substr(replace(_order_id::text,'-',''),1,6)) || '-' || upper(substr(md5(COALESCE(_station::text,'unassigned') || _it.course), 1, 4)),
      _it.course, COALESCE(_o.order_type,'dine-in'), 'new', _target, now(), auth.uid())
    ON CONFLICT (order_id, COALESCE(station_id, '00000000-0000-0000-0000-000000000000'::uuid), course) DO NOTHING;

    SELECT id INTO _ticket FROM public.station_tickets
      WHERE order_id = _order_id AND course = _it.course
        AND COALESCE(station_id,'00000000-0000-0000-0000-000000000000'::uuid) = COALESCE(_station,'00000000-0000-0000-0000-000000000000'::uuid);
    IF _ticket IS NULL THEN CONTINUE; END IF;
    _tickets := _tickets + 1;

    INSERT INTO public.station_ticket_items (organization_id, ticket_id, order_item_id, status)
    VALUES (_org, _ticket, _it.id, 'new')
    ON CONFLICT (ticket_id, order_item_id) DO NOTHING;
    _items := _items + 1;

    PERFORM public.emit_domain_event(_org, _branch, 'kitchen.ticket.created', 'kitchen', _ticket,
      jsonb_build_object('order_id', _order_id, 'station_id', _station, 'order_item_id', _it.id),
      'kitchen-ticket-item-' || _it.id::text, _o.customer_id);
  END LOOP;

  RETURN jsonb_build_object('items_routed', _items, 'tickets_touched', _tickets, 'unrouted_items', _unrouted);
END $$;
REVOKE ALL ON FUNCTION public.kitchen_route_order(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.kitchen_route_order(uuid) TO authenticated;

-- Server-enforced ticket-item transitions + parent rollup.
CREATE OR REPLACE FUNCTION public.kitchen_item_transition(_ticket_item_id uuid, _to_status text, _reason text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  _org uuid; _ti record; _t record; _allowed text[]; _now timestamptz := now();
  _active int; _ready int; _order_state text; _ticket_state text; _perm text;
BEGIN
  _org := public.current_org_id();
  SELECT * INTO _ti FROM public.station_ticket_items WHERE id = _ticket_item_id AND organization_id = _org;
  IF _ti.id IS NULL THEN RAISE EXCEPTION 'Ticket item not found'; END IF;
  SELECT * INTO _t FROM public.station_tickets WHERE id = _ti.ticket_id;

  _perm := CASE _to_status
    WHEN 'accepted' THEN 'ticket.accept'
    WHEN 'preparing' THEN 'item.prepare'
    WHEN 'ready' THEN 'item.ready'
    WHEN 'cancel-pending' THEN 'item.cancel_request'
    WHEN 'remake-requested' THEN 'item.cancel_request'
    ELSE 'item.prepare' END;
  IF NOT public.has_permission('kitchen', _perm) THEN
    RAISE EXCEPTION 'You do not have the kitchen.% permission', _perm;
  END IF;

  _allowed := CASE _ti.status
    WHEN 'new' THEN ARRAY['accepted','cancel-pending','cancelled']
    WHEN 'accepted' THEN ARRAY['preparing','cancel-pending','cancelled']
    WHEN 'preparing' THEN ARRAY['ready','cancel-pending','cancelled']
    WHEN 'ready' THEN ARRAY['collected','remake-requested','cancelled']
    WHEN 'collected' THEN ARRAY['served','remake-requested']
    WHEN 'served' THEN ARRAY['completed','remake-requested']
    WHEN 'cancel-pending' THEN ARRAY['cancelled','accepted','preparing']
    WHEN 'remake-requested' THEN ARRAY['remaking','cancelled']
    WHEN 'remaking' THEN ARRAY['ready','cancelled']
    ELSE ARRAY[]::text[] END;
  IF NOT (_to_status = ANY (_allowed)) THEN
    RAISE EXCEPTION 'Cannot move a % item to %', _ti.status, _to_status;
  END IF;

  IF _to_status IN ('ready','collected','served','completed')
     AND EXISTS (SELECT 1 FROM public.quality_holds qh
                  WHERE qh.ticket_item_id = _ticket_item_id AND qh.status = 'active' AND qh.blocks_release) THEN
    RAISE EXCEPTION 'This item is on an active quality hold and cannot be released';
  END IF;

  UPDATE public.station_ticket_items SET
    status = _to_status,
    chef_id = CASE WHEN _to_status IN ('accepted','preparing') THEN COALESCE(chef_id, auth.uid()) ELSE chef_id END,
    accepted_at = CASE WHEN _to_status = 'accepted' THEN COALESCE(accepted_at, _now) ELSE accepted_at END,
    started_at = CASE WHEN _to_status IN ('preparing','remaking') THEN COALESCE(started_at, _now) ELSE started_at END,
    ready_at = CASE WHEN _to_status = 'ready' THEN _now ELSE ready_at END,
    collected_at = CASE WHEN _to_status = 'collected' THEN _now ELSE collected_at END,
    served_at = CASE WHEN _to_status = 'served' THEN _now ELSE served_at END,
    cancelled_at = CASE WHEN _to_status = 'cancelled' THEN _now ELSE cancelled_at END,
    completed_at = CASE WHEN _to_status = 'completed' THEN _now ELSE completed_at END,
    production_note = COALESCE(_reason, production_note)
  WHERE id = _ticket_item_id;

  INSERT INTO public.station_ticket_status_history (organization_id, ticket_id, ticket_item_id, from_status, to_status, reason, changed_by)
  VALUES (_org, _ti.ticket_id, _ticket_item_id, _ti.status, _to_status, _reason, auth.uid());

  -- keep the POS order item in step (financial record stays owned by POS)
  _order_state := CASE _to_status
    WHEN 'accepted' THEN 'accepted' WHEN 'preparing' THEN 'preparing' WHEN 'remaking' THEN 'preparing'
    WHEN 'ready' THEN 'ready' WHEN 'served' THEN 'served' WHEN 'cancel-pending' THEN 'cancel-pending'
    WHEN 'cancelled' THEN 'cancelled' ELSE NULL END;
  IF _order_state IS NOT NULL THEN
    UPDATE public.pos_order_items SET status = _order_state WHERE id = _ti.order_item_id AND status <> _order_state;
  END IF;

  -- roll the station ticket up from its items
  SELECT count(*) FILTER (WHERE status NOT IN ('cancelled')),
         count(*) FILTER (WHERE status IN ('ready','collected','served','completed'))
    INTO _active, _ready
  FROM public.station_ticket_items WHERE ticket_id = _ti.ticket_id;

  _ticket_state := CASE
    WHEN _active = 0 THEN 'cancelled'
    WHEN _ready = 0 AND EXISTS (SELECT 1 FROM public.station_ticket_items WHERE ticket_id=_ti.ticket_id AND status='preparing') THEN 'preparing'
    WHEN _ready = 0 AND EXISTS (SELECT 1 FROM public.station_ticket_items WHERE ticket_id=_ti.ticket_id AND status='accepted') THEN 'accepted'
    WHEN _ready = 0 THEN 'new'
    WHEN _ready < _active THEN 'partially-ready'
    ELSE 'ready' END;

  UPDATE public.station_tickets SET
    status = _ticket_state,
    accepted_at = CASE WHEN _ticket_state <> 'new' THEN COALESCE(accepted_at, _now) ELSE accepted_at END,
    started_at = CASE WHEN _ticket_state IN ('preparing','partially-ready','ready') THEN COALESCE(started_at, _now) ELSE started_at END,
    ready_at = CASE WHEN _ticket_state = 'ready' THEN COALESCE(ready_at, _now) ELSE ready_at END,
    cancelled_at = CASE WHEN _ticket_state = 'cancelled' THEN COALESCE(cancelled_at, _now) ELSE cancelled_at END
  WHERE id = _ti.ticket_id;

  IF _ticket_state = 'ready' THEN
    PERFORM public.emit_domain_event(_org, _t.branch_id, 'kitchen.order.ready', 'kitchen', _ti.ticket_id,
      jsonb_build_object('order_id', _t.order_id, 'station_id', _t.station_id),
      'kitchen-ticket-ready-' || _ti.ticket_id::text, NULL);
    INSERT INTO public.notifications (organization_id, user_id, branch_id, department_id, station_id, category, title, body, link, priority)
    SELECT _org, o.waiter_id, _t.branch_id, _t.department_id, _t.station_id, 'kitchen',
           'Order ' || o.order_number || ' is ready',
           'All items on ticket ' || _t.ticket_number || ' are ready for collection.',
           '/pos/orders/' || o.id::text, 'high'
    FROM public.pos_orders o WHERE o.id = _t.order_id AND o.waiter_id IS NOT NULL;
  END IF;

  RETURN jsonb_build_object('item_status', _to_status, 'ticket_status', _ticket_state);
END $$;
REVOKE ALL ON FUNCTION public.kitchen_item_transition(uuid, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.kitchen_item_transition(uuid, text, text) TO authenticated;

-- Kitchen performance metrics computed from real records only.
CREATE OR REPLACE FUNCTION public.kitchen_metrics(_branch uuid DEFAULT NULL, _from timestamptz DEFAULT (now() - interval '1 day'), _to timestamptz DEFAULT now())
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE _org uuid; _res jsonb;
BEGIN
  _org := public.current_org_id();
  IF _org IS NULL OR NOT public.has_permission('kitchen','access') THEN RETURN '{}'::jsonb; END IF;

  SELECT jsonb_build_object(
    'tickets_received', count(*),
    'tickets_completed', count(*) FILTER (WHERE t.status IN ('ready','served','completed')),
    'tickets_in_preparation', count(*) FILTER (WHERE t.status IN ('accepted','preparing')),
    'tickets_partially_ready', count(*) FILTER (WHERE t.status = 'partially-ready'),
    'tickets_delayed', count(*) FILTER (WHERE t.status <> 'ready' AND t.ready_at IS NULL
        AND EXTRACT(EPOCH FROM (now() - t.received_at))/60 > COALESCE(t.target_minutes,15)),
    'tickets_cancelled', count(*) FILTER (WHERE t.status = 'cancelled'),
    'avg_prep_minutes', ROUND(AVG(EXTRACT(EPOCH FROM (t.ready_at - t.received_at))/60) FILTER (WHERE t.ready_at IS NOT NULL)::numeric, 1)
  ) INTO _res
  FROM public.station_tickets t
  WHERE t.organization_id = _org AND (_branch IS NULL OR t.branch_id = _branch)
    AND t.received_at BETWEEN _from AND _to;

  RETURN COALESCE(_res,'{}'::jsonb)
    || jsonb_build_object(
      'items_received', (SELECT count(*) FROM public.station_ticket_items i JOIN public.station_tickets t ON t.id=i.ticket_id
                          WHERE i.organization_id=_org AND (_branch IS NULL OR t.branch_id=_branch) AND i.created_at BETWEEN _from AND _to),
      'items_ready', (SELECT count(*) FROM public.station_ticket_items i JOIN public.station_tickets t ON t.id=i.ticket_id
                          WHERE i.organization_id=_org AND (_branch IS NULL OR t.branch_id=_branch) AND i.ready_at BETWEEN _from AND _to),
      'remakes', (SELECT count(*) FROM public.station_ticket_items i JOIN public.station_tickets t ON t.id=i.ticket_id
                          WHERE i.organization_id=_org AND (_branch IS NULL OR t.branch_id=_branch)
                            AND i.status IN ('remake-requested','remaking') AND i.updated_at BETWEEN _from AND _to),
      'waste_records', (SELECT count(*) FROM public.waste_records w WHERE w.organization_id=_org AND (_branch IS NULL OR w.branch_id=_branch) AND w.occurred_at BETWEEN _from AND _to),
      'waste_cost', (SELECT COALESCE(SUM(w.estimated_cost),0) FROM public.waste_records w WHERE w.organization_id=_org AND (_branch IS NULL OR w.branch_id=_branch) AND w.occurred_at BETWEEN _from AND _to AND w.status IN ('approved','posted')),
      'open_shortages', (SELECT count(*) FROM public.ingredient_shortage_alerts a WHERE a.organization_id=_org AND (_branch IS NULL OR a.branch_id=_branch) AND a.status NOT IN ('resolved','closed')),
      'open_requests', (SELECT count(*) FROM public.kitchen_ingredient_requests r WHERE r.organization_id=_org AND (_branch IS NULL OR r.branch_id=_branch) AND r.status NOT IN ('closed','cancelled','collected')),
      'active_quality_holds', (SELECT count(*) FROM public.quality_holds q WHERE q.organization_id=_org AND (_branch IS NULL OR q.branch_id=_branch) AND q.status='active'),
      'quality_failures', (SELECT count(*) FROM public.quality_check_records q WHERE q.organization_id=_org AND (_branch IS NULL OR q.branch_id=_branch) AND q.result='fail' AND q.created_at BETWEEN _from AND _to),
      'kitchen_revenue', (SELECT COALESCE(SUM(o.grand_total),0) FROM public.pos_orders o
                           WHERE o.organization_id=_org AND (_branch IS NULL OR o.branch_id=_branch)
                             AND o.status IN ('closed','completed','paid') AND o.closed_at BETWEEN _from AND _to)
    );
END $$;
REVOKE ALL ON FUNCTION public.kitchen_metrics(uuid, timestamptz, timestamptz) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.kitchen_metrics(uuid, timestamptz, timestamptz) TO authenticated;

-- ---------- 7. Realtime ----------
DO $$
BEGIN
  BEGIN ALTER PUBLICATION supabase_realtime ADD TABLE public.station_ticket_items; EXCEPTION WHEN duplicate_object THEN NULL; END;
  BEGIN ALTER PUBLICATION supabase_realtime ADD TABLE public.ticket_clarifications; EXCEPTION WHEN duplicate_object THEN NULL; END;
  BEGIN ALTER PUBLICATION supabase_realtime ADD TABLE public.ingredient_shortage_alerts; EXCEPTION WHEN duplicate_object THEN NULL; END;
END $$;