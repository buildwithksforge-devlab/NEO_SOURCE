CREATE TABLE IF NOT EXISTS public.platform_property_listing (
  branch_id uuid PRIMARY KEY REFERENCES public.branches(id) ON DELETE CASCADE,
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  listing_state text NOT NULL DEFAULT 'eligible' CHECK (listing_state IN ('eligible','blocked')),
  reason text,
  updated_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT ON public.platform_property_listing TO authenticated;
GRANT ALL ON public.platform_property_listing TO service_role;
ALTER TABLE public.platform_property_listing ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Platform operators read property listing" ON public.platform_property_listing;
CREATE POLICY "Platform operators read property listing"
  ON public.platform_property_listing FOR SELECT TO authenticated
  USING (public.is_platform_admin());

DROP POLICY IF EXISTS "Platform operators manage property listing" ON public.platform_property_listing;
CREATE POLICY "Platform operators manage property listing"
  ON public.platform_property_listing FOR ALL TO authenticated
  USING (public.is_platform_admin())
  WITH CHECK (public.is_platform_admin());

CREATE OR REPLACE FUNCTION public.neo_platform_tenant_active(_org uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
  SELECT COALESCE(
    (SELECT lower(s.state) = 'active' FROM public.tenant_lifecycle_states s WHERE s.organization_id = _org),
    true);
$$;

CREATE OR REPLACE FUNCTION public.neo_platform_listing_eligible(_branch uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
  SELECT COALESCE(
    (SELECT l.listing_state = 'eligible' FROM public.platform_property_listing l WHERE l.branch_id = _branch),
    true);
$$;

CREATE OR REPLACE FUNCTION public.neo_public_directory(_search text DEFAULT NULL::text, _limit integer DEFAULT 40)
 RETURNS TABLE(branch_id uuid, organization_id uuid, public_slug text, property_name text, organization_name text, tagline text, summary text, city text, country text, logo_url text, cover_image_url text, services jsonb)
 LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$
  SELECT b.id, b.organization_id, e.public_slug,
         COALESCE(NULLIF(e.display_name,''), b.name),
         o.name, e.tagline, e.summary, b.city, b.country,
         b.logo_url, e.cover_image_url, e.services
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
    'portal_slug', b.portal_slug
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

CREATE OR REPLACE FUNCTION public.neo_my_entrances()
 RETURNS TABLE(branch_id uuid, organization_id uuid, property_name text, organization_name text,
               public_slug text, portal_slug text, logo_url text,
               work boolean, rider boolean, partner boolean)
 LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$
  WITH me AS (SELECT auth.uid() AS uid),
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
  SELECT b.id, b.organization_id,
         COALESCE(NULLIF(e.display_name,''), b.name), o.name,
         e.public_slug, b.portal_slug, b.logo_url,
         (b.organization_id IN (SELECT organization_id FROM staff_orgs))
           AND COALESCE((e.doors ->> 'work')::boolean, true),
         EXISTS (SELECT 1 FROM rider_rows r WHERE r.organization_id = b.organization_id
                   AND (r.branch_id IS NULL OR r.branch_id = b.id))
           AND COALESCE((e.doors ->> 'rider')::boolean, true),
         EXISTS (SELECT 1 FROM partner_rows p WHERE p.organization_id = b.organization_id
                   AND (p.branch_id IS NULL OR p.branch_id = b.id))
           AND COALESCE((e.doors ->> 'partner')::boolean, true)
    FROM public.branches b
    JOIN public.organizations o ON o.id = b.organization_id
    LEFT JOIN public.neo_public_experience e ON e.branch_id = b.id
   WHERE b.active IS TRUE
     AND public.neo_platform_tenant_active(b.organization_id)
     AND (
       b.organization_id IN (SELECT organization_id FROM staff_orgs)
       OR EXISTS (SELECT 1 FROM rider_rows r WHERE r.organization_id = b.organization_id
                    AND (r.branch_id IS NULL OR r.branch_id = b.id))
       OR EXISTS (SELECT 1 FROM partner_rows p WHERE p.organization_id = b.organization_id
                    AND (p.branch_id IS NULL OR p.branch_id = b.id))
     )
   ORDER BY o.name, b.name
   LIMIT 24;
$function$;

CREATE OR REPLACE FUNCTION public.neo_platform_console()
 RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE _out jsonb;
BEGIN
  IF NOT public.is_platform_admin() THEN
    RETURN jsonb_build_object('allowed', false, 'operators', (SELECT count(*) FROM public.platform_admins WHERE active));
  END IF;

  SELECT jsonb_build_object(
    'allowed', true,
    'operators', (SELECT count(*) FROM public.platform_admins WHERE active),
    'businesses', COALESCE(jsonb_agg(x.row ORDER BY x.name), '[]'::jsonb)
  ) INTO _out
  FROM (
    SELECT o.name,
      jsonb_build_object(
        'organization_id', o.id,
        'name', o.name,
        'legal_name', o.legal_name,
        'business_type', o.business_type,
        'created_at', o.created_at,
        'tenant_state', COALESCE((SELECT s.state FROM public.tenant_lifecycle_states s WHERE s.organization_id = o.id), 'active'),
        'grace_until', (SELECT s.grace_until FROM public.tenant_lifecycle_states s WHERE s.organization_id = o.id),
        'properties', COALESCE((
          SELECT jsonb_agg(jsonb_build_object(
            'branch_id', b.id,
            'name', b.name,
            'city', b.city,
            'country', b.country,
            'active', b.active,
            'public_slug', e.public_slug,
            'hotel_discovery', COALESCE(e.discoverable, false),
            'listing_state', COALESCE(l.listing_state, 'eligible'),
            'listing_reason', l.reason,
            'listed', COALESCE(e.discoverable, false)
              AND b.active
              AND COALESCE(l.listing_state, 'eligible') = 'eligible'
              AND public.neo_platform_tenant_active(o.id)
          ) ORDER BY b.name)
          FROM public.branches b
          LEFT JOIN public.neo_public_experience e ON e.branch_id = b.id
          LEFT JOIN public.platform_property_listing l ON l.branch_id = b.id
          WHERE b.organization_id = o.id
        ), '[]'::jsonb)
      ) AS row
    FROM public.organizations o
  ) x;

  RETURN _out;
END;
$function$;

CREATE OR REPLACE FUNCTION public.neo_platform_set_listing(_branch uuid, _state text, _reason text DEFAULT NULL)
 RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE _org uuid;
BEGIN
  IF NOT public.is_platform_admin() THEN
    RAISE EXCEPTION 'not_platform_operator';
  END IF;
  IF _state NOT IN ('eligible','blocked') THEN
    RAISE EXCEPTION 'invalid_listing_state';
  END IF;
  SELECT organization_id INTO _org FROM public.branches WHERE id = _branch;
  IF _org IS NULL THEN
    RAISE EXCEPTION 'unknown_property';
  END IF;

  INSERT INTO public.platform_property_listing (branch_id, organization_id, listing_state, reason, updated_by, updated_at)
  VALUES (_branch, _org, _state, NULLIF(btrim(COALESCE(_reason,'')), ''), auth.uid(), now())
  ON CONFLICT (branch_id) DO UPDATE
    SET listing_state = EXCLUDED.listing_state,
        reason = EXCLUDED.reason,
        updated_by = EXCLUDED.updated_by,
        updated_at = now();

  RETURN jsonb_build_object('branch_id', _branch, 'listing_state', _state);
END;
$function$;

GRANT EXECUTE ON FUNCTION public.neo_platform_tenant_active(uuid) TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.neo_platform_listing_eligible(uuid) TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.neo_my_entrances() TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.neo_platform_console() TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.neo_platform_set_listing(uuid, text, text) TO authenticated, service_role;