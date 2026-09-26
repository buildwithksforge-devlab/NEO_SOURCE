INSERT INTO public.role_permissions (organization_id, role_id, permission_id)
SELECT r.organization_id, r.id, p.id
FROM public.roles r
CROSS JOIN public.permissions p
WHERE r.name = 'Owner'
  AND NOT EXISTS (
    SELECT 1 FROM public.role_permissions rp
    WHERE rp.role_id = r.id AND rp.permission_id = p.id
  );

WITH removed AS (
  DELETE FROM public.user_roles ur
  USING public.roles r, public.role_catalogue rc
  WHERE ur.role_id = r.id
    AND r.name = rc.role_name
    AND rc.restricted_authority
    AND ur.is_primary = false
    AND EXISTS (
      SELECT 1 FROM public.user_roles pu
      WHERE pu.user_id = ur.user_id AND pu.is_primary = true AND pu.role_id <> ur.role_id
    )
  RETURNING ur.user_id, r.name AS role_name
)
INSERT INTO public.audit_logs (organization_id, user_id, user_name, action, module, record_id, previous_value, reason)
SELECT p.organization_id, removed.user_id, p.full_name,
       'role.unassign', 'roles', removed.user_id::text,
       jsonb_build_object('role', removed.role_name),
       'Unintended restricted-authority assignment removed: the account holds a different primary role.'
FROM removed
JOIN public.profiles p ON p.id = removed.user_id;

WITH target AS (
  SELECT p.id AS user_id, d.id AS department_id
  FROM public.profiles p
  JOIN public.user_roles ur ON ur.user_id = p.id AND ur.is_primary
  JOIN public.roles r ON r.id = ur.role_id
  JOIN public.role_catalogue rc ON rc.role_name = r.name
  JOIN public.departments d
    ON d.organization_id = p.organization_id AND lower(d.name) = lower(rc.department)
  WHERE p.department_id IS DISTINCT FROM d.id
)
UPDATE public.profiles p
SET department_id = target.department_id
FROM target
WHERE p.id = target.user_id;