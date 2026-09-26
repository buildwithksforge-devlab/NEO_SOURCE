CREATE OR REPLACE FUNCTION public.role_permission_ids(_role uuid)
RETURNS TABLE(permission_id uuid)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
  SELECT DISTINCT x.permission_id
  FROM (
    SELECT b.permission_id FROM public.role_permissions_base b WHERE b.role_id = _role
    UNION
    SELECT o.permission_id FROM public.role_permission_overrides o
      WHERE o.role_id = _role AND o.effect = 'grant'
    UNION
    SELECT p.id
      FROM public.roles r
      JOIN public.role_feature_templates t ON t.role_key = r.template_key
      JOIN public.permissions p ON p.module = t.module AND p.feature = t.feature AND p.action = t.action
     WHERE r.id = _role AND r.follows_template
  ) x
  WHERE NOT EXISTS (
    SELECT 1 FROM public.role_permission_overrides d
     WHERE d.role_id = _role AND d.permission_id = x.permission_id AND d.effect = 'deny'
  );
$$;

REVOKE ALL ON FUNCTION public.role_permission_ids(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.role_permission_ids(uuid) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.has_permission(_module text, _feature text, _action text)
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
    FROM public.user_permissions up JOIN public.permissions p ON p.id=up.permission_id,
         LATERAL public.canonical_permission(p.module,p.feature,p.action) c
    WHERE up.user_id=auth.uid() AND up.effect='deny' AND up.organization_id=public.current_org_id()
    UNION ALL
    SELECT c.module,c.feature,c.action,public.permission_action_class(c.action),'grant'
    FROM public.user_roles ur
    JOIN public.roles r ON r.id=ur.role_id AND r.active,
         LATERAL public.role_permission_ids(r.id) rpi
    JOIN public.permissions p ON p.id=rpi.permission_id,
         LATERAL public.canonical_permission(p.module,p.feature,p.action) c
    WHERE ur.user_id=auth.uid() AND ur.organization_id=public.current_org_id()
      AND r.organization_id=public.current_org_id()
    UNION ALL
    SELECT c.module,c.feature,c.action,public.permission_action_class(c.action),'grant'
    FROM public.user_permissions up JOIN public.permissions p ON p.id=up.permission_id,
         LATERAL public.canonical_permission(p.module,p.feature,p.action) c
    WHERE up.user_id=auth.uid() AND up.effect='grant' AND up.organization_id=public.current_org_id()
  )
  SELECT CASE
    WHEN NOT public.is_active_staff() THEN false
    WHEN public.is_org_admin() THEN true
    WHEN EXISTS (
      SELECT 1 FROM held h,want w WHERE h.effect='deny' AND h.module=w.module
        AND (w.feature='*' OR h.feature IN (w.feature,'*'))
        AND (h.action=w.action OR h.action_class=w.action_class)
    ) THEN false
    ELSE EXISTS (
      SELECT 1 FROM held h,want w WHERE h.effect='grant' AND h.module=w.module
        AND (w.feature='*' OR h.feature IN (w.feature,'*'))
        AND (h.action=w.action OR h.action_class=w.action_class)
    )
  END;
$$;