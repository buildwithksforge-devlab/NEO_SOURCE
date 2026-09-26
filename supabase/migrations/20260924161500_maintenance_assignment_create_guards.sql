-- NEØ certification hardening: maintenance assignment picker and nullable cost estimate.

ALTER TABLE public.maintenance_work_orders
  ALTER COLUMN cost_estimate SET DEFAULT 0;

CREATE OR REPLACE FUNCTION public.neo_maintenance_cost_default()
RETURNS trigger
LANGUAGE plpgsql
SET search_path=public
AS $$
BEGIN
  NEW.cost_estimate := COALESCE(NEW.cost_estimate,0);
  RETURN NEW;
END; $$;

DROP TRIGGER IF EXISTS neo_maintenance_cost_default_trg ON public.maintenance_work_orders;
CREATE TRIGGER neo_maintenance_cost_default_trg
BEFORE INSERT OR UPDATE OF cost_estimate ON public.maintenance_work_orders
FOR EACH ROW EXECUTE FUNCTION public.neo_maintenance_cost_default();

CREATE OR REPLACE FUNCTION public.neo_maintenance_technicians(_branch uuid)
RETURNS TABLE(
  id uuid,
  full_name text,
  staff_id text,
  job_title text,
  department_id uuid,
  department_name text,
  branch_id uuid,
  branch_name text
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path=public
AS $$
  SELECT
    e.profile_id AS id,
    COALESCE(NULLIF(e.full_name,''),p.full_name) AS full_name,
    COALESCE(NULLIF(e.employee_number,''),p.staff_id) AS staff_id,
    COALESCE(NULLIF(e.job_title,''),p.job_title) AS job_title,
    e.department_id,
    d.name AS department_name,
    e.branch_id,
    b.name AS branch_name
  FROM public.employees e
  JOIN public.profiles p
    ON p.id=e.profile_id
   AND p.organization_id=e.organization_id
  LEFT JOIN public.departments d
    ON d.id=e.department_id AND d.organization_id=e.organization_id
  LEFT JOIN public.branches b
    ON b.id=e.branch_id AND b.organization_id=e.organization_id
  WHERE e.organization_id=public.current_org_id()
    AND e.branch_id=_branch
    AND COALESCE(e.employment_status,'active') NOT IN ('terminated','inactive','separated')
    AND COALESCE(p.account_status,'active')='active'
    AND (lower(COALESCE(d.name,'')) LIKE 'maintenance%'
         OR EXISTS (
           SELECT 1 FROM public.user_roles ur
           JOIN public.roles r ON r.id=ur.role_id AND r.organization_id=e.organization_id
           WHERE ur.user_id=e.profile_id AND ur.organization_id=e.organization_id
             AND COALESCE(r.normalized_role_key,r.template_key,'') IN
               ('maintenance-manager','maintenance-officer','maintenance-technician')
         ))
    AND public.neo_maintenance_technician_eligible(e.profile_id,e.organization_id,_branch)
  ORDER BY COALESCE(NULLIF(e.full_name,''),p.full_name);
$$;

REVOKE ALL ON FUNCTION public.neo_maintenance_technicians(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.neo_maintenance_technicians(uuid) TO authenticated, service_role;
