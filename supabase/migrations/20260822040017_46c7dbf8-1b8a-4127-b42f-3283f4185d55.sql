-- Reconcile the permission checker with feature-level grants.
-- Legacy access rules ask broad module questions (e.g. "pms write",
-- "pos menu.manage") while every role now holds feature-level capabilities
-- (restaurant.menu.edit). The checker only matched a broad question against a
-- broad grant, so feature-templated staff were refused by the database even
-- when the sidebar, route guard and Access Matrix all agreed they were allowed.

INSERT INTO public.permission_action_classes (action_suffix, action_class)
VALUES ('write', 'edit'), ('manage-all', 'edit'), ('read', 'view')
ON CONFLICT (action_suffix) DO NOTHING;

CREATE OR REPLACE FUNCTION public.has_permission(_module text, _feature text, _action text)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
    -- A denial still wins, and a module-wide question is denied by a denial on
    -- any feature of that module for the same action.
    WHEN EXISTS (
      SELECT 1 FROM held h, want w
      WHERE h.effect = 'deny' AND h.module = w.module
        AND (w.feature = '*' OR h.feature IN (w.feature, '*'))
        AND (h.action = w.action OR h.action_class = w.action_class)
    ) THEN false
    WHEN public.is_org_admin() THEN true
    ELSE EXISTS (
      SELECT 1 FROM held h, want w
      WHERE h.effect = 'grant' AND h.module = w.module
        -- A module-wide question ("may this person write in Front Office?") is
        -- satisfied by any feature of that module the person actually holds.
        -- A feature-specific question stays tight: only that feature, or a
        -- genuine module-wide grant, answers it.
        AND (w.feature = '*' OR h.feature IN (w.feature, '*'))
        AND (h.action = w.action OR h.action_class = w.action_class)
    )
  END;
$function$;