CREATE TABLE IF NOT EXISTS public.public_workspaces (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  branch_id uuid REFERENCES public.branches(id) ON DELETE CASCADE,
  app_key text NOT NULL CHECK (app_key IN ('guest','delivery','rider')),
  slug text NOT NULL,
  published boolean NOT NULL DEFAULT false,
  app_name text NOT NULL DEFAULT '',
  hotel_name text NOT NULL DEFAULT '',
  logo_url text,
  icon_url text,
  primary_color text NOT NULL DEFAULT '#18C4C8',
  secondary_color text NOT NULL DEFAULT '#07142D',
  background_color text NOT NULL DEFAULT '#F7F9FC',
  button_style text NOT NULL DEFAULT 'rounded' CHECK (button_style IN ('rounded','pill','square')),
  menu_style text NOT NULL DEFAULT 'tabs' CHECK (menu_style IN ('tabs','drawer','floating')),
  welcome_title text NOT NULL DEFAULT '',
  welcome_message text NOT NULL DEFAULT '',
  contact_phone text,
  contact_email text,
  contact_address text,
  support_details text,
  terms_text text,
  policy_text text,
  features jsonb NOT NULL DEFAULT '{}'::jsonb,
  settings jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (app_key, slug)
);

CREATE INDEX IF NOT EXISTS public_workspaces_org_idx ON public.public_workspaces (organization_id, app_key);

GRANT SELECT ON public.public_workspaces TO anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.public_workspaces TO authenticated;
GRANT ALL ON public.public_workspaces TO service_role;

ALTER TABLE public.public_workspaces ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Anyone can read published workspaces"
  ON public.public_workspaces FOR SELECT TO anon
  USING (published = true);

CREATE POLICY "Staff read own organization workspaces"
  ON public.public_workspaces FOR SELECT TO authenticated
  USING (published = true OR organization_id = public.current_org_id());

CREATE POLICY "Org admins insert workspaces"
  ON public.public_workspaces FOR INSERT TO authenticated
  WITH CHECK (organization_id = public.current_org_id() AND public.is_org_admin());

CREATE POLICY "Org admins update workspaces"
  ON public.public_workspaces FOR UPDATE TO authenticated
  USING (organization_id = public.current_org_id() AND public.is_org_admin())
  WITH CHECK (organization_id = public.current_org_id() AND public.is_org_admin());

CREATE POLICY "Org admins delete workspaces"
  ON public.public_workspaces FOR DELETE TO authenticated
  USING (organization_id = public.current_org_id() AND public.is_org_admin());

CREATE OR REPLACE FUNCTION public.public_workspaces_touch_updated_at()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END; $$;

DROP TRIGGER IF EXISTS public_workspaces_touch ON public.public_workspaces;
CREATE TRIGGER public_workspaces_touch BEFORE UPDATE ON public.public_workspaces
FOR EACH ROW EXECUTE FUNCTION public.public_workspaces_touch_updated_at();

CREATE OR REPLACE FUNCTION public.resolve_public_workspace(_app_key text, _slug text)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT to_jsonb(w) - 'created_by' - 'settings'
  FROM public.public_workspaces w
  WHERE w.app_key = _app_key
    AND lower(w.slug) = lower(_slug)
    AND w.published = true
  LIMIT 1;
$$;

REVOKE ALL ON FUNCTION public.resolve_public_workspace(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.resolve_public_workspace(text, text) TO anon, authenticated, service_role;