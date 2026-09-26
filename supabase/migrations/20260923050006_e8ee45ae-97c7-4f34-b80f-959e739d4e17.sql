DROP FUNCTION IF EXISTS public.neo_public_directory(text, integer, text, text);
CREATE OR REPLACE FUNCTION public.neo_public_directory(_search text DEFAULT NULL::text, _limit integer DEFAULT 40, _place text DEFAULT NULL::text, _service text DEFAULT NULL::text)
 RETURNS TABLE(branch_id uuid, organization_id uuid, public_slug text, property_name text, organization_name text, tagline text, summary text, city text, country text, logo_url text, cover_image_url text, services jsonb, brand jsonb, media jsonb, from_rate numeric, currency text, room_type_count integer)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT b.id, b.organization_id, e.public_slug,
         COALESCE(NULLIF(e.display_name,''), b.name),
         o.name, e.tagline, e.summary, b.city, b.country,
         b.logo_url, e.cover_image_url, e.services,
         COALESCE(e.brand,'{}'::jsonb), COALESCE(e.media,'{}'::jsonb),
         r.from_rate, COALESCE(r.currency, b.currency), COALESCE(r.room_type_count, 0)
  FROM public.neo_public_experience e
  JOIN public.branches b ON b.id = e.branch_id
  JOIN public.organizations o ON o.id = b.organization_id
  LEFT JOIN LATERAL (
    SELECT MIN(rp.base_rate) AS from_rate,
           MIN(rp.currency) AS currency,
           COUNT(DISTINCT rt.id)::int AS room_type_count
    FROM public.room_types rt
    LEFT JOIN public.rate_plans rp
      ON rp.room_type_id = rt.id AND rp.status = 'active' AND rp.corporate_only IS NOT TRUE
    WHERE rt.branch_id = b.id AND rt.status = 'active'
  ) r ON TRUE
  WHERE e.discoverable IS TRUE
    AND b.active IS TRUE
    AND public.neo_platform_tenant_active(b.organization_id)
    AND public.neo_platform_listing_eligible(b.id)
    AND (
      _search IS NULL OR btrim(_search) = ''
      OR b.name ILIKE '%' || btrim(_search) || '%'
      OR o.name ILIKE '%' || btrim(_search) || '%'
      OR COALESCE(e.display_name,'') ILIKE '%' || btrim(_search) || '%'
      OR COALESCE(e.tagline,'') ILIKE '%' || btrim(_search) || '%'
      OR COALESCE(e.summary,'') ILIKE '%' || btrim(_search) || '%'
      OR COALESCE(b.city,'') ILIKE '%' || btrim(_search) || '%'
      OR COALESCE(b.country,'') ILIKE '%' || btrim(_search) || '%'
    )
    AND (
      _place IS NULL OR btrim(_place) = ''
      OR COALESCE(b.city,'') = btrim(_place)
      OR COALESCE(b.country,'') = btrim(_place)
    )
    AND (
      _service IS NULL OR btrim(_service) = ''
      OR COALESCE(e.services,'{}'::jsonb) -> btrim(_service) = 'true'::jsonb
    )
  ORDER BY b.name
  LIMIT GREATEST(1, LEAST(COALESCE(_limit, 40), 100));
$function$;

CREATE OR REPLACE FUNCTION public.neo_public_property_rooms(_slug text)
 RETURNS TABLE(room_type_id uuid, name text, description text, max_occupancy integer, bed_configuration text, amenities text[], images text[], from_rate numeric, currency text)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT rt.id, rt.name, NULLIF(rt.description,''), rt.max_occupancy, NULLIF(rt.bed_configuration,''),
         COALESCE(rt.amenities, ARRAY[]::text[]), COALESCE(rt.images, ARRAY[]::text[]),
         r.from_rate, COALESCE(r.currency, b.currency)
  FROM public.neo_public_experience e
  JOIN public.branches b ON b.id = e.branch_id
  JOIN public.room_types rt ON rt.branch_id = b.id AND rt.status = 'active'
  LEFT JOIN LATERAL (
    SELECT MIN(rp.base_rate) AS from_rate, MIN(rp.currency) AS currency
    FROM public.rate_plans rp
    WHERE rp.room_type_id = rt.id AND rp.status = 'active' AND rp.corporate_only IS NOT TRUE
  ) r ON TRUE
  WHERE lower(e.public_slug) = lower(btrim(_slug))
    AND e.discoverable IS TRUE
    AND b.active IS TRUE
    AND public.neo_platform_tenant_active(b.organization_id)
    AND public.neo_platform_listing_eligible(b.id)
  ORDER BY r.from_rate NULLS LAST, rt.sort_order, rt.name;
$function$;

GRANT EXECUTE ON FUNCTION public.neo_public_directory(text, integer, text, text) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.neo_public_property_rooms(text) TO anon, authenticated;