-- 1. Feature templates: rider self-service capabilities + delivery manager roster authority
INSERT INTO public.role_feature_templates (role_key, module, feature, action) VALUES
  ('rider','delivery','*','rider.availability'),
  ('rider','delivery','*','rider.assignment.view'),
  ('rider','delivery','*','rider.assignment.accept'),
  ('rider','delivery','*','rider.assignment.reject'),
  ('rider','delivery','*','rider.pickup'),
  ('rider','delivery','*','rider.start'),
  ('rider','delivery','*','rider.attempt'),
  ('rider','delivery','*','rider.confirm'),
  ('rider','delivery','*','rider.proof'),
  ('rider','delivery','*','rider.cash'),
  ('rider','delivery','*','rider.issue'),
  ('rider','delivery','*','orders.view-own'),
  ('delivery-manager','delivery','*','riders.manage'),
  ('delivery-manager','delivery','*','dispatch.view'),
  ('delivery-manager','delivery','*','dispatch.assign'),
  ('delivery-manager','delivery','*','dispatch.reassign'),
  ('delivery-manager','delivery','*','dispatch.eta'),
  ('delivery-manager','delivery','*','dispatch.rider-location'),
  ('delivery-manager','delivery','*','dispatch.contact-rider'),
  ('delivery-manager','delivery','*','orders.view'),
  ('delivery-manager','delivery','*','zones.view')
ON CONFLICT (role_key, module, feature, action) DO NOTHING;

-- 2. Candidates: staff holding a rider capability, with roster linkage state
CREATE OR REPLACE FUNCTION public.neo_delivery_rider_candidates(_branch uuid DEFAULT NULL)
RETURNS TABLE (
  profile_id uuid,
  employee_id uuid,
  full_name text,
  staff_id text,
  job_title text,
  phone text,
  branch_id uuid,
  role_names text[],
  rider_profile_id uuid,
  rider_code text,
  rider_active boolean
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH guard AS (
    SELECT CASE WHEN public.has_permission('delivery','riders.manage') THEN public.current_org_id()
                ELSE NULL::uuid END AS org
  ),
  rider_staff AS (
    SELECT ur.user_id,
           array_agg(DISTINCT r.name ORDER BY r.name) AS role_names
    FROM public.user_roles ur
    JOIN public.roles r ON r.id = ur.role_id AND coalesce(r.active, true)
    WHERE ur.organization_id = (SELECT org FROM guard)
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
         e.id,
         p.full_name,
         p.staff_id,
         coalesce(e.job_title, p.job_title),
         coalesce(e.phone, p.phone),
         coalesce(e.branch_id, p.branch_id),
         rs.role_names,
         rp.id,
         rp.rider_code,
         rp.active
  FROM rider_staff rs
  JOIN public.profiles p ON p.id = rs.user_id
  LEFT JOIN public.employees e ON e.profile_id = p.id AND e.organization_id = p.organization_id
  LEFT JOIN public.rider_profiles rp ON rp.profile_id = p.id AND rp.organization_id = p.organization_id
  WHERE p.organization_id = (SELECT org FROM guard)
    AND coalesce(p.account_type,'staff') = 'staff'
    AND coalesce(p.account_status,'active') = 'active'
    AND (_branch IS NULL OR coalesce(e.branch_id, p.branch_id) IS NULL OR coalesce(e.branch_id, p.branch_id) = _branch)
  ORDER BY p.full_name;
$$;

-- 3. Roster: rider profiles with their staff linkage status
CREATE OR REPLACE FUNCTION public.neo_delivery_rider_roster(_branch uuid DEFAULT NULL)
RETURNS TABLE (
  id uuid,
  rider_code text,
  display_name text,
  availability_status text,
  vehicle_type text,
  vehicle_registration text,
  work_phone text,
  max_active_deliveries integer,
  cash_handling_allowed boolean,
  active boolean,
  branch_id uuid,
  profile_id uuid,
  employee_id uuid,
  staff_id text,
  staff_name text,
  staff_account_status text,
  holds_rider_capability boolean,
  linkage_status text,
  active_orders integer
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH org AS (
    SELECT CASE WHEN public.is_staff() THEN public.current_org_id() ELSE NULL::uuid END AS id
  )
  SELECT rp.id,
         rp.rider_code,
         rp.display_name,
         rp.availability_status,
         rp.vehicle_type,
         rp.vehicle_registration,
         rp.work_phone,
         rp.max_active_deliveries,
         rp.cash_handling_allowed,
         rp.active,
         rp.branch_id,
         rp.profile_id,
         rp.employee_id,
         p.staff_id,
         p.full_name,
         p.account_status,
         cap.held,
         CASE
           WHEN rp.profile_id IS NULL THEN 'unlinked'
           WHEN p.id IS NULL THEN 'missing-account'
           WHEN coalesce(p.account_status,'active') <> 'active' THEN 'account-inactive'
           WHEN NOT cap.held THEN 'capability-missing'
           ELSE 'linked'
         END,
         coalesce(o.active_orders, 0)::integer
  FROM public.rider_profiles rp
  LEFT JOIN public.profiles p ON p.id = rp.profile_id
  LEFT JOIN LATERAL (
    SELECT EXISTS (
      SELECT 1
      FROM public.user_roles ur
      JOIN public.roles r ON r.id = ur.role_id AND coalesce(r.active, true)
      WHERE ur.user_id = rp.profile_id
        AND ur.organization_id = rp.organization_id
        AND (
          lower(coalesce(r.normalized_role_key,'')) IN ('rider','driver')
          OR EXISTS (
            SELECT 1 FROM public.role_permissions x
            JOIN public.permissions pm ON pm.id = x.permission_id
            WHERE x.role_id = r.id AND pm.module = 'delivery' AND pm.action LIKE 'rider.%'
          )
        )
    ) AS held
  ) cap ON true
  LEFT JOIN LATERAL (
    SELECT count(*) AS active_orders
    FROM public.delivery_orders d
    WHERE d.rider_id = rp.id
      AND coalesce(d.order_status,'') NOT IN ('delivered','cancelled','failed','rejected')
  ) o ON true
  WHERE rp.organization_id = (SELECT id FROM org)
    AND (_branch IS NULL OR rp.branch_id IS NULL OR rp.branch_id = _branch)
  ORDER BY rp.active DESC, rp.display_name;
$$;

-- 4. Enrol a staff member onto the roster
CREATE OR REPLACE FUNCTION public.neo_delivery_rider_enrol(
  _profile uuid,
  _branch uuid DEFAULT NULL,
  _vehicle_type text DEFAULT 'motorcycle',
  _vehicle_registration text DEFAULT NULL,
  _work_phone text DEFAULT NULL,
  _max_active integer DEFAULT 3,
  _cash_handling boolean DEFAULT true
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _org uuid := public.current_org_id();
  _prof public.profiles;
  _emp uuid;
  _cap boolean;
  _existing public.rider_profiles;
  _code text;
  _n integer;
  _rider uuid;
BEGIN
  IF NOT public.has_permission('delivery','riders.manage') THEN
    RAISE EXCEPTION 'Not permitted to manage the delivery rider roster';
  END IF;
  IF _branch IS NOT NULL AND NOT public.neo_branch_in_scope(_branch) THEN
    RAISE EXCEPTION 'Property is outside your access scope';
  END IF;

  SELECT * INTO _prof FROM public.profiles
   WHERE id = _profile AND organization_id = _org;
  IF _prof.id IS NULL THEN
    RAISE EXCEPTION 'Staff member not found in this workspace';
  END IF;
  IF coalesce(_prof.account_type,'staff') <> 'staff'
     OR coalesce(_prof.account_status,'active') <> 'active' THEN
    RAISE EXCEPTION 'Only active staff accounts can join the delivery roster';
  END IF;

  SELECT EXISTS (
    SELECT 1
    FROM public.user_roles ur
    JOIN public.roles r ON r.id = ur.role_id AND coalesce(r.active, true)
    WHERE ur.user_id = _profile AND ur.organization_id = _org
      AND (
        lower(coalesce(r.normalized_role_key,'')) IN ('rider','driver')
        OR EXISTS (
          SELECT 1 FROM public.role_permissions x
          JOIN public.permissions pm ON pm.id = x.permission_id
          WHERE x.role_id = r.id AND pm.module = 'delivery' AND pm.action LIKE 'rider.%'
        )
      )
  ) INTO _cap;
  IF NOT _cap THEN
    RAISE EXCEPTION 'This staff member does not hold a rider capability — assign a rider role first';
  END IF;

  SELECT id INTO _emp FROM public.employees
   WHERE profile_id = _profile AND organization_id = _org LIMIT 1;

  SELECT * INTO _existing FROM public.rider_profiles
   WHERE profile_id = _profile AND organization_id = _org LIMIT 1;

  IF _existing.id IS NOT NULL THEN
    UPDATE public.rider_profiles
       SET active = true,
           employee_id = coalesce(_emp, employee_id),
           branch_id = coalesce(_branch, branch_id),
           display_name = _prof.full_name,
           work_phone = coalesce(_work_phone, work_phone, _prof.phone),
           vehicle_type = coalesce(_vehicle_type, vehicle_type),
           vehicle_registration = coalesce(_vehicle_registration, vehicle_registration),
           max_active_deliveries = coalesce(_max_active, max_active_deliveries),
           cash_handling_allowed = coalesce(_cash_handling, cash_handling_allowed),
           updated_at = now()
     WHERE id = _existing.id
    RETURNING id, rider_code INTO _rider, _code;

    RETURN jsonb_build_object('rider_id', _rider, 'rider_code', _code, 'operation', 'reinstated');
  END IF;

  LOOP
    SELECT coalesce(max((regexp_replace(rider_code, '^RDR-', ''))::int), 0) + 1
      INTO _n
      FROM public.rider_profiles
     WHERE organization_id = _org AND rider_code ~ '^RDR-[0-9]+$';
    _code := 'RDR-' || lpad(_n::text, 3, '0');
    EXIT WHEN NOT EXISTS (
      SELECT 1 FROM public.rider_profiles
       WHERE organization_id = _org AND rider_code = _code);
  END LOOP;

  INSERT INTO public.rider_profiles (
    organization_id, branch_id, employee_id, profile_id, rider_code, display_name,
    work_phone, vehicle_type, vehicle_registration, max_active_deliveries,
    cash_handling_allowed, availability_status, active, created_by
  ) VALUES (
    _org, _branch, _emp, _profile, _code, _prof.full_name,
    coalesce(_work_phone, _prof.phone), coalesce(_vehicle_type,'motorcycle'), _vehicle_registration,
    coalesce(_max_active, 3), coalesce(_cash_handling, true), 'offline', true, auth.uid()
  ) RETURNING id INTO _rider;

  RETURN jsonb_build_object('rider_id', _rider, 'rider_code', _code, 'operation', 'enrolled');
END;
$$;

-- 5. Retire a rider from the roster
CREATE OR REPLACE FUNCTION public.neo_delivery_rider_retire(_rider uuid, _reason text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _org uuid := public.current_org_id();
  _open integer;
BEGIN
  IF NOT public.has_permission('delivery','riders.manage') THEN
    RAISE EXCEPTION 'Not permitted to manage the delivery rider roster';
  END IF;

  SELECT count(*) INTO _open
    FROM public.delivery_orders d
   WHERE d.rider_id = _rider
     AND coalesce(d.order_status,'') NOT IN ('delivered','cancelled','failed','rejected');
  IF _open > 0 THEN
    RAISE EXCEPTION 'Rider still has % open delivery order(s) — reassign them first', _open;
  END IF;

  UPDATE public.rider_profiles
     SET active = false, availability_status = 'offline', updated_at = now()
   WHERE id = _rider AND organization_id = _org;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Rider not found in this workspace';
  END IF;

  RETURN jsonb_build_object('rider_id', _rider, 'operation', 'retired', 'reason', _reason);
END;
$$;

REVOKE ALL ON FUNCTION public.neo_delivery_rider_candidates(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.neo_delivery_rider_roster(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.neo_delivery_rider_enrol(uuid, uuid, text, text, text, integer, boolean) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.neo_delivery_rider_retire(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.neo_delivery_rider_candidates(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.neo_delivery_rider_roster(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.neo_delivery_rider_enrol(uuid, uuid, text, text, text, integer, boolean) TO authenticated;
GRANT EXECUTE ON FUNCTION public.neo_delivery_rider_retire(uuid, text) TO authenticated;