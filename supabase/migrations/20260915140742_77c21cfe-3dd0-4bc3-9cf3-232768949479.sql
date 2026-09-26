DROP POLICY IF EXISTS "exit clearance update" ON public.employee_exit_clearances;
CREATE POLICY "exit clearance update" ON public.employee_exit_clearances
FOR UPDATE TO authenticated
USING (organization_id = current_org_id() AND (has_permission('hr-employees','terminate') OR has_permission('hr-employees','edit')))
WITH CHECK (organization_id = current_org_id() AND (has_permission('hr-employees','terminate') OR has_permission('hr-employees','edit')));