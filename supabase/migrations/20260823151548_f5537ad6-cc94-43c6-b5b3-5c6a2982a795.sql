-- Purchase-order approval is gated on procurement|lpos|approve, which the
-- Procurement Manager template did not carry, so approved requisitions could
-- never become live purchase orders.
INSERT INTO public.role_permission_templates (version, template_name, template_key, module, action)
SELECT 1, 'Procurement Manager', 'procurement-manager', 'procurement', 'lpos.approve'
WHERE NOT EXISTS (
  SELECT 1 FROM public.role_permission_templates t
   WHERE t.template_key = 'procurement-manager' AND t.module = 'procurement' AND t.action = 'lpos.approve'
);

INSERT INTO public.role_permissions (organization_id, role_id, permission_id)
SELECT r.organization_id, r.id, p.id
FROM public.roles r
JOIN public.permissions p ON p.module = 'procurement' AND p.feature = 'lpos' AND p.action = 'approve'
WHERE lower(r.name) = 'procurement manager'
ON CONFLICT DO NOTHING;