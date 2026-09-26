-- Kitchen roles that work a station or the queue must be able to move a ticket.
WITH kitchen_roles AS (
  SELECT DISTINCT role_key
    FROM public.role_feature_templates
   WHERE module = 'kitchen'
     AND feature IN ('my-station', 'queue', 'production')
), acts(action) AS (VALUES ('ticket.accept'), ('item.prepare'), ('item.ready'))
INSERT INTO public.role_feature_templates (role_key, module, feature, action)
SELECT k.role_key, 'kitchen', '*', a.action
  FROM kitchen_roles k CROSS JOIN acts a
 WHERE NOT EXISTS (
   SELECT 1 FROM public.role_feature_templates ft
    WHERE ft.role_key = k.role_key AND ft.module = 'kitchen' AND ft.feature = '*' AND ft.action = a.action
 );

-- Grant them to the live roles that already match those templates.
INSERT INTO public.role_permissions (organization_id, role_id, permission_id, source)
SELECT r.organization_id, r.id, p.id, 'template'
  FROM public.roles r
  JOIN public.role_feature_templates ft
    ON ft.role_key = public.neo_resolve_role_template_key(r.normalized_role_key, r.name)
   AND ft.module = 'kitchen' AND ft.feature = '*'
   AND ft.action IN ('ticket.accept', 'item.prepare', 'item.ready')
  JOIN public.permissions p
    ON p.module = ft.module AND p.feature = ft.feature AND p.action = ft.action
 WHERE coalesce(r.active, true)
   AND NOT EXISTS (
     SELECT 1 FROM public.role_permissions rp WHERE rp.role_id = r.id AND rp.permission_id = p.id
   );