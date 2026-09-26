-- NEØ P0: strict organisation isolation for Finance-bearing tables.
-- Root cause: policies wrote "<scope predicate> OR is_org_admin()". is_org_admin()
-- is a property of the CALLER (am I an admin of my own org?), not of the ROW, so the
-- disjunct removed every organisation constraint for owners / system administrators.

CREATE OR REPLACE FUNCTION public.is_org_admin_for(_org uuid)
RETURNS boolean
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $$
  SELECT _org IS NOT NULL
     AND _org = public.current_org_id()
     AND public.is_org_admin();
$$;

REVOKE ALL ON FUNCTION public.is_org_admin_for(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.is_org_admin_for(uuid) TO authenticated, service_role;

-- journals -------------------------------------------------------------
DROP POLICY IF EXISTS finance_read_journal_entries ON public.journal_entries;
CREATE POLICY finance_read_journal_entries ON public.journal_entries FOR SELECT TO authenticated
USING (
  organization_id = public.current_org_id()
  AND public.can_read_general_ledger()
  AND (public.in_my_branch_scope(organization_id, branch_id) OR public.is_org_admin_for(organization_id))
);

DROP POLICY IF EXISTS finance_read_journal_entry_lines ON public.journal_entry_lines;
CREATE POLICY finance_read_journal_entry_lines ON public.journal_entry_lines FOR SELECT TO authenticated
USING (
  organization_id = public.current_org_id()
  AND public.can_read_general_ledger()
  AND (public.in_my_branch_scope(organization_id, branch_id) OR public.is_org_admin_for(organization_id))
);

-- receivables ----------------------------------------------------------
DROP POLICY IF EXISTS finance_read_invoices ON public.invoices;
CREATE POLICY finance_read_invoices ON public.invoices FOR SELECT TO authenticated
USING (
  organization_id = public.current_org_id()
  AND (public.can_read_general_ledger() OR public.can_read_guest_ledger() OR created_by = auth.uid())
  AND (
    public.in_my_branch_scope(organization_id, branch_id)
    OR public.is_org_admin_for(organization_id)
    OR created_by = auth.uid()
  )
);

DROP POLICY IF EXISTS finance_update_invoices ON public.invoices;
CREATE POLICY finance_update_invoices ON public.invoices FOR UPDATE TO authenticated
USING (
  organization_id = public.current_org_id()
  AND (public.has_permission('finance','edit') OR public.is_org_admin_for(organization_id))
  AND (public.in_my_branch_scope(organization_id, branch_id) OR public.is_org_admin_for(organization_id))
)
WITH CHECK (
  organization_id = public.current_org_id()
  AND (public.in_my_branch_scope(organization_id, branch_id) OR public.is_org_admin_for(organization_id))
);

DROP POLICY IF EXISTS finance_read_invoice_lines ON public.invoice_lines;
CREATE POLICY finance_read_invoice_lines ON public.invoice_lines FOR SELECT TO authenticated
USING (
  organization_id = public.current_org_id()
  AND (public.has_permission('finance','view') OR public.is_org_admin_for(organization_id))
  AND EXISTS (
    SELECT 1 FROM public.invoices i
     WHERE i.id = invoice_lines.invoice_id
       AND i.organization_id = public.current_org_id()
       AND (
         public.in_my_branch_scope(i.organization_id, i.branch_id)
         OR public.is_org_admin_for(i.organization_id)
         OR i.created_by = auth.uid()
       )
  )
);

-- collections / payments ----------------------------------------------
DROP POLICY IF EXISTS staff_read_payments ON public.payments;
CREATE POLICY staff_read_payments ON public.payments FOR SELECT TO authenticated
USING (
  organization_id = public.current_org_id()
  AND (public.in_my_branch_scope(organization_id, branch_id) OR public.is_org_admin_for(organization_id))
  AND (public.can_read_guest_ledger() OR public.can_read_general_ledger())
);

DROP POLICY IF EXISTS staff_update_payments ON public.payments;
CREATE POLICY staff_update_payments ON public.payments FOR UPDATE TO authenticated
USING (
  organization_id = public.current_org_id()
  AND public.has_permission('pms','write')
  AND (public.in_my_branch_scope(organization_id, branch_id) OR public.is_org_admin_for(organization_id))
)
WITH CHECK (
  organization_id = public.current_org_id()
  AND (public.in_my_branch_scope(organization_id, branch_id) OR public.is_org_admin_for(organization_id))
);

-- payables -------------------------------------------------------------
DROP POLICY IF EXISTS supplier_invoices_select ON public.supplier_invoices;
CREATE POLICY supplier_invoices_select ON public.supplier_invoices FOR SELECT TO authenticated
USING (
  organization_id = public.current_org_id()
  AND (
    created_by = auth.uid()
    OR public.in_my_branch_scope(organization_id, branch_id)
    OR public.is_org_admin_for(organization_id)
  )
);

DROP POLICY IF EXISTS goods_receipts_select ON public.goods_receipts;
CREATE POLICY goods_receipts_select ON public.goods_receipts FOR SELECT TO authenticated
USING (
  organization_id = public.current_org_id()
  AND (public.in_my_branch_scope(organization_id, branch_id) OR public.is_org_admin_for(organization_id))
);

DROP POLICY IF EXISTS goods_receipt_lines_select ON public.goods_receipt_lines;
CREATE POLICY goods_receipt_lines_select ON public.goods_receipt_lines FOR SELECT TO authenticated
USING (
  EXISTS (
    SELECT 1 FROM public.goods_receipts g
     WHERE g.id = goods_receipt_lines.receipt_id
       AND g.organization_id = public.current_org_id()
       AND (public.in_my_branch_scope(g.organization_id, g.branch_id) OR public.is_org_admin_for(g.organization_id))
  )
);

-- budgets --------------------------------------------------------------
DROP POLICY IF EXISTS finance_read_budgets ON public.budgets;
CREATE POLICY finance_read_budgets ON public.budgets FOR SELECT TO authenticated
USING (
  organization_id = public.current_org_id()
  AND (public.has_permission('finance','view') OR public.is_org_admin_for(organization_id))
  AND (
    public.in_my_scope(organization_id, branch_id, department_id, NULL::uuid, NULL::uuid, created_by)
    OR public.is_org_admin_for(organization_id)
  )
);

DROP POLICY IF EXISTS finance_update_budgets ON public.budgets;
CREATE POLICY finance_update_budgets ON public.budgets FOR UPDATE TO authenticated
USING (
  organization_id = public.current_org_id()
  AND (public.has_permission('finance','edit') OR public.is_org_admin_for(organization_id))
  AND (public.in_my_branch_scope(organization_id, branch_id) OR public.is_org_admin_for(organization_id))
)
WITH CHECK (
  organization_id = public.current_org_id()
  AND (public.in_my_branch_scope(organization_id, branch_id) OR public.is_org_admin_for(organization_id))
);