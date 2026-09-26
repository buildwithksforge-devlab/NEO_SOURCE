-- A Procurement Manager must be able to approve requisitions and purchase
-- orders. The template only carried the *.manage keys, which do not imply the
-- restricted approve action, so approvals were impossible for every tenant.
INSERT INTO public.role_permission_templates (version, template_name, template_key, module, action)
SELECT 1, 'Procurement Manager', 'procurement-manager', 'procurement', v.a
FROM (VALUES ('requests.approve'), ('orders.approve')) v(a)
WHERE NOT EXISTS (
  SELECT 1 FROM public.role_permission_templates t
   WHERE t.template_key = 'procurement-manager' AND t.module = 'procurement' AND t.action = v.a
);

INSERT INTO public.role_permissions (organization_id, role_id, permission_id)
SELECT r.organization_id, r.id, p.id
FROM public.roles r
JOIN public.permissions p
  ON p.module = 'procurement'
 AND p.feature IN ('requests', 'orders')
 AND p.action = 'approve'
WHERE lower(r.name) = 'procurement manager'
ON CONFLICT DO NOTHING;