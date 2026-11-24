BEGIN;

-- Public Delivery requires a published workspace on an active, matching property.
-- This projection allows the public site to resolve it without a service key.
CREATE OR REPLACE FUNCTION public.neo_public_delivery_workspace(_slug text)
RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $function$
  WITH requested AS (
    SELECT lower(btrim(_slug)) AS slug, public.neo_public_property(_slug) AS property
    WHERE length(btrim(_slug)) BETWEEN 1 AND 80
  ), candidates AS (
    SELECT w.*, b.currency, e.public_slug AS property_slug, lower(w.slug) = r.slug AS exact_slug
    FROM requested r
    JOIN public.public_workspaces w ON w.app_key = 'delivery' AND w.published IS TRUE
    JOIN public.branches b ON b.id = w.branch_id AND b.organization_id = w.organization_id AND b.active IS TRUE
    LEFT JOIN public.neo_public_experience e ON e.branch_id = b.id AND e.organization_id = b.organization_id
    WHERE public.neo_platform_tenant_active(w.organization_id)
      AND (r.property IS NULL OR (r.property->>'branch_id' = b.id::text AND r.property->>'organization_id' = b.organization_id::text))
      AND (lower(w.slug) = r.slug OR r.property IS NOT NULL)
    ORDER BY (lower(w.slug) = r.slug) DESC
    LIMIT 2
  ), priority AS (
    SELECT c.* FROM candidates c
    WHERE c.exact_slug OR NOT EXISTS (SELECT 1 FROM candidates e WHERE e.exact_slug)
  )
  SELECT jsonb_build_object(
    'id', w.id, 'organization_id', w.organization_id, 'branch_id', w.branch_id,
    'app_key', 'delivery', 'slug', w.slug, 'published', true, 'currency', w.currency,
    'app_name', w.app_name, 'hotel_name', w.hotel_name,
    'logo_url', coalesce(nullif(w.logo_url, ''), p.property#>>'{media,logo_url}', p.property->>'logo_url'),
    'icon_url', w.icon_url, 'hero_url', coalesce(p.property#>>'{media,hero_url}', p.property->>'cover_image_url'),
    'primary_color', coalesce(nullif(w.primary_color, ''), p.property#>>'{brand,primary}', '#18C4C8'),
    'secondary_color', coalesce(nullif(w.secondary_color, ''), p.property#>>'{brand,accent}', '#07142D'),
    'background_color', coalesce(nullif(w.background_color, ''), p.property#>>'{brand,surface}', '#F7F9FC'),
    'button_style', w.button_style, 'menu_style', w.menu_style,
    'welcome_title', w.welcome_title, 'welcome_message', w.welcome_message,
    'contact_phone', coalesce(nullif(w.contact_phone, ''), p.property->>'phone'),
    'contact_email', coalesce(nullif(w.contact_email, ''), p.property->>'email'),
    'contact_address', coalesce(nullif(w.contact_address, ''), p.property->>'address'),
    'support_details', w.support_details, 'terms_text', w.terms_text, 'policy_text', w.policy_text,
    'features', w.features
  ) || CASE WHEN p.property->>'publicly_listed' = 'true' AND p.property#>>'{doors,stay_dine}' IS DISTINCT FROM 'false'
       THEN jsonb_build_object('guest_slug', p.property->>'public_slug') ELSE '{}'::jsonb END
  FROM priority w
  CROSS JOIN LATERAL (SELECT public.neo_public_property(w.property_slug) AS property) p
  WHERE (SELECT count(*) FROM priority) = 1;
$function$;
REVOKE ALL ON FUNCTION public.neo_public_delivery_workspace(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.neo_public_delivery_workspace(text) TO anon, authenticated, service_role;

-- Staff see the expected links for one authorised property so the dashboard
-- can compare the live anonymous response with the publication records.
CREATE OR REPLACE FUNCTION public.neo_platform_public_app_targets(_branch uuid)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $function$
DECLARE
  _org uuid := public.current_org_id();
  _slug text;
  _delivery_slugs text[];
  _property jsonb;
BEGIN
  IF auth.uid() IS NULL OR _org IS NULL OR public.neo_branch_in_scope(_branch) IS NOT TRUE OR
     (public.is_org_admin() OR public.has_permission('platform','readiness','view') OR
      public.has_permission('platform','quality','view')) IS NOT TRUE THEN
    RAISE EXCEPTION 'Not permitted to check public links for this property' USING ERRCODE = '42501';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.branches WHERE id = _branch AND organization_id = _org AND active IS TRUE) THEN
    RAISE EXCEPTION 'Select an active property in this organisation' USING ERRCODE = '42501';
  END IF;

  SELECT e.public_slug INTO _slug FROM public.neo_public_experience e
    WHERE e.branch_id = _branch AND e.organization_id = _org;
  _property := public.neo_public_property(_slug);
  SELECT array_agg(w.slug ORDER BY w.slug) INTO _delivery_slugs FROM public.public_workspaces w
    WHERE w.branch_id = _branch AND w.organization_id = _org AND w.app_key = 'delivery' AND w.published IS TRUE;

  RETURN jsonb_build_array(
    jsonb_build_object('app', 'guest', 'slug', _slug,
      'state', CASE WHEN _property->>'publicly_listed' = 'true' AND _property#>>'{doors,stay_dine}' IS DISTINCT FROM 'false'
               THEN 'published' ELSE 'unpublished' END),
    jsonb_build_object('app', 'delivery', 'slug', coalesce(_delivery_slugs[1], _slug),
      'state', CASE WHEN coalesce(cardinality(_delivery_slugs),0) > 1 THEN 'ambiguous'
                    WHEN _delivery_slugs[1] IS NOT NULL THEN 'published' ELSE 'unpublished' END)
  );
END;
$function$;
REVOKE ALL ON FUNCTION public.neo_platform_public_app_targets(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.neo_platform_public_app_targets(uuid) TO authenticated, service_role;

NOTIFY pgrst, 'reload schema';
COMMIT;
