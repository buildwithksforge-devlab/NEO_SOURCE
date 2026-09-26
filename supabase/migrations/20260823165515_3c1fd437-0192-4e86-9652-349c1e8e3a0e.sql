INSERT INTO public.role_permissions (organization_id, role_id, permission_id, source)
SELECT r.organization_id, r.id, p.id, 'certification'
FROM public.roles r
JOIN public.permissions p ON (p.module, p.feature, p.action) = ('events','billing','view')
WHERE lower(btrim(r.name)) IN ('events manager','sales and events manager','banqueting manager')
  AND NOT EXISTS (SELECT 1 FROM public.role_permissions rp WHERE rp.role_id=r.id AND rp.permission_id=p.id);

DROP TABLE IF EXISTS public.neo_cert_results;