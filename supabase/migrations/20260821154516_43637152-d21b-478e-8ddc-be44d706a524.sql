
-- 0. Allow feature-level permission rows ------------------------------------
UPDATE public.permissions SET feature = '*' WHERE feature IS NULL;
ALTER TABLE public.permissions ALTER COLUMN feature SET DEFAULT '*';
ALTER TABLE public.permissions ALTER COLUMN feature SET NOT NULL;
ALTER TABLE public.permissions DROP CONSTRAINT IF EXISTS permissions_module_action_key;
CREATE UNIQUE INDEX IF NOT EXISTS permissions_module_feature_action_key
  ON public.permissions (module, feature, action);

-- 1. Feature-level template catalogue --------------------------------------
CREATE TABLE IF NOT EXISTS public.role_feature_templates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  role_key text NOT NULL,
  module text NOT NULL,
  feature text NOT NULL,
  action text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (role_key, module, feature, action)
);

GRANT SELECT ON public.role_feature_templates TO authenticated;
GRANT ALL ON public.role_feature_templates TO service_role;
ALTER TABLE public.role_feature_templates ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "role_feature_templates readable" ON public.role_feature_templates;
CREATE POLICY "role_feature_templates readable" ON public.role_feature_templates
  FOR SELECT TO authenticated USING (true);

-- 2. Reversibility log ------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.role_grant_migration_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid,
  role_id uuid,
  role_key text,
  permission_id uuid,
  module text,
  feature text,
  action text,
  operation text NOT NULL,
  reason text,
  created_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT ON public.role_grant_migration_log TO authenticated;
GRANT ALL ON public.role_grant_migration_log TO service_role;
ALTER TABLE public.role_grant_migration_log ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "role_grant_log readable in org" ON public.role_grant_migration_log;
CREATE POLICY "role_grant_log readable in org" ON public.role_grant_migration_log
  FOR SELECT TO authenticated USING (organization_id = public.current_org_id());

-- 3. Seed the templates -----------------------------------------------------
DELETE FROM public.role_feature_templates;

WITH spec(role_key, caps) AS (
  VALUES
    ('owner', 'front-office.*|restaurant.*|kitchen.*|housekeeping.*|laundry.*|maintenance.*|stores.*|procurement.*|finance.*|marketing.*|events.*|delivery.*|human-resources.*|administration.*|integrations.*|platform.*|migration.*|quality.*|support.*|analytics.*|reports.*|ai.*'),
    ('operations-manager', 'front-office.*|restaurant.*|kitchen.*|housekeeping.*|laundry.*|maintenance.*|stores.*|procurement.*|events.*|delivery.*|marketing.*|analytics.*|reports.*|ai.insights|administration.users|administration.roles|administration.audit-logs|finance.overview'),
    ('finance-manager', 'finance.*|front-office.folios|restaurant.reports|procurement.overview|procurement.lpos|events.billing|marketing.crm-corporate|analytics.overview|reports.overview'),
    ('accountant', 'finance.overview|finance.ledger|finance.journals|finance.payables|finance.receivables|finance.banking|finance.tax|front-office.folios|restaurant.reports|reports.overview'),
    ('night-auditor', 'front-office.overview|front-office.arrivals|front-office.departures|front-office.in-house|front-office.rack|front-office.folios|restaurant.reports|finance.overview|reports.overview'),
    ('food-and-beverage-manager', 'restaurant.*|kitchen.overview|kitchen.queue|kitchen.reports|stores.overview|events.overview'),
    ('waiter', 'restaurant.overview|restaurant.floor|restaurant.orders|restaurant.kds|restaurant.shifts'),
    ('barista', 'restaurant.overview|restaurant.floor|restaurant.orders|restaurant.shifts'),
    ('bar-attendant', 'restaurant.overview|restaurant.floor|restaurant.orders|restaurant.shifts'),
    ('head-chef', 'kitchen.*|restaurant.kds|restaurant.menu|stores.overview|procurement.overview'),
    ('hot-kitchen-chef', 'kitchen.overview|kitchen.queue|kitchen.production|kitchen.recipes|restaurant.kds'),
    ('chief-steward', 'kitchen.overview|kitchen.stores|kitchen.waste|kitchen.quality|stores.overview'),
    ('kitchen-steward', 'kitchen.overview|kitchen.queue|kitchen.waste'),
    ('head-pastry-chef', 'kitchen.overview|kitchen.production|kitchen.recipes|kitchen.queue|kitchen.quality|kitchen.waste|kitchen.reports'),
    ('pastry-chef', 'kitchen.overview|kitchen.production|kitchen.queue|kitchen.recipes'),
    ('front-office-supervisor', 'front-office.*|marketing.crm-customers|housekeeping.board'),
    ('receptionist', 'front-office.overview|front-office.arrivals|front-office.departures|front-office.in-house|front-office.reservations|front-office.availability|front-office.rack|front-office.requests|front-office.guests|marketing.crm-customers'),
    ('reservations-agent', 'front-office.reservations|front-office.availability|front-office.waitlist|front-office.groups|front-office.guests|front-office.rates'),
    ('front-office-cashier', 'front-office.overview|front-office.folios|front-office.departures|restaurant.shifts'),
    ('porter', 'front-office.arrivals|front-office.in-house|front-office.requests'),
    ('driver', 'front-office.requests|delivery.overview'),
    ('housekeeping-supervisor', 'housekeeping.*|laundry.overview|front-office.rack|maintenance.overview'),
    ('housekeeper', 'housekeeping.overview|housekeeping.board|housekeeping.tasks|housekeeping.lost-found'),
    ('laundry-supervisor', 'laundry.overview|housekeeping.overview|front-office.rack'),
    ('laundry-attendant', 'laundry.overview'),
    ('maintenance-manager', 'maintenance.*|housekeeping.board|front-office.rack|stores.overview|procurement.overview'),
    ('maintenance-technician', 'maintenance.overview'),
    ('grounds-worker', 'maintenance.overview'),
    ('marketing-manager', 'marketing.*|events.overview|analytics.overview|reports.overview'),
    ('sales-and-events-manager', 'events.*|marketing.crm-corporate|marketing.leads|front-office.availability'),
    ('events-coordinator', 'events.overview|events.enquiries|events.quotations|events.bookings|events.calendar|events.site-visits|events.readiness|events.resources|events.venues'),
    ('banqueting-staff', 'events.overview|events.calendar|events.readiness'),
    ('procurement-manager', 'procurement.*|stores.overview|finance.payables'),
    ('procurement-officer', 'procurement.overview|procurement.lpos'),
    ('storekeeper', 'stores.overview|procurement.overview|kitchen.stores'),
    ('receiving-clerk', 'stores.overview|procurement.lpos'),
    ('human-resources-manager', 'human-resources.*|administration.users|administration.departments'),
    ('hr-officer', 'human-resources.overview|human-resources.employees|human-resources.attendance|human-resources.leave|human-resources.recruitment|human-resources.training|human-resources.scheduling'),
    ('security-supervisor', 'front-office.in-house|administration.audit-logs|maintenance.overview|housekeeping.board'),
    ('security-guard', 'front-office.in-house'),
    ('it-system-administrator', 'administration.*|integrations.*|platform.*|migration.overview|quality.overview|support.overview'),
    ('delivery-manager', 'delivery.overview|restaurant.orders|marketing.crm-customers'),
    ('rider', 'delivery.overview')
),
expanded AS (
  SELECT
    spec.role_key,
    split_part(cap, '.', 1) AS module,
    regexp_replace(cap, '^[^.]+\.', '') AS feature
  FROM spec, LATERAL unnest(string_to_array(spec.caps, '|')) AS cap
),
levelled AS (
  SELECT e.*, rc.access_scope,
         rc.access_scope IN ('organisation', 'branch', 'department') AS is_lead
  FROM expanded e
  JOIN public.role_catalogue rc ON rc.role_key = e.role_key
)
INSERT INTO public.role_feature_templates (role_key, module, feature, action)
SELECT DISTINCT l.role_key, l.module, l.feature, a.action
FROM levelled l
CROSS JOIN LATERAL (
  SELECT unnest(
    CASE
      WHEN l.access_scope = 'organisation'
        THEN ARRAY['view','create','edit','delete','approve','reject','export','print','override','void','refund']
      WHEN l.is_lead
        THEN ARRAY['view','create','edit','approve','export','print']
      WHEN l.access_scope = 'team'
        THEN ARRAY['view','create','edit','export']
      ELSE ARRAY['view','create','edit']
    END
  ) AS action
) a
ON CONFLICT DO NOTHING;

-- 4. Register every capability as a real permission -------------------------
INSERT INTO public.permissions (module, feature, action, label)
SELECT DISTINCT t.module, t.feature, t.action,
       initcap(replace(t.action,'-',' ')) || ' ' || replace(t.feature,'-',' ') || ' (' || replace(t.module,'-',' ') || ')'
FROM public.role_feature_templates t
WHERE NOT EXISTS (
  SELECT 1 FROM public.permissions p
  WHERE p.module = t.module AND p.feature = t.feature AND p.action = t.action
);

-- 5. Apply templates to a workspace ----------------------------------------
CREATE OR REPLACE FUNCTION public.neo_apply_feature_templates(_org uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _removed integer := 0;
  _added integer := 0;
BEGIN
  WITH targets AS (
    SELECT r.id AS role_id, r.normalized_role_key AS role_key
    FROM public.roles r
    WHERE r.organization_id = _org
      AND coalesce(r.active, true)
      AND r.normalized_role_key IN (SELECT DISTINCT role_key FROM public.role_feature_templates)
  ),
  doomed AS (
    SELECT rp.id, t.role_id, t.role_key, p.id AS permission_id, p.module, p.feature, p.action
    FROM targets t
    JOIN public.role_permissions rp ON rp.role_id = t.role_id
    JOIN public.permissions p ON p.id = rp.permission_id
    WHERE NOT EXISTS (
      SELECT 1 FROM public.role_feature_templates ft
      WHERE ft.role_key = t.role_key
        AND ft.module = p.module
        AND ft.feature = p.feature
        AND ft.action = p.action
    )
  ),
  logged AS (
    INSERT INTO public.role_grant_migration_log
      (organization_id, role_id, role_key, permission_id, module, feature, action, operation, reason)
    SELECT _org, d.role_id, d.role_key, d.permission_id, d.module, d.feature, d.action, 'revoked',
           'replaced broad module grant with feature-level capabilities'
    FROM doomed d
    RETURNING 1
  ),
  deleted AS (
    DELETE FROM public.role_permissions rp USING doomed d WHERE rp.id = d.id RETURNING 1
  )
  SELECT count(*) INTO _removed FROM deleted;

  WITH targets AS (
    SELECT r.id AS role_id, r.normalized_role_key AS role_key
    FROM public.roles r
    WHERE r.organization_id = _org
      AND coalesce(r.active, true)
      AND r.normalized_role_key IN (SELECT DISTINCT role_key FROM public.role_feature_templates)
  ),
  wanted AS (
    SELECT t.role_id, t.role_key, p.id AS permission_id, p.module, p.feature, p.action
    FROM targets t
    JOIN public.role_feature_templates ft ON ft.role_key = t.role_key
    JOIN public.permissions p
      ON p.module = ft.module AND p.feature = ft.feature AND p.action = ft.action
    WHERE NOT EXISTS (
      SELECT 1 FROM public.role_permissions rp
      WHERE rp.role_id = t.role_id AND rp.permission_id = p.id
    )
  ),
  inserted AS (
    INSERT INTO public.role_permissions (organization_id, role_id, permission_id)
    SELECT _org, w.role_id, w.permission_id FROM wanted w
    RETURNING 1
  ),
  logged2 AS (
    INSERT INTO public.role_grant_migration_log
      (organization_id, role_id, role_key, permission_id, module, feature, action, operation, reason)
    SELECT _org, w.role_id, w.role_key, w.permission_id, w.module, w.feature, w.action, 'granted',
           'feature-level capability compiled from the modern role catalogue'
    FROM wanted w
    RETURNING 1
  )
  SELECT count(*) INTO _added FROM inserted;

  RETURN jsonb_build_object('organization_id', _org, 'revoked', _removed, 'granted', _added);
END;
$$;

REVOKE EXECUTE ON FUNCTION public.neo_apply_feature_templates(uuid) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.neo_apply_feature_templates(uuid) FROM anon;
GRANT EXECUTE ON FUNCTION public.neo_apply_feature_templates(uuid) TO authenticated, service_role;

-- 6. Apply to every existing workspace -------------------------------------
DO $$
DECLARE o record;
BEGIN
  FOR o IN SELECT id FROM public.organizations LOOP
    PERFORM public.neo_apply_feature_templates(o.id);
  END LOOP;
END $$;
