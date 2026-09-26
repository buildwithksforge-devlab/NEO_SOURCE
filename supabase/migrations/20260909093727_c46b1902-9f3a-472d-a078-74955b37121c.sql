-- Catalogue editing needs a grant that names the menu itself. A blanket
-- "everything in the restaurant" grant (which service roles such as waiters
-- carry so they can work the floor) no longer opens the menu for editing.
CREATE OR REPLACE FUNCTION public.has_explicit_permission(_module text, _feature text, _action text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
  WITH want AS (
    SELECT c.module, c.feature, c.action, public.permission_action_class(c.action) AS action_class
      FROM public.canonical_permission(_module, _feature, _action) c
  ), held AS (
    SELECT c.module, c.feature, c.action, public.permission_action_class(c.action) AS action_class, 'deny'::text AS effect
      FROM public.user_permissions up JOIN public.permissions p ON p.id = up.permission_id,
           LATERAL public.canonical_permission(p.module, p.feature, p.action) c
     WHERE up.user_id = auth.uid() AND up.effect = 'deny' AND up.organization_id = public.current_org_id()
    UNION ALL
    SELECT c.module, c.feature, c.action, public.permission_action_class(c.action), 'grant'
      FROM public.user_roles ur JOIN public.roles r ON r.id = ur.role_id AND r.active
      JOIN public.role_permissions rp ON rp.role_id = r.id
      JOIN public.permissions p ON p.id = rp.permission_id,
           LATERAL public.canonical_permission(p.module, p.feature, p.action) c
     WHERE ur.user_id = auth.uid() AND ur.organization_id = public.current_org_id()
       AND r.organization_id = public.current_org_id() AND rp.organization_id = public.current_org_id()
    UNION ALL
    SELECT c.module, c.feature, c.action, public.permission_action_class(c.action), 'grant'
      FROM public.user_permissions up JOIN public.permissions p ON p.id = up.permission_id,
           LATERAL public.canonical_permission(p.module, p.feature, p.action) c
     WHERE up.user_id = auth.uid() AND up.effect = 'grant' AND up.organization_id = public.current_org_id()
  )
  SELECT CASE
    WHEN NOT public.is_active_staff() THEN false
    WHEN public.is_org_admin() THEN true
    WHEN EXISTS (SELECT 1 FROM held h, want w
                  WHERE h.effect = 'deny' AND h.module = w.module AND h.feature = w.feature
                    AND (h.action = w.action OR h.action_class = w.action_class)) THEN false
    ELSE EXISTS (SELECT 1 FROM held h, want w
                  WHERE h.effect = 'grant' AND h.module = w.module AND h.feature = w.feature
                    AND (h.action = w.action OR h.action_class = w.action_class))
  END;
$$;

REVOKE ALL ON FUNCTION public.has_explicit_permission(text, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.has_explicit_permission(text, text, text) TO authenticated, service_role;

DROP POLICY IF EXISTS menu_items_manage ON public.menu_items;
CREATE POLICY menu_items_manage ON public.menu_items
FOR ALL TO authenticated
USING (
  in_my_config_scope(organization_id, branch_id)
  AND (public.has_explicit_permission('pos', 'menu', 'manage')
    OR public.has_explicit_permission('pos', 'settings', 'manage'))
)
WITH CHECK (
  in_my_config_scope(organization_id, branch_id)
  AND (public.has_explicit_permission('pos', 'menu', 'manage')
    OR public.has_explicit_permission('pos', 'settings', 'manage'))
);