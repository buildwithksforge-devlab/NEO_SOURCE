-- 1. Scoped, capability-guarded rider directory for dispatch/shift selectors.
CREATE OR REPLACE FUNCTION public.neo_delivery_rider_directory(_branch uuid DEFAULT NULL)
RETURNS TABLE(
  rider_id uuid,
  rider_code text,
  display_name text,
  vehicle_type text,
  availability_status text,
  branch_id uuid,
  active boolean,
  active_load integer,
  max_active integer,
  on_shift boolean
)
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE _org uuid := public.current_org_id();
BEGIN
  IF _org IS NULL THEN RETURN; END IF;
  IF NOT (public.has_permission('delivery','dispatch.assign')
          OR public.has_permission('delivery','riders.manage')
          OR public.is_org_admin()) THEN
    RAISE EXCEPTION 'insufficient_privilege' USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
  SELECT r.id,
         r.rider_code,
         r.display_name,
         r.vehicle_type,
         r.availability_status,
         r.branch_id,
         coalesce(r.active, false),
         (SELECT count(*) FROM public.delivery_orders o
           WHERE o.rider_id = r.id
             AND o.order_status NOT IN ('delivered','cancelled','rejected','failed'))::int,
         coalesce(r.max_active_deliveries, 3),
         EXISTS (SELECT 1 FROM public.rider_shifts s
                  WHERE s.rider_id = r.id AND s.status IN ('scheduled','active')
                    AND now() BETWEEN s.starts_at AND s.ends_at)
    FROM public.rider_profiles r
   WHERE r.organization_id = _org
     AND public.neo_branch_in_scope(r.branch_id)
     AND (_branch IS NULL OR r.branch_id IS NULL OR r.branch_id = _branch)
   ORDER BY coalesce(r.active,false) DESC, r.display_name;
END $$;

REVOKE ALL ON FUNCTION public.neo_delivery_rider_directory(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.neo_delivery_rider_directory(uuid) TO authenticated, service_role;

-- 2. Rider enrolment candidates: raise on missing capability instead of silently
--    returning nothing, enforce property scope, and drop unused contact details.
DROP FUNCTION IF EXISTS public.neo_delivery_rider_candidates(uuid);

CREATE OR REPLACE FUNCTION public.neo_delivery_rider_candidates(_branch uuid DEFAULT NULL)
RETURNS TABLE(
  profile_id uuid,
  full_name text,
  staff_id text,
  job_title text,
  branch_id uuid,
  role_names text[],
  rider_profile_id uuid,
  rider_code text,
  rider_active boolean
)
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE _org uuid := public.current_org_id();
BEGIN
  IF _org IS NULL THEN RETURN; END IF;
  IF NOT (public.has_permission('delivery','riders.manage') OR public.is_org_admin()) THEN
    RAISE EXCEPTION 'insufficient_privilege' USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
  WITH rider_staff AS (
    SELECT ur.user_id,
           array_agg(DISTINCT r.name ORDER BY r.name) AS role_names
    FROM public.user_roles ur
    JOIN public.roles r ON r.id = ur.role_id AND coalesce(r.active, true)
    WHERE ur.organization_id = _org
      AND (
        lower(coalesce(r.normalized_role_key,'')) IN ('rider','driver')
        OR EXISTS (
          SELECT 1
          FROM public.role_permissions rp
          JOIN public.permissions p ON p.id = rp.permission_id
          WHERE rp.role_id = r.id
            AND p.module = 'delivery'
            AND p.action LIKE 'rider.%'
        )
      )
    GROUP BY ur.user_id
  )
  SELECT p.id,
         p.full_name,
         p.staff_id,
         coalesce(e.job_title, p.job_title),
         coalesce(e.branch_id, p.branch_id),
         rs.role_names,
         rp.id,
         rp.rider_code,
         rp.active
    FROM rider_staff rs
    JOIN public.profiles p ON p.id = rs.user_id
    LEFT JOIN public.employees e ON e.profile_id = p.id AND e.organization_id = p.organization_id
    LEFT JOIN public.rider_profiles rp ON rp.profile_id = p.id AND rp.organization_id = p.organization_id
   WHERE p.organization_id = _org
     AND coalesce(p.account_type,'staff') = 'staff'
     AND coalesce(p.account_status,'active') = 'active'
     AND coalesce(p.is_active, true)
     AND public.neo_branch_in_scope(coalesce(e.branch_id, p.branch_id))
     AND (_branch IS NULL OR coalesce(e.branch_id, p.branch_id) IS NULL
          OR coalesce(e.branch_id, p.branch_id) = _branch)
   ORDER BY p.full_name;
END $$;

REVOKE ALL ON FUNCTION public.neo_delivery_rider_candidates(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.neo_delivery_rider_candidates(uuid) TO authenticated, service_role;