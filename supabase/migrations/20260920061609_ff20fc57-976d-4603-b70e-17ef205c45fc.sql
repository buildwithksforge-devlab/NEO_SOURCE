CREATE OR REPLACE FUNCTION public.has_exact_permission(_module text, _feature text, _action text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
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
    , LATERAL public.role_permission_ids(r.id) rpi
    JOIN public.permissions p ON p.id = rpi.permission_id
    , LATERAL public.canonical_permission(p.module, p.feature, p.action) c
    WHERE ur.user_id = auth.uid()
      AND ur.organization_id = public.current_org_id()
      AND r.organization_id = public.current_org_id()
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
      SELECT 1 FROM held h, want w
      WHERE h.effect = 'grant' AND h.module = w.module
        AND (h.feature = w.feature OR h.feature = '*')
        AND h.action = w.action
    )
  END;
$$;