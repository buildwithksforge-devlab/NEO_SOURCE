-- 1. First-operator bootstrap. Deliberately refuses once ANY operator exists,
-- so it can never be used to escalate into an established platform.
CREATE OR REPLACE FUNCTION public.neo_platform_claim_first_operator()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE _uid uuid := auth.uid();
BEGIN
  IF _uid IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'Sign in first.');
  END IF;
  IF EXISTS (SELECT 1 FROM public.platform_admins) THEN
    RETURN jsonb_build_object('ok', false, 'reason',
      'A NEØ platform operator is already registered. Ask an existing operator to add you.');
  END IF;

  INSERT INTO public.platform_admins (user_id, platform_role, active, notes)
  VALUES (_uid, 'owner', true, 'First platform operator, self-registered while none existed.');

  RETURN jsonb_build_object('ok', true, 'user_id', _uid);
END;
$$;

REVOKE EXECUTE ON FUNCTION public.neo_platform_claim_first_operator() FROM public, anon;
GRANT EXECUTE ON FUNCTION public.neo_platform_claim_first_operator() TO authenticated;

-- 2. Console dashboard: platform totals and per-business entitlements alongside
-- the existing business/property/tenant/discovery records.
CREATE OR REPLACE FUNCTION public.neo_platform_console()
RETURNS jsonb
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE _out jsonb; _businesses jsonb;
BEGIN
  IF NOT public.is_platform_admin() THEN
    RETURN jsonb_build_object('allowed', false,
      'operators', (SELECT count(*) FROM public.platform_admins WHERE active));
  END IF;

  SELECT COALESCE(jsonb_agg(x.row ORDER BY x.name), '[]'::jsonb) INTO _businesses
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
        'entitlements', COALESCE((
          SELECT jsonb_agg(jsonb_build_object(
            'key', f.key,
            'name', f.name,
            'enabled', COALESCE(ov.enabled, f.default_enabled),
            'source', CASE WHEN ov.id IS NULL THEN 'platform default' ELSE 'business override' END
          ) ORDER BY f.key)
          FROM public.feature_flags f
          LEFT JOIN public.feature_flag_overrides ov
            ON ov.flag_id = f.id AND ov.organization_id = o.id AND ov.branch_id IS NULL
        ), '[]'::jsonb),
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

  SELECT jsonb_build_object(
    'allowed', true,
    'operators', (SELECT count(*) FROM public.platform_admins WHERE active),
    'businesses', _businesses,
    'summary', jsonb_build_object(
      'businesses', jsonb_array_length(_businesses),
      'properties', (SELECT count(*) FROM public.branches),
      'listed', (
        SELECT count(*) FROM public.branches b
        LEFT JOIN public.neo_public_experience e ON e.branch_id = b.id
        LEFT JOIN public.platform_property_listing l ON l.branch_id = b.id
        WHERE COALESCE(e.discoverable, false) AND b.active
          AND COALESCE(l.listing_state, 'eligible') = 'eligible'
          AND public.neo_platform_tenant_active(b.organization_id)),
      'blocked', (SELECT count(*) FROM public.platform_property_listing WHERE listing_state = 'blocked'),
      'suspended_tenants', (SELECT count(*) FROM public.tenant_lifecycle_states WHERE lower(state) <> 'active')
    )
  ) INTO _out;

  RETURN _out;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.neo_platform_console() FROM public, anon;
GRANT EXECUTE ON FUNCTION public.neo_platform_console() TO authenticated;

-- 3. Hotel-side listing readiness: what this property still needs before NEØ
-- can show it publicly, and which of those the hotel itself controls.
CREATE OR REPLACE FUNCTION public.neo_property_listing_status(_branch uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE _b public.branches; _e public.neo_public_experience; _listing text; _tenant boolean;
BEGIN
  SELECT * INTO _b FROM public.branches WHERE id = _branch;
  IF _b.id IS NULL THEN RETURN NULL; END IF;

  -- Never answer about another workspace's property.
  IF _b.organization_id <> public.current_org_id() THEN
    RAISE EXCEPTION 'Property does not belong to your workspace';
  END IF;

  SELECT * INTO _e FROM public.neo_public_experience WHERE branch_id = _branch;
  SELECT COALESCE(l.listing_state, 'eligible') INTO _listing
    FROM public.platform_property_listing l WHERE l.branch_id = _branch;
  _listing := COALESCE(_listing, 'eligible');
  _tenant := public.neo_platform_tenant_active(_b.organization_id);

  RETURN jsonb_build_object(
    'branch_id', _b.id,
    'property_name', _b.name,
    'public_slug', _e.public_slug,
    'tenant_active', _tenant,
    'property_active', _b.active,
    'platform_eligible', _listing = 'eligible',
    'hotel_discovery', COALESCE(_e.discoverable, false),
    'has_public_experience', _e.id IS NOT NULL,
    'publicly_discoverable', _tenant AND _b.active AND _listing = 'eligible' AND COALESCE(_e.discoverable, false)
  );
END;
$$;

REVOKE EXECUTE ON FUNCTION public.neo_property_listing_status(uuid) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.neo_property_listing_status(uuid) TO authenticated;