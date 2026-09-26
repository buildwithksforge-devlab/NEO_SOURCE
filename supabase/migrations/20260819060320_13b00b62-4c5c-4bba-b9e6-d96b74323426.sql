
CREATE TABLE IF NOT EXISTS public.permission_module_aliases (
  alias_module text PRIMARY KEY,
  canonical_module text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT ON public.permission_module_aliases TO authenticated;
GRANT ALL ON public.permission_module_aliases TO service_role;
ALTER TABLE public.permission_module_aliases ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policy WHERE polrelid='public.permission_module_aliases'::regclass AND polname='alias read') THEN
    CREATE POLICY "alias read" ON public.permission_module_aliases FOR SELECT TO authenticated USING (true);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policy WHERE polrelid='public.permission_module_aliases'::regclass AND polname='alias platform write') THEN
    CREATE POLICY "alias platform write" ON public.permission_module_aliases FOR ALL TO authenticated
      USING (public.is_platform_admin()) WITH CHECK (public.is_platform_admin());
  END IF;
END $$;

INSERT INTO public.permission_module_aliases (alias_module, canonical_module) VALUES
  ('pms','front-office'),('front-office','front-office'),
  ('pos','restaurant'),('restaurant','restaurant'),('bar','bar'),
  ('kitchen','kitchen'),('housekeeping','housekeeping'),('laundry','laundry'),('maintenance','maintenance'),
  ('inventory','stores'),('stores','stores'),('procurement','procurement'),
  ('finance','finance'),('finance-ap','finance'),('finance-ar','finance'),('finance-gl','finance'),
  ('finance-tax','finance'),('finance-payments','finance'),('finance-reports','finance'),
  ('events','events'),('delivery','delivery'),('marketing','marketing'),
  ('crm-customers','marketing'),('crm-corporate','marketing'),('crm-loyalty','marketing'),
  ('crm-segments','marketing'),('crm-feedback','marketing'),('crm-communications','marketing'),
  ('crm-credit','marketing'),('crm-identity','marketing'),('crm-preferences','marketing'),('crm-ai','marketing'),
  ('human-resources','human-resources'),('hr-employees','human-resources'),('hr-attendance','human-resources'),
  ('hr-leave','human-resources'),('hr-payroll','human-resources'),('hr-performance','human-resources'),
  ('hr-recruitment','human-resources'),('hr-scheduling','human-resources'),('hr-training','human-resources'),
  ('hr-reports','human-resources'),('hr-announcements','human-resources'),
  ('administration','administration'),('users','administration'),('roles','administration'),
  ('permissions','administration'),('departments','administration'),('stations','administration'),
  ('settings','administration'),('security','administration'),('audit_logs','administration'),
  ('automation','integrations'),('automation-ai','integrations'),('automation-providers','integrations'),
  ('integrations','integrations'),('migration','migration'),('quality','quality'),('support','support'),
  ('platform','platform'),('analytics','analytics'),('kpis','analytics'),('dashboards','analytics'),
  ('executive-dashboard','analytics'),('reports','reports'),('ai','ai'),('ai-insights','ai'),('alerts','ai'),
  ('approvals','approvals'),('tasks','tasks'),('notifications','notifications')
ON CONFLICT (alias_module) DO NOTHING;

CREATE OR REPLACE FUNCTION public.canonical_permission(_module text, _feature text, _action text)
RETURNS TABLE(module text, feature text, action text)
LANGUAGE sql IMMUTABLE
SET search_path TO 'public'
AS $$
  SELECT
    COALESCE((SELECT a.canonical_module FROM public.permission_module_aliases a WHERE a.alias_module = _module), _module),
    CASE
      WHEN position('.' in _action) > 0 THEN split_part(_action, '.', 1)
      WHEN COALESCE(_feature, '*') <> '*' THEN _feature
      ELSE '*'
    END,
    CASE WHEN position('.' in _action) > 0
      THEN substring(_action from position('.' in _action) + 1)
      ELSE _action END;
$$;

CREATE OR REPLACE FUNCTION public.my_effective_permissions()
RETURNS TABLE(module text, feature text, action text)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $$
  WITH org AS (SELECT public.current_org_id() AS id),
  denied AS (
    SELECT p.id FROM public.user_permissions up
    JOIN public.permissions p ON p.id = up.permission_id
    WHERE up.user_id = auth.uid() AND up.effect = 'deny'
      AND up.organization_id = (SELECT id FROM org)
  ),
  base AS (
    SELECT p.id, p.module, p.feature, p.action
    FROM public.permissions p
    WHERE public.is_org_admin()
    UNION
    SELECT p.id, p.module, p.feature, p.action
    FROM public.user_roles ur
    JOIN public.roles r ON r.id = ur.role_id AND r.active
    JOIN public.role_permissions rp ON rp.role_id = r.id
    JOIN public.permissions p ON p.id = rp.permission_id
    WHERE ur.user_id = auth.uid()
      AND ur.organization_id = (SELECT id FROM org)
      AND r.organization_id = (SELECT id FROM org)
      AND rp.organization_id = (SELECT id FROM org)
    UNION
    SELECT p.id, p.module, p.feature, p.action
    FROM public.user_permissions up
    JOIN public.permissions p ON p.id = up.permission_id
    WHERE up.user_id = auth.uid() AND up.effect = 'grant'
      AND up.organization_id = (SELECT id FROM org)
  ),
  kept AS (
    SELECT b.module, b.feature, b.action FROM base b WHERE b.id NOT IN (SELECT id FROM denied)
  )
  SELECT module, COALESCE(feature,'*'), action FROM kept
  UNION
  SELECT c.module, c.feature, c.action FROM kept k, LATERAL public.canonical_permission(k.module, k.feature, k.action) c;
$$;

CREATE OR REPLACE FUNCTION public.has_permission(_module text, _feature text, _action text)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $$
  WITH want AS (SELECT * FROM public.canonical_permission(_module, _feature, _action))
  SELECT CASE
    WHEN NOT public.is_active_staff() THEN false
    WHEN EXISTS (
      SELECT 1 FROM public.user_permissions up
      JOIN public.permissions p ON p.id = up.permission_id
      CROSS JOIN want w, LATERAL public.canonical_permission(p.module, p.feature, p.action) c
      WHERE up.user_id = auth.uid() AND up.effect = 'deny'
        AND up.organization_id = public.current_org_id()
        AND c.module = w.module AND c.action = w.action AND c.feature IN (w.feature, '*')
    ) THEN false
    WHEN public.is_org_admin() THEN true
    ELSE EXISTS (
      SELECT 1 FROM public.user_roles ur
      JOIN public.roles r ON r.id = ur.role_id AND r.active
      JOIN public.role_permissions rp ON rp.role_id = r.id
      JOIN public.permissions p ON p.id = rp.permission_id
      CROSS JOIN want w, LATERAL public.canonical_permission(p.module, p.feature, p.action) c
      WHERE ur.user_id = auth.uid()
        AND ur.organization_id = public.current_org_id()
        AND r.organization_id = public.current_org_id()
        AND rp.organization_id = public.current_org_id()
        AND c.module = w.module AND c.action = w.action AND c.feature IN (w.feature, '*')
    ) OR EXISTS (
      SELECT 1 FROM public.user_permissions up
      JOIN public.permissions p ON p.id = up.permission_id
      CROSS JOIN want w, LATERAL public.canonical_permission(p.module, p.feature, p.action) c
      WHERE up.user_id = auth.uid() AND up.effect = 'grant'
        AND up.organization_id = public.current_org_id()
        AND c.module = w.module AND c.action = w.action AND c.feature IN (w.feature, '*')
    )
  END;
$$;

CREATE UNIQUE INDEX IF NOT EXISTS role_permissions_role_permission_uniq
  ON public.role_permissions (role_id, permission_id);

WITH latest AS (
  SELECT template_name, max(version) AS version
  FROM public.role_permission_templates GROUP BY template_name
),
tmpl AS (
  SELECT t.template_name, t.module, t.action
  FROM public.role_permission_templates t JOIN latest l
    ON l.template_name = t.template_name AND l.version = t.version
),
target AS (
  SELECT DISTINCT r.id AS role_id, r.organization_id, p.id AS permission_id
  FROM public.roles r
  JOIN tmpl t ON lower(t.template_name) = lower(r.name)
  JOIN public.permissions p ON p.module = t.module AND p.action = t.action
  WHERE r.active
)
INSERT INTO public.role_permissions (role_id, permission_id, organization_id)
SELECT role_id, permission_id, organization_id FROM target
ON CONFLICT (role_id, permission_id) DO NOTHING;

CREATE OR REPLACE FUNCTION public.audit_trail(
  _from timestamptz DEFAULT (now() - interval '30 days'),
  _to timestamptz DEFAULT now(),
  _module text DEFAULT NULL,
  _branch uuid DEFAULT NULL,
  _limit integer DEFAULT 500
)
RETURNS TABLE(
  id uuid, created_at timestamptz, action text, module text,
  actor_id uuid, actor_name text, record_id text,
  previous_value jsonb, new_value jsonb, reason text, device text, branch_id uuid
)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $$
  SELECT a.id, a.created_at, a.action, a.module,
         a.user_id,
         COALESCE(NULLIF(btrim(pr.full_name), ''), NULLIF(btrim(a.user_name), ''),
                  CASE WHEN a.user_id IS NULL THEN 'System migration' ELSE 'Removed account' END),
         a.record_id, a.previous_value, a.new_value, a.reason, a.device, a.branch_id
  FROM public.audit_logs a
  LEFT JOIN public.profiles pr ON pr.id = a.user_id
  WHERE a.organization_id = public.current_org_id()
    AND public.current_org_id() IS NOT NULL
    AND (public.is_org_admin() OR public.has_permission('administration','audit','view') OR a.user_id = auth.uid())
    AND a.created_at >= _from AND a.created_at <= _to
    AND (_module IS NULL OR a.module = _module)
    AND (_branch IS NULL OR a.branch_id = _branch)
  ORDER BY a.created_at DESC
  LIMIT GREATEST(COALESCE(_limit, 500), 1);
$$;
REVOKE EXECUTE ON FUNCTION public.audit_trail(timestamptz,timestamptz,text,uuid,integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.audit_trail(timestamptz,timestamptz,text,uuid,integer) TO authenticated;
REVOKE EXECUTE ON FUNCTION public.canonical_permission(text,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.canonical_permission(text,text,text) TO authenticated, service_role;
