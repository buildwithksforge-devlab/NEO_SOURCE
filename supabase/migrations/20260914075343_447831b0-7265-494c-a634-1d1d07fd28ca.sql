ALTER TABLE public.branches
  ADD COLUMN IF NOT EXISTS pickup_latitude numeric,
  ADD COLUMN IF NOT EXISTS pickup_longitude numeric;

COMMENT ON COLUMN public.branches.pickup_latitude IS
  'Administrator-entered latitude of the delivery pickup point. Used to measure real delivery distances; never inferred.';
COMMENT ON COLUMN public.branches.pickup_longitude IS
  'Administrator-entered longitude of the delivery pickup point. Used to measure real delivery distances; never inferred.';

CREATE OR REPLACE FUNCTION public.neo_geo_distance_km(
  _lat1 numeric, _lon1 numeric, _lat2 numeric, _lon2 numeric
) RETURNS numeric
LANGUAGE sql IMMUTABLE SET search_path TO 'public'
AS $function$
  SELECT CASE
    WHEN _lat1 IS NULL OR _lon1 IS NULL OR _lat2 IS NULL OR _lon2 IS NULL THEN NULL
    ELSE round((
      6371 * 2 * asin(least(1, sqrt(
        power(sin(radians(_lat2::double precision - _lat1::double precision) / 2), 2)
        + cos(radians(_lat1::double precision)) * cos(radians(_lat2::double precision))
        * power(sin(radians(_lon2::double precision - _lon1::double precision) / 2), 2)
      )))
    )::numeric, 2)
  END
$function$;

REVOKE ALL ON FUNCTION public.neo_geo_distance_km(numeric,numeric,numeric,numeric) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.neo_geo_distance_km(numeric,numeric,numeric,numeric) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.neo_delivery_route_log(
  _branch uuid DEFAULT NULL, _from date DEFAULT NULL, _to date DEFAULT NULL, _limit integer DEFAULT 100
) RETURNS TABLE(
  order_id uuid, order_number text, rider_id uuid, rider_name text,
  zone_name text, delivered_at timestamptz, minutes numeric,
  distance_km numeric, distance_source text,
  minutes_per_km numeric, km_per_hour numeric
)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE _org uuid := public.current_org_id();
  _f timestamptz := coalesce(_from, (now() - interval '30 days')::date)::timestamptz;
  _t timestamptz := (coalesce(_to, now()::date) + 1)::timestamptz;
BEGIN
  IF _org IS NULL THEN RETURN; END IF;
  IF NOT (public.has_permission('delivery','dispatch.view')
          OR public.has_permission('delivery','riders.manage')
          OR public.is_org_admin_for(_org)) THEN
    RAISE EXCEPTION 'insufficient_privilege' USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
  WITH base AS (
    SELECT o.id, o.order_number, o.rider_id, r.display_name AS rider_name,
           z.name AS zone_name, o.delivered_at,
           round(extract(epoch FROM (o.delivered_at - coalesce(o.collected_at, o.ready_at))) / 60.0, 1) AS mins,
           b.pickup_latitude AS plat, b.pickup_longitude AS plon,
           p.latitude AS proof_lat, p.longitude AS proof_lon,
           o.latitude AS dest_lat, o.longitude AS dest_lon,
           z.configured_distance_km AS zone_km
      FROM public.delivery_orders o
      JOIN public.branches b ON b.id = o.branch_id
      LEFT JOIN public.rider_profiles r ON r.id = o.rider_id
      LEFT JOIN public.delivery_zones z ON z.id = o.zone_id AND z.organization_id = _org
      LEFT JOIN LATERAL (
        SELECT dp.latitude, dp.longitude FROM public.delivery_proofs dp
         WHERE dp.delivery_order_id = o.id AND dp.latitude IS NOT NULL
         ORDER BY dp.confirmed_at DESC NULLS LAST LIMIT 1
      ) p ON true
     WHERE o.organization_id = _org
       AND o.order_status = 'delivered'
       AND o.delivered_at >= _f AND o.delivered_at < _t
       AND (_branch IS NULL OR o.branch_id = _branch)
       AND public.neo_branch_in_scope(o.branch_id)
  ), measured AS (
    SELECT base.*,
      CASE
        WHEN plat IS NOT NULL AND proof_lat IS NOT NULL
          THEN public.neo_geo_distance_km(plat, plon, proof_lat, proof_lon)
        WHEN plat IS NOT NULL AND dest_lat IS NOT NULL
          THEN public.neo_geo_distance_km(plat, plon, dest_lat, dest_lon)
        ELSE zone_km
      END AS km,
      CASE
        WHEN plat IS NOT NULL AND proof_lat IS NOT NULL THEN 'confirmed-location'
        WHEN plat IS NOT NULL AND dest_lat IS NOT NULL THEN 'address-location'
        WHEN zone_km IS NOT NULL THEN 'zone-distance'
        ELSE 'not-measured'
      END AS src
      FROM base
  )
  SELECT m.id, m.order_number, m.rider_id, m.rider_name, m.zone_name, m.delivered_at,
         m.mins, m.km, m.src,
         CASE WHEN m.km > 0 AND m.mins IS NOT NULL THEN round(m.mins / m.km, 1) END,
         CASE WHEN m.km > 0 AND m.mins > 0 THEN round(m.km / (m.mins / 60.0), 1) END
    FROM measured m
   ORDER BY m.delivered_at DESC
   LIMIT greatest(coalesce(_limit, 100), 1);
END
$function$;

REVOKE ALL ON FUNCTION public.neo_delivery_route_log(uuid,date,date,integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.neo_delivery_route_log(uuid,date,date,integer) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.neo_delivery_rider_routes(
  _branch uuid DEFAULT NULL, _from date DEFAULT NULL, _to date DEFAULT NULL
) RETURNS TABLE(
  rider_id uuid, rider_name text, measured_deliveries integer, unmeasured_deliveries integer,
  total_km numeric, avg_km numeric, avg_minutes numeric, avg_minutes_per_km numeric, avg_km_per_hour numeric
)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$
BEGIN
  RETURN QUERY
  SELECT l.rider_id,
         max(l.rider_name),
         count(*) FILTER (WHERE l.distance_source <> 'not-measured')::int,
         count(*) FILTER (WHERE l.distance_source = 'not-measured')::int,
         round(coalesce(sum(l.distance_km), 0), 2),
         round(avg(l.distance_km), 2),
         round(avg(l.minutes), 1),
         round(sum(l.minutes) FILTER (WHERE l.distance_km > 0) / nullif(sum(l.distance_km), 0), 1),
         round(sum(l.distance_km) / nullif(sum(l.minutes) FILTER (WHERE l.distance_km > 0) / 60.0, 0), 1)
    FROM public.neo_delivery_route_log(_branch, _from, _to, 100000) l
   WHERE l.rider_id IS NOT NULL
   GROUP BY l.rider_id
   ORDER BY 2;
END
$function$;

REVOKE ALL ON FUNCTION public.neo_delivery_rider_routes(uuid,date,date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.neo_delivery_rider_routes(uuid,date,date) TO authenticated, service_role;