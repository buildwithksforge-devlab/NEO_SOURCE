
CREATE TABLE IF NOT EXISTS public.role_template_pass_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  batch text NOT NULL,
  organization_id uuid NOT NULL,
  role_id uuid NOT NULL,
  role_name text NOT NULL,
  role_key text,
  missing_before integer NOT NULL,
  missing_after integer NOT NULL,
  granted_added integer NOT NULL,
  unavailable integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT ON public.role_template_pass_runs TO authenticated;
GRANT ALL ON public.role_template_pass_runs TO service_role;
ALTER TABLE public.role_template_pass_runs ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public'
    AND tablename='role_template_pass_runs' AND policyname='rtpr_org_read') THEN
    EXECUTE $p$CREATE POLICY "rtpr_org_read" ON public.role_template_pass_runs
      FOR SELECT TO authenticated USING (organization_id = public.current_org_id())$p$;
  END IF;
END $$;

DO $$
DECLARE
  r record;
  _before int;
  _after int;
  _added int;
  _unavail int;
  _batch text := 'template-pass-2026-09-16';
BEGIN
  FOR r IN SELECT id, organization_id, name, normalized_role_key FROM public.roles WHERE active LOOP
    SELECT count(*) FILTER (WHERE g.permission_id IS NOT NULL
             AND NOT EXISTS (SELECT 1 FROM public.role_permissions rp
                             WHERE rp.role_id = r.id AND rp.permission_id = g.permission_id)),
           count(*) FILTER (WHERE g.permission_id IS NULL)
      INTO _before, _unavail
      FROM public.recommended_template_grants(r.id) g;

    IF _before IS NULL THEN CONTINUE; END IF;

    INSERT INTO public.role_permissions (organization_id, role_id, permission_id, source)
    SELECT r.organization_id, r.id, g.permission_id, 'template'
    FROM public.recommended_template_grants(r.id) g
    WHERE g.permission_id IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM public.role_permissions rp
                      WHERE rp.role_id = r.id AND rp.permission_id = g.permission_id)
    ON CONFLICT DO NOTHING;

    GET DIAGNOSTICS _added = ROW_COUNT;

    SELECT count(*) FILTER (WHERE g.permission_id IS NOT NULL
             AND NOT EXISTS (SELECT 1 FROM public.role_permissions rp
                             WHERE rp.role_id = r.id AND rp.permission_id = g.permission_id))
      INTO _after
      FROM public.recommended_template_grants(r.id) g;

    INSERT INTO public.role_template_pass_runs
      (batch, organization_id, role_id, role_name, role_key, missing_before, missing_after, granted_added, unavailable)
    VALUES (_batch, r.organization_id, r.id, r.name, r.normalized_role_key,
            coalesce(_before,0), coalesce(_after,0), coalesce(_added,0), coalesce(_unavail,0));
  END LOOP;
END $$;
