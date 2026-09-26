CREATE TABLE IF NOT EXISTS public.role_template_rollout_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  roles int NOT NULL DEFAULT 0,
  reconciled int NOT NULL DEFAULT 0,
  incomplete int NOT NULL DEFAULT 0,
  no_template int NOT NULL DEFAULT 0,
  added int NOT NULL DEFAULT 0,
  details jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT ON public.role_template_rollout_runs TO authenticated;
GRANT ALL ON public.role_template_rollout_runs TO service_role;
ALTER TABLE public.role_template_rollout_runs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Members read their own workspace rollout runs" ON public.role_template_rollout_runs;
CREATE POLICY "Members read their own workspace rollout runs"
  ON public.role_template_rollout_runs FOR SELECT TO authenticated
  USING (organization_id = public.current_org_id());

DO $rollout$
DECLARE
  o record; r record;
  _key text; _added int; _missing int;
  _roles int; _rec int; _inc int; _none int; _tot int;
  _details jsonb;
BEGIN
  FOR o IN SELECT id FROM public.organizations ORDER BY created_at LOOP
    _roles := 0; _rec := 0; _inc := 0; _none := 0; _tot := 0; _details := '[]'::jsonb;

    FOR r IN SELECT id, name FROM public.roles
             WHERE organization_id = o.id AND coalesce(active, true) ORDER BY name LOOP
      _roles := _roles + 1;
      _key := public.canonical_role_template_key(r.id);

      IF _key IS NULL OR NOT EXISTS (SELECT 1 FROM public.role_feature_templates WHERE role_key = _key) THEN
        _none := _none + 1;
        _details := _details || jsonb_build_object('role', r.name, 'status', 'no_template');
        CONTINUE;
      END IF;

      -- Additive only. Nothing granted is removed, so custom permissions survive.
      INSERT INTO public.role_permissions(organization_id, role_id, permission_id, source)
      SELECT o.id, r.id, g.permission_id, 'template'
      FROM (SELECT DISTINCT permission_id FROM public.recommended_template_grants(r.id)
            WHERE permission_id IS NOT NULL) g
      ON CONFLICT (role_id, permission_id) DO NOTHING;
      GET DIAGNOSTICS _added = ROW_COUNT;
      _tot := _tot + _added;

      SELECT count(*) INTO _missing
      FROM (SELECT DISTINCT permission_id FROM public.recommended_template_grants(r.id)
            WHERE permission_id IS NOT NULL) g
      WHERE NOT EXISTS (SELECT 1 FROM public.role_permissions rp
                        WHERE rp.role_id = r.id AND rp.permission_id = g.permission_id);

      IF _missing > 0 THEN _inc := _inc + 1; ELSE _rec := _rec + 1; END IF;

      IF _added > 0 OR _missing > 0 THEN
        _details := _details || jsonb_build_object('role', r.name, 'role_key', _key,
          'added', _added, 'missing', _missing,
          'status', CASE WHEN _missing > 0 THEN 'incomplete' ELSE 'reconciled' END);
      END IF;

      IF _added > 0 THEN
        INSERT INTO public.audit_logs(organization_id, user_id, user_name, action, module, record_id, new_value)
        VALUES (o.id, NULL, 'Platform template rollout',
                'role.permissions.apply_recommended', 'administration', r.id,
                jsonb_build_object('role', r.name, 'canonical_role_key', _key,
                                   'added', _added, 'missing_after', _missing,
                                   'scope', 'platform_rollout'));
      END IF;
    END LOOP;

    INSERT INTO public.role_template_rollout_runs(organization_id, roles, reconciled, incomplete, no_template, added, details)
    VALUES (o.id, _roles, _rec, _inc, _none, _tot, _details);
  END LOOP;
END
$rollout$;