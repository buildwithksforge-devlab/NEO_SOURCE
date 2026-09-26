-- Property-level scope helper for shared records that have no department column.
CREATE OR REPLACE FUNCTION public.in_my_branch_scope(_org uuid, _branch uuid)
RETURNS boolean
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT CASE
    WHEN _org IS NULL OR _org <> public.current_org_id() THEN false
    WHEN public.current_access_scope() = 'organisation' THEN true
    WHEN public.current_access_scope() = 'technical' THEN false
    ELSE (_branch IS NULL OR _branch = ANY (public.current_branch_ids()))
  END;
$$;
REVOKE EXECUTE ON FUNCTION public.in_my_branch_scope(uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.in_my_branch_scope(uuid, uuid) TO authenticated;

-- Folios: property-scoped for staff (guest self-read policy is untouched).
DROP POLICY IF EXISTS staff_read_folios ON public.folios;
CREATE POLICY staff_read_folios ON public.folios FOR SELECT TO authenticated
USING (public.in_my_branch_scope(organization_id, branch_id));

DROP POLICY IF EXISTS staff_update_folios ON public.folios;
CREATE POLICY staff_update_folios ON public.folios FOR UPDATE TO authenticated
USING (public.in_my_branch_scope(organization_id, branch_id) AND public.has_permission('pms', 'write'))
WITH CHECK (public.in_my_branch_scope(organization_id, branch_id));

DROP POLICY IF EXISTS staff_insert_folios ON public.folios;
CREATE POLICY staff_insert_folios ON public.folios FOR INSERT TO authenticated
WITH CHECK (public.in_my_branch_scope(organization_id, branch_id) AND public.has_permission('pms', 'write'));

-- Guest requests: task-level scope (own, station, department, supervised, property).
DROP POLICY IF EXISTS staff_read_guest_requests ON public.guest_requests;
CREATE POLICY staff_read_guest_requests ON public.guest_requests FOR SELECT TO authenticated
USING (public.in_my_scope(organization_id, branch_id, department_id, station_id, assignee_id, created_by));

DROP POLICY IF EXISTS staff_update_guest_requests ON public.guest_requests;
CREATE POLICY staff_update_guest_requests ON public.guest_requests FOR UPDATE TO authenticated
USING (
  public.in_my_scope(organization_id, branch_id, department_id, station_id, assignee_id, created_by)
  AND public.has_permission('pms', 'write')
)
WITH CHECK (organization_id = public.current_org_id());

DROP POLICY IF EXISTS staff_insert_guest_requests ON public.guest_requests;
CREATE POLICY staff_insert_guest_requests ON public.guest_requests FOR INSERT TO authenticated
WITH CHECK (public.in_my_branch_scope(organization_id, branch_id) AND public.has_permission('pms', 'write'));

-- Internal requisitions: raised by me, my department, my property, or my team.
DROP POLICY IF EXISTS internal_requisitions_select ON public.internal_requisitions;
CREATE POLICY internal_requisitions_select ON public.internal_requisitions FOR SELECT TO authenticated
USING (public.in_my_scope(organization_id, branch_id, department_id, NULL, requested_by, requested_by));

-- Expense claims: raised by me, my department, my property, or my team.
DROP POLICY IF EXISTS finance_read_expense_claims ON public.expense_claims;
CREATE POLICY finance_read_expense_claims ON public.expense_claims FOR SELECT TO authenticated
USING (
  public.in_my_scope(organization_id, branch_id, department_id, NULL, requested_by, requested_by)
  AND (public.has_permission('finance', 'view') OR public.is_org_admin() OR requested_by = auth.uid())
);

DROP POLICY IF EXISTS finance_update_expense_claims ON public.expense_claims;
CREATE POLICY finance_update_expense_claims ON public.expense_claims FOR UPDATE TO authenticated
USING (
  public.in_my_scope(organization_id, branch_id, department_id, NULL, requested_by, requested_by)
  AND (public.has_permission('finance', 'edit') OR public.is_org_admin())
)
WITH CHECK (organization_id = public.current_org_id());