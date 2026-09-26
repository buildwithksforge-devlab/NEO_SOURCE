-- Additive: per-property live-tracking policy for the customer experience.
ALTER TABLE public.delivery_settings
  ADD COLUMN IF NOT EXISTS customer_tracking_enabled boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS rider_contact_enabled boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS location_ping_seconds integer NOT NULL DEFAULT 30;

COMMENT ON COLUMN public.delivery_settings.customer_tracking_enabled IS
  'Whether the customer may see the assigned rider''s latest location while their own delivery is in progress.';
COMMENT ON COLUMN public.delivery_settings.location_ping_seconds IS
  'How often the rider app sends a lightweight location update during an active delivery.';

CREATE INDEX IF NOT EXISTS rider_location_events_order_recent_idx
  ON public.rider_location_events (delivery_order_id, created_at DESC);

-- The rider app reports its own position, and only while it is actually
-- carrying an active delivery for a property that has tracking switched on.
CREATE OR REPLACE FUNCTION public.neo_rider_report_location(
  _delivery uuid, _lat numeric, _lng numeric,
  _accuracy numeric DEFAULT NULL, _heading numeric DEFAULT NULL, _speed numeric DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path TO 'public'
AS $fn$
DECLARE _rider uuid := public.my_rider_id();
        _d public.delivery_orders;
        _s public.delivery_settings;
BEGIN
  IF _rider IS NULL THEN RETURN jsonb_build_object('ok', false, 'detail', 'not_a_rider'); END IF;
  IF _lat IS NULL OR _lng IS NULL
     OR _lat < -90 OR _lat > 90 OR _lng < -180 OR _lng > 180 THEN
    RETURN jsonb_build_object('ok', false, 'detail', 'invalid_location');
  END IF;

  SELECT * INTO _d FROM public.delivery_orders WHERE id = _delivery AND rider_id = _rider;
  IF _d.id IS NULL THEN RETURN jsonb_build_object('ok', false, 'detail', 'not_your_delivery'); END IF;
  IF _d.order_status NOT IN ('rider-assigned', 'collected', 'en-route', 'arrived') THEN
    RETURN jsonb_build_object('ok', false, 'detail', 'delivery_not_active');
  END IF;

  SELECT * INTO _s FROM public.delivery_settings
   WHERE organization_id = _d.organization_id
     AND (branch_id = _d.branch_id OR branch_id IS NULL)
   ORDER BY branch_id NULLS LAST LIMIT 1;
  IF NOT coalesce(_s.gps_tracking_enabled, false) THEN
    RETURN jsonb_build_object('ok', false, 'detail', 'tracking_disabled');
  END IF;

  INSERT INTO public.rider_location_events
    (organization_id, rider_id, delivery_order_id, latitude, longitude,
     accuracy, heading, speed, source, retention_expires_at)
  VALUES (_d.organization_id, _rider, _d.id, _lat, _lng, _accuracy, _heading, _speed, 'rider-app',
          now() + make_interval(days => greatest(coalesce(_s.location_retention_days, 7), 1)));

  RETURN jsonb_build_object('ok', true, 'next_ping_seconds', greatest(coalesce(_s.location_ping_seconds, 30), 10));
END $fn$;

REVOKE ALL ON FUNCTION public.neo_rider_report_location(uuid, numeric, numeric, numeric, numeric, numeric) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.neo_rider_report_location(uuid, numeric, numeric, numeric, numeric, numeric) TO authenticated, service_role;

-- The customer sees their own delivery: where it is going, what the rider may
-- be contacted on, and the rider's latest position while the run is live.
CREATE OR REPLACE FUNCTION public.neo_guest_delivery_live(_org uuid, _reference text)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $fn$
DECLARE _cust uuid := public.my_customer_id();
        _d public.delivery_orders;
        _s public.delivery_settings;
        _rider public.rider_profiles;
        _loc public.rider_location_events;
        _live boolean;
        _addr jsonb;
BEGIN
  IF _cust IS NULL THEN RETURN NULL; END IF;
  SELECT * INTO _d FROM public.delivery_orders
   WHERE organization_id = _org AND order_number = _reference AND customer_id = _cust;
  IF _d.id IS NULL THEN RETURN NULL; END IF;

  SELECT * INTO _s FROM public.delivery_settings
   WHERE organization_id = _d.organization_id
     AND (branch_id = _d.branch_id OR branch_id IS NULL)
   ORDER BY branch_id NULLS LAST LIMIT 1;

  _live := _d.order_status IN ('rider-assigned', 'collected', 'en-route', 'arrived');
  _addr := coalesce(_d.address_snapshot, '{}'::jsonb);

  IF _d.rider_id IS NOT NULL THEN
    SELECT * INTO _rider FROM public.rider_profiles WHERE id = _d.rider_id;
  END IF;

  IF _live AND _rider.id IS NOT NULL
     AND coalesce(_s.gps_tracking_enabled, false)
     AND coalesce(_s.customer_tracking_enabled, true) THEN
    SELECT * INTO _loc FROM public.rider_location_events
     WHERE delivery_order_id = _d.id
     ORDER BY created_at DESC LIMIT 1;
  END IF;

  RETURN jsonb_build_object(
    'order_number', _d.order_number,
    'order_status', _d.order_status,
    'fulfilment_type', _d.fulfilment_type,
    'live', _live,
    'estimated_delivery_at', _d.estimated_delivery_at,
    'delivered_at', _d.delivered_at,
    'delivery_fee', _d.delivery_fee,
    'tracking_enabled', coalesce(_s.gps_tracking_enabled, false) AND coalesce(_s.customer_tracking_enabled, true),
    'refresh_seconds', greatest(coalesce(_s.location_ping_seconds, 30), 10),
    'destination', CASE WHEN _d.fulfilment_type = 'pickup' THEN NULL ELSE jsonb_build_object(
        'label', _addr->>'label',
        'address_line', _addr->>'address_line',
        'city', _addr->>'city',
        'landmark', _addr->>'landmark',
        'instructions', _addr->>'delivery_instructions',
        'recipient_name', coalesce(_d.contact_name, _addr->>'recipient_name'),
        'latitude', coalesce(_d.latitude, (_addr->>'latitude')::numeric),
        'longitude', coalesce(_d.longitude, (_addr->>'longitude')::numeric)) END,
    'courier', CASE WHEN _rider.id IS NULL OR NOT _live THEN NULL ELSE jsonb_build_object(
        'display_name', split_part(coalesce(_rider.display_name, 'Courier'), ' ', 1),
        'vehicle_type', _rider.vehicle_type,
        'vehicle_registration', _rider.vehicle_registration,
        'phone', CASE WHEN coalesce(_s.rider_contact_enabled, true) THEN _rider.work_phone END) END,
    'courier_location', CASE WHEN _loc.id IS NULL THEN NULL ELSE jsonb_build_object(
        'latitude', _loc.latitude, 'longitude', _loc.longitude,
        'accuracy', _loc.accuracy, 'captured_at', _loc.created_at) END);
END $fn$;

REVOKE ALL ON FUNCTION public.neo_guest_delivery_live(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.neo_guest_delivery_live(uuid, text) TO authenticated, service_role;

INSERT INTO public.privileged_function_review
  (function_name, identity_arguments, reachability, sensitive, establishes_tenant_context,
   classification, trusts_client_tenant, search_path_fixed, domain, review_note, reviewed_at)
VALUES
  ('neo_rider_report_location', '_delivery uuid, _lat numeric, _lng numeric, _accuracy numeric, _heading numeric, _speed numeric',
   'app_callable', false, true, 'tenant_validated_privileged', false, true, 'other',
   'Rider app position update. Accepts a point only from the rider actually assigned to that delivery, only while the run is active, and only where the property has tracking switched on.', now()),
  ('neo_guest_delivery_live', '_org uuid, _reference text',
   'app_callable', false, true, 'tenant_validated_privileged', false, true, 'other',
   'Customer view of their own delivery: destination, courier first name/vehicle, contact where the property allows it, and the courier''s latest position while the run is live.', now())
ON CONFLICT DO NOTHING;