INSERT INTO public.permission_key_aliases (alias_module, alias_action, canonical_module, canonical_feature, canonical_action)
VALUES
  ('finance-payments','open_shift','restaurant','shifts','create'),
  ('finance-payments','close_shift','restaurant','shifts','edit'),
  ('finance-payments','count_cash','restaurant','shifts','edit'),
  ('finance-payments','receive_payment','front-office','folios','create')
ON CONFLICT DO NOTHING;

INSERT INTO public.role_permissions (organization_id, role_id, permission_id)
SELECT DISTINCT r.organization_id, r.id, p.id
  FROM public.roles r
  JOIN public.role_permission_templates t
    ON t.version = 1
   AND t.template_key IN (coalesce(r.normalized_role_key, ''),
                          public.neo_norm_key(r.name),
                          lower(r.name))
  CROSS JOIN LATERAL public.canonical_permission(t.module, '*', t.action) c
  JOIN public.permissions p
    ON p.module = c.module AND p.feature = c.feature AND p.action = c.action
 WHERE r.role_status IN ('active','custom')
   AND NOT EXISTS (SELECT 1 FROM public.role_permissions rp
                    WHERE rp.role_id = r.id AND rp.permission_id = p.id);