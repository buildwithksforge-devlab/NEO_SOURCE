CREATE OR REPLACE FUNCTION public.has_exact_permission(_module text, _feature text, _action text)
RETURNS boolean
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $$
  WITH want AS (
    SELECT c.module, c.feature, c.action, public.permission_action_class(c.action) AS action_class
    FROM public.canonical_permission(_module, _feature, _action) c
  ),
  held AS (
    SELECT c.module, c.feature, c.action, public.permission_action_class(c.action) AS action_class, 'deny'::text AS effect
    FROM public.user_permissions up
    JOIN public.permissions p ON p.id = up.permission_id
    , LATERAL public.canonical_permission(p.module, p.feature, p.action) c
    WHERE up.user_id = auth.uid() AND up.effect = 'deny'
      AND up.organization_id = public.current_org_id()
    UNION ALL
    SELECT c.module, c.feature, c.action, public.permission_action_class(c.action), 'grant'
    FROM public.user_roles ur
    JOIN public.roles r ON r.id = ur.role_id AND r.active
    JOIN public.role_permissions rp ON rp.role_id = r.id
    JOIN public.permissions p ON p.id = rp.permission_id
    , LATERAL public.canonical_permission(p.module, p.feature, p.action) c
    WHERE ur.user_id = auth.uid()
      AND ur.organization_id = public.current_org_id()
      AND r.organization_id = public.current_org_id()
      AND rp.organization_id = public.current_org_id()
    UNION ALL
    SELECT c.module, c.feature, c.action, public.permission_action_class(c.action), 'grant'
    FROM public.user_permissions up
    JOIN public.permissions p ON p.id = up.permission_id
    , LATERAL public.canonical_permission(p.module, p.feature, p.action) c
    WHERE up.user_id = auth.uid() AND up.effect = 'grant'
      AND up.organization_id = public.current_org_id()
  )
  SELECT CASE
    WHEN NOT public.is_active_staff() THEN false
    WHEN EXISTS (
      SELECT 1 FROM held h, want w
      WHERE h.effect = 'deny' AND h.module = w.module
        AND (h.feature = w.feature OR h.feature = '*')
        AND (h.action = w.action OR h.action_class = w.action_class)
    ) THEN false
    WHEN public.is_org_admin() THEN true
    ELSE EXISTS (
      -- A genuine module-wide grant ("all Front Office features") answers a
      -- feature-specific question. The action still has to match exactly, so
      -- this stays stricter than has_permission.
      SELECT 1 FROM held h, want w
      WHERE h.effect = 'grant' AND h.module = w.module
        AND (h.feature = w.feature OR h.feature = '*')
        AND h.action = w.action
    )
  END;
$$;

REVOKE ALL ON FUNCTION public.has_exact_permission(text, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.has_exact_permission(text, text, text) FROM anon;
GRANT EXECUTE ON FUNCTION public.has_exact_permission(text, text, text) TO authenticated, service_role;

-- Receptionists open the folio at check-in; they must be able to read and post to it.
INSERT INTO public.role_feature_templates (role_key, module, feature, action) VALUES
  ('receptionist','front-office','folios','view'),
  ('receptionist','front-office','folios','create'),
  ('receptionist','front-office','folios','edit'),
  ('front-office-supervisor','front-office','folios','view'),
  ('front-office-manager','front-office','folios','view')
ON CONFLICT (role_key, module, feature, action) DO NOTHING;