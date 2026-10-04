-- Branch catalogue visibility must follow effective access.
-- Ordinary staff may read only properties assigned to them.
-- Organisation/technical scoped users retain organisation-wide visibility
-- through neo_branch_in_scope().

DROP POLICY IF EXISTS "branches tenant read" ON public.branches;

CREATE POLICY "branches tenant read"
ON public.branches
FOR SELECT
TO authenticated
USING (
  organization_id = public.current_org_id()
  AND public.neo_branch_in_scope(id)
);

NOTIFY pgrst, 'reload schema';