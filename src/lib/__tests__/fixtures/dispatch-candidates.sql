CREATE OR REPLACE FUNCTION public.neo_delivery_assign(_order uuid, _rider uuid, _reason text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  _org uuid := public.current_org_id();
  _o public.delivery_orders; _new public.rider_profiles; _prev public.rider_profiles;
  _cand record; _found boolean := false; _reason_clean text := nullif(btrim(coalesce(_reason,'')),'');
BEGIN
  IF _org IS NULL THEN RETURN jsonb_build_object('ok', false, 'reason', 'no_organisation'); END IF;
  IF NOT (public.has_permission('delivery','dispatch.assign') OR public.is_org_admin()) THEN
    RAISE EXCEPTION 'The delivery.dispatch.assign permission is required.' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO _o FROM public.delivery_orders
   WHERE id = _order AND organization_id = _org FOR UPDATE;
  IF _o.id IS NULL THEN RETURN jsonb_build_object('ok', false, 'reason', 'order_not_found'); END IF;
  IF NOT public.neo_branch_in_scope(_o.branch_id) THEN
    RAISE EXCEPTION 'That order is outside your access scope.' USING ERRCODE = '42501';
  END IF;
  IF _o.order_status IN ('delivered','cancelled','rejected','failed') THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'order_closed',
      'detail', 'That order is already ' || _o.order_status || '.');
  END IF;
  IF _o.rider_id = _rider THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'already_assigned',
      'detail', 'That rider already holds this order.');
  END IF;
  IF _o.rider_id IS NOT NULL AND _reason_clean IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'reason_required',
      'detail', 'Reassigning an order requires a written reason.');
  END IF;

  FOR _cand IN SELECT * FROM public.neo_delivery_dispatch_candidates(_order) c WHERE c.rider_id = _rider LOOP
    _found := true;
    IF _cand.eligible IS NOT TRUE THEN
      RETURN jsonb_build_object('ok', false, 'reason', 'rider_ineligible',
        'detail', array_to_string(_cand.reasons, '; '), 'reasons', to_jsonb(_cand.reasons));
    END IF;
  END LOOP;
  IF NOT _found THEN RETURN jsonb_build_object('ok', false, 'reason', 'rider_not_found'); END IF;

  SELECT * INTO _new FROM public.rider_profiles WHERE id = _rider;
  IF _o.rider_id IS NOT NULL THEN
    SELECT * INTO _prev FROM public.rider_profiles WHERE id = _o.rider_id;
  END IF;

  UPDATE public.delivery_orders
     SET rider_id = _rider, dispatch_status = 'assigned', updated_at = now()
   WHERE id = _order;

  INSERT INTO public.delivery_order_status_history
    (organization_id, delivery_order_id, status_kind, previous_status, new_status, reason, changed_by)
  VALUES (_org, _order, 'dispatch', coalesce(_prev.display_name, 'unassigned'),
          coalesce(_new.display_name, 'rider'), _reason_clean, auth.uid());

  PERFORM public.neo_delivery_rider_notify(
    _org, _rider, 'delivery.assigned', 'Delivery assigned to you',
    _o.order_number || coalesce(' · ' || _o.contact_name, '') ||
      coalesce(' · reassigned: ' || _reason_clean, ''),
    'delivery.assign:' || _order::text || ':' || _rider::text,
    _order, _prev.id, _rider, 'high', '/rider');

  IF _prev.id IS NOT NULL THEN
    PERFORM public.neo_delivery_rider_notify(
      _org, _prev.id, 'delivery.reassigned', 'Delivery reassigned',
      _o.order_number || ' is now with ' || coalesce(_new.display_name,'another rider') ||
        coalesce(' — ' || _reason_clean, ''),
      'delivery.unassign:' || _order::text || ':' || _prev.id::text || ':' || _rider::text,
      _order, _prev.id, _rider, 'normal', '/rider');
  END IF;

  INSERT INTO public.audit_logs
    (organization_id, user_id, user_name, action, module, record_id, previous_value, new_value, reason)
  VALUES (_org, auth.uid(), '',
    CASE WHEN _prev.id IS NULL THEN 'delivery.dispatch.assign' ELSE 'delivery.dispatch.reassign' END,
    'delivery', _order::text,
    jsonb_build_object('rider_id', _prev.id, 'rider', _prev.display_name),
    jsonb_build_object('rider_id', _rider, 'rider', _new.display_name),
    _reason_clean);

  RETURN jsonb_build_object('ok', true, 'order_id', _order, 'rider_id', _rider,
    'previous_rider_id', _prev.id, 'reassigned', _prev.id IS NOT NULL);
END $function$
;

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
               WHERE p.id = r.profile_id AND coalesce(p.is_active, true)
                 AND coalesce(p.account_status,'active') = 'active') AS account_live,
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
END $function$
;

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
     AND coalesce(p.is_active, true)
     AND public.neo_branch_in_scope(coalesce(e.branch_id, p.branch_id))
     AND (_branch IS NULL OR coalesce(e.branch_id, p.branch_id) IS NULL
          OR coalesce(e.branch_id, p.branch_id) = _branch)
   ORDER BY p.full_name;
END $function$
;

CREATE OR REPLACE FUNCTION public.neo_delivery_rider_directory(_branch uuid DEFAULT NULL::uuid)
 RETURNS TABLE(rider_id uuid, rider_code text, display_name text, vehicle_type text, availability_status text, branch_id uuid, active boolean, active_load integer, max_active integer, on_shift boolean)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
END $function$
;

CREATE OR REPLACE FUNCTION public.neo_rider_holds_capability(_profile uuid, _org uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT _profile IS NOT NULL AND EXISTS (
    SELECT 1 FROM public.user_roles ur
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
  );
$function$
;

