
-- Kitchen production roles could accept and prepare tickets but were never granted
-- the two screens that show them: the live queue and their own station. Add the
-- missing features to the role templates, then reconcile existing organisations.
INSERT INTO public.role_feature_templates (role_key, module, feature, action)
SELECT rk.role_key, 'kitchen', f.feature, a.action
FROM (VALUES ('chef'),('hot-kitchen-chef'),('pastry-chef'),('head-chef'),('head-pastry-chef'),('sous-chef'),('cold-kitchen-chef'),('grill-chef'),('commis-chef'),('line-cook'),('baker')) AS rk(role_key)
CROSS JOIN (VALUES ('queue'),('my-station')) AS f(feature)
CROSS JOIN (VALUES ('view'),('edit')) AS a(action)
WHERE EXISTS (SELECT 1 FROM public.role_feature_templates t WHERE t.role_key = rk.role_key)
  AND NOT EXISTS (
    SELECT 1 FROM public.role_feature_templates t
    WHERE t.role_key = rk.role_key AND t.module = 'kitchen'
      AND t.feature = f.feature AND t.action = a.action
  );

-- Existing roles in every organisation pick the same two screens up.
INSERT INTO public.role_permissions_base (organization_id, role_id, permission_id, source)
SELECT r.organization_id, r.id, p.id, 'template'
FROM public.roles r
JOIN public.permissions p
  ON p.module = 'kitchen' AND p.feature IN ('queue','my-station') AND p.action IN ('view','edit')
WHERE EXISTS (
    SELECT 1 FROM public.role_permissions_base b
    JOIN public.permissions bp ON bp.id = b.permission_id
    WHERE b.role_id = r.id AND bp.module = 'kitchen' AND bp.feature = 'production'
  )
  AND NOT EXISTS (
    SELECT 1 FROM public.role_permissions_base b2 WHERE b2.role_id = r.id AND b2.permission_id = p.id
  );
