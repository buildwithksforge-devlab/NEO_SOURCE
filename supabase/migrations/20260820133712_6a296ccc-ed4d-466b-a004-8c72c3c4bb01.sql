ALTER TABLE public.roles
  ADD COLUMN IF NOT EXISTS role_status text NOT NULL DEFAULT 'active',
  ADD COLUMN IF NOT EXISTS catalogue_version integer NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS normalized_role_key text,
  ADD COLUMN IF NOT EXISTS predecessor_role_id uuid REFERENCES public.roles(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS successor_role_id uuid REFERENCES public.roles(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS position_level integer,
  ADD COLUMN IF NOT EXISTS reports_to_role_id uuid REFERENCES public.roles(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS managerial_scope text,
  ADD COLUMN IF NOT EXISTS approval_class text NOT NULL DEFAULT 'none',
  ADD COLUMN IF NOT EXISTS effective_from date NOT NULL DEFAULT current_date,
  ADD COLUMN IF NOT EXISTS effective_until date,
  ADD COLUMN IF NOT EXISTS migration_status text NOT NULL DEFAULT 'not_started',
  ADD COLUMN IF NOT EXISTS migration_review_reason text,
  ADD COLUMN IF NOT EXISTS previous_name text;

DO $$ BEGIN
  ALTER TABLE public.roles ADD CONSTRAINT roles_role_status_chk
    CHECK (role_status IN ('active','legacy','archived','custom'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE public.roles ADD CONSTRAINT roles_migration_status_chk
    CHECK (migration_status IN ('not_started','planned','review_required','migrated','retired','blocked'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

ALTER TABLE public.departments
  ADD COLUMN IF NOT EXISTS parent_department_id uuid REFERENCES public.departments(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS department_status text NOT NULL DEFAULT 'active',
  ADD COLUMN IF NOT EXISTS catalogue_key text,
  ADD COLUMN IF NOT EXISTS previous_name text;

DO $$ BEGIN
  ALTER TABLE public.departments ADD CONSTRAINT departments_status_chk
    CHECK (department_status IN ('active','legacy','archived'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS public.role_catalogue_aliases (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  alias_key text NOT NULL,
  role_key text NOT NULL REFERENCES public.role_catalogue(role_key) ON DELETE CASCADE,
  ambiguous boolean NOT NULL DEFAULT false,
  review_reason text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (alias_key)
);
GRANT SELECT ON public.role_catalogue_aliases TO authenticated;
GRANT ALL ON public.role_catalogue_aliases TO service_role;
ALTER TABLE public.role_catalogue_aliases ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN
  CREATE POLICY "aliases readable by members" ON public.role_catalogue_aliases
    FOR SELECT TO authenticated USING (true);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS public.role_migration_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  catalogue_version integer NOT NULL DEFAULT 2,
  status text NOT NULL DEFAULT 'draft',
  idempotency_key text NOT NULL,
  preflight jsonb NOT NULL DEFAULT '{}'::jsonb,
  report jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by uuid,
  approved_by uuid,
  approved_at timestamptz,
  executed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, idempotency_key)
);
DO $$ BEGIN
  ALTER TABLE public.role_migration_runs ADD CONSTRAINT role_migration_runs_status_chk
    CHECK (status IN ('draft','previewed','approved','executing','completed','failed','rolled_back'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
GRANT SELECT ON public.role_migration_runs TO authenticated;
GRANT ALL ON public.role_migration_runs TO service_role;
ALTER TABLE public.role_migration_runs ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN
  CREATE POLICY "migration runs admin read" ON public.role_migration_runs
    FOR SELECT TO authenticated USING (organization_id = public.current_org_id() AND public.is_org_admin());
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS public.role_migration_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id uuid NOT NULL REFERENCES public.role_migration_runs(id) ON DELETE CASCADE,
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  item_kind text NOT NULL,
  subject_user_id uuid,
  subject_label text NOT NULL DEFAULT '',
  current_role_id uuid REFERENCES public.roles(id) ON DELETE SET NULL,
  proposed_role_id uuid REFERENCES public.roles(id) ON DELETE SET NULL,
  proposed_role_key text,
  target_department_id uuid REFERENCES public.departments(id) ON DELETE SET NULL,
  target_station_id uuid REFERENCES public.operational_stations(id) ON DELETE SET NULL,
  manager_candidate boolean NOT NULL DEFAULT false,
  ambiguous boolean NOT NULL DEFAULT false,
  options jsonb NOT NULL DEFAULT '[]'::jsonb,
  permissions_gained jsonb NOT NULL DEFAULT '[]'::jsonb,
  permissions_retained jsonb NOT NULL DEFAULT '[]'::jsonb,
  permissions_removed jsonb NOT NULL DEFAULT '[]'::jsonb,
  restricted_authority_change text NOT NULL DEFAULT 'none',
  migration_reason text NOT NULL DEFAULT '',
  decision text NOT NULL DEFAULT 'pending',
  decided_by uuid,
  decided_at timestamptz,
  applied_at timestamptz,
  apply_result jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
DO $$ BEGIN
  ALTER TABLE public.role_migration_items ADD CONSTRAINT role_migration_items_decision_chk
    CHECK (decision IN ('pending','approved','rejected','applied','failed','skipped'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE INDEX IF NOT EXISTS role_migration_items_run_idx ON public.role_migration_items(run_id);
GRANT SELECT ON public.role_migration_items TO authenticated;
GRANT ALL ON public.role_migration_items TO service_role;
ALTER TABLE public.role_migration_items ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN
  CREATE POLICY "migration items admin read" ON public.role_migration_items
    FOR SELECT TO authenticated USING (organization_id = public.current_org_id() AND public.is_org_admin());
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS public.role_assignment_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  user_id uuid NOT NULL,
  role_id uuid REFERENCES public.roles(id) ON DELETE SET NULL,
  role_name_at_time text NOT NULL DEFAULT '',
  branch_id uuid,
  department_id uuid,
  department_name_at_time text NOT NULL DEFAULT '',
  station_id uuid,
  primary_manager_user_id uuid,
  functional_manager_user_id uuid,
  delegated_manager_id uuid,
  assignment_type text NOT NULL DEFAULT 'primary',
  assignment_status text NOT NULL DEFAULT 'active',
  effective_from timestamptz NOT NULL DEFAULT now(),
  effective_until timestamptz,
  change_reason text NOT NULL DEFAULT '',
  migration_item_id uuid REFERENCES public.role_migration_items(id) ON DELETE SET NULL,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS role_assignment_history_user_idx ON public.role_assignment_history(user_id);
GRANT SELECT ON public.role_assignment_history TO authenticated;
GRANT ALL ON public.role_assignment_history TO service_role;
ALTER TABLE public.role_assignment_history ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN
  CREATE POLICY "assignment history tenant read" ON public.role_assignment_history
    FOR SELECT TO authenticated USING (organization_id = public.current_org_id());
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Canonical restricted permissions. This project stores the feature inside the
-- dotted action with feature '*', so the keys read module.<feature>.<action>.
INSERT INTO public.permissions (module, feature, action, label) VALUES
  ('pos','*','void.request','Request a void'),
  ('pos','*','void.approve','Approve a void'),
  ('pos','*','void.execute','Execute a void'),
  ('pos','*','discount.request','Request a discount'),
  ('pos','*','discount.approve','Approve a discount'),
  ('pos','*','discount.execute','Execute a discount'),
  ('pos','*','complimentary.execute','Execute a complimentary item'),
  ('finance','*','refunds.request','Request a guest refund'),
  ('finance','*','refunds.approve','Approve a guest refund'),
  ('finance','*','refunds.execute','Execute a guest refund'),
  ('finance','*','payments.reverse.request','Request a payment reversal'),
  ('finance','*','payments.reverse.approve','Approve a payment reversal'),
  ('finance','*','payments.reverse.execute','Execute a payment reversal'),
  ('pms','*','folios.reopen.request','Request reopening a folio'),
  ('pms','*','folios.reopen.approve','Approve reopening a folio'),
  ('pms','*','folios.reopen.execute','Execute reopening a folio'),
  ('pms','*','charges.reverse.request','Request reversing a posted charge'),
  ('pms','*','charges.reverse.approve','Approve reversing a posted charge'),
  ('pms','*','charges.reverse.execute','Execute reversing a posted charge'),
  ('pricing','*','override.request','Request a price override'),
  ('pricing','*','override.approve','Approve a price override'),
  ('pricing','*','override.execute','Execute a price override')
ON CONFLICT (module, action) DO NOTHING;

INSERT INTO public.role_catalogue
  (role_key, role_name, department, reports_to_key, multiplicity, access_scope, restricted_authority, optional_role, sort_order, summary)
VALUES
  ('delivery-manager','Delivery Manager','Delivery','operations-manager','single','department',false,false,395,
   'Runs the delivery operation: zones, riders, dispatch and delivery performance. Submits restricted correction requests but never approves them.'),
  ('rider','Rider','Delivery','delivery-manager','multiple','self',false,false,396,
   'Collects and delivers assigned orders, confirms handover and records cash collected. Sees only their own assigned deliveries.')
ON CONFLICT (role_key) DO NOTHING;

UPDATE public.role_catalogue SET department = 'Inventory and Stores' WHERE department = 'Stores and Inventory';
UPDATE public.role_catalogue SET role_name = 'IT/System Administrator' WHERE role_key = 'it-system-administrator';

INSERT INTO public.role_catalogue_aliases (alias_key, role_key, ambiguous, review_reason) VALUES
  ('owner','owner',false,''),
  ('owner / director / super user','owner',false,''),
  ('operations manager','operations-manager',false,''),
  ('restaurant manager','food-and-beverage-manager',false,''),
  ('food and beverage manager','food-and-beverage-manager',false,''),
  ('waiter / waitress','waiter',false,''),
  ('waiter','waiter',false,''),
  ('barista','barista',false,''),
  ('bar attendant','bar-attendant',false,''),
  ('banqueting service staff','banqueting-staff',false,''),
  ('kitchen manager','head-chef',false,''),
  ('head chef','head-chef',false,''),
  ('chef','hot-kitchen-chef',false,''),
  ('hot-kitchen chef','hot-kitchen-chef',false,''),
  ('chief steward','chief-steward',false,''),
  ('kitchen steward / dishwasher','kitchen-steward',false,''),
  ('pastry supervisor','head-pastry-chef',false,''),
  ('head pastry chef','head-pastry-chef',false,''),
  ('pastry chef','pastry-chef',false,''),
  ('front office manager','front-office-supervisor',false,''),
  ('front office supervisor','front-office-supervisor',false,''),
  ('receptionist','receptionist',false,''),
  ('front office receptionist','receptionist',false,''),
  ('reservations agent','reservations-agent',false,''),
  ('front office cashier','front-office-cashier',false,''),
  ('porter / bell attendant','porter',false,''),
  ('driver / transport officer','driver',false,''),
  ('housekeeping supervisor','housekeeping-supervisor',false,''),
  ('housekeeper','housekeeper',false,''),
  ('laundry supervisor','laundry-supervisor',false,''),
  ('laundry attendant','laundry-attendant',false,''),
  ('maintenance manager','maintenance-manager',false,''),
  ('maintenance technician','maintenance-technician',false,''),
  ('grounds and landscaping worker','grounds-worker',false,''),
  ('marketing manager','marketing-manager',false,''),
  ('events manager','sales-and-events-manager',false,''),
  ('sales and events manager','sales-and-events-manager',false,''),
  ('events / banqueting coordinator','events-coordinator',false,''),
  ('procurement manager','procurement-manager',false,''),
  ('procurement officer','procurement-officer',false,''),
  ('storekeeper','storekeeper',false,''),
  ('receiving clerk','receiving-clerk',false,''),
  ('finance manager','finance-manager',false,''),
  ('accountant','accountant',false,''),
  ('night auditor','night-auditor',false,''),
  ('human resources','human-resources-manager',false,''),
  ('human resources manager','human-resources-manager',false,''),
  ('hr officer','hr-officer',false,''),
  ('security supervisor','security-supervisor',false,''),
  ('security guard','security-guard',false,''),
  ('system administrator','it-system-administrator',false,''),
  ('it/system administrator','it-system-administrator',false,''),
  ('delivery manager','delivery-manager',false,''),
  ('rider','rider',false,''),
  ('general manager','operations-manager',true,'General Manager may be an executive role or an Operations Manager equivalent. An authorised administrator must decide; it stays Custom until then.'),
  ('maintenance officer','maintenance-manager',true,'Maintenance Officer may map to Maintenance Manager or Maintenance Technician, or stay a custom role. The job title alone is not evidence.'),
  ('bar manager','food-and-beverage-manager',true,'The approved catalogue has no separate Bar Manager. It may consolidate into Food and Beverage Manager or stay a custom outlet role.'),
  ('coffee station supervisor','food-and-beverage-manager',true,'No catalogue equivalent. It may consolidate into Food and Beverage Manager or stay a custom outlet role.'),
  ('hot kitchen supervisor','hot-kitchen-chef',true,'No catalogue equivalent. It may consolidate into Hot-Kitchen Chef or stay a custom production role.')
ON CONFLICT (alias_key) DO NOTHING;
