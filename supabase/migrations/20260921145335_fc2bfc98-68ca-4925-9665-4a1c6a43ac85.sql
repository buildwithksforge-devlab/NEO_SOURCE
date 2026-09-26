CREATE OR REPLACE FUNCTION public.neo_rider_me()
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  _r public.rider_profiles;
  _open integer := 0;
  _d30 integer := 0;
  _all integer := 0;
  _avatar text;
  _full text;
BEGIN
  -- A rider reaches the field app either as their own login on the roster
  -- entry, or as the hotel employee that roster entry belongs to. Both resolve
  -- to the same canonical person, so Work actions and Rider actions stay
  -- attributable to one identity.
  SELECT * INTO _r
  FROM public.rider_profiles r
  WHERE r.active
    AND (
      r.profile_id = auth.uid()
      OR r.employee_id IN (SELECT e.id FROM public.employees e WHERE e.profile_id = auth.uid())
    )
  ORDER BY (r.profile_id = auth.uid()) DESC
  LIMIT 1;

  IF _r.id IS NULL THEN RETURN NULL; END IF;

  SELECT
    count(*) FILTER (WHERE d.order_status NOT IN ('delivered','cancelled','rejected')),
    count(*) FILTER (WHERE d.order_status = 'delivered' AND d.delivered_at >= now() - interval '30 days'),
    count(*) FILTER (WHERE d.order_status = 'delivered')
  INTO _open, _d30, _all
  FROM public.delivery_orders d
  WHERE d.rider_id = _r.id
    AND d.organization_id = _r.organization_id;

  SELECT p.avatar_url, p.full_name INTO _avatar, _full
  FROM public.profiles p
  WHERE p.id = _r.profile_id;

  RETURN jsonb_build_object(
    'rider_id', _r.id,
    'organization_id', _r.organization_id,
    'branch_id', _r.branch_id,
    'employee_id', _r.employee_id,
    'profile_id', _r.profile_id,
    'rider_code', _r.rider_code,
    'display_name', _r.display_name,
    'work_phone', _r.work_phone,
    'vehicle_type', _r.vehicle_type,
    'vehicle_registration', _r.vehicle_registration,
    'zone_ids', _r.zone_ids,
    'availability_status', _r.availability_status,
    'cash_handling_allowed', _r.cash_handling_allowed,
    'max_active_deliveries', _r.max_active_deliveries,
    'active', _r.active,
    'avatar_url', _avatar,
    'full_name', _full,
    'stats', jsonb_build_object(
      'assigned_open', coalesce(_open, 0),
      'delivered_30d', coalesce(_d30, 0),
      'delivered_total', coalesce(_all, 0)
    )
  );
END;
$function$;