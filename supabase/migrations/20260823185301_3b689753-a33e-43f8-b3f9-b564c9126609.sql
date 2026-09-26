DROP POLICY IF EXISTS "environment_registry_read" ON public.environment_registry;
CREATE POLICY "environment_registry_read" ON public.environment_registry
  FOR SELECT TO authenticated
  USING (public.is_platform_admin());

DROP POLICY IF EXISTS "monitoring_checks_read" ON public.monitoring_checks;
CREATE POLICY "monitoring_checks_read" ON public.monitoring_checks
  FOR SELECT TO authenticated
  USING (public.is_platform_admin());

DROP POLICY IF EXISTS "Signed-in staff may read the role catalogue" ON public.role_catalogue;
CREATE POLICY "Role administrators may read the role catalogue" ON public.role_catalogue
  FOR SELECT TO authenticated
  USING (
    public.is_platform_admin()
    OR public.can_manage_workforce()
    OR public.has_permission('administration', 'roles', 'view')
    OR public.has_permission('administration', 'users', 'view_access')
  );