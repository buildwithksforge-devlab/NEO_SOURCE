-- Bar Attendant roles are defined to sell at the bar, but the selling screen
-- was gated on a non-existent `bar.sell` feature, so the grant never compiled.
-- Add the catalogued bar/pos view+create+edit permissions additively.
INSERT INTO public.role_permissions (organization_id, role_id, permission_id, source)
SELECT r.organization_id, r.id, p.id, 'template'
FROM public.roles r
JOIN public.permissions p
  ON p.module = 'bar' AND p.feature = 'pos' AND p.action IN ('view','create','edit')
WHERE lower(r.name) = 'bar attendant'
  AND NOT EXISTS (
    SELECT 1 FROM public.role_permissions rp
    WHERE rp.role_id = r.id AND rp.permission_id = p.id
  );