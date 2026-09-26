CREATE OR REPLACE FUNCTION public.has_exact_permission(_module text, _feature text, _action text)
RETURNS boolean
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $$
  WITH want AS (
    SELECT c.module, c.feature, c.action, public.permission_action_class(c.action) AS action_class
    FROM public.canonical_permission(_module, _feature, _action) c
  ),
  held AS (
    SELECT c.module, c.feature, c.action, public.permission_action_class(c.action) AS action_class, 'deny'::text AS effect
    FROM public.user_permissions up
    JOIN public.permissions p ON p.id = up.permission_id
    , LATERAL public.canonical_permission(p.module, p.feature, p.action) c
    WHERE up.user_id = auth.uid() AND up.effect = 'deny'
      AND up.organization_id = public.current_org_id()
    UNION ALL
    SELECT c.module, c.feature, c.action, public.permission_action_class(c.action), 'grant'
    FROM public.user_roles ur
    JOIN public.roles r ON r.id = ur.role_id AND r.active
    JOIN public.role_permissions rp ON rp.role_id = r.id
    JOIN public.permissions p ON p.id = rp.permission_id
    , LATERAL public.canonical_permission(p.module, p.feature, p.action) c
    WHERE ur.user_id = auth.uid()
      AND ur.organization_id = public.current_org_id()
      AND r.organization_id = public.current_org_id()
      AND rp.organization_id = public.current_org_id()
    UNION ALL
    SELECT c.module, c.feature, c.action, public.permission_action_class(c.action), 'grant'
    FROM public.user_permissions up
    JOIN public.permissions p ON p.id = up.permission_id
    , LATERAL public.canonical_permission(p.module, p.feature, p.action) c
    WHERE up.user_id = auth.uid() AND up.effect = 'grant'
      AND up.organization_id = public.current_org_id()
  )
  SELECT CASE
    WHEN NOT public.is_active_staff() THEN false
    WHEN EXISTS (
      SELECT 1 FROM held h, want w
      WHERE h.effect = 'deny' AND h.module = w.module
        AND (h.feature = w.feature OR h.feature = '*')
        AND (h.action = w.action OR h.action_class = w.action_class)
    ) THEN false
    WHEN public.is_org_admin() THEN true
    ELSE EXISTS (
      SELECT 1 FROM held h, want w
      WHERE h.effect = 'grant' AND h.module = w.module
        AND h.feature = w.feature
        AND h.action = w.action
    )
  END;
$$;

REVOKE ALL ON FUNCTION public.has_exact_permission(text, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.has_exact_permission(text, text, text) FROM anon;
GRANT EXECUTE ON FUNCTION public.has_exact_permission(text, text, text) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.can_read_guest_ledger()
RETURNS boolean
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $$
  SELECT public.is_active_staff() AND (
       public.is_org_admin()
    OR public.has_exact_permission('front-office','folios','view')
    OR public.has_exact_permission('pms','*','folios.view')
    OR public.has_exact_permission('finance','receivables','view')
    OR public.has_exact_permission('finance','ledger','view')
    OR public.has_exact_permission('events','billing','view')
  );
$$;

REVOKE ALL ON FUNCTION public.can_read_guest_ledger() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.can_read_guest_ledger() FROM anon;
GRANT EXECUTE ON FUNCTION public.can_read_guest_ledger() TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.can_read_general_ledger()
RETURNS boolean
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $$
  SELECT public.is_active_staff() AND (
       public.is_org_admin()
    OR public.has_exact_permission('finance','journals','view')
    OR public.has_exact_permission('finance','ledger','view')
    OR public.has_exact_permission('finance','receivables','view')
  );
$$;

REVOKE ALL ON FUNCTION public.can_read_general_ledger() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.can_read_general_ledger() FROM anon;
GRANT EXECUTE ON FUNCTION public.can_read_general_ledger() TO authenticated, service_role;

INSERT INTO public.role_permissions (organization_id, role_id, permission_id, source)
SELECT r.organization_id, r.id, p.id, 'certification'
FROM public.roles r
JOIN public.permissions p
  ON (p.module, p.feature, p.action) IN (
       ('finance','journals','view'),
       ('finance','ledger','view'),
       ('finance','receivables','view')
     )
WHERE lower(btrim(r.name)) IN ('owner','finance manager','accountant','general manager','operations manager','night auditor','financial controller')
  AND NOT EXISTS (
    SELECT 1 FROM public.role_permissions rp WHERE rp.role_id = r.id AND rp.permission_id = p.id
  );

INSERT INTO public.role_permissions (organization_id, role_id, permission_id, source)
SELECT r.organization_id, r.id, p.id, 'certification'
FROM public.roles r
JOIN public.permissions p ON (p.module, p.feature, p.action) = ('front-office','folios','view')
WHERE lower(btrim(r.name)) IN ('owner','general manager','operations manager','front office manager','front office supervisor','front office cashier','receptionist','night auditor','finance manager','accountant','reservations agent')
  AND NOT EXISTS (
    SELECT 1 FROM public.role_permissions rp WHERE rp.role_id = r.id AND rp.permission_id = p.id
  );

DROP POLICY IF EXISTS staff_read_folios ON public.folios;
CREATE POLICY staff_read_folios ON public.folios FOR SELECT TO authenticated
USING (public.in_my_branch_scope(organization_id, branch_id) AND public.can_read_guest_ledger());

DROP POLICY IF EXISTS staff_read_folio_lines ON public.folio_lines;
CREATE POLICY staff_read_folio_lines ON public.folio_lines FOR SELECT TO authenticated
USING (organization_id = public.current_org_id() AND public.can_read_guest_ledger());

DROP POLICY IF EXISTS staff_read_folio_allocations ON public.folio_allocations;
CREATE POLICY staff_read_folio_allocations ON public.folio_allocations FOR SELECT TO authenticated
USING (organization_id = public.current_org_id() AND public.can_read_guest_ledger());

DROP POLICY IF EXISTS staff_read_payments ON public.payments;
CREATE POLICY staff_read_payments ON public.payments FOR SELECT TO authenticated
USING ((public.in_my_branch_scope(organization_id, branch_id) OR public.is_org_admin())
       AND (public.can_read_guest_ledger() OR public.can_read_general_ledger()));

DROP POLICY IF EXISTS finance_read_journal_entries ON public.journal_entries;
CREATE POLICY finance_read_journal_entries ON public.journal_entries FOR SELECT TO authenticated
USING (public.can_read_general_ledger()
       AND (public.in_my_branch_scope(organization_id, branch_id) OR public.is_org_admin()));

DROP POLICY IF EXISTS finance_read_journal_entry_lines ON public.journal_entry_lines;
CREATE POLICY finance_read_journal_entry_lines ON public.journal_entry_lines FOR SELECT TO authenticated
USING (public.can_read_general_ledger()
       AND (public.in_my_branch_scope(organization_id, branch_id) OR public.is_org_admin()));

DROP POLICY IF EXISTS finance_read_invoices ON public.invoices;
CREATE POLICY finance_read_invoices ON public.invoices FOR SELECT TO authenticated
USING ((public.can_read_general_ledger() OR public.can_read_guest_ledger() OR created_by = auth.uid())
       AND (public.in_my_branch_scope(organization_id, branch_id) OR public.is_org_admin() OR created_by = auth.uid()));