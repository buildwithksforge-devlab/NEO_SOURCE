-- 1. Guard violations: an actor may only log a violation against themselves.
DROP POLICY IF EXISTS guard_violations_insert ON public.guard_violations;
CREATE POLICY guard_violations_insert ON public.guard_violations
  FOR INSERT TO authenticated
  WITH CHECK (
    organization_id = current_org_id()
    AND (
      actor_id = auth.uid()
      OR is_org_admin_for(organization_id)
      OR has_permission('administration', 'workspace.edit')
    )
  );

-- 2. Quality and inspection reads require the same module permission as writes.
DROP POLICY IF EXISTS room_inspections_select ON public.room_inspections;
CREATE POLICY room_inspections_select ON public.room_inspections
  FOR SELECT TO authenticated
  USING (
    organization_id = current_org_id()
    AND (
      is_org_admin_for(organization_id)
      OR has_permission('housekeeping', 'inspections', 'view')
      OR has_permission('housekeeping', 'inspections', 'create')
      OR has_permission('housekeeping', 'inspections', 'edit')
      OR has_permission('housekeeping', 'inspections', 'approve')
    )
  );

DROP POLICY IF EXISTS quality_check_records_select ON public.quality_check_records;
CREATE POLICY quality_check_records_select ON public.quality_check_records
  FOR SELECT TO authenticated
  USING (
    organization_id = current_org_id()
    AND (
      is_org_admin_for(organization_id)
      OR has_permission('kitchen', 'quality', 'view')
      OR has_permission('kitchen', 'quality', 'complete')
      OR has_permission('kitchen', 'quality', 'approve')
    )
  );

DROP POLICY IF EXISTS quality_checklists_select ON public.quality_checklists;
CREATE POLICY quality_checklists_select ON public.quality_checklists
  FOR SELECT TO authenticated
  USING (
    organization_id = current_org_id()
    AND (
      is_org_admin_for(organization_id)
      OR has_permission('kitchen', 'quality', 'view')
      OR has_permission('kitchen', 'quality', 'complete')
      OR has_permission('kitchen', 'quality', 'approve')
    )
  );

DROP POLICY IF EXISTS quality_holds_select ON public.quality_holds;
CREATE POLICY quality_holds_select ON public.quality_holds
  FOR SELECT TO authenticated
  USING (
    organization_id = current_org_id()
    AND (
      is_org_admin_for(organization_id)
      OR has_permission('kitchen', 'quality', 'view')
      OR has_permission('kitchen', 'quality_hold', 'create')
      OR has_permission('kitchen', 'quality_hold', 'release')
      OR has_permission('kitchen', 'quality', 'approve')
    )
  );

-- 3. Role assignment reconnaissance: own assignments stay visible, everyone
--    else's requires an administration permission.
CREATE OR REPLACE FUNCTION public.current_user_role_ids()
RETURNS uuid[]
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COALESCE(array_agg(ur.role_id), '{}'::uuid[])
  FROM public.user_roles ur
  WHERE ur.user_id = auth.uid()
    AND ur.organization_id = current_org_id()
$$;

REVOKE ALL ON FUNCTION public.current_user_role_ids() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.current_user_role_ids() TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.can_view_role_directory()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT is_org_admin_for(current_org_id())
      OR has_permission('administration', 'roles', 'view')
      OR has_permission('administration', 'roles', 'manage')
      OR has_permission('administration', 'users', 'view')
      OR has_permission('administration', 'users', 'view_access')
$$;

REVOKE ALL ON FUNCTION public.can_view_role_directory() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.can_view_role_directory() TO authenticated, service_role;

DROP POLICY IF EXISTS "user_roles tenant read" ON public.user_roles;
CREATE POLICY "user_roles tenant read" ON public.user_roles
  FOR SELECT TO authenticated
  USING (
    organization_id = current_org_id()
    AND (user_id = auth.uid() OR can_view_role_directory())
  );

DROP POLICY IF EXISTS "role_permissions tenant read" ON public.role_permissions;
CREATE POLICY "role_permissions tenant read" ON public.role_permissions
  FOR SELECT TO authenticated
  USING (
    organization_id = current_org_id()
    AND (role_id = ANY (current_user_role_ids()) OR can_view_role_directory())
  );