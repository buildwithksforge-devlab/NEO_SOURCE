-- Stage F: new roles inherit; duplicated rows cannot come back.
CREATE OR REPLACE FUNCTION public.neo_role_link_template()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE _key text; _ver integer;
BEGIN
  IF NEW.template_key IS NOT NULL THEN RETURN NEW; END IF;
  _key := public.canonical_role_template_key(NEW.id);
  IF _key IS NULL THEN RETURN NEW; END IF;
  SELECT version INTO _ver FROM public.role_template_versions WHERE role_key = _key;
  IF _ver IS NULL THEN RETURN NEW; END IF;
  UPDATE public.roles
     SET template_key = _key, template_version = _ver,
         follows_template = true, template_state = 'following'
   WHERE id = NEW.id;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS neo_role_link_template ON public.roles;
CREATE TRIGGER neo_role_link_template
  AFTER INSERT ON public.roles
  FOR EACH ROW EXECUTE FUNCTION public.neo_role_link_template();

CREATE OR REPLACE FUNCTION public.neo_role_permission_no_reclone()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  -- Already inherited from the template: storing a copy would only re-create
  -- the duplication this model removed. A genuine divergence is an override.
  IF EXISTS (
    SELECT 1 FROM public.roles r
      JOIN public.role_feature_templates t ON t.role_key = r.template_key
      JOIN public.permissions p ON p.module = t.module AND p.feature = t.feature AND p.action = t.action
     WHERE r.id = NEW.role_id AND r.follows_template AND p.id = NEW.permission_id)
  THEN
    DELETE FROM public.role_permission_overrides
     WHERE role_id = NEW.role_id AND permission_id = NEW.permission_id AND effect = 'deny';
    RETURN NULL;
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS neo_role_permission_no_reclone ON public.role_permissions_base;
CREATE TRIGGER neo_role_permission_no_reclone
  BEFORE INSERT ON public.role_permissions_base
  FOR EACH ROW EXECUTE FUNCTION public.neo_role_permission_no_reclone();

-- Stage F guard: report any role whose stored model and resolved model disagree.
CREATE OR REPLACE FUNCTION public.neo_rbac_model_health()
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT jsonb_build_object(
    'roles', (SELECT count(*) FROM public.roles),
    'roles_following_template', (SELECT count(*) FROM public.roles WHERE follows_template),
    'materialised_rows', (SELECT count(*) FROM public.role_permissions_base),
    'resolved_rows', (SELECT count(*) FROM public.role_permissions),
    'overrides_grant', (SELECT count(*) FROM public.role_permission_overrides WHERE effect='grant'),
    'overrides_deny', (SELECT count(*) FROM public.role_permission_overrides WHERE effect='deny'),
    'roles_without_permissions', (SELECT count(*) FROM public.roles r
       WHERE NOT EXISTS (SELECT 1 FROM public.role_permissions rp WHERE rp.role_id = r.id)),
    'checked_at', now());
$$;

REVOKE ALL ON FUNCTION public.neo_rbac_model_health() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.neo_rbac_model_health() TO authenticated, service_role;

-- Stage G: keep the one-off migration evidence, out of the operational table.
CREATE TABLE IF NOT EXISTS public.role_grant_migration_log_archive
  (LIKE public.role_grant_migration_log INCLUDING DEFAULTS);

GRANT SELECT ON public.role_grant_migration_log_archive TO authenticated;
GRANT ALL ON public.role_grant_migration_log_archive TO service_role;
ALTER TABLE public.role_grant_migration_log_archive ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS role_grant_migration_log_archive_read ON public.role_grant_migration_log_archive;
CREATE POLICY role_grant_migration_log_archive_read ON public.role_grant_migration_log_archive
  FOR SELECT TO authenticated
  USING (organization_id = public.current_org_id() AND public.is_org_admin_for(organization_id));