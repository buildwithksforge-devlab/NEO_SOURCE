-- ============ Phase 3: dashboards & business intelligence ============

CREATE TABLE public.dashboard_definitions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  key text NOT NULL,
  name text NOT NULL,
  description text NOT NULL DEFAULT '',
  scope text NOT NULL DEFAULT 'organization',
  department_id uuid REFERENCES public.departments(id) ON DELETE SET NULL,
  station_id uuid REFERENCES public.operational_stations(id) ON DELETE SET NULL,
  permission_module text NOT NULL DEFAULT 'dashboards',
  default_layout jsonb NOT NULL DEFAULT '{}'::jsonb,
  sort_order integer NOT NULL DEFAULT 0,
  active boolean NOT NULL DEFAULT true,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, key)
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.dashboard_definitions TO authenticated;
GRANT ALL ON public.dashboard_definitions TO service_role;
ALTER TABLE public.dashboard_definitions ENABLE ROW LEVEL SECURITY;
CREATE POLICY "dashboard defs read" ON public.dashboard_definitions FOR SELECT TO authenticated
  USING (organization_id = public.current_org_id());
CREATE POLICY "dashboard defs insert" ON public.dashboard_definitions FOR INSERT TO authenticated
  WITH CHECK (organization_id = public.current_org_id() AND public.is_org_admin());
CREATE POLICY "dashboard defs update" ON public.dashboard_definitions FOR UPDATE TO authenticated
  USING (organization_id = public.current_org_id() AND public.is_org_admin())
  WITH CHECK (organization_id = public.current_org_id() AND public.is_org_admin());
CREATE POLICY "dashboard defs delete" ON public.dashboard_definitions FOR DELETE TO authenticated
  USING (organization_id = public.current_org_id() AND public.is_org_admin());
CREATE TRIGGER dashboard_definitions_touch BEFORE UPDATE ON public.dashboard_definitions
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();
CREATE INDEX dashboard_definitions_org_idx ON public.dashboard_definitions(organization_id, sort_order);

CREATE TABLE public.role_dashboard_assignments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  role_id uuid NOT NULL REFERENCES public.roles(id) ON DELETE CASCADE,
  dashboard_key text NOT NULL,
  priority integer NOT NULL DEFAULT 100,
  is_default boolean NOT NULL DEFAULT true,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (role_id, dashboard_key)
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.role_dashboard_assignments TO authenticated;
GRANT ALL ON public.role_dashboard_assignments TO service_role;
ALTER TABLE public.role_dashboard_assignments ENABLE ROW LEVEL SECURITY;
CREATE POLICY "role dashboards read" ON public.role_dashboard_assignments FOR SELECT TO authenticated
  USING (organization_id = public.current_org_id());
CREATE POLICY "role dashboards insert" ON public.role_dashboard_assignments FOR INSERT TO authenticated
  WITH CHECK (organization_id = public.current_org_id() AND public.is_org_admin());
CREATE POLICY "role dashboards update" ON public.role_dashboard_assignments FOR UPDATE TO authenticated
  USING (organization_id = public.current_org_id() AND public.is_org_admin())
  WITH CHECK (organization_id = public.current_org_id() AND public.is_org_admin());
CREATE POLICY "role dashboards delete" ON public.role_dashboard_assignments FOR DELETE TO authenticated
  USING (organization_id = public.current_org_id() AND public.is_org_admin());
CREATE TRIGGER role_dashboard_assignments_touch BEFORE UPDATE ON public.role_dashboard_assignments
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

CREATE TABLE public.user_dashboard_layouts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  user_id uuid NOT NULL,
  dashboard_key text NOT NULL,
  layout jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, dashboard_key)
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.user_dashboard_layouts TO authenticated;
GRANT ALL ON public.user_dashboard_layouts TO service_role;
ALTER TABLE public.user_dashboard_layouts ENABLE ROW LEVEL SECURITY;
CREATE POLICY "own layouts" ON public.user_dashboard_layouts FOR ALL TO authenticated
  USING (user_id = auth.uid() AND organization_id = public.current_org_id())
  WITH CHECK (user_id = auth.uid() AND organization_id = public.current_org_id());
CREATE TRIGGER user_dashboard_layouts_touch BEFORE UPDATE ON public.user_dashboard_layouts
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

CREATE TABLE public.saved_dashboard_filters (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  user_id uuid NOT NULL,
  dashboard_key text NOT NULL,
  name text NOT NULL DEFAULT 'Default',
  filters jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, dashboard_key, name)
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.saved_dashboard_filters TO authenticated;
GRANT ALL ON public.saved_dashboard_filters TO service_role;
ALTER TABLE public.saved_dashboard_filters ENABLE ROW LEVEL SECURITY;
CREATE POLICY "own filters" ON public.saved_dashboard_filters FOR ALL TO authenticated
  USING (user_id = auth.uid() AND organization_id = public.current_org_id())
  WITH CHECK (user_id = auth.uid() AND organization_id = public.current_org_id());
CREATE TRIGGER saved_dashboard_filters_touch BEFORE UPDATE ON public.saved_dashboard_filters
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

CREATE TABLE public.kpi_definitions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  key text NOT NULL,
  name text NOT NULL,
  definition text NOT NULL DEFAULT '',
  formula text NOT NULL DEFAULT '',
  data_source text NOT NULL DEFAULT '',
  unit text NOT NULL DEFAULT 'count',
  comparison_period text NOT NULL DEFAULT 'previous-period',
  availability text NOT NULL DEFAULT 'available',
  active boolean NOT NULL DEFAULT true,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, key)
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.kpi_definitions TO authenticated;
GRANT ALL ON public.kpi_definitions TO service_role;
ALTER TABLE public.kpi_definitions ENABLE ROW LEVEL SECURITY;
CREATE POLICY "kpi defs read" ON public.kpi_definitions FOR SELECT TO authenticated
  USING (organization_id = public.current_org_id());
CREATE POLICY "kpi defs insert" ON public.kpi_definitions FOR INSERT TO authenticated
  WITH CHECK (organization_id = public.current_org_id() AND public.is_org_admin());
CREATE POLICY "kpi defs update" ON public.kpi_definitions FOR UPDATE TO authenticated
  USING (organization_id = public.current_org_id() AND public.is_org_admin())
  WITH CHECK (organization_id = public.current_org_id() AND public.is_org_admin());
CREATE POLICY "kpi defs delete" ON public.kpi_definitions FOR DELETE TO authenticated
  USING (organization_id = public.current_org_id() AND public.is_org_admin());
CREATE TRIGGER kpi_definitions_touch BEFORE UPDATE ON public.kpi_definitions
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

CREATE TABLE public.kpi_snapshots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  branch_id uuid REFERENCES public.branches(id) ON DELETE CASCADE,
  department_id uuid REFERENCES public.departments(id) ON DELETE SET NULL,
  station_id uuid REFERENCES public.operational_stations(id) ON DELETE SET NULL,
  kpi_key text NOT NULL,
  period_start timestamptz NOT NULL,
  period_end timestamptz NOT NULL,
  value numeric,
  meta jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT ON public.kpi_snapshots TO authenticated;
GRANT ALL ON public.kpi_snapshots TO service_role;
ALTER TABLE public.kpi_snapshots ENABLE ROW LEVEL SECURITY;
CREATE POLICY "kpi snapshots read" ON public.kpi_snapshots FOR SELECT TO authenticated
  USING (organization_id = public.current_org_id());
CREATE INDEX kpi_snapshots_lookup_idx ON public.kpi_snapshots(organization_id, kpi_key, period_start DESC);

CREATE TABLE public.dashboard_alert_rules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  branch_id uuid REFERENCES public.branches(id) ON DELETE CASCADE,
  department_id uuid REFERENCES public.departments(id) ON DELETE SET NULL,
  station_id uuid REFERENCES public.operational_stations(id) ON DELETE SET NULL,
  name text NOT NULL,
  metric text NOT NULL,
  comparator text NOT NULL DEFAULT 'gte',
  threshold numeric NOT NULL DEFAULT 1,
  severity text NOT NULL DEFAULT 'warning',
  recipient_role_id uuid REFERENCES public.roles(id) ON DELETE SET NULL,
  recipient_user_id uuid,
  channel text NOT NULL DEFAULT 'in-app',
  active boolean NOT NULL DEFAULT true,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.dashboard_alert_rules TO authenticated;
GRANT ALL ON public.dashboard_alert_rules TO service_role;
ALTER TABLE public.dashboard_alert_rules ENABLE ROW LEVEL SECURITY;
CREATE POLICY "alert rules read" ON public.dashboard_alert_rules FOR SELECT TO authenticated
  USING (organization_id = public.current_org_id());
CREATE POLICY "alert rules insert" ON public.dashboard_alert_rules FOR INSERT TO authenticated
  WITH CHECK (organization_id = public.current_org_id() AND public.is_org_admin());
CREATE POLICY "alert rules update" ON public.dashboard_alert_rules FOR UPDATE TO authenticated
  USING (organization_id = public.current_org_id() AND public.is_org_admin())
  WITH CHECK (organization_id = public.current_org_id() AND public.is_org_admin());
CREATE POLICY "alert rules delete" ON public.dashboard_alert_rules FOR DELETE TO authenticated
  USING (organization_id = public.current_org_id() AND public.is_org_admin());
CREATE TRIGGER dashboard_alert_rules_touch BEFORE UPDATE ON public.dashboard_alert_rules
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

CREATE TABLE public.dashboard_alerts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  rule_id uuid REFERENCES public.dashboard_alert_rules(id) ON DELETE CASCADE,
  branch_id uuid REFERENCES public.branches(id) ON DELETE CASCADE,
  department_id uuid REFERENCES public.departments(id) ON DELETE SET NULL,
  station_id uuid REFERENCES public.operational_stations(id) ON DELETE SET NULL,
  severity text NOT NULL DEFAULT 'information',
  title text NOT NULL,
  body text NOT NULL DEFAULT '',
  metric text NOT NULL DEFAULT '',
  observed_value numeric,
  status text NOT NULL DEFAULT 'open',
  acknowledged_by uuid,
  acknowledged_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE ON public.dashboard_alerts TO authenticated;
GRANT ALL ON public.dashboard_alerts TO service_role;
ALTER TABLE public.dashboard_alerts ENABLE ROW LEVEL SECURITY;
CREATE POLICY "alerts read" ON public.dashboard_alerts FOR SELECT TO authenticated
  USING (organization_id = public.current_org_id());
CREATE POLICY "alerts insert" ON public.dashboard_alerts FOR INSERT TO authenticated
  WITH CHECK (organization_id = public.current_org_id());
CREATE POLICY "alerts update" ON public.dashboard_alerts FOR UPDATE TO authenticated
  USING (organization_id = public.current_org_id())
  WITH CHECK (organization_id = public.current_org_id());
CREATE TRIGGER dashboard_alerts_touch BEFORE UPDATE ON public.dashboard_alerts
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

CREATE TABLE public.ai_insights (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  branch_id uuid REFERENCES public.branches(id) ON DELETE CASCADE,
  dashboard_key text NOT NULL DEFAULT 'ai-executive',
  period_start timestamptz NOT NULL,
  period_end timestamptz NOT NULL,
  summary text NOT NULL DEFAULT '',
  insights jsonb NOT NULL DEFAULT '[]'::jsonb,
  data_sources jsonb NOT NULL DEFAULT '[]'::jsonb,
  model text NOT NULL DEFAULT '',
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT ON public.ai_insights TO authenticated;
GRANT ALL ON public.ai_insights TO service_role;
ALTER TABLE public.ai_insights ENABLE ROW LEVEL SECURITY;
CREATE POLICY "ai insights read" ON public.ai_insights FOR SELECT TO authenticated
  USING (organization_id = public.current_org_id());
CREATE POLICY "ai insights insert" ON public.ai_insights FOR INSERT TO authenticated
  WITH CHECK (organization_id = public.current_org_id() AND created_by = auth.uid());
CREATE INDEX ai_insights_recent_idx ON public.ai_insights(organization_id, created_at DESC);

CREATE TABLE public.dashboard_exports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  branch_id uuid REFERENCES public.branches(id) ON DELETE CASCADE,
  user_id uuid NOT NULL,
  dashboard_key text NOT NULL,
  format text NOT NULL DEFAULT 'csv',
  filters jsonb NOT NULL DEFAULT '{}'::jsonb,
  row_count integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT ON public.dashboard_exports TO authenticated;
GRANT ALL ON public.dashboard_exports TO service_role;
ALTER TABLE public.dashboard_exports ENABLE ROW LEVEL SECURITY;
CREATE POLICY "exports read" ON public.dashboard_exports FOR SELECT TO authenticated
  USING (organization_id = public.current_org_id() AND (user_id = auth.uid() OR public.is_org_admin()));
CREATE POLICY "exports insert" ON public.dashboard_exports FOR INSERT TO authenticated
  WITH CHECK (organization_id = public.current_org_id() AND user_id = auth.uid());

-- ============ permissions ============
INSERT INTO public.permissions (module, action, label) VALUES
  ('dashboards','view','View dashboards'),
  ('dashboards','customize','Customise dashboard layout'),
  ('dashboards','export','Export dashboard data'),
  ('dashboards','manage-defaults','Manage default dashboard layouts'),
  ('kpis','view','View KPIs'),
  ('kpis','manage','Manage KPI definitions'),
  ('alerts','view','View dashboard alerts'),
  ('alerts','manage','Manage dashboard alert rules'),
  ('ai-insights','view','View AI insights'),
  ('ai-insights','generate','Generate AI insights'),
  ('executive-dashboard','view','View executive dashboard')
ON CONFLICT (module, action) DO NOTHING;

-- grant the new permissions to Owner / System Administrator roles of every org
INSERT INTO public.role_permissions (organization_id, role_id, permission_id)
SELECT r.organization_id, r.id, p.id
FROM public.roles r
CROSS JOIN public.permissions p
WHERE r.name IN ('Owner','System Administrator')
  AND p.module IN ('dashboards','kpis','alerts','ai-insights','executive-dashboard')
  AND NOT EXISTS (
    SELECT 1 FROM public.role_permissions rp WHERE rp.role_id = r.id AND rp.permission_id = p.id
  );

-- baseline dashboard view permission for all other roles
INSERT INTO public.role_permissions (organization_id, role_id, permission_id)
SELECT r.organization_id, r.id, p.id
FROM public.roles r
CROSS JOIN public.permissions p
WHERE p.module = 'dashboards' AND p.action IN ('view','customize')
  AND NOT EXISTS (
    SELECT 1 FROM public.role_permissions rp WHERE rp.role_id = r.id AND rp.permission_id = p.id
  );

-- ============ seeding helpers ============
CREATE OR REPLACE FUNCTION public.seed_dashboard_catalogue(_org uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE _d record;
BEGIN
  FOR _d IN SELECT * FROM (VALUES
    ('owner','Owner Dashboard','Organisation-wide performance across authorised branches','organization','executive-dashboard',10),
    ('general-manager','General Manager Dashboard','Daily operational oversight for the assigned property','branch','dashboards',20),
    ('administration','Administration Dashboard','Platform configuration, users and security monitoring','organization','administration',30),
    ('finance','Finance Dashboard','Authorised financial operations and reconciliation','organization','finance',40),
    ('front-office','Front Office Dashboard','Guest arrivals, departures and room activity','department','front-office',50),
    ('restaurant-operations','Restaurant Operations','Coordination across floor, coffee, bar and kitchen stations','department','restaurant',60),
    ('restaurant-floor','Restaurant Floor Dashboard','Table service, orders and floor tasks','station','restaurant',70),
    ('coffee-station','Coffee Station Dashboard','Coffee station queue, workload and tasks','station','restaurant',80),
    ('bar','Bar Dashboard','Bar queue, workload and stock alerts','station','bar',90),
    ('kitchen-overview','Kitchen Overview','Production monitoring across kitchen stations','department','kitchen',100),
    ('hot-kitchen','Hot Kitchen Dashboard','Hot kitchen queue and preparation performance','station','kitchen',110),
    ('pastry','Pastry Dashboard','Pastry queue, special orders and deadlines','station','kitchen',120),
    ('housekeeping','Housekeeping Dashboard','Room readiness, inspections and housekeeping tasks','department','housekeeping',130),
    ('procurement','Procurement Dashboard','Sourcing, purchase requests and supplier activity','department','procurement',140),
    ('stores','Inventory & Stores Dashboard','Stock control, receiving and departmental issues','department','stores',150),
    ('marketing','Marketing Dashboard','Campaigns, enquiries and guest engagement','department','marketing',160),
    ('events','Events Dashboard','Conferences, event readiness and bookings','department','events',170),
    ('delivery','Delivery Dashboard','Delivery operations and rider activity','department','delivery',180),
    ('human-resources','Human Resources Dashboard','Staff operations with protected HR data','department','human-resources',190),
    ('maintenance','Maintenance Dashboard','Maintenance requests, work orders and escalations','department','maintenance',200),
    ('ai-executive','AI Executive Dashboard','AI-generated management insights from authorised data','organization','ai-insights',210)
  ) AS s(key, name, description, scope, permission_module, sort_order) LOOP
    INSERT INTO public.dashboard_definitions (organization_id, key, name, description, scope, permission_module, sort_order)
    VALUES (_org, _d.key, _d.name, _d.description, _d.scope, _d.permission_module, _d.sort_order)
    ON CONFLICT (organization_id, key) DO NOTHING;
  END LOOP;

  FOR _d IN SELECT * FROM (VALUES
    ('occupancy-rate','Occupancy rate','Share of sellable rooms that are occupied for the period.','Occupied sellable rooms / total sellable rooms x 100','Rooms module (not yet implemented)','percent','awaiting-module'),
    ('revenue','Revenue','Valid posted transactions for the period, excluding voided and cancelled records; refunds reported separately.','SUM(valid posted transaction totals) for the period','Finance & POS modules (not yet implemented)','currency','awaiting-module'),
    ('average-service-time','Average service time','Average duration between order acceptance and service completion.','SUM(service duration) / COUNT(completed orders)','POS & kitchen modules (not yet implemented)','minutes','awaiting-module'),
    ('task-completion-rate','Task completion rate','Share of tasks due in the period that were completed.','Completed tasks / tasks due in period x 100 (0 when no tasks are due)','public.tasks','percent','available'),
    ('overdue-tasks','Overdue tasks','Tasks past their due date that are not completed or cancelled.','COUNT(tasks WHERE due_at < now() AND status NOT IN (completed, cancelled))','public.tasks','count','available'),
    ('approval-turnaround','Approval turnaround','Average hours between an approval request being raised and its final decision.','AVG(updated_at - created_at) for approved/rejected requests','public.approval_requests','hours','available'),
    ('pending-approvals','Pending approvals','Approval requests still awaiting a decision.','COUNT(approval_requests WHERE status = pending)','public.approval_requests','count','available'),
    ('unread-notifications','Unread notifications','Notifications addressed to the user that have not been read.','COUNT(notifications WHERE read_at IS NULL)','public.notifications','count','available'),
    ('active-staff','Active staff','Staff profiles with an active account status.','COUNT(profiles WHERE account_type = staff AND account_status = active)','public.profiles','count','available'),
    ('guest-satisfaction','Guest satisfaction','Average valid guest feedback score for the period.','AVG(valid feedback score)','Guest feedback module (not yet implemented)','score','awaiting-module'),
    ('repeat-guest-rate','Repeat guest rate','Share of guests in the period who had stayed before.','Returning guests / total guests in period x 100','CRM module (not yet implemented)','percent','awaiting-module')
  ) AS k(key, name, definition, formula, data_source, unit, availability) LOOP
    INSERT INTO public.kpi_definitions (organization_id, key, name, definition, formula, data_source, unit, availability)
    VALUES (_org, _d.key, _d.name, _d.definition, _d.formula, _d.data_source, _d.unit, _d.availability)
    ON CONFLICT (organization_id, key) DO NOTHING;
  END LOOP;

  INSERT INTO public.dashboard_alert_rules (organization_id, name, metric, comparator, threshold, severity)
  SELECT _org, v.name, v.metric, 'gte', v.threshold, v.severity
  FROM (VALUES
    ('Overdue tasks require attention','overdue_tasks', 1, 'warning'),
    ('Approvals waiting for a decision','pending_approvals', 1, 'information'),
    ('Approvals delayed beyond 24 hours','delayed_approvals', 1, 'critical'),
    ('Staff without complete assignments','unassigned_staff', 1, 'warning'),
    ('Locked or suspended staff accounts','suspended_staff', 1, 'critical')
  ) AS v(name, metric, threshold, severity)
  WHERE NOT EXISTS (
    SELECT 1 FROM public.dashboard_alert_rules r WHERE r.organization_id = _org AND r.metric = v.metric
  );
END; $$;

CREATE OR REPLACE FUNCTION public.dashboard_key_for_role(_role_name text)
RETURNS text
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT CASE _role_name
    WHEN 'Owner' THEN 'owner'
    WHEN 'System Administrator' THEN 'administration'
    WHEN 'General Manager' THEN 'general-manager'
    WHEN 'Operations Manager' THEN 'general-manager'
    WHEN 'Finance Manager' THEN 'finance'
    WHEN 'Accountant' THEN 'finance'
    WHEN 'Front Office Manager' THEN 'front-office'
    WHEN 'Receptionist' THEN 'front-office'
    WHEN 'Restaurant Manager' THEN 'restaurant-operations'
    WHEN 'Waiter / Waitress' THEN 'restaurant-floor'
    WHEN 'Barista' THEN 'coffee-station'
    WHEN 'Coffee Station Supervisor' THEN 'coffee-station'
    WHEN 'Bar Manager' THEN 'bar'
    WHEN 'Bar Attendant' THEN 'bar'
    WHEN 'Kitchen Manager' THEN 'kitchen-overview'
    WHEN 'Hot Kitchen Supervisor' THEN 'hot-kitchen'
    WHEN 'Chef' THEN 'hot-kitchen'
    WHEN 'Pastry Supervisor' THEN 'pastry'
    WHEN 'Pastry Chef' THEN 'pastry'
    WHEN 'Housekeeping Supervisor' THEN 'housekeeping'
    WHEN 'Housekeeper' THEN 'housekeeping'
    WHEN 'Procurement Officer' THEN 'procurement'
    WHEN 'Storekeeper' THEN 'stores'
    WHEN 'Marketing Manager' THEN 'marketing'
    WHEN 'Events Manager' THEN 'events'
    WHEN 'Delivery Manager' THEN 'delivery'
    WHEN 'Rider' THEN 'delivery'
    WHEN 'Human Resources' THEN 'human-resources'
    WHEN 'Maintenance Officer' THEN 'maintenance'
    ELSE NULL
  END;
$$;

CREATE OR REPLACE FUNCTION public.seed_role_dashboard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE _key text;
BEGIN
  _key := public.dashboard_key_for_role(NEW.name);
  IF _key IS NULL THEN RETURN NEW; END IF;
  PERFORM public.seed_dashboard_catalogue(NEW.organization_id);
  INSERT INTO public.role_dashboard_assignments (organization_id, role_id, dashboard_key,
    priority, is_default)
  VALUES (NEW.organization_id, NEW.id, _key,
    CASE WHEN NEW.name IN ('Owner','System Administrator','General Manager','Operations Manager') THEN 10 ELSE 100 END,
    true)
  ON CONFLICT (role_id, dashboard_key) DO NOTHING;
  RETURN NEW;
END; $$;

CREATE TRIGGER roles_seed_dashboard AFTER INSERT ON public.roles
  FOR EACH ROW EXECUTE FUNCTION public.seed_role_dashboard();

CREATE OR REPLACE FUNCTION public.seed_org_dashboards()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
  PERFORM public.seed_dashboard_catalogue(NEW.id);
  RETURN NEW;
END; $$;

CREATE TRIGGER organizations_seed_dashboards AFTER INSERT ON public.organizations
  FOR EACH ROW EXECUTE FUNCTION public.seed_org_dashboards();

-- backfill existing organisations and roles
DO $$
DECLARE _o record; _r record; _key text;
BEGIN
  FOR _o IN SELECT id FROM public.organizations LOOP
    PERFORM public.seed_dashboard_catalogue(_o.id);
  END LOOP;
  FOR _r IN SELECT id, organization_id, name FROM public.roles LOOP
    _key := public.dashboard_key_for_role(_r.name);
    IF _key IS NOT NULL THEN
      INSERT INTO public.role_dashboard_assignments (organization_id, role_id, dashboard_key, priority)
      VALUES (_r.organization_id, _r.id, _key,
        CASE WHEN _r.name IN ('Owner','System Administrator','General Manager','Operations Manager') THEN 10 ELSE 100 END)
      ON CONFLICT (role_id, dashboard_key) DO NOTHING;
    END IF;
  END LOOP;
END $$;

-- ============ metrics RPC ============
CREATE OR REPLACE FUNCTION public.dashboard_metrics(
  _branch uuid DEFAULT NULL,
  _department uuid DEFAULT NULL,
  _station uuid DEFAULT NULL,
  _from timestamptz DEFAULT (now() - interval '30 days'),
  _to timestamptz DEFAULT now()
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  _org uuid := public.current_org_id();
  _uid uuid := auth.uid();
  _result jsonb;
  _due integer; _done integer;
BEGIN
  IF _org IS NULL THEN RAISE EXCEPTION 'No organisation context'; END IF;

  SELECT count(*) FILTER (WHERE due_at BETWEEN _from AND _to),
         count(*) FILTER (WHERE due_at BETWEEN _from AND _to AND status = 'completed')
    INTO _due, _done
  FROM public.tasks
  WHERE organization_id = _org
    AND (_branch IS NULL OR branch_id = _branch)
    AND (_department IS NULL OR department_id = _department)
    AND (_station IS NULL OR station_id = _station);

  SELECT jsonb_build_object(
    'organization_id', _org,
    'period_start', _from,
    'period_end', _to,
    'generated_at', now(),
    'tasks', (
      SELECT jsonb_build_object(
        'total', count(*),
        'open', count(*) FILTER (WHERE status NOT IN ('completed','cancelled')),
        'in_progress', count(*) FILTER (WHERE status = 'in-progress'),
        'completed', count(*) FILTER (WHERE status = 'completed'),
        'overdue', count(*) FILTER (WHERE due_at < now() AND status NOT IN ('completed','cancelled')),
        'mine_open', count(*) FILTER (WHERE assignee_id = _uid AND status NOT IN ('completed','cancelled')),
        'mine_overdue', count(*) FILTER (WHERE assignee_id = _uid AND due_at < now() AND status NOT IN ('completed','cancelled')),
        'unassigned', count(*) FILTER (WHERE assignee_id IS NULL AND status NOT IN ('completed','cancelled')),
        'due_in_period', _due,
        'completion_rate', CASE WHEN _due = 0 THEN NULL ELSE round((_done::numeric / _due) * 100, 1) END
      )
      FROM public.tasks
      WHERE organization_id = _org
        AND (_branch IS NULL OR branch_id = _branch)
        AND (_department IS NULL OR department_id = _department)
        AND (_station IS NULL OR station_id = _station)
    ),
    'approvals', (
      SELECT jsonb_build_object(
        'pending', count(*) FILTER (WHERE status = 'pending'),
        'approved', count(*) FILTER (WHERE status = 'approved' AND updated_at BETWEEN _from AND _to),
        'rejected', count(*) FILTER (WHERE status = 'rejected' AND updated_at BETWEEN _from AND _to),
        'mine_pending', count(*) FILTER (WHERE status = 'pending' AND requester_id = _uid),
        'delayed', count(*) FILTER (WHERE status = 'pending' AND created_at < now() - interval '24 hours'),
        'avg_turnaround_hours', round(COALESCE(AVG(EXTRACT(epoch FROM (updated_at - created_at)) / 3600)
            FILTER (WHERE status IN ('approved','rejected')), 0)::numeric, 1)
      )
      FROM public.approval_requests
      WHERE organization_id = _org
        AND (_branch IS NULL OR branch_id = _branch)
        AND (_department IS NULL OR department_id = _department)
    ),
    'notifications', (
      SELECT jsonb_build_object(
        'unread', count(*) FILTER (WHERE read_at IS NULL),
        'total', count(*)
      )
      FROM public.notifications
      WHERE organization_id = _org
        AND (user_id IS NULL OR user_id = _uid)
        AND (_branch IS NULL OR branch_id IS NULL OR branch_id = _branch)
    ),
    'staff', (
      SELECT jsonb_build_object(
        'active', count(*) FILTER (WHERE account_status = 'active'),
        'suspended', count(*) FILTER (WHERE account_status <> 'active'),
        'invited', count(*) FILTER (WHERE invitation_status = 'invited'),
        'unassigned', count(*) FILTER (WHERE branch_id IS NULL OR department_id IS NULL),
        'new_in_period', count(*) FILTER (WHERE created_at BETWEEN _from AND _to)
      )
      FROM public.profiles
      WHERE organization_id = _org AND account_type IN ('staff','platform_admin')
        AND (_branch IS NULL OR branch_id = _branch)
    ),
    'structure', jsonb_build_object(
      'branches', (SELECT count(*) FROM public.branches WHERE organization_id = _org AND active),
      'departments', (SELECT count(*) FROM public.departments WHERE organization_id = _org AND active),
      'stations', (SELECT count(*) FROM public.operational_stations WHERE organization_id = _org AND active),
      'roles', (SELECT count(*) FROM public.roles WHERE organization_id = _org AND active)
    ),
    'audit', (
      SELECT jsonb_build_object(
        'events_in_period', count(*) FILTER (WHERE created_at BETWEEN _from AND _to),
        'events_24h', count(*) FILTER (WHERE created_at > now() - interval '24 hours'),
        'security_events', count(*) FILTER (WHERE module = 'security' AND created_at BETWEEN _from AND _to)
      )
      FROM public.audit_logs WHERE organization_id = _org
    ),
    'alerts', (
      SELECT jsonb_build_object(
        'open', count(*) FILTER (WHERE status = 'open'),
        'critical', count(*) FILTER (WHERE status = 'open' AND severity = 'critical')
      )
      FROM public.dashboard_alerts WHERE organization_id = _org
    )
  ) INTO _result;

  RETURN _result;
END; $$;

CREATE OR REPLACE FUNCTION public.tasks_trend(
  _branch uuid DEFAULT NULL,
  _department uuid DEFAULT NULL,
  _station uuid DEFAULT NULL,
  _days integer DEFAULT 14
)
RETURNS TABLE(day date, created bigint, completed bigint)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
  WITH days AS (
    SELECT generate_series((current_date - (GREATEST(_days,1) - 1)), current_date, interval '1 day')::date AS day
  )
  SELECT d.day,
    (SELECT count(*) FROM public.tasks t WHERE t.organization_id = public.current_org_id()
       AND t.created_at::date = d.day
       AND (_branch IS NULL OR t.branch_id = _branch)
       AND (_department IS NULL OR t.department_id = _department)
       AND (_station IS NULL OR t.station_id = _station)) AS created,
    (SELECT count(*) FROM public.tasks t WHERE t.organization_id = public.current_org_id()
       AND t.completed_at::date = d.day
       AND (_branch IS NULL OR t.branch_id = _branch)
       AND (_department IS NULL OR t.department_id = _department)
       AND (_station IS NULL OR t.station_id = _station)) AS completed
  FROM days d ORDER BY d.day;
$$;

CREATE OR REPLACE FUNCTION public.department_workload()
RETURNS TABLE(department_id uuid, department text, open_tasks bigint, overdue_tasks bigint)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
  SELECT d.id, d.name,
    count(t.id) FILTER (WHERE t.status NOT IN ('completed','cancelled')),
    count(t.id) FILTER (WHERE t.due_at < now() AND t.status NOT IN ('completed','cancelled'))
  FROM public.departments d
  LEFT JOIN public.tasks t ON t.department_id = d.id
  WHERE d.organization_id = public.current_org_id() AND d.active
  GROUP BY d.id, d.name
  ORDER BY d.name;
$$;

CREATE OR REPLACE FUNCTION public.station_workload()
RETURNS TABLE(station_id uuid, station text, station_type text, open_tasks bigint, overdue_tasks bigint)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
  SELECT s.id, s.name, s.station_type,
    count(t.id) FILTER (WHERE t.status NOT IN ('completed','cancelled')),
    count(t.id) FILTER (WHERE t.due_at < now() AND t.status NOT IN ('completed','cancelled'))
  FROM public.operational_stations s
  LEFT JOIN public.tasks t ON t.station_id = s.id
  WHERE s.organization_id = public.current_org_id() AND s.active
  GROUP BY s.id, s.name, s.station_type
  ORDER BY s.sort_order;
$$;

CREATE OR REPLACE FUNCTION public.my_dashboards()
RETURNS TABLE(key text, name text, description text, scope text, priority integer)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
  SELECT DISTINCT ON (d.key) d.key, d.name, d.description, d.scope, rda.priority
  FROM public.user_roles ur
  JOIN public.role_dashboard_assignments rda ON rda.role_id = ur.role_id
  JOIN public.dashboard_definitions d
    ON d.organization_id = rda.organization_id AND d.key = rda.dashboard_key AND d.active
  WHERE ur.user_id = auth.uid() AND public.is_staff()
  ORDER BY d.key, rda.priority;
$$;

CREATE OR REPLACE FUNCTION public.evaluate_dashboard_alerts(_branch uuid DEFAULT NULL)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  _org uuid := public.current_org_id();
  _m jsonb; _rule record; _val numeric; _count integer := 0;
BEGIN
  IF _org IS NULL THEN RETURN 0; END IF;
  _m := public.dashboard_metrics(_branch, NULL, NULL, now() - interval '30 days', now());

  FOR _rule IN SELECT * FROM public.dashboard_alert_rules
    WHERE organization_id = _org AND active
      AND (branch_id IS NULL OR _branch IS NULL OR branch_id = _branch) LOOP
    _val := CASE _rule.metric
      WHEN 'overdue_tasks' THEN (_m->'tasks'->>'overdue')::numeric
      WHEN 'pending_approvals' THEN (_m->'approvals'->>'pending')::numeric
      WHEN 'delayed_approvals' THEN (_m->'approvals'->>'delayed')::numeric
      WHEN 'unassigned_staff' THEN (_m->'staff'->>'unassigned')::numeric
      WHEN 'suspended_staff' THEN (_m->'staff'->>'suspended')::numeric
      ELSE NULL END;
    IF _val IS NULL THEN CONTINUE; END IF;
    IF (_rule.comparator = 'gte' AND _val >= _rule.threshold)
       OR (_rule.comparator = 'lte' AND _val <= _rule.threshold) THEN
      IF NOT EXISTS (
        SELECT 1 FROM public.dashboard_alerts a
        WHERE a.organization_id = _org AND a.rule_id = _rule.id AND a.status = 'open'
      ) THEN
        INSERT INTO public.dashboard_alerts (organization_id, rule_id, branch_id, severity, title,
          body, metric, observed_value)
        VALUES (_org, _rule.id, _rule.branch_id, _rule.severity, _rule.name,
          'Observed value ' || _val::text || ' met the configured threshold of ' || _rule.threshold::text || '.',
          _rule.metric, _val);
        _count := _count + 1;
      ELSE
        UPDATE public.dashboard_alerts SET observed_value = _val, updated_at = now()
        WHERE organization_id = _org AND rule_id = _rule.id AND status = 'open';
      END IF;
    ELSE
      UPDATE public.dashboard_alerts SET status = 'resolved', updated_at = now()
      WHERE organization_id = _org AND rule_id = _rule.id AND status = 'open';
    END IF;
  END LOOP;
  RETURN _count;
END; $$;