CREATE OR REPLACE FUNCTION public.neo_delivery_dispatch_candidates(_order uuid)
 RETURNS TABLE(rider_id uuid, rider_code text, display_name text, vehicle_type text, availability_status text, active_load integer, max_active integer, on_shift boolean, next_shift timestamp with time zone, delivered_today integer, cash_handling_allowed boolean, eligible boolean, reasons text[])
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE _org uuid := public.current_org_id(); _o public.delivery_orders; _cash boolean;
BEGIN
  IF _org IS NULL THEN RETURN; END IF;
  IF NOT (public.has_permission('delivery','dispatch.assign')
          OR public.has_permission('delivery','riders.manage')
          OR public.is_org_admin()) THEN
    RAISE EXCEPTION 'insufficient_privilege' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO _o FROM public.delivery_orders WHERE id = _order AND organization_id = _org;
  IF _o.id IS NULL THEN RETURN; END IF;
  IF NOT public.neo_branch_in_scope(_o.branch_id) THEN
    RAISE EXCEPTION 'That order is outside your access scope.' USING ERRCODE = '42501';
  END IF;

  _cash := coalesce(_o.payment_method,'') IN ('cash','cash-on-delivery','cod')
           AND coalesce(_o.payment_status,'') <> 'paid';

  RETURN QUERY
  WITH base AS (
    SELECT r.*,
      (SELECT count(*) FROM public.delivery_orders o
        WHERE o.rider_id = r.id
          AND o.order_status NOT IN ('delivered','cancelled','rejected','failed'))::int AS load,
      EXISTS (SELECT 1 FROM public.rider_shifts s
               WHERE s.rider_id = r.id AND s.status IN ('scheduled','active')
                 AND now() BETWEEN s.starts_at AND s.ends_at) AS shift_now,
      (SELECT min(s.starts_at) FROM public.rider_shifts s
        WHERE s.rider_id = r.id AND s.status = 'scheduled' AND s.starts_at > now()) AS next_start,
      (SELECT count(*) FROM public.delivery_orders o
        WHERE o.rider_id = r.id AND o.delivered_at >= date_trunc('day', now()))::int AS today,
      EXISTS (SELECT 1 FROM public.profiles p
               WHERE p.id = r.profile_id
                 AND coalesce(p.account_status,'active') = 'active'
                 AND coalesce(p.employment_status,'active') NOT IN ('terminated','resigned','suspended','inactive')) AS account_live,
      public.neo_rider_holds_capability(r.profile_id, _org) AS capability_held
    FROM public.rider_profiles r
    WHERE r.organization_id = _org
  ), judged AS (
    SELECT b.*, (
      ARRAY[]::text[]
      || CASE WHEN b.active IS NOT TRUE THEN ARRAY['Retired from the roster'] ELSE '{}'::text[] END
      || CASE WHEN b.profile_id IS NULL THEN ARRAY['No linked staff account'] ELSE '{}'::text[] END
      || CASE WHEN b.profile_id IS NOT NULL AND NOT b.account_live
              THEN ARRAY['Staff account is inactive'] ELSE '{}'::text[] END
      || CASE WHEN b.profile_id IS NOT NULL AND NOT b.capability_held
              THEN ARRAY['Staff account does not hold the Rider capability'] ELSE '{}'::text[] END
      || CASE WHEN b.branch_id IS NOT NULL AND _o.branch_id IS NOT NULL AND b.branch_id <> _o.branch_id
              THEN ARRAY['Assigned to a different property'] ELSE '{}'::text[] END
      || CASE WHEN NOT b.shift_now THEN ARRAY['Not on an active shift'] ELSE '{}'::text[] END
      || CASE WHEN coalesce(b.availability_status,'offline') <> 'available'
              THEN ARRAY['Rider is ' || coalesce(b.availability_status,'offline')] ELSE '{}'::text[] END
      || CASE WHEN b.load >= coalesce(b.max_active_deliveries, 3)
              THEN ARRAY['At the active delivery ceiling'] ELSE '{}'::text[] END
      || CASE WHEN _cash AND b.cash_handling_allowed IS NOT TRUE
              THEN ARRAY['Not cleared to carry cash'] ELSE '{}'::text[] END
    ) AS why
    FROM base b
  )
  SELECT j.id, j.rider_code, j.display_name, j.vehicle_type, j.availability_status,
         j.load, coalesce(j.max_active_deliveries, 3), j.shift_now, j.next_start, j.today,
         j.cash_handling_allowed, cardinality(j.why) = 0, j.why
    FROM judged j
   WHERE public.neo_branch_in_scope(j.branch_id)
   ORDER BY cardinality(j.why), j.load, j.display_name;
END $function$;

CREATE OR REPLACE FUNCTION public.neo_delivery_rider_candidates(_branch uuid DEFAULT NULL::uuid)
 RETURNS TABLE(profile_id uuid, full_name text, staff_id text, job_title text, branch_id uuid, role_names text[], rider_profile_id uuid, rider_code text, rider_active boolean)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
     AND coalesce(p.employment_status,'active') NOT IN ('terminated','resigned','suspended','inactive')
     AND public.neo_branch_in_scope(coalesce(e.branch_id, p.branch_id))
     AND (_branch IS NULL OR coalesce(e.branch_id, p.branch_id) IS NULL
          OR coalesce(e.branch_id, p.branch_id) = _branch)
   ORDER BY p.full_name;
END $function$;

REVOKE ALL ON FUNCTION public.neo_delivery_dispatch_candidates(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.neo_delivery_rider_candidates(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.neo_delivery_dispatch_candidates(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.neo_delivery_rider_candidates(uuid) TO authenticated;