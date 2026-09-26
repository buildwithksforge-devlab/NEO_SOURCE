DROP POLICY IF EXISTS "Members read financial states in their organisation" ON public.financial_states;
CREATE POLICY "Finance roles read financial states in their organisation"
ON public.financial_states FOR SELECT TO authenticated
USING (
  organization_id = current_org_id()
  AND (public.can_read_general_ledger() OR public.can_read_guest_ledger())
);

DROP POLICY IF EXISTS "Members read canonical states in their organisation" ON public.canonical_transaction_states;
CREATE POLICY "Finance roles read canonical states in their organisation"
ON public.canonical_transaction_states FOR SELECT TO authenticated
USING (
  organization_id = current_org_id()
  AND (public.can_read_general_ledger() OR public.can_read_guest_ledger())
);

DROP POLICY IF EXISTS "Members read canonical state history in their organisation" ON public.canonical_transaction_state_history;
CREATE POLICY "Finance roles read canonical state history in their organisation"
ON public.canonical_transaction_state_history FOR SELECT TO authenticated
USING (
  organization_id = current_org_id()
  AND (public.can_read_general_ledger() OR public.can_read_guest_ledger())
);