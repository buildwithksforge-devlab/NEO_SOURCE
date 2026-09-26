-- Rider capability helper -----------------------------------------------
CREATE OR REPLACE FUNCTION public.neo_rider_holds_capability(_profile uuid, _org uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
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
$$;
REVOKE EXECUTE ON FUNCTION public.neo_rider_holds_capability(uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.neo_rider_holds_capability(uuid, uuid) TO authenticated;

-- Dispatch eligibility: add the Rider capability test ---------------------
CREATE OR REPLACE FUNCTION public.neo_delivery_dispatch_candidates(_order uuid)
 RETURNS TABLE(rider_id uuid, rider_code text, display_name text, vehicle_type text, availability_status text, active_load integer, max_active integer, on_shift boolean, next_shift timestamp with time zone, delivered_today integer, cash_handling_allowed boolean, eligible boolean, reasons text[])
 LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public'
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
END $function$;

-- Roster now carries the operating metrics -------------------------------
DROP FUNCTION IF EXISTS public.neo_delivery_rider_roster(uuid);
CREATE OR REPLACE FUNCTION public.neo_delivery_rider_roster(_branch uuid DEFAULT NULL::uuid)
 RETURNS TABLE(id uuid, rider_code text, display_name text, availability_status text, vehicle_type text,
   vehicle_registration text, work_phone text, max_active_deliveries integer, cash_handling_allowed boolean,
   active boolean, branch_id uuid, profile_id uuid, employee_id uuid, staff_id text, staff_name text,
   staff_account_status text, holds_rider_capability boolean, linkage_status text, active_orders integer,
   delivered_orders integer, cancelled_orders integer, on_time_rate numeric,
   avg_assignment_minutes numeric, avg_pickup_minutes numeric)
 LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$
  WITH org AS (
    SELECT CASE WHEN public.is_staff() THEN public.current_org_id() ELSE NULL::uuid END AS id
  )
  SELECT rp.id, rp.rider_code, rp.display_name, rp.availability_status, rp.vehicle_type,
         rp.vehicle_registration, rp.work_phone, rp.max_active_deliveries, rp.cash_handling_allowed,
         rp.active, rp.branch_id, rp.profile_id, rp.employee_id,
         p.staff_id, p.full_name, p.account_status,
         public.neo_rider_holds_capability(rp.profile_id, rp.organization_id),
         CASE
           WHEN rp.profile_id IS NULL THEN 'unlinked'
           WHEN p.id IS NULL THEN 'missing-account'
           WHEN coalesce(p.account_status,'active') <> 'active' THEN 'account-inactive'
           WHEN NOT public.neo_rider_holds_capability(rp.profile_id, rp.organization_id) THEN 'capability-missing'
           ELSE 'linked'
         END,
         coalesce(m.active_orders, 0)::integer,
         coalesce(m.delivered_orders, 0)::integer,
         coalesce(m.cancelled_orders, 0)::integer,
         m.on_time_rate,
         m.avg_assignment_minutes,
         m.avg_pickup_minutes
  FROM public.rider_profiles rp
  LEFT JOIN public.profiles p ON p.id = rp.profile_id
  LEFT JOIN LATERAL (
    SELECT
      count(*) FILTER (WHERE coalesce(d.order_status,'') NOT IN ('delivered','cancelled','failed','rejected')) AS active_orders,
      count(*) FILTER (WHERE d.order_status = 'delivered' AND d.created_at >= now() - interval '30 days') AS delivered_orders,
      count(*) FILTER (WHERE d.order_status IN ('cancelled','failed','rejected') AND d.created_at >= now() - interval '30 days') AS cancelled_orders,
      round(100.0 * count(*) FILTER (
              WHERE d.delivered_at IS NOT NULL AND d.estimated_delivery_at IS NOT NULL
                AND d.delivered_at <= d.estimated_delivery_at)::numeric
            / nullif(count(*) FILTER (WHERE d.delivered_at IS NOT NULL AND d.estimated_delivery_at IS NOT NULL), 0), 1) AS on_time_rate,
      round(avg(extract(epoch FROM (d.delivered_at - coalesce(d.accepted_at, d.requested_at, d.created_at))) / 60.0)
            FILTER (WHERE d.delivered_at IS NOT NULL), 1) AS avg_assignment_minutes,
      round(avg(extract(epoch FROM (d.delivered_at - coalesce(d.collected_at, d.ready_at))) / 60.0)
            FILTER (WHERE d.delivered_at IS NOT NULL AND coalesce(d.collected_at, d.ready_at) IS NOT NULL), 1) AS avg_pickup_minutes
    FROM public.delivery_orders d
    WHERE d.rider_id = rp.id
  ) m ON true
  WHERE rp.organization_id = (SELECT id FROM org)
    AND (_branch IS NULL OR rp.branch_id IS NULL OR rp.branch_id = _branch)
  ORDER BY rp.active DESC, rp.display_name;
$function$;
REVOKE EXECUTE ON FUNCTION public.neo_delivery_rider_roster(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.neo_delivery_rider_roster(uuid) TO authenticated;

-- Availability: a checked server routine, not a browser table write -------
CREATE OR REPLACE FUNCTION public.neo_delivery_rider_availability(_rider uuid, _status text, _reason text DEFAULT NULL::text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $function$
DECLARE
  _org uuid := public.current_org_id();
  _r public.rider_profiles; _self boolean; _prev text;
  _clean text := lower(btrim(coalesce(_status,'')));
BEGIN
  IF _org IS NULL THEN RETURN jsonb_build_object('ok', false, 'reason', 'no_organisation'); END IF;
  IF _clean NOT IN ('available','busy','on-break','offline') THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'invalid_status');
  END IF;

  SELECT * INTO _r FROM public.rider_profiles WHERE id = _rider AND organization_id = _org FOR UPDATE;
  IF _r.id IS NULL THEN RETURN jsonb_build_object('ok', false, 'reason', 'rider_not_found'); END IF;

  _self := _r.profile_id IS NOT NULL AND _r.profile_id = auth.uid();
  IF NOT (_self AND public.has_permission('delivery','rider.availability'))
     AND NOT public.has_permission('delivery','riders.manage')
     AND NOT public.is_org_admin() THEN
    RAISE EXCEPTION 'Not permitted to change that rider''s availability.' USING ERRCODE = '42501';
  END IF;
  IF NOT public.neo_branch_in_scope(_r.branch_id) THEN
    RAISE EXCEPTION 'That rider is outside your access scope.' USING ERRCODE = '42501';
  END IF;

  _prev := _r.availability_status;
  IF coalesce(_prev,'') = _clean THEN
    RETURN jsonb_build_object('ok', true, 'status', _clean, 'unchanged', true);
  END IF;

  UPDATE public.rider_profiles SET availability_status = _clean, updated_at = now() WHERE id = _rider;

  INSERT INTO public.rider_availability_history (organization_id, rider_id, previous_status, new_status, reason, changed_by)
  VALUES (_org, _rider, _prev, _clean, nullif(btrim(coalesce(_reason,'')),''), auth.uid());

  IF _r.profile_id IS NOT NULL AND NOT _self THEN
    INSERT INTO public.notifications
      (organization_id, branch_id, user_id, category, title, body, link,
       source_module, source_record_id, event_type, idempotency_key)
    VALUES (_org, _r.branch_id, _r.profile_id, 'operations', 'Your rider availability was changed',
      'Now ' || _clean || coalesce(' — ' || nullif(btrim(coalesce(_reason,'')),''), ''),
      '/rider', 'delivery', _rider, 'delivery.rider.availability',
      'delivery.rider.availability:' || _rider::text || ':' || _clean || ':' ||
        to_char(date_trunc('minute', now()), 'YYYYMMDDHH24MI'))
    ON CONFLICT DO NOTHING;
  END IF;

  INSERT INTO public.audit_logs
    (organization_id, user_id, user_name, action, module, record_id, previous_value, new_value, reason)
  VALUES (_org, auth.uid(), '', 'delivery.rider.availability', 'delivery', _rider::text,
    jsonb_build_object('availability_status', _prev), jsonb_build_object('availability_status', _clean),
    nullif(btrim(coalesce(_reason,'')),''));

  RETURN jsonb_build_object('ok', true, 'status', _clean, 'previous', _prev, 'self', _self);
END $function$;
REVOKE EXECUTE ON FUNCTION public.neo_delivery_rider_availability(uuid, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.neo_delivery_rider_availability(uuid, text, text) TO authenticated;

-- Rider notification audit trail -----------------------------------------
CREATE OR REPLACE FUNCTION public.neo_delivery_rider_notifications(_rider uuid, _limit integer DEFAULT 100)
RETURNS TABLE(created_at timestamp with time zone, event_type text, title text, body text,
  idempotency_key text, delivery_status text, read_at timestamp with time zone,
  order_number text, recipient uuid, duplicate_suppressed boolean)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public' AS $function$
DECLARE _org uuid := public.current_org_id(); _r public.rider_profiles;
BEGIN
  IF _org IS NULL THEN RETURN; END IF;
  IF NOT (public.has_permission('delivery','dispatch.view')
          OR public.has_permission('delivery','riders.manage')
          OR public.is_org_admin()) THEN
    RAISE EXCEPTION 'insufficient_privilege' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO _r FROM public.rider_profiles WHERE id = _rider AND organization_id = _org;
  IF _r.id IS NULL THEN RETURN; END IF;
  IF NOT public.neo_branch_in_scope(_r.branch_id) THEN
    RAISE EXCEPTION 'That rider is outside your access scope.' USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
  SELECT n.created_at,
         coalesce(n.event_type, 'notification')::text,
         n.title, n.body, n.idempotency_key,
         coalesce(n.status, CASE WHEN n.read_at IS NOT NULL THEN 'read' ELSE 'sent' END)::text,
         n.read_at,
         o.order_number,
         n.user_id,
         false
    FROM public.notifications n
    LEFT JOIN public.delivery_orders o ON o.id = n.source_record_id
   WHERE n.organization_id = _org
     AND n.source_module = 'delivery'
     AND (n.user_id = _r.profile_id OR n.source_record_id = _rider
          OR n.idempotency_key LIKE 'delivery.%:' || _rider::text || '%'
          OR EXISTS (SELECT 1 FROM public.delivery_orders d
                      WHERE d.id = n.source_record_id AND d.rider_id = _rider))
   ORDER BY n.created_at DESC
   LIMIT greatest(coalesce(_limit, 100), 1);
END $function$;
REVOKE EXECUTE ON FUNCTION public.neo_delivery_rider_notifications(uuid, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.neo_delivery_rider_notifications(uuid, integer) TO authenticated;
