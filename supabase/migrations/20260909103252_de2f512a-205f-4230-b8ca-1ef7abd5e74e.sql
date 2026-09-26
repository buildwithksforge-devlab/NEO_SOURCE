-- Standard role provisioning matched only module + action, so a general
-- "create in the restaurant" line handed out menu and settings editing too.
CREATE OR REPLACE FUNCTION public.provision_catalogue_roles(_org uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  _created integer := 0;
  _granted integer := 0;
  _revoked integer := 0;
BEGIN
  WITH ins AS (
    INSERT INTO public.roles (organization_id, name, description, is_system, active, access_scope)
    SELECT _org, c.role_name, c.summary, true, true, c.access_scope
    FROM public.role_catalogue c
    ON CONFLICT (organization_id, name) DO UPDATE
      SET description  = EXCLUDED.description,
          access_scope = EXCLUDED.access_scope,
          is_system    = true,
          updated_at   = now()
    RETURNING (xmax = 0) AS inserted
  )
  SELECT count(*) FILTER (WHERE inserted) INTO _created FROM ins;

  WITH added AS (
    INSERT INTO public.role_permissions (organization_id, role_id, permission_id)
    SELECT _org, r.id, p.id
    FROM public.role_catalogue c
    JOIN public.roles r ON r.organization_id = _org AND r.name = c.role_name
    JOIN public.role_permission_templates t ON t.template_key = c.role_key
    JOIN public.permissions p ON p.module = t.module AND p.action = t.action
    WHERE (
      position('.' in t.action) > 0
      OR p.feature NOT IN ('menu','settings','configuration','pricing','rate_plans','catalogue')
      OR p.action IN ('view','print','export','access')
    )
    AND NOT EXISTS (
      SELECT 1 FROM public.role_permissions rp
      WHERE rp.role_id = r.id AND rp.permission_id = p.id
    )
    RETURNING 1
  )
  SELECT count(*) INTO _granted FROM added;

  WITH removed AS (
    DELETE FROM public.role_permissions rp
    USING public.roles r,
          public.permissions p,
          public.restricted_actions ra,
          public.role_catalogue c
    WHERE rp.role_id = r.id
      AND r.organization_id = _org
      AND rp.permission_id = p.id
      AND p.module = ra.module
      AND p.action = ra.action
      AND c.role_name = r.name
      AND c.restricted_authority = false
    RETURNING 1
  )
  SELECT count(*) INTO _revoked FROM removed;

  RETURN jsonb_build_object(
    'organization_id', _org,
    'roles_created', _created,
    'permissions_granted', _granted,
    'restricted_permissions_revoked', _revoked
  );
END;
$function$;