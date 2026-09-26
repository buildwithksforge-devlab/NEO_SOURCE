DROP FUNCTION IF EXISTS public.neo_public_directory(text, integer);

CREATE OR REPLACE FUNCTION public.neo_public_directory(
  _search text DEFAULT NULL,
  _limit integer DEFAULT 40,
  _place text DEFAULT NULL,
  _service text DEFAULT NULL
)
RETURNS TABLE(branch_id uuid, organization_id uuid, public_slug text, property_name text, organization_name text, tagline text, summary text, city text, country text, logo_url text, cover_image_url text, services jsonb, brand jsonb, media jsonb)
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  SELECT b.id, b.organization_id, e.public_slug,
         COALESCE(NULLIF(e.display_name,''), b.name),
         o.name, e.tagline, e.summary, b.city, b.country,
         b.logo_url, e.cover_image_url, e.services,
         COALESCE(e.brand,'{}'::jsonb), COALESCE(e.media,'{}'::jsonb)
  FROM public.neo_public_experience e
  JOIN public.branches b ON b.id = e.branch_id
  JOIN public.organizations o ON o.id = b.organization_id
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

CREATE OR REPLACE FUNCTION public.neo_public_destinations()
RETURNS TABLE(place text, hotels bigint)
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  SELECT COALESCE(NULLIF(b.city,''), b.country) AS place, count(*) AS hotels
  FROM public.neo_public_experience e
  JOIN public.branches b ON b.id = e.branch_id
  WHERE e.discoverable IS TRUE
    AND b.active IS TRUE
    AND public.neo_platform_tenant_active(b.organization_id)
    AND public.neo_platform_listing_eligible(b.id)
    AND COALESCE(NULLIF(b.city,''), b.country) IS NOT NULL
  GROUP BY 1
  ORDER BY 2 DESC, 1 ASC
  LIMIT 100;
$function$;

GRANT EXECUTE ON FUNCTION public.neo_public_directory(text, integer, text, text) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.neo_public_destinations() TO anon, authenticated;