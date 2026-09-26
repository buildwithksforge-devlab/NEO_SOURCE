ALTER TABLE public.neo_public_experience
  ADD COLUMN IF NOT EXISTS brand jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS media jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS content jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS published_at timestamptz,
  ADD COLUMN IF NOT EXISTS published_by uuid;

DROP FUNCTION IF EXISTS public.neo_public_directory(text, integer);

CREATE OR REPLACE FUNCTION public.neo_public_directory(_search text DEFAULT NULL::text, _limit integer DEFAULT 40)
 RETURNS TABLE(branch_id uuid, organization_id uuid, public_slug text, property_name text, organization_name text, tagline text, summary text, city text, country text, logo_url text, cover_image_url text, services jsonb, brand jsonb, media jsonb)
 LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
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
      OR COALESCE(b.city,'') ILIKE '%' || btrim(_search) || '%'
      OR COALESCE(b.country,'') ILIKE '%' || btrim(_search) || '%'
    )
  ORDER BY b.name
  LIMIT GREATEST(1, LEAST(COALESCE(_limit, 40), 100));
$function$;

REVOKE ALL ON FUNCTION public.neo_public_directory(text, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.neo_public_directory(text, integer) TO anon, authenticated;

CREATE OR REPLACE FUNCTION public.neo_public_property(_slug text)
 RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$
  SELECT jsonb_build_object(
    'branch_id', b.id,
    'organization_id', b.organization_id,
    'public_slug', e.public_slug,
    'property_name', COALESCE(NULLIF(e.display_name,''), b.name),
    'organization_name', o.name,
    'tagline', e.tagline,
    'summary', e.summary,
    'city', b.city,
    'country', b.country,
    'phone', b.phone,
    'email', b.email,
    'address', b.address,
    'logo_url', b.logo_url,
    'cover_image_url', e.cover_image_url,
    'services', e.services,
    'doors', e.doors,
    'portal_slug', b.portal_slug,
    'brand', COALESCE(e.brand,'{}'::jsonb),
    'media', COALESCE(e.media,'{}'::jsonb),
    'content', COALESCE(e.content,'{}'::jsonb),
    'publicly_listed', COALESCE(e.discoverable,false)
  )
  FROM public.neo_public_experience e
  JOIN public.branches b ON b.id = e.branch_id
  JOIN public.organizations o ON o.id = b.organization_id
  WHERE lower(e.public_slug) = lower(btrim(_slug))
    AND b.active IS TRUE
    AND public.neo_platform_tenant_active(b.organization_id)
    AND public.neo_platform_listing_eligible(b.id)
  LIMIT 1;
$function$;

CREATE OR REPLACE FUNCTION public.neo_relationship_property(_key text)
 RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$
  WITH me AS (SELECT auth.uid() AS uid),
  key AS (SELECT lower(btrim(COALESCE(_key,''))) AS k),
  staff_orgs AS (
    SELECT p.organization_id FROM public.profiles p, me
     WHERE p.id = me.uid
       AND COALESCE(p.account_status,'active') = 'active'
       AND COALESCE(p.account_type,'staff') <> 'customer'
       AND p.organization_id IS NOT NULL
  ),
  rider_rows AS (
    SELECT r.organization_id, r.branch_id FROM public.rider_profiles r, me
     WHERE r.active IS TRUE
       AND (r.profile_id = me.uid
            OR r.employee_id IN (SELECT e.id FROM public.employees e WHERE e.profile_id = me.uid))
  ),
  partner_rows AS (
    SELECT a.organization_id, a.branch_id FROM public.neo_access_relationships a, me
     WHERE a.auth_user_id = me.uid AND a.door = 'partner' AND a.status = 'active'
  )
  SELECT jsonb_build_object(
    'branch_id', b.id,
    'organization_id', b.organization_id,
    'public_slug', COALESCE(e.public_slug, b.portal_slug, b.id::text),
    'property_name', COALESCE(NULLIF(e.display_name,''), b.name),
    'organization_name', o.name,
    'tagline', e.tagline,
    'summary', e.summary,
    'city', b.city,
    'country', b.country,
    'phone', b.phone,
    'email', b.email,
    'address', b.address,
    'logo_url', b.logo_url,
    'cover_image_url', e.cover_image_url,
    'services', COALESCE(e.services, '{}'::jsonb),
    'doors', COALESCE(e.doors, '{}'::jsonb),
    'portal_slug', b.portal_slug,
    'brand', COALESCE(e.brand,'{}'::jsonb),
    'media', COALESCE(e.media,'{}'::jsonb),
    'content', COALESCE(e.content,'{}'::jsonb),
    'publicly_listed', COALESCE(e.discoverable, false),
    'via_relationship', true
  )
  FROM public.branches b
  JOIN public.organizations o ON o.id = b.organization_id
  LEFT JOIN public.neo_public_experience e ON e.branch_id = b.id
  CROSS JOIN key
  WHERE b.active IS TRUE
    AND public.neo_platform_tenant_active(b.organization_id)
    AND (
      lower(COALESCE(e.public_slug,'')) = key.k
      OR lower(COALESCE(b.portal_slug,'')) = key.k
      OR (key.k ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' AND b.id = key.k::uuid)
    )
    AND (
      b.organization_id IN (SELECT organization_id FROM staff_orgs)
      OR EXISTS (SELECT 1 FROM rider_rows r WHERE r.organization_id = b.organization_id
                   AND (r.branch_id IS NULL OR r.branch_id = b.id))
      OR EXISTS (SELECT 1 FROM partner_rows p WHERE p.organization_id = b.organization_id
                   AND (p.branch_id IS NULL OR p.branch_id = b.id))
    )
  LIMIT 1;
$function$;

REVOKE ALL ON FUNCTION public.neo_relationship_property(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.neo_relationship_property(text) TO authenticated;