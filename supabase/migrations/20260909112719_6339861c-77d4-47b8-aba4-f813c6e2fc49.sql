CREATE OR REPLACE FUNCTION public.can_read_journals()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT public.is_active_staff() AND (
    public.is_org_admin()
    OR public.has_exact_permission('finance','journals','view')
    OR public.has_exact_permission('finance','ledger','view')
    OR public.has_exact_permission('finance','gl','view')
  )
$$;

GRANT EXECUTE ON FUNCTION public.can_read_journals() TO authenticated;

DROP POLICY IF EXISTS finance_read_journal_entries ON public.journal_entries;
CREATE POLICY finance_read_journal_entries ON public.journal_entries
FOR SELECT TO authenticated
USING (
  organization_id = public.current_org_id()
  AND public.can_read_journals()
  AND (public.in_my_branch_scope(organization_id, branch_id) OR public.is_org_admin_for(organization_id))
);

DROP POLICY IF EXISTS finance_read_journal_entry_lines ON public.journal_entry_lines;
CREATE POLICY finance_read_journal_entry_lines ON public.journal_entry_lines
FOR SELECT TO authenticated
USING (
  EXISTS (
    SELECT 1 FROM public.journal_entries j
    WHERE j.id = journal_entry_lines.journal_id
      AND j.organization_id = public.current_org_id()
      AND public.can_read_journals()
      AND (public.in_my_branch_scope(j.organization_id, j.branch_id) OR public.is_org_admin_for(j.organization_id))
  )
);