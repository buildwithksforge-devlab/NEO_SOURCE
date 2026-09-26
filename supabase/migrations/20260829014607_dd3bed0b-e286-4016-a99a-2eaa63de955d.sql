-- The personal Housekeeping surface lets a cleaner report a supply need.
-- The backing routine (neo_department_stock_need_create) only requires active
-- staff, and it deliberately does NOT create a Stores requisition. This adds
-- the exact, minimal capability for that subordinate action so the button is
-- never gated behind stores.requisition.create/submit.

INSERT INTO public.permissions (module, feature, action, label)
SELECT 'housekeeping', '*', 'supply-need.report', 'Report a Supply Need'
WHERE NOT EXISTS (
  SELECT 1 FROM public.permissions
  WHERE module = 'housekeeping' AND feature = '*' AND action = 'supply-need.report'
);

INSERT INTO public.role_permission_templates (version, template_name, template_key, module, action)
SELECT t.version, t.template_name, t.template_key, 'housekeeping', 'supply-need.report'
FROM (
  SELECT DISTINCT version, template_name, template_key
  FROM public.role_permission_templates
  WHERE template_key IN ('housekeeper', 'housekeeping-supervisor', 'housekeeping-manager')
) t
WHERE NOT EXISTS (
  SELECT 1 FROM public.role_permission_templates x
  WHERE x.template_key = t.template_key
    AND x.version = t.version
    AND x.module = 'housekeeping'
    AND x.action = 'supply-need.report'
);

INSERT INTO public.role_permissions (organization_id, role_id, permission_id, source)
SELECT r.organization_id, r.id, p.id, 'template'
FROM public.roles r
CROSS JOIN public.permissions p
WHERE p.module = 'housekeeping' AND p.feature = '*' AND p.action = 'supply-need.report'
  AND r.normalized_role_key IN ('housekeeper', 'housekeeping-supervisor', 'housekeeping-manager')
  AND NOT EXISTS (
    SELECT 1 FROM public.role_permissions rp
    WHERE rp.role_id = r.id AND rp.permission_id = p.id
  );
