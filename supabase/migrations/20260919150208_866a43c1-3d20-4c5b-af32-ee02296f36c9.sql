
-- Stage A/B: immutable RBAC baseline + redundancy classification. Additive only.

CREATE TABLE public.rbac_baseline_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  label text NOT NULL,
  captured_by uuid,
  captured_at timestamptz NOT NULL DEFAULT now(),
  stats jsonb NOT NULL DEFAULT '{}'::jsonb
);
GRANT SELECT ON public.rbac_baseline_runs TO authenticated;
GRANT ALL ON public.rbac_baseline_runs TO service_role;
ALTER TABLE public.rbac_baseline_runs ENABLE ROW LEVEL SECURITY;
CREATE POLICY "admins read baseline runs" ON public.rbac_baseline_runs
  FOR SELECT TO authenticated USING (public.is_org_admin_for(public.current_org_id()));

CREATE TABLE public.rbac_baseline_roles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id uuid NOT NULL REFERENCES public.rbac_baseline_runs(id) ON DELETE CASCADE,
  organization_id uuid NOT NULL,
  role_id uuid NOT NULL,
  role_name text NOT NULL,
  normalized_role_key text,
  template_key text,
  is_system boolean NOT NULL DEFAULT false,
  active boolean NOT NULL DEFAULT true,
  access_scope text,
  branch_scope text,
  station_scope text,
  department_id uuid,
  approval_class text,
  permission_count integer NOT NULL DEFAULT 0,
  permission_fingerprint text
);
GRANT SELECT ON public.rbac_baseline_roles TO authenticated;
GRANT ALL ON public.rbac_baseline_roles TO service_role;
ALTER TABLE public.rbac_baseline_roles ENABLE ROW LEVEL SECURITY;
CREATE POLICY "admins read baseline roles" ON public.rbac_baseline_roles
  FOR SELECT TO authenticated
  USING (organization_id = public.current_org_id() AND public.is_org_admin_for(organization_id));
CREATE INDEX rbac_baseline_roles_run_org_idx ON public.rbac_baseline_roles(run_id, organization_id);
CREATE UNIQUE INDEX rbac_baseline_roles_unique ON public.rbac_baseline_roles(run_id, role_id);

CREATE TABLE public.rbac_baseline_role_permissions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id uuid NOT NULL REFERENCES public.rbac_baseline_runs(id) ON DELETE CASCADE,
  organization_id uuid NOT NULL,
  role_id uuid NOT NULL,
  permission_id uuid NOT NULL,
  template_key text,
  module text NOT NULL,
  feature text NOT NULL,
  action text NOT NULL,
  source text NOT NULL,
  -- 'default'  : exactly reproducible from the role's template
  -- 'added'    : held beyond the template (organisation customisation)
  -- 'untemplated': role has no resolvable template, so nothing can be proven
  classification text NOT NULL
);
GRANT SELECT ON public.rbac_baseline_role_permissions TO authenticated;
GRANT ALL ON public.rbac_baseline_role_permissions TO service_role;
ALTER TABLE public.rbac_baseline_role_permissions ENABLE ROW LEVEL SECURITY;
CREATE POLICY "admins read baseline role permissions" ON public.rbac_baseline_role_permissions
  FOR SELECT TO authenticated
  USING (organization_id = public.current_org_id() AND public.is_org_admin_for(organization_id));
CREATE INDEX rbac_baseline_rp_run_org_idx ON public.rbac_baseline_role_permissions(run_id, organization_id);
CREATE INDEX rbac_baseline_rp_class_idx ON public.rbac_baseline_role_permissions(run_id, classification);
CREATE UNIQUE INDEX rbac_baseline_rp_unique ON public.rbac_baseline_role_permissions(run_id, role_id, permission_id);

-- Template lines the organisation dropped: recorded as explicit negatives so a
-- de-materialised role can never silently regain them from the template.
CREATE TABLE public.rbac_baseline_template_omissions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id uuid NOT NULL REFERENCES public.rbac_baseline_runs(id) ON DELETE CASCADE,
  organization_id uuid NOT NULL,
  role_id uuid NOT NULL,
  template_key text NOT NULL,
  module text NOT NULL,
  feature text NOT NULL,
  action text NOT NULL
);
GRANT SELECT ON public.rbac_baseline_template_omissions TO authenticated;
GRANT ALL ON public.rbac_baseline_template_omissions TO service_role;
ALTER TABLE public.rbac_baseline_template_omissions ENABLE ROW LEVEL SECURITY;
CREATE POLICY "admins read baseline omissions" ON public.rbac_baseline_template_omissions
  FOR SELECT TO authenticated
  USING (organization_id = public.current_org_id() AND public.is_org_admin_for(organization_id));
CREATE INDEX rbac_baseline_omissions_run_org_idx ON public.rbac_baseline_template_omissions(run_id, organization_id);

CREATE TABLE public.rbac_baseline_assignments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id uuid NOT NULL REFERENCES public.rbac_baseline_runs(id) ON DELETE CASCADE,
  organization_id uuid NOT NULL,
  user_id uuid NOT NULL,
  role_id uuid,
  branch_id uuid,
  kind text NOT NULL,
  is_primary boolean NOT NULL DEFAULT false
);
GRANT SELECT ON public.rbac_baseline_assignments TO authenticated;
GRANT ALL ON public.rbac_baseline_assignments TO service_role;
ALTER TABLE public.rbac_baseline_assignments ENABLE ROW LEVEL SECURITY;
CREATE POLICY "admins read baseline assignments" ON public.rbac_baseline_assignments
  FOR SELECT TO authenticated
  USING (organization_id = public.current_org_id() AND public.is_org_admin_for(organization_id));
CREATE INDEX rbac_baseline_assignments_run_org_idx ON public.rbac_baseline_assignments(run_id, organization_id);

-- The reconciliation reference: user x organisation x permission x effect x source.
CREATE TABLE public.rbac_baseline_effective_access (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id uuid NOT NULL REFERENCES public.rbac_baseline_runs(id) ON DELETE CASCADE,
  organization_id uuid NOT NULL,
  user_id uuid NOT NULL,
  module text NOT NULL,
  feature text NOT NULL,
  action text NOT NULL,
  effect text NOT NULL,
  source text NOT NULL,
  branch_ids uuid[] NOT NULL DEFAULT '{}'::uuid[]
);
GRANT SELECT ON public.rbac_baseline_effective_access TO authenticated;
GRANT ALL ON public.rbac_baseline_effective_access TO service_role;
ALTER TABLE public.rbac_baseline_effective_access ENABLE ROW LEVEL SECURITY;
CREATE POLICY "admins read baseline effective access" ON public.rbac_baseline_effective_access
  FOR SELECT TO authenticated
  USING (organization_id = public.current_org_id() AND public.is_org_admin_for(organization_id));
CREATE INDEX rbac_baseline_eff_run_org_idx ON public.rbac_baseline_effective_access(run_id, organization_id, user_id);
CREATE UNIQUE INDEX rbac_baseline_eff_unique
  ON public.rbac_baseline_effective_access(run_id, user_id, module, feature, action, effect);

-- Capture is platform maintenance: service role / migration only. No app write path.
CREATE OR REPLACE FUNCTION public.neo_rbac_capture_baseline(_label text)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  _run uuid;
BEGIN
  IF auth.uid() IS NOT NULL THEN
    RAISE EXCEPTION 'RBAC baseline capture is a platform maintenance routine'
      USING ERRCODE = '42501';
  END IF;

  INSERT INTO public.rbac_baseline_runs(label) VALUES (_label) RETURNING id INTO _run;

  INSERT INTO public.rbac_baseline_roles
    (run_id, organization_id, role_id, role_name, normalized_role_key, template_key,
     is_system, active, access_scope, branch_scope, station_scope, department_id,
     approval_class, permission_count, permission_fingerprint)
  SELECT _run, r.organization_id, r.id, r.name, r.normalized_role_key,
         public.neo_resolve_role_template_key(r.normalized_role_key, r.name),
         coalesce(r.is_system, false), coalesce(r.active, true), r.access_scope,
         r.branch_scope, r.station_scope, r.department_id, r.approval_class,
         coalesce(x.n, 0), x.fp
  FROM public.roles r
  LEFT JOIN LATERAL (
    SELECT count(*) AS n,
           md5(string_agg(p.module||'.'||p.feature||'.'||p.action, ',' ORDER BY p.module, p.feature, p.action)) AS fp
    FROM public.role_permissions rp JOIN public.permissions p ON p.id = rp.permission_id
    WHERE rp.role_id = r.id
  ) x ON true;

  INSERT INTO public.rbac_baseline_role_permissions
    (run_id, organization_id, role_id, permission_id, template_key, module, feature, action,
     source, classification)
  SELECT _run, rp.organization_id, rp.role_id, rp.permission_id, br.template_key,
         p.module, p.feature, p.action, rp.source,
         CASE
           WHEN br.template_key IS NULL THEN 'untemplated'
           WHEN rp.source <> 'template' THEN 'added'
           WHEN EXISTS (
             SELECT 1 FROM public.role_feature_templates ft
             WHERE ft.role_key = br.template_key
               AND ft.module = p.module AND ft.feature = p.feature AND ft.action = p.action
           ) THEN 'default'
           ELSE 'added'
         END
  FROM public.role_permissions rp
  JOIN public.permissions p ON p.id = rp.permission_id
  JOIN public.rbac_baseline_roles br ON br.run_id = _run AND br.role_id = rp.role_id;

  INSERT INTO public.rbac_baseline_template_omissions
    (run_id, organization_id, role_id, template_key, module, feature, action)
  SELECT _run, br.organization_id, br.role_id, br.template_key, ft.module, ft.feature, ft.action
  FROM public.rbac_baseline_roles br
  JOIN public.role_feature_templates ft ON ft.role_key = br.template_key
  WHERE br.run_id = _run
    AND br.template_key IS NOT NULL
    AND NOT EXISTS (
      SELECT 1 FROM public.rbac_baseline_role_permissions brp
      WHERE brp.run_id = _run AND brp.role_id = br.role_id
        AND brp.module = ft.module AND brp.feature = ft.feature AND brp.action = ft.action
    );

  INSERT INTO public.rbac_baseline_assignments
    (run_id, organization_id, user_id, role_id, branch_id, kind, is_primary)
  SELECT _run, ur.organization_id, ur.user_id, ur.role_id, NULL, 'role', coalesce(ur.is_primary, false)
  FROM public.user_roles ur
  UNION ALL
  SELECT _run, ub.organization_id, ub.user_id, NULL, ub.branch_id, 'branch', false
  FROM public.user_branches ub;

  INSERT INTO public.rbac_baseline_effective_access
    (run_id, organization_id, user_id, module, feature, action, effect, source, branch_ids)
  SELECT _run, x.organization_id, x.user_id, x.module, x.feature, x.action, x.effect,
         string_agg(DISTINCT x.source, '+' ORDER BY x.source),
         coalesce((SELECT array_agg(DISTINCT ub.branch_id)
                     FROM public.user_branches ub
                    WHERE ub.user_id = x.user_id AND ub.organization_id = x.organization_id), '{}')
  FROM (
    SELECT ur.organization_id, ur.user_id, p.module, p.feature, p.action,
           'grant'::text AS effect, 'role:'||coalesce(r.normalized_role_key, r.name) AS source
    FROM public.user_roles ur
    JOIN public.roles r ON r.id = ur.role_id AND coalesce(r.active, true)
    JOIN public.role_permissions rp ON rp.role_id = r.id
    JOIN public.permissions p ON p.id = rp.permission_id
    WHERE r.organization_id = ur.organization_id AND rp.organization_id = ur.organization_id
    UNION ALL
    SELECT up.organization_id, up.user_id, p.module, p.feature, p.action,
           up.effect, 'user-override'
    FROM public.user_permissions up
    JOIN public.permissions p ON p.id = up.permission_id
  ) x
  GROUP BY x.organization_id, x.user_id, x.module, x.feature, x.action, x.effect;

  UPDATE public.rbac_baseline_runs
     SET stats = jsonb_build_object(
       'roles', (SELECT count(*) FROM public.rbac_baseline_roles WHERE run_id = _run),
       'role_permissions', (SELECT count(*) FROM public.rbac_baseline_role_permissions WHERE run_id = _run),
       'default_rows', (SELECT count(*) FROM public.rbac_baseline_role_permissions WHERE run_id = _run AND classification = 'default'),
       'added_rows', (SELECT count(*) FROM public.rbac_baseline_role_permissions WHERE run_id = _run AND classification = 'added'),
       'untemplated_rows', (SELECT count(*) FROM public.rbac_baseline_role_permissions WHERE run_id = _run AND classification = 'untemplated'),
       'template_omissions', (SELECT count(*) FROM public.rbac_baseline_template_omissions WHERE run_id = _run),
       'assignments', (SELECT count(*) FROM public.rbac_baseline_assignments WHERE run_id = _run),
       'effective_access_rows', (SELECT count(*) FROM public.rbac_baseline_effective_access WHERE run_id = _run),
       'users_covered', (SELECT count(DISTINCT user_id) FROM public.rbac_baseline_effective_access WHERE run_id = _run)
     )
   WHERE id = _run;

  RETURN _run;
END;
$$;
REVOKE ALL ON FUNCTION public.neo_rbac_capture_baseline(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.neo_rbac_capture_baseline(text) TO service_role;
