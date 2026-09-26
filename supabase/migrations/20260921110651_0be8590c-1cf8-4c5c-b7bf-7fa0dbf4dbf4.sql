
CREATE TABLE IF NOT EXISTS public.neo_access_relationships (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  branch_id uuid REFERENCES public.branches(id) ON DELETE CASCADE,
  auth_user_id uuid NOT NULL,
  door text NOT NULL CHECK (door IN ('stay_dine','work','partner','rider')),
  relationship_type text NOT NULL CHECK (relationship_type IN (
    'customer','guest','employee','supplier','corporate_client','travel_agent',
    'tour_operator','contractor','service_provider','delivery_partner',
    'event_partner','professional_adviser','rider'
  )),
  party_kind text NOT NULL DEFAULT 'person' CHECK (party_kind IN ('person','organization')),
  party_display_name text,
  supplier_id uuid REFERENCES public.suppliers(id) ON DELETE CASCADE,
  corporate_account_id uuid REFERENCES public.corporate_accounts(id) ON DELETE CASCADE,
  employee_id uuid REFERENCES public.employees(id) ON DELETE CASCADE,
  customer_id uuid REFERENCES public.customers(id) ON DELETE CASCADE,
  rider_profile_id uuid REFERENCES public.rider_profiles(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended','revoked')),
  granted_by uuid,
  granted_at timestamptz NOT NULL DEFAULT now(),
  revoked_by uuid,
  revoked_at timestamptz,
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS neo_access_rel_unique
  ON public.neo_access_relationships (
    organization_id, COALESCE(branch_id, '00000000-0000-0000-0000-000000000000'::uuid),
    auth_user_id, door, relationship_type,
    COALESCE(supplier_id, '00000000-0000-0000-0000-000000000000'::uuid),
    COALESCE(corporate_account_id, '00000000-0000-0000-0000-000000000000'::uuid)
  );
CREATE INDEX IF NOT EXISTS neo_access_rel_user ON public.neo_access_relationships (auth_user_id, status);
CREATE INDEX IF NOT EXISTS neo_access_rel_org ON public.neo_access_relationships (organization_id, branch_id);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.neo_access_relationships TO authenticated;
GRANT ALL ON public.neo_access_relationships TO service_role;

ALTER TABLE public.neo_access_relationships ENABLE ROW LEVEL SECURITY;

CREATE POLICY neo_access_rel_read_own ON public.neo_access_relationships
  FOR SELECT TO authenticated
  USING (auth_user_id = auth.uid());

CREATE POLICY neo_access_rel_read_org ON public.neo_access_relationships
  FOR SELECT TO authenticated
  USING (organization_id = public.current_org_id());

CREATE POLICY neo_access_rel_write_admin ON public.neo_access_relationships
  FOR ALL TO authenticated
  USING (organization_id = public.current_org_id() AND public.is_org_admin_for(organization_id))
  WITH CHECK (organization_id = public.current_org_id() AND public.is_org_admin_for(organization_id));

CREATE TRIGGER neo_access_rel_touch
  BEFORE UPDATE ON public.neo_access_relationships
  FOR EACH ROW EXECUTE FUNCTION public.neo_touch_updated_at();

CREATE OR REPLACE FUNCTION public.neo_access_rel_no_self_grant()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF auth.uid() IS NOT NULL
     AND NEW.auth_user_id = auth.uid()
     AND NEW.door IN ('partner','rider','work')
     AND NOT public.is_org_admin_for(NEW.organization_id) THEN
    RAISE EXCEPTION 'Access to this entrance must be granted by the hotel.';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER neo_access_rel_guard
  BEFORE INSERT OR UPDATE ON public.neo_access_relationships
  FOR EACH ROW EXECUTE FUNCTION public.neo_access_rel_no_self_grant();

CREATE TABLE IF NOT EXISTS public.neo_public_experience (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  branch_id uuid NOT NULL UNIQUE REFERENCES public.branches(id) ON DELETE CASCADE,
  public_slug text NOT NULL UNIQUE,
  discoverable boolean NOT NULL DEFAULT false,
  display_name text,
  tagline text,
  summary text,
  cover_image_url text,
  services jsonb NOT NULL DEFAULT '{}'::jsonb,
  doors jsonb NOT NULL DEFAULT '{"stay_dine":true,"work":true,"partner":true,"rider":true}'::jsonb,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.neo_public_experience TO authenticated;
GRANT ALL ON public.neo_public_experience TO service_role;

ALTER TABLE public.neo_public_experience ENABLE ROW LEVEL SECURITY;

CREATE POLICY neo_public_exp_read_org ON public.neo_public_experience
  FOR SELECT TO authenticated
  USING (organization_id = public.current_org_id());

CREATE POLICY neo_public_exp_write_admin ON public.neo_public_experience
  FOR ALL TO authenticated
  USING (organization_id = public.current_org_id() AND public.is_org_admin_for(organization_id))
  WITH CHECK (organization_id = public.current_org_id() AND public.is_org_admin_for(organization_id));

CREATE TRIGGER neo_public_exp_touch
  BEFORE UPDATE ON public.neo_public_experience
  FOR EACH ROW EXECUTE FUNCTION public.neo_touch_updated_at();

CREATE OR REPLACE FUNCTION public.neo_public_directory(_search text DEFAULT NULL, _limit integer DEFAULT 40)
RETURNS TABLE (
  branch_id uuid,
  organization_id uuid,
  public_slug text,
  property_name text,
  organization_name text,
  tagline text,
  summary text,
  city text,
  country text,
  logo_url text,
  cover_image_url text,
  services jsonb
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT b.id, b.organization_id, e.public_slug,
         COALESCE(NULLIF(e.display_name,''), b.name),
         o.name, e.tagline, e.summary, b.city, b.country,
         b.logo_url, e.cover_image_url, e.services
  FROM public.neo_public_experience e
  JOIN public.branches b ON b.id = e.branch_id
  JOIN public.organizations o ON o.id = b.organization_id
  WHERE e.discoverable IS TRUE
    AND b.active IS TRUE
    AND (
      _search IS NULL OR btrim(_search) = ''
      OR b.name ILIKE '%' || btrim(_search) || '%'
      OR o.name ILIKE '%' || btrim(_search) || '%'
      OR COALESCE(b.city,'') ILIKE '%' || btrim(_search) || '%'
      OR COALESCE(b.country,'') ILIKE '%' || btrim(_search) || '%'
    )
  ORDER BY b.name
  LIMIT GREATEST(1, LEAST(COALESCE(_limit, 40), 100));
$$;

REVOKE ALL ON FUNCTION public.neo_public_directory(text, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.neo_public_directory(text, integer) TO anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.neo_public_property(_slug text)
RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
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
  LIMIT 1;
$$;

REVOKE ALL ON FUNCTION public.neo_public_property(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.neo_public_property(text) TO anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.neo_property_doors(_branch uuid)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  _uid uuid := auth.uid();
  _org uuid;
  _cfg public.neo_public_experience%ROWTYPE;
  _work boolean := false;
  _rider boolean := false;
  _partner boolean := false;
  _partner_names text[] := ARRAY[]::text[];
  _stay boolean := true;
BEGIN
  SELECT organization_id INTO _org FROM public.branches WHERE id = _branch AND active IS TRUE;
  IF _org IS NULL THEN
    RETURN jsonb_build_object('found', false);
  END IF;
  SELECT * INTO _cfg FROM public.neo_public_experience WHERE branch_id = _branch;

  IF _uid IS NOT NULL THEN
    SELECT EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.id = _uid
        AND p.organization_id = _org
        AND COALESCE(p.account_status,'active') = 'active'
        AND COALESCE(p.account_type,'staff') <> 'customer'
    ) INTO _work;

    SELECT EXISTS (
      SELECT 1 FROM public.rider_profiles r
      WHERE r.active IS TRUE
        AND r.organization_id = _org
        AND (r.branch_id IS NULL OR r.branch_id = _branch)
        AND (r.profile_id = _uid
             OR r.employee_id IN (SELECT e.id FROM public.employees e WHERE e.profile_id = _uid))
    ) INTO _rider;

    SELECT EXISTS (
      SELECT 1 FROM public.neo_access_relationships a
      WHERE a.auth_user_id = _uid AND a.door = 'partner' AND a.status = 'active'
        AND a.organization_id = _org
        AND (a.branch_id IS NULL OR a.branch_id = _branch)
    ) INTO _partner;

    SELECT COALESCE(array_agg(DISTINCT COALESCE(a.party_display_name, a.relationship_type)), ARRAY[]::text[])
      INTO _partner_names
    FROM public.neo_access_relationships a
    WHERE a.auth_user_id = _uid AND a.door = 'partner' AND a.status = 'active'
      AND a.organization_id = _org
      AND (a.branch_id IS NULL OR a.branch_id = _branch);
  END IF;

  IF _cfg.id IS NOT NULL THEN
    _stay := COALESCE((_cfg.doors ->> 'stay_dine')::boolean, true);
    IF COALESCE((_cfg.doors ->> 'work')::boolean, true) IS FALSE THEN _work := false; END IF;
    IF COALESCE((_cfg.doors ->> 'partner')::boolean, true) IS FALSE THEN _partner := false; END IF;
    IF COALESCE((_cfg.doors ->> 'rider')::boolean, true) IS FALSE THEN _rider := false; END IF;
  END IF;

  RETURN jsonb_build_object(
    'found', true,
    'branch_id', _branch,
    'organization_id', _org,
    'signed_in', _uid IS NOT NULL,
    'stay_dine', jsonb_build_object('available', _stay, 'allowed', _stay),
    'work', jsonb_build_object('available', true, 'allowed', _work),
    'partner', jsonb_build_object('available', true, 'allowed', _partner, 'relationships', to_jsonb(_partner_names)),
    'rider', jsonb_build_object('available', true, 'allowed', _rider)
  );
END;
$$;

REVOKE ALL ON FUNCTION public.neo_property_doors(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.neo_property_doors(uuid) TO anon, authenticated, service_role;
