CREATE OR REPLACE VIEW public.role_permissions
WITH (security_invoker = true) AS
  SELECT DISTINCT ON (x.role_id, x.permission_id)
         uuid_in(md5(x.role_id::text || x.permission_id::text)::cstring) AS id,
         x.organization_id, x.role_id, x.permission_id, x.created_at, x.source
    FROM (
      SELECT b.organization_id, b.role_id, b.permission_id, b.created_at, b.source, 0 AS rank
        FROM public.role_permissions_base b
      UNION ALL
      SELECT o.organization_id, o.role_id, o.permission_id, o.created_at, o.source, 1
        FROM public.role_permission_overrides o
       WHERE o.effect = 'grant'
      UNION ALL
      SELECT r.organization_id, r.id, p.id, r.created_at, 'template'::text, 2
        FROM public.roles r
        JOIN public.role_feature_templates t ON t.role_key = r.template_key
        JOIN public.permissions p
          ON p.module = t.module AND p.feature = t.feature AND p.action = t.action
       WHERE r.follows_template
    ) x
   WHERE NOT EXISTS (
     SELECT 1 FROM public.role_permission_overrides d
      WHERE d.role_id = x.role_id AND d.permission_id = x.permission_id AND d.effect = 'deny')
   ORDER BY x.role_id, x.permission_id, x.rank;