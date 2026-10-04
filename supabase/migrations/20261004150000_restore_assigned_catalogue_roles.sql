-- Restore legitimate catalogue roles that are still assigned to active staff.
--
-- Effective access intentionally ignores archived roles. These catalogue roles
-- still hold their compiled permissions and are still assigned to workers, so
-- leaving them archived strands those workers at "No role assigned".
--
-- Do not weaken neo_build_effective_access(). Repair the role records instead.

WITH restored AS (
  UPDATE public.roles r
     SET active = true,
         role_status = 'active',
         updated_at = now()
   WHERE r.normalized_role_key IN (
     'night-auditor',
     'maintenance-technician',
     'procurement-officer'
   )
     AND EXISTS (
       SELECT 1
         FROM public.user_roles ur
        WHERE ur.role_id = r.id
          AND ur.organization_id = r.organization_id
     )
     AND (
       r.active IS DISTINCT FROM true
       OR r.role_status = 'archived'
     )
  RETURNING r.id, r.organization_id
),
affected_users AS (
  SELECT DISTINCT ur.user_id
    FROM public.user_roles ur
    JOIN restored r
      ON r.id = ur.role_id
     AND r.organization_id = ur.organization_id
)
DELETE FROM public.user_access_snapshots s
USING affected_users a
WHERE s.user_id = a.user_id;

NOTIFY pgrst, 'reload schema';