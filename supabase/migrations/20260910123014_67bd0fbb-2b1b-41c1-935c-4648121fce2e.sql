DROP POLICY IF EXISTS feature_flag_overrides_read ON public.feature_flag_overrides;
CREATE POLICY feature_flag_overrides_read ON public.feature_flag_overrides
  FOR SELECT TO authenticated
  USING (
    public.is_platform_admin()
    OR organization_id IS NULL
    OR organization_id = public.current_org_id()
  );