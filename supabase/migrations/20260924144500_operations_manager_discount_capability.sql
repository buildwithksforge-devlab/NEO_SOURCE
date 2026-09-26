-- Operations Manager may execute configured discounts up to the server-enforced
-- 15% ceiling. The ceiling itself is enforced by neo_pos_apply_discount; this
-- migration only restores the base UI/RBAC capabilities needed to reach it.
INSERT INTO public.role_permissions (organization_id, role_id, permission_id, source)
SELECT r.organization_id, r.id, p.id, 'template'
FROM public.roles r
JOIN public.permissions p
  ON p.module = 'pos'
 AND p.feature = '*'
 AND p.action IN ('discount.execute','discount.approve')
WHERE r.active IS TRUE
  AND public.neo_resolve_role_template_key(r.normalized_role_key, r.name) = 'operations-manager'
ON CONFLICT DO NOTHING;
