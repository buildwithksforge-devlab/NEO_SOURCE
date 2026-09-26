CREATE TABLE IF NOT EXISTS public.organization_settings (
  organization_id uuid PRIMARY KEY REFERENCES public.organizations(id) ON DELETE CASCADE,
  contact jsonb NOT NULL DEFAULT '{}'::jsonb,
  brand jsonb NOT NULL DEFAULT '{}'::jsonb,
  regional jsonb NOT NULL DEFAULT '{}'::jsonb,
  dashboard jsonb NOT NULL DEFAULT '{}'::jsonb,
  app_branding jsonb NOT NULL DEFAULT '{}'::jsonb,
  communication_templates jsonb NOT NULL DEFAULT '[]'::jsonb,
  document_templates jsonb NOT NULL DEFAULT '[]'::jsonb,
  onboarding_completed boolean NOT NULL DEFAULT false,
  updated_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT, UPDATE ON public.organization_settings TO authenticated;
GRANT ALL ON public.organization_settings TO service_role;

ALTER TABLE public.organization_settings ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "org members read settings" ON public.organization_settings;
CREATE POLICY "org members read settings" ON public.organization_settings
  FOR SELECT TO authenticated
  USING (organization_id = public.current_org_id());

DROP POLICY IF EXISTS "org admins insert settings" ON public.organization_settings;
CREATE POLICY "org admins insert settings" ON public.organization_settings
  FOR INSERT TO authenticated
  WITH CHECK (organization_id = public.current_org_id() AND public.is_org_admin());

DROP POLICY IF EXISTS "org admins update settings" ON public.organization_settings;
CREATE POLICY "org admins update settings" ON public.organization_settings
  FOR UPDATE TO authenticated
  USING (organization_id = public.current_org_id() AND public.is_org_admin())
  WITH CHECK (organization_id = public.current_org_id() AND public.is_org_admin());

CREATE OR REPLACE FUNCTION public.organization_settings_touch()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_organization_settings_touch ON public.organization_settings;
CREATE TRIGGER trg_organization_settings_touch
  BEFORE UPDATE ON public.organization_settings
  FOR EACH ROW EXECUTE FUNCTION public.organization_settings_touch();