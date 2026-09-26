DROP POLICY IF EXISTS neo_public_exp_write_admin ON public.neo_public_experience;

CREATE POLICY neo_public_exp_write_admin
ON public.neo_public_experience
FOR ALL
TO authenticated
USING (
  organization_id = public.current_org_id()
  AND (
    public.is_org_admin_for(organization_id)
    OR public.has_permission('administration', 'workspace', 'edit')
  )
  AND EXISTS (
    SELECT 1 FROM public.branches b
    WHERE b.id = neo_public_experience.branch_id
      AND b.organization_id = neo_public_experience.organization_id
  )
)
WITH CHECK (
  organization_id = public.current_org_id()
  AND (
    public.is_org_admin_for(organization_id)
    OR public.has_permission('administration', 'workspace', 'edit')
  )
  AND EXISTS (
    SELECT 1 FROM public.branches b
    WHERE b.id = neo_public_experience.branch_id
      AND b.organization_id = neo_public_experience.organization_id
  )
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.neo_public_experience TO authenticated;