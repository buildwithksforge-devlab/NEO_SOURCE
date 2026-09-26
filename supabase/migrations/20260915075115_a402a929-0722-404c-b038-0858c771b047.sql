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
      'profile_id', r.profile_id,
      'linkage_status', CASE
        WHEN r.profile_id IS NULL THEN 'unlinked'
        WHEN p.id IS NULL THEN 'missing-account'
        WHEN coalesce(p.account_status,'active') <> 'active' THEN 'account-inactive'
        WHEN NOT public.neo_rider_holds_capability(r.profile_id, r.organization_id) THEN 'capability-missing'
        ELSE 'linked'
      END,
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
    LEFT JOIN public.profiles p ON p.id = r.profile_id
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
END $function$;