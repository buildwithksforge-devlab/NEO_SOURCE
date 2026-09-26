-- ---------------------------------------------------------------------------
-- Stage C: template inheritance, running in parallel with the existing rows.
-- Nothing is deleted. Nothing is switched over in this migration.
-- ---------------------------------------------------------------------------

ALTER TABLE public.roles
  ADD COLUMN IF NOT EXISTS template_key text,
  ADD COLUMN IF NOT EXISTS template_version integer,
  ADD COLUMN IF NOT EXISTS follows_template boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS template_state text NOT NULL DEFAULT 'unlinked';

-- The catalogue of template versions NEØ ships.
CREATE TABLE IF NOT EXISTS public.role_template_versions (
  role_key text PRIMARY KEY,
  version integer NOT NULL DEFAULT 1,
  fingerprint text NOT NULL,
  line_count integer NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT ON public.role_template_versions TO authenticated;
GRANT ALL ON public.role_template_versions TO service_role;
ALTER TABLE public.role_template_versions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS role_template_versions_read ON public.role_template_versions;
CREATE POLICY role_template_versions_read ON public.role_template_versions
  FOR SELECT TO authenticated USING (public.is_active_staff());

-- Intentional divergence from a template, stored explicitly.
CREATE TABLE IF NOT EXISTS public.role_permission_overrides (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  role_id uuid NOT NULL REFERENCES public.roles(id) ON DELETE CASCADE,
  permission_id uuid NOT NULL REFERENCES public.permissions(id) ON DELETE CASCADE,
  effect text NOT NULL CHECK (effect IN ('grant','deny')),
  source text NOT NULL DEFAULT 'custom',
  reason text,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (role_id, permission_id)
);

CREATE INDEX IF NOT EXISTS role_permission_overrides_role_idx
  ON public.role_permission_overrides (role_id, effect);
CREATE INDEX IF NOT EXISTS role_permission_overrides_org_idx
  ON public.role_permission_overrides (organization_id, role_id);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.role_permission_overrides TO authenticated;
GRANT ALL ON public.role_permission_overrides TO service_role;
ALTER TABLE public.role_permission_overrides ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS role_permission_overrides_read ON public.role_permission_overrides;
CREATE POLICY role_permission_overrides_read ON public.role_permission_overrides
  FOR SELECT TO authenticated
  USING (organization_id = public.current_org_id());

DROP POLICY IF EXISTS role_permission_overrides_write ON public.role_permission_overrides;
CREATE POLICY role_permission_overrides_write ON public.role_permission_overrides
  FOR ALL TO authenticated
  USING (organization_id = public.current_org_id() AND public.neo_can_manage_roles())
  WITH CHECK (organization_id = public.current_org_id() AND public.neo_can_manage_roles());

CREATE OR REPLACE FUNCTION public.role_permission_overrides_touch()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
BEGIN NEW.updated_at := now(); RETURN NEW; END; $$;

DROP TRIGGER IF EXISTS role_permission_overrides_touch ON public.role_permission_overrides;
CREATE TRIGGER role_permission_overrides_touch
  BEFORE UPDATE ON public.role_permission_overrides
  FOR EACH ROW EXECUTE FUNCTION public.role_permission_overrides_touch();

-- ---------------------------------------------------------------------------
-- Template version register, computed from the shipped template lines.
-- ---------------------------------------------------------------------------
INSERT INTO public.role_template_versions (role_key, version, fingerprint, line_count, updated_at)
SELECT t.role_key, 1,
       md5(string_agg(t.module||'.'||t.feature||'.'||t.action, ',' ORDER BY t.module, t.feature, t.action)),
       count(*), now()
FROM public.role_feature_templates t
GROUP BY t.role_key
ON CONFLICT (role_key) DO UPDATE
  SET fingerprint = EXCLUDED.fingerprint,
      line_count = EXCLUDED.line_count,
      version = CASE WHEN public.role_template_versions.fingerprint = EXCLUDED.fingerprint
                     THEN public.role_template_versions.version
                     ELSE public.role_template_versions.version + 1 END,
      updated_at = now();

-- ---------------------------------------------------------------------------
-- Link every role that demonstrably derives from a shipped template.
-- ---------------------------------------------------------------------------
UPDATE public.roles r
   SET template_key = public.canonical_role_template_key(r.id)
 WHERE r.template_key IS NULL
   AND public.canonical_role_template_key(r.id) IS NOT NULL
   AND EXISTS (SELECT 1 FROM public.role_template_versions v
                WHERE v.role_key = public.canonical_role_template_key(r.id));

-- Every template line the role does NOT currently hold is recorded as an
-- explicit removal, so inheriting the template cannot widen anyone's access.
INSERT INTO public.role_permission_overrides (organization_id, role_id, permission_id, effect, source, reason)
SELECT r.organization_id, r.id, p.id, 'deny', 'baseline_omission',
       'Template line the workspace did not hold when inheritance was introduced'
  FROM public.roles r
  JOIN public.role_feature_templates t ON t.role_key = r.template_key
  JOIN public.permissions p
    ON p.module = t.module AND p.feature = t.feature AND p.action = t.action
 WHERE r.template_key IS NOT NULL
   AND NOT EXISTS (
     SELECT 1 FROM public.role_permissions rp
      WHERE rp.role_id = r.id AND rp.permission_id = p.id)
ON CONFLICT (role_id, permission_id) DO NOTHING;

UPDATE public.roles r
   SET follows_template = true,
       template_state = 'following',
       template_version = v.version
  FROM public.role_template_versions v
 WHERE v.role_key = r.template_key
   AND r.template_key IS NOT NULL;

-- ---------------------------------------------------------------------------
-- The resolver: template ∪ explicit grants ∪ still-materialised rows − denies.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.neo_role_permission_ids(_role_id uuid)
RETURNS TABLE(permission_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT x.pid FROM (
    SELECT rp.permission_id AS pid
      FROM public.role_permissions rp
     WHERE rp.role_id = _role_id
    UNION
    SELECT p.id
      FROM public.roles r
      JOIN public.role_feature_templates t ON t.role_key = r.template_key
      JOIN public.permissions p
        ON p.module = t.module AND p.feature = t.feature AND p.action = t.action
     WHERE r.id = _role_id AND r.follows_template
    UNION
    SELECT o.permission_id
      FROM public.role_permission_overrides o
     WHERE o.role_id = _role_id AND o.effect = 'grant'
  ) x
  WHERE NOT EXISTS (
    SELECT 1 FROM public.role_permission_overrides d
     WHERE d.role_id = _role_id AND d.effect = 'deny' AND d.permission_id = x.pid
  );
$$;

REVOKE ALL ON FUNCTION public.neo_role_permission_ids(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.neo_role_permission_ids(uuid) TO authenticated, service_role;

CREATE OR REPLACE VIEW public.role_permissions_resolved
WITH (security_invoker = true) AS
  SELECT r.organization_id, r.id AS role_id, x.permission_id
    FROM public.roles r
    CROSS JOIN LATERAL public.neo_role_permission_ids(r.id) x;

GRANT SELECT ON public.role_permissions_resolved TO authenticated;
GRANT ALL ON public.role_permissions_resolved TO service_role;

-- ---------------------------------------------------------------------------
-- Stage D instrument: where do the two models disagree? Must be empty.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.neo_rbac_resolution_diff()
RETURNS TABLE(role_id uuid, organization_id uuid, role_name text,
              unexpected_grants bigint, unexpected_removals bigint)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT r.id, r.organization_id, r.name,
         (SELECT count(*) FROM public.neo_role_permission_ids(r.id) n
           WHERE NOT EXISTS (SELECT 1 FROM public.role_permissions rp
                              WHERE rp.role_id = r.id AND rp.permission_id = n.permission_id)),
         (SELECT count(*) FROM public.role_permissions rp
           WHERE rp.role_id = r.id
             AND NOT EXISTS (SELECT 1 FROM public.neo_role_permission_ids(r.id) n
                              WHERE n.permission_id = rp.permission_id))
    FROM public.roles r;
$$;

REVOKE ALL ON FUNCTION public.neo_rbac_resolution_diff() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.neo_rbac_resolution_diff() TO service_role;