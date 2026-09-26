INSERT INTO public.role_permissions (organization_id, role_id, permission_id)
SELECT r.organization_id, r.id, p.id
FROM public.roles r
JOIN public.permissions p ON p.module='finance' AND p.feature='receivables' AND p.action='view'
WHERE r.id = '18a19410-c9b3-4365-a58b-8644e7f8b02f'
ON CONFLICT DO NOTHING;