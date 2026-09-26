
CREATE OR REPLACE FUNCTION public.neo_rider_me()
RETURNS jsonb
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE _r public.rider_profiles;
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
    'availability_status', _r.availability_status,
    'cash_handling_allowed', _r.cash_handling_allowed,
    'max_active_orders', _r.max_active_orders,
    'active', _r.active
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.my_rider_id()
RETURNS uuid
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  SELECT r.id
  FROM public.rider_profiles r
  WHERE r.active
    AND (
      r.profile_id = auth.uid()
      OR r.employee_id IN (SELECT e.id FROM public.employees e WHERE e.profile_id = auth.uid())
    )
  ORDER BY (r.profile_id = auth.uid()) DESC
  LIMIT 1;
$function$;

CREATE OR REPLACE FUNCTION public.my_rider_branch_id()
RETURNS uuid
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  SELECT r.branch_id
  FROM public.rider_profiles r
  WHERE r.active
    AND (
      r.profile_id = auth.uid()
      OR r.employee_id IN (SELECT e.id FROM public.employees e WHERE e.profile_id = auth.uid())
    )
  ORDER BY (r.profile_id = auth.uid()) DESC
  LIMIT 1;
$function$;
