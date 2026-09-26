-- Stage D: swap the read path onto the resolver without changing any answer.
ALTER TABLE public.role_permissions RENAME TO role_permissions_base;

-- Writers keep their current physical semantics; only the name changes.
DO $$
DECLARE f text; src text;
BEGIN
  FOREACH f IN ARRAY ARRAY[
    'apply_recommended_permissions','bootstrap_tenant_for','neo_apply_feature_templates',
    'neo_apply_role_templates','neo_consolidate_duplicate_roles','neo_delete_structure_record',
    'neo_provision_workspace_for','neo_reconcile_org_role_templates','provision_catalogue_roles',
    'set_role_permissions']
  LOOP
    FOR src IN
      SELECT pg_get_functiondef(p.oid) FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname='public' AND p.proname=f
    LOOP
      EXECUTE replace(src, 'public.role_permissions', 'public.role_permissions_base');
    END LOOP;
  END LOOP;
END $$;

CREATE VIEW public.role_permissions
WITH (security_invoker = true) AS
  SELECT uuid_in(md5(x.role_id::text || x.permission_id::text)::cstring) AS id,
         x.organization_id, x.role_id, x.permission_id, x.created_at, x.source
    FROM (
      SELECT b.organization_id, b.role_id, b.permission_id, b.created_at, b.source
        FROM public.role_permissions_base b
      UNION
      SELECT r.organization_id, r.id, p.id, r.created_at, 'template'::text
        FROM public.roles r
        JOIN public.role_feature_templates t ON t.role_key = r.template_key
        JOIN public.permissions p
          ON p.module = t.module AND p.feature = t.feature AND p.action = t.action
       WHERE r.follows_template
      UNION
      SELECT o.organization_id, o.role_id, o.permission_id, o.created_at, o.source
        FROM public.role_permission_overrides o
       WHERE o.effect = 'grant'
    ) x
   WHERE NOT EXISTS (
     SELECT 1 FROM public.role_permission_overrides d
      WHERE d.role_id = x.role_id AND d.permission_id = x.permission_id AND d.effect = 'deny');

GRANT SELECT, INSERT, UPDATE, DELETE ON public.role_permissions TO authenticated;
GRANT ALL ON public.role_permissions TO service_role;

CREATE OR REPLACE FUNCTION public.role_permissions_view_write()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE _org uuid;
BEGIN
  IF TG_OP = 'INSERT' THEN
    SELECT organization_id INTO _org FROM public.roles WHERE id = NEW.role_id;
    DELETE FROM public.role_permission_overrides
     WHERE role_id = NEW.role_id AND permission_id = NEW.permission_id AND effect = 'deny';
    INSERT INTO public.role_permissions_base(organization_id, role_id, permission_id, source)
    VALUES (coalesce(NEW.organization_id, _org), NEW.role_id, NEW.permission_id,
            coalesce(NEW.source, 'custom'))
    ON CONFLICT (role_id, permission_id) DO NOTHING;
    RETURN NEW;
  ELSIF TG_OP = 'DELETE' THEN
    SELECT organization_id INTO _org FROM public.roles WHERE id = OLD.role_id;
    DELETE FROM public.role_permissions_base
     WHERE role_id = OLD.role_id AND permission_id = OLD.permission_id;
    DELETE FROM public.role_permission_overrides
     WHERE role_id = OLD.role_id AND permission_id = OLD.permission_id AND effect = 'grant';
    IF EXISTS (SELECT 1 FROM public.neo_role_permission_ids(OLD.role_id) n
                WHERE n.permission_id = OLD.permission_id) THEN
      INSERT INTO public.role_permission_overrides(organization_id, role_id, permission_id, effect, source, reason)
      VALUES (coalesce(OLD.organization_id, _org), OLD.role_id, OLD.permission_id, 'deny', 'custom',
              'Removed from the role by an administrator')
      ON CONFLICT (role_id, permission_id) DO UPDATE SET effect = 'deny', updated_at = now();
    END IF;
    RETURN OLD;
  ELSE
    UPDATE public.role_permissions_base SET source = coalesce(NEW.source, source)
     WHERE role_id = OLD.role_id AND permission_id = OLD.permission_id;
    RETURN NEW;
  END IF;
END $$;

CREATE TRIGGER role_permissions_view_insert INSTEAD OF INSERT ON public.role_permissions
  FOR EACH ROW EXECUTE FUNCTION public.role_permissions_view_write();
CREATE TRIGGER role_permissions_view_update INSTEAD OF UPDATE ON public.role_permissions
  FOR EACH ROW EXECUTE FUNCTION public.role_permissions_view_write();
CREATE TRIGGER role_permissions_view_delete INSTEAD OF DELETE ON public.role_permissions
  FOR EACH ROW EXECUTE FUNCTION public.role_permissions_view_write();