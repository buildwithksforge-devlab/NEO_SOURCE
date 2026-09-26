DROP POLICY IF EXISTS readiness_gates_select ON public.readiness_gates;

CREATE POLICY readiness_gates_select ON public.readiness_gates
FOR SELECT
TO authenticated
USING (
  -- Shared, tenant-free catalogue rows: readable so a property can seed its own
  -- checklist. They carry no organisation data of any kind.
  (organization_id IS NULL)
  OR (
    organization_id = current_org_id()
    AND (is_org_admin_for(organization_id) OR has_permission('quality', 'view'))
  )
);