DROP POLICY IF EXISTS "Anyone can read published workspaces" ON public.public_workspaces;
REVOKE ALL ON public.public_workspaces FROM anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.public_workspaces TO authenticated;
GRANT ALL ON public.public_workspaces TO service_role;