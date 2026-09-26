ALTER TABLE public.branches
  ADD COLUMN IF NOT EXISTS portal_slug text,
  ADD COLUMN IF NOT EXISTS portal_enabled boolean NOT NULL DEFAULT true;

CREATE UNIQUE INDEX IF NOT EXISTS branches_portal_slug_key
  ON public.branches (lower(portal_slug)) WHERE portal_slug IS NOT NULL;

DO $$
DECLARE r record; base text; candidate text;
BEGIN
  FOR r IN SELECT id, name, code FROM public.branches WHERE portal_slug IS NULL LOOP
    base := regexp_replace(lower(coalesce(r.name, r.code, 'property')), '[^a-z0-9]+', '-', 'g');
    base := trim(both '-' from base);
    IF base = '' THEN base := 'property'; END IF;
    base := left(base, 48);
    candidate := base;
    IF EXISTS (SELECT 1 FROM public.branches b WHERE lower(b.portal_slug) = candidate) THEN
      candidate := base || '-' || left(replace(r.id::text, '-', ''), 6);
    END IF;
    UPDATE public.branches SET portal_slug = candidate WHERE id = r.id;
  END LOOP;
END $$;

-- Public, pre-sign-in lookup. Returns branding only; never any operational data.
CREATE OR REPLACE FUNCTION public.neo_property_entrance(_slug text)
RETURNS jsonb
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $$
  SELECT jsonb_build_object(
           'branch_id', b.id,
           'organization_id', b.organization_id,
           'property_name', b.name,
           'organization_name', o.name,
           'city', b.city,
           'country', b.country,
           'logo_url', b.logo_url,
           'branding', coalesce(b.branding, '{}'::jsonb),
           'slug', b.portal_slug)
    FROM public.branches b
    JOIN public.organizations o ON o.id = b.organization_id
   WHERE b.portal_slug IS NOT NULL
     AND lower(b.portal_slug) = lower(_slug)
     AND b.portal_enabled = true
     AND coalesce(b.active, true) = true
   LIMIT 1;
$$;

REVOKE ALL ON FUNCTION public.neo_property_entrance(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.neo_property_entrance(text) TO anon, authenticated;

-- Post-sign-in entry check. The address only proposes a property; membership
-- and assignment decide access, and the workspace context is applied only when
-- the signed-in person genuinely belongs there.
CREATE OR REPLACE FUNCTION public.neo_property_entrance_enter(_branch uuid)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_branch public.branches%ROWTYPE;
  v_member boolean;
  v_assigned boolean;
  v_scope text;
  v_reach integer;
  v_count integer;
BEGIN
  IF v_uid IS NULL THEN
    RETURN jsonb_build_object('allowed', false, 'reason', 'not_signed_in');
  END IF;

  SELECT * INTO v_branch FROM public.branches
   WHERE id = _branch AND portal_enabled = true AND coalesce(active, true) = true;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('allowed', false, 'reason', 'unknown_property');
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM public.organization_memberships m
     WHERE m.user_id = v_uid AND m.organization_id = v_branch.organization_id
       AND m.status = 'active')
    OR EXISTS (
    SELECT 1 FROM public.profiles p
     WHERE p.id = v_uid AND p.organization_id = v_branch.organization_id
       AND p.account_status = 'active')
  INTO v_member;

  IF NOT v_member THEN
    RETURN jsonb_build_object('allowed', false, 'reason', 'not_a_member');
  END IF;

  -- Apply the workspace the entrance belongs to before scope is evaluated.
  UPDATE public.profiles
     SET active_organization_id = v_branch.organization_id, updated_at = now()
   WHERE id = v_uid
     AND coalesce(active_organization_id, organization_id) IS DISTINCT FROM v_branch.organization_id;

  SELECT EXISTS (
    SELECT 1 FROM public.user_branches ub
     WHERE ub.user_id = v_uid AND ub.branch_id = _branch)
    OR EXISTS (
    SELECT 1 FROM public.profiles p
     WHERE p.id = v_uid AND p.branch_id = _branch)
  INTO v_assigned;

  SELECT coalesce(max(public.scope_rank(coalesce(r.access_scope, public.role_scope_level(r.name)))), 1)
    INTO v_reach
    FROM public.user_roles ur
    JOIN public.roles r ON r.id = ur.role_id
   WHERE ur.user_id = v_uid AND ur.organization_id = v_branch.organization_id;

  IF NOT v_assigned AND v_reach < 5 THEN
    RETURN jsonb_build_object('allowed', false, 'reason', 'not_assigned_to_property');
  END IF;

  SELECT count(*) INTO v_count FROM (
    SELECT ub.branch_id FROM public.user_branches ub WHERE ub.user_id = v_uid
    UNION
    SELECT p.branch_id FROM public.profiles p WHERE p.id = v_uid AND p.branch_id IS NOT NULL
  ) s;

  SELECT coalesce(access_scope, 'self') INTO v_scope FROM (
    SELECT coalesce(r.access_scope, public.role_scope_level(r.name)) AS access_scope
      FROM public.user_roles ur JOIN public.roles r ON r.id = ur.role_id
     WHERE ur.user_id = v_uid AND ur.organization_id = v_branch.organization_id
     ORDER BY public.scope_rank(coalesce(r.access_scope, public.role_scope_level(r.name))) DESC
     LIMIT 1) t;

  RETURN jsonb_build_object(
    'allowed', true,
    'branch_id', _branch,
    'organization_id', v_branch.organization_id,
    'property_name', v_branch.name,
    'access_scope', coalesce(v_scope, 'self'),
    'group_wide', v_reach >= 5,
    'assigned_property_count', v_count);
END $$;

REVOKE ALL ON FUNCTION public.neo_property_entrance_enter(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.neo_property_entrance_enter(uuid) TO authenticated;