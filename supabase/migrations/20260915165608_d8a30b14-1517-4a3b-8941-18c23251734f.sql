DROP POLICY IF EXISTS "user_branches tenant read" ON public.user_branches;
CREATE POLICY "user_branches tenant read" ON public.user_branches FOR SELECT TO authenticated
USING (organization_id = current_org_id() AND (user_id = auth.uid() OR can_view_role_directory() OR supervises_user(user_id)));

DROP POLICY IF EXISTS "user_departments tenant read" ON public.user_departments;
CREATE POLICY "user_departments tenant read" ON public.user_departments FOR SELECT TO authenticated
USING (organization_id = current_org_id() AND (user_id = auth.uid() OR can_view_role_directory() OR supervises_user(user_id)));

DROP POLICY IF EXISTS "user_stations tenant read" ON public.user_stations;
CREATE POLICY "user_stations tenant read" ON public.user_stations FOR SELECT TO authenticated
USING (organization_id = current_org_id() AND (user_id = auth.uid() OR can_view_role_directory() OR supervises_user(user_id)));

DROP POLICY IF EXISTS "user_permissions tenant read" ON public.user_permissions;
CREATE POLICY "user_permissions tenant read" ON public.user_permissions FOR SELECT TO authenticated
USING (organization_id = current_org_id() AND (user_id = auth.uid() OR can_view_role_directory()));