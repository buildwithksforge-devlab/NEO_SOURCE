CREATE OR REPLACE FUNCTION public.can_read_journals()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT public.is_active_staff() AND (
    public.is_org_admin()
    OR EXISTS (
      SELECT 1
      FROM public.user_roles ur
      JOIN public.roles r ON r.id = ur.role_id AND r.active
      JOIN public.role_permissions rp ON rp.role_id = r.id
      JOIN public.permissions p ON p.id = rp.permission_id
      WHERE ur.user_id = auth.uid()
        AND ur.organization_id = public.current_org_id()
        AND rp.organization_id = public.current_org_id()
        AND p.module = 'finance'
        AND p.feature IN ('journals','ledger','gl')
        AND p.action = 'view'
    )
    OR EXISTS (
      SELECT 1
      FROM public.user_permissions up
      JOIN public.permissions p ON p.id = up.permission_id
      WHERE up.user_id = auth.uid()
        AND up.organization_id = public.current_org_id()
        AND up.effect = 'grant'
        AND p.module = 'finance'
        AND p.feature IN ('journals','ledger','gl')
        AND p.action = 'view'
    )
  )
$$;

REVOKE EXECUTE ON FUNCTION public.can_read_journals() FROM anon, PUBLIC;
GRANT EXECUTE ON FUNCTION public.can_read_journals() TO authenticated;