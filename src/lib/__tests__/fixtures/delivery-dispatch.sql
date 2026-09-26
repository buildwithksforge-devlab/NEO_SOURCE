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

  INSERT INTO public.notifications
    (organization_id, branch_id, user_id, category, title, body, link, priority,
     source_module, source_record_id, event_type, idempotency_key)
  VALUES (_org, _o.branch_id, _new.profile_id, 'operations',
    'Delivery assigned to you',
    _o.order_number || coalesce(' · ' || _o.contact_name, '') ||
      coalesce(' · reassigned: ' || _reason_clean, ''),
    '/delivery', 'high', 'delivery', _order, 'delivery.assigned',
    'delivery.assign:' || _order::text || ':' || _rider::text)
  ON CONFLICT DO NOTHING;

  IF _prev.profile_id IS NOT NULL THEN
    INSERT INTO public.notifications
      (organization_id, branch_id, user_id, category, title, body, link,
       source_module, source_record_id, event_type, idempotency_key)
    VALUES (_org, _o.branch_id, _prev.profile_id, 'operations',
      'Delivery reassigned',
      _o.order_number || ' is now with ' || coalesce(_new.display_name,'another rider') ||
        coalesce(' — ' || _reason_clean, ''),
      '/delivery', 'delivery', _order, 'delivery.reassigned',
      'delivery.unassign:' || _order::text || ':' || _prev.id::text || ':' || _rider::text)
    ON CONFLICT DO NOTHING;
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

CREATE OR REPLACE FUNCTION public.neo_delivery_dispatch_board(_branch uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE _org uuid := public.current_org_id(); _riders jsonb; _queue jsonb;
BEGIN
  IF _org IS NULL THEN RETURN jsonb_build_object('ok', false, 'reason', 'no_organisation'); END IF;
  IF NOT (public.has_permission('delivery','dispatch.view')
          OR public.has_permission('delivery','riders.manage')
          OR public.is_org_admin()) THEN
    RAISE EXCEPTION 'insufficient_privilege' USING ERRCODE = '42501';
  END IF;

  SELECT coalesce(jsonb_agg(x ORDER BY x->>'display_name'), '[]'::jsonb) INTO _riders
  FROM (
    SELECT jsonb_build_object(
      'rider_id', r.id,
      'rider_code', r.rider_code,
      'display_name', r.display_name,
      'vehicle_type', r.vehicle_type,
      'availability_status', r.availability_status,
      'max_active', coalesce(r.max_active_deliveries, 3),
      'cash_handling_allowed', r.cash_handling_allowed,
      'branch_id', r.branch_id,
      'active_load', (
        SELECT count(*) FROM public.delivery_orders o
         WHERE o.rider_id = r.id
           AND o.order_status NOT IN ('delivered','cancelled','rejected','failed')
      ),
      'on_shift', EXISTS (
        SELECT 1 FROM public.rider_shifts s
         WHERE s.rider_id = r.id AND s.status IN ('scheduled','active')
           AND now() BETWEEN s.starts_at AND s.ends_at
      ),
      'next_shift', (
        SELECT min(s.starts_at) FROM public.rider_shifts s
         WHERE s.rider_id = r.id AND s.status = 'scheduled' AND s.starts_at > now()
      ),
      'delivered_today', (
        SELECT count(*) FROM public.delivery_orders o
         WHERE o.rider_id = r.id AND o.delivered_at >= date_trunc('day', now())
      )
    ) AS x
    FROM public.rider_profiles r
    WHERE r.organization_id = _org
      AND r.active IS TRUE
      AND (_branch IS NULL OR r.branch_id IS NULL OR r.branch_id = _branch)
      AND public.neo_branch_in_scope(r.branch_id)
  ) t;

  SELECT coalesce(jsonb_agg(y ORDER BY y->>'requested_at'), '[]'::jsonb) INTO _queue
  FROM (
    SELECT jsonb_build_object(
      'order_id', o.id,
      'order_number', o.order_number,
      'contact_name', o.contact_name,
      'order_status', o.order_status,
      'kitchen_status', o.kitchen_status,
      'dispatch_status', o.dispatch_status,
      'payment_method', o.payment_method,
      'grand_total', o.grand_total,
      'requested_at', o.requested_at,
      'waiting_minutes', round(extract(epoch FROM (now() - coalesce(o.ready_at, o.requested_at, o.created_at))) / 60.0),
      'branch_id', o.branch_id
    ) AS y
    FROM public.delivery_orders o
    WHERE o.organization_id = _org
      AND (_branch IS NULL OR o.branch_id = _branch)
      AND public.neo_branch_in_scope(o.branch_id)
      AND o.rider_id IS NULL
      AND o.order_status NOT IN ('delivered','cancelled','rejected','failed','draft')
    LIMIT 200
  ) q;

  RETURN jsonb_build_object('ok', true, 'generated_at', now(), 'riders', _riders, 'queue', _queue);
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

CREATE OR REPLACE FUNCTION public.neo_delivery_rider_availability(_rider uuid, _status text, _reason text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
END $function$
;

CREATE OR REPLACE FUNCTION public.neo_delivery_rider_enrol(_profile uuid, _branch uuid DEFAULT NULL::uuid, _vehicle_type text DEFAULT 'motorcycle'::text, _vehicle_registration text DEFAULT NULL::text, _work_phone text DEFAULT NULL::text, _max_active integer DEFAULT 3, _cash_handling boolean DEFAULT true)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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

    PERFORM public.neo_delivery_rider_notify(_org, _rider, 'delivery.rider.enrolled',
       'You are back on the delivery roster', 'Rider code ' || _code,
       'delivery.rider.enrol:' || _rider::text || ':' || _code);
     INSERT INTO public.audit_logs (organization_id, user_id, user_name, action, module, record_id, new_value)
     VALUES (_org, auth.uid(), '', 'delivery.rider.reinstate', 'delivery', _rider::text,
       jsonb_build_object('rider_id', _rider, 'rider_code', _code));
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

  PERFORM public.neo_delivery_rider_notify(_org, _rider, 'delivery.rider.enrolled',
       'You have been added to the delivery roster', 'Rider code ' || _code,
       'delivery.rider.enrol:' || _rider::text || ':' || _code);
     INSERT INTO public.audit_logs (organization_id, user_id, user_name, action, module, record_id, new_value)
     VALUES (_org, auth.uid(), '', 'delivery.rider.enrol', 'delivery', _rider::text,
       jsonb_build_object('rider_id', _rider, 'rider_code', _code));
     RETURN jsonb_build_object('rider_id', _rider, 'rider_code', _code, 'operation', 'enrolled');
END;
$function$
;

CREATE OR REPLACE FUNCTION public.neo_delivery_rider_notifications(_rider uuid, _limit integer DEFAULT 100)
 RETURNS TABLE(created_at timestamp with time zone, event_type text, title text, body text, idempotency_key text, delivery_status text, read_at timestamp with time zone, order_number text, recipient uuid, duplicate_suppressed boolean)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
END $function$
;

CREATE OR REPLACE FUNCTION public.neo_delivery_rider_retire(_rider uuid, _reason text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  _org uuid := public.current_org_id();
  _open integer; _r public.rider_profiles;
  _clean text := nullif(btrim(coalesce(_reason,'')),'');
BEGIN
  IF NOT public.has_permission('delivery','riders.manage') THEN
    RAISE EXCEPTION 'Not permitted to manage the delivery rider roster' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO _r FROM public.rider_profiles WHERE id = _rider AND organization_id = _org FOR UPDATE;
  IF _r.id IS NULL THEN RAISE EXCEPTION 'Rider not found in this workspace'; END IF;
  IF NOT public.neo_branch_in_scope(_r.branch_id) THEN
    RAISE EXCEPTION 'That rider is outside your access scope.' USING ERRCODE = '42501';
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

  PERFORM public.neo_delivery_rider_notify(_org, _rider, 'delivery.rider.retired',
    'You have been removed from the delivery roster',
    coalesce(_clean, 'Your rider account is no longer on the active roster.'),
    'delivery.rider.retire:' || _rider::text);

  INSERT INTO public.audit_logs
    (organization_id, user_id, user_name, action, module, record_id, previous_value, new_value, reason)
  VALUES (_org, auth.uid(), '', 'delivery.rider.retire', 'delivery', _rider::text,
    jsonb_build_object('active', true, 'rider_id', _rider, 'rider_code', _r.rider_code),
    jsonb_build_object('active', false, 'rider_id', _rider), _clean);

  RETURN jsonb_build_object('rider_id', _rider, 'operation', 'retired', 'reason', _clean);
END;
$function$
;

CREATE OR REPLACE FUNCTION public.neo_delivery_rider_roster(_branch uuid DEFAULT NULL::uuid)
 RETURNS TABLE(id uuid, rider_code text, display_name text, availability_status text, vehicle_type text, vehicle_registration text, work_phone text, max_active_deliveries integer, cash_handling_allowed boolean, active boolean, branch_id uuid, profile_id uuid, employee_id uuid, staff_id text, staff_name text, staff_account_status text, holds_rider_capability boolean, linkage_status text, active_orders integer, delivered_orders integer, cancelled_orders integer, on_time_rate numeric, avg_assignment_minutes numeric, avg_pickup_minutes numeric)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
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
$function$
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

CREATE OR REPLACE FUNCTION public.neo_rider_lifecycle_notify()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE _title text; _body text; _event text; _key text;
BEGIN
  IF NEW.profile_id IS NULL THEN RETURN NEW; END IF;

  IF TG_OP = 'INSERT' THEN
    _title := 'You are on the delivery roster';
    _body  := 'Rider code ' || coalesce(NEW.rider_code, '—');
    _event := 'delivery.rider.enrolled';
    _key   := 'delivery.rider.enrol:' || NEW.id::text || ':' || coalesce(NEW.rider_code, '');
  ELSIF coalesce(OLD.active, false) IS DISTINCT FROM coalesce(NEW.active, false) THEN
    IF NEW.active THEN
      _title := 'You are back on the delivery roster';
      _body  := 'Rider code ' || coalesce(NEW.rider_code, '—');
      _event := 'delivery.rider.reinstated';
      _key   := 'delivery.rider.reinstate:' || NEW.id::text || ':' || to_char(now(),'YYYYMMDDHH24MI');
    ELSE
      _title := 'You have been retired from the delivery roster';
      _body  := 'You will not receive new delivery assignments.';
      _event := 'delivery.rider.retired';
      _key   := 'delivery.rider.retire:' || NEW.id::text || ':' || to_char(now(),'YYYYMMDDHH24MI');
    END IF;
  ELSIF coalesce(OLD.rider_code,'') IS DISTINCT FROM coalesce(NEW.rider_code,'') THEN
    _title := 'Your rider code changed';
    _body  := 'New rider code ' || coalesce(NEW.rider_code, '—');
    _event := 'delivery.rider.code_changed';
    _key   := 'delivery.rider.code:' || NEW.id::text || ':' || coalesce(NEW.rider_code,'');
  ELSE
    RETURN NEW;
  END IF;

  INSERT INTO public.notifications
    (organization_id, branch_id, user_id, category, title, body, link,
     source_module, source_record_id, event_type, idempotency_key)
  VALUES (NEW.organization_id, NEW.branch_id, NEW.profile_id, 'operations',
    _title, _body, '/rider', 'delivery', NEW.id, _event, _key)
  ON CONFLICT DO NOTHING;

  RETURN NEW;
END $function$
;

CREATE OR REPLACE FUNCTION public.neo_rider_shift_notify()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE _profile uuid; _branch uuid;
BEGIN
  SELECT rp.profile_id, rp.branch_id INTO _profile, _branch
    FROM public.rider_profiles rp WHERE rp.id = NEW.rider_id;
  IF _profile IS NULL THEN RETURN NEW; END IF;

  INSERT INTO public.notifications
    (organization_id, branch_id, user_id, category, title, body, link,
     source_module, source_record_id, event_type, idempotency_key)
  VALUES (NEW.organization_id, _branch, _profile, 'operations',
    'Delivery shift scheduled',
    to_char(NEW.starts_at, 'DD Mon HH24:MI') || ' — ' || to_char(NEW.ends_at, 'HH24:MI'),
    '/rider', 'delivery', NEW.id, 'delivery.rider.shift_scheduled',
    'delivery.rider.shift:' || NEW.id::text || ':' || to_char(NEW.starts_at,'YYYYMMDDHH24MI'))
  ON CONFLICT DO NOTHING;

  RETURN NEW;
END $function$

