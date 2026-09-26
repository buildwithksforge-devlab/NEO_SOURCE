-- Ordinary housekeepers keep only precise, feature-qualified authority.
-- Supervisors and managers are untouched.
DELETE FROM public.role_permissions rp
 USING public.roles r, public.permissions p
 WHERE rp.role_id = r.id
   AND rp.permission_id = p.id
   AND lower(r.name) IN ('housekeeper', 'room attendant', 'housekeeping attendant')
   AND (
     -- Catch-all housekeeping grants: superseded by the feature-qualified set.
     (p.module = 'housekeeping' AND p.action IN ('view', 'manage', 'start', 'complete'))
     -- Stores requisitions belong to the supervisor; the housekeeper reports a need.
     OR (p.module = 'stores' AND p.action IN ('create', 'submit', 'record', 'edit', 'approve'))
   );