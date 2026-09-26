-- ============ CONFIGURATION DATA (property-scoped, admins keep access) ============
DROP POLICY IF EXISTS menu_items_select ON public.menu_items;
CREATE POLICY menu_items_select ON public.menu_items FOR SELECT TO authenticated
USING (public.in_my_config_scope(organization_id, branch_id));
DROP POLICY IF EXISTS menu_items_manage ON public.menu_items;
CREATE POLICY menu_items_manage ON public.menu_items FOR ALL TO authenticated
USING (public.in_my_config_scope(organization_id, branch_id)
  AND (public.has_permission('pos','menu.manage') OR public.has_permission('pos','settings.manage') OR public.has_permission('pos','tables.manage')))
WITH CHECK (public.in_my_config_scope(organization_id, branch_id)
  AND (public.has_permission('pos','menu.manage') OR public.has_permission('pos','settings.manage') OR public.has_permission('pos','tables.manage')));

DROP POLICY IF EXISTS menu_categories_select ON public.menu_categories;
CREATE POLICY menu_categories_select ON public.menu_categories FOR SELECT TO authenticated
USING (public.in_my_config_scope(organization_id, NULL));
DROP POLICY IF EXISTS menu_categories_manage ON public.menu_categories;
CREATE POLICY menu_categories_manage ON public.menu_categories FOR ALL TO authenticated
USING (public.in_my_config_scope(organization_id, NULL)
  AND (public.has_permission('pos','menu.manage') OR public.has_permission('pos','settings.manage') OR public.has_permission('pos','tables.manage')))
WITH CHECK (public.in_my_config_scope(organization_id, NULL)
  AND (public.has_permission('pos','menu.manage') OR public.has_permission('pos','settings.manage') OR public.has_permission('pos','tables.manage')));

DROP POLICY IF EXISTS recipes_select ON public.recipes;
CREATE POLICY recipes_select ON public.recipes FOR SELECT TO authenticated
USING (public.in_my_config_scope(organization_id, branch_id) OR created_by = auth.uid());
DROP POLICY IF EXISTS recipes_manage ON public.recipes;
CREATE POLICY recipes_manage ON public.recipes FOR ALL TO authenticated
USING (public.in_my_config_scope(organization_id, branch_id)
  AND (public.has_permission('pos','menu.manage') OR public.has_permission('pos','settings.manage') OR public.has_permission('pos','tables.manage')))
WITH CHECK (public.in_my_config_scope(organization_id, branch_id)
  AND (public.has_permission('pos','menu.manage') OR public.has_permission('pos','settings.manage') OR public.has_permission('pos','tables.manage')));

DROP POLICY IF EXISTS stock_items_select ON public.stock_items;
CREATE POLICY stock_items_select ON public.stock_items FOR SELECT TO authenticated
USING (public.in_my_config_scope(organization_id, branch_id));
DROP POLICY IF EXISTS stock_items_write ON public.stock_items;
CREATE POLICY stock_items_write ON public.stock_items FOR ALL TO authenticated
USING (public.in_my_config_scope(organization_id, branch_id) AND public.has_permission('inventory','items.manage'))
WITH CHECK (public.in_my_config_scope(organization_id, branch_id) AND public.has_permission('inventory','items.manage'));

DROP POLICY IF EXISTS stock_locations_select ON public.stock_locations;
CREATE POLICY stock_locations_select ON public.stock_locations FOR SELECT TO authenticated
USING (public.in_my_config_scope(organization_id, branch_id));
DROP POLICY IF EXISTS stock_locations_write ON public.stock_locations;
CREATE POLICY stock_locations_write ON public.stock_locations FOR ALL TO authenticated
USING (public.in_my_config_scope(organization_id, branch_id) AND public.has_permission('inventory','settings.manage'))
WITH CHECK (public.in_my_config_scope(organization_id, branch_id) AND public.has_permission('inventory','settings.manage'));

DROP POLICY IF EXISTS suppliers_select ON public.suppliers;
CREATE POLICY suppliers_select ON public.suppliers FOR SELECT TO authenticated
USING (public.in_my_config_scope(organization_id, branch_id));
DROP POLICY IF EXISTS suppliers_write ON public.suppliers;
CREATE POLICY suppliers_write ON public.suppliers FOR ALL TO authenticated
USING (public.in_my_config_scope(organization_id, branch_id) AND public.has_permission('procurement','suppliers.manage'))
WITH CHECK (public.in_my_config_scope(organization_id, branch_id) AND public.has_permission('procurement','suppliers.manage'));

-- ============ STOCK BALANCES AND MOVEMENTS ============
DROP POLICY IF EXISTS stock_levels_select ON public.stock_levels;
CREATE POLICY stock_levels_select ON public.stock_levels FOR SELECT TO authenticated
USING (organization_id = public.current_org_id() AND (
  (location_id IS NULL AND public.in_my_config_scope(organization_id, NULL))
  OR EXISTS (SELECT 1 FROM public.stock_locations l WHERE l.id = stock_levels.location_id
             AND public.in_my_config_scope(l.organization_id, l.branch_id))));
DROP POLICY IF EXISTS stock_levels_write ON public.stock_levels;
CREATE POLICY stock_levels_write ON public.stock_levels FOR ALL TO authenticated
USING (organization_id = public.current_org_id() AND public.has_permission('inventory','stock.manage') AND (
  (location_id IS NULL AND public.in_my_config_scope(organization_id, NULL))
  OR EXISTS (SELECT 1 FROM public.stock_locations l WHERE l.id = stock_levels.location_id
             AND public.in_my_config_scope(l.organization_id, l.branch_id))))
WITH CHECK (organization_id = public.current_org_id() AND public.has_permission('inventory','stock.manage') AND (
  (location_id IS NULL AND public.in_my_config_scope(organization_id, NULL))
  OR EXISTS (SELECT 1 FROM public.stock_locations l WHERE l.id = stock_levels.location_id
             AND public.in_my_config_scope(l.organization_id, l.branch_id))));

DROP POLICY IF EXISTS stock_movements_select ON public.stock_movements;
CREATE POLICY stock_movements_select ON public.stock_movements FOR SELECT TO authenticated
USING (public.in_my_config_scope(organization_id, branch_id)
  OR EXISTS (SELECT 1 FROM public.stock_locations l WHERE l.id = stock_movements.location_id
             AND public.in_my_config_scope(l.organization_id, l.branch_id)));
DROP POLICY IF EXISTS stock_movements_write ON public.stock_movements;
CREATE POLICY stock_movements_write ON public.stock_movements FOR ALL TO authenticated
USING (public.has_permission('inventory','stock.manage') AND (public.in_my_config_scope(organization_id, branch_id)
  OR EXISTS (SELECT 1 FROM public.stock_locations l WHERE l.id = stock_movements.location_id
             AND public.in_my_config_scope(l.organization_id, l.branch_id))))
WITH CHECK (public.has_permission('inventory','stock.manage') AND (public.in_my_config_scope(organization_id, branch_id)
  OR EXISTS (SELECT 1 FROM public.stock_locations l WHERE l.id = stock_movements.location_id
             AND public.in_my_config_scope(l.organization_id, l.branch_id))));

-- ============ PROCUREMENT ============
DROP POLICY IF EXISTS purchase_requests_select ON public.purchase_requests;
CREATE POLICY purchase_requests_select ON public.purchase_requests FOR SELECT TO authenticated
USING (requested_by = auth.uid()
  OR public.in_my_scope(organization_id, branch_id, department_id, NULL, requested_by, requested_by));
DROP POLICY IF EXISTS purchase_requests_write ON public.purchase_requests;
CREATE POLICY purchase_requests_write ON public.purchase_requests FOR ALL TO authenticated
USING (public.has_permission('procurement','requests.manage')
  AND (requested_by = auth.uid() OR public.in_my_scope(organization_id, branch_id, department_id, NULL, requested_by, requested_by)))
WITH CHECK (public.has_permission('procurement','requests.manage')
  AND public.in_my_branch_scope(organization_id, branch_id));

DROP POLICY IF EXISTS purchase_orders_select ON public.purchase_orders;
CREATE POLICY purchase_orders_select ON public.purchase_orders FOR SELECT TO authenticated
USING (created_by = auth.uid()
  OR public.in_my_scope(organization_id, branch_id, department_id, NULL, NULL, created_by));
DROP POLICY IF EXISTS purchase_orders_write ON public.purchase_orders;
CREATE POLICY purchase_orders_write ON public.purchase_orders FOR ALL TO authenticated
USING (public.has_permission('procurement','orders.manage')
  AND (created_by = auth.uid() OR public.in_my_scope(organization_id, branch_id, department_id, NULL, NULL, created_by)))
WITH CHECK (public.has_permission('procurement','orders.manage')
  AND public.in_my_branch_scope(organization_id, branch_id));

DROP POLICY IF EXISTS purchase_order_lines_select ON public.purchase_order_lines;
CREATE POLICY purchase_order_lines_select ON public.purchase_order_lines FOR SELECT TO authenticated
USING (EXISTS (SELECT 1 FROM public.purchase_orders o WHERE o.id = purchase_order_lines.order_id
  AND (o.created_by = auth.uid() OR public.in_my_scope(o.organization_id, o.branch_id, o.department_id, NULL, NULL, o.created_by))));
DROP POLICY IF EXISTS purchase_order_lines_write ON public.purchase_order_lines;
CREATE POLICY purchase_order_lines_write ON public.purchase_order_lines FOR ALL TO authenticated
USING (public.has_permission('procurement','orders.manage') AND EXISTS (
  SELECT 1 FROM public.purchase_orders o WHERE o.id = purchase_order_lines.order_id
  AND (o.created_by = auth.uid() OR public.in_my_scope(o.organization_id, o.branch_id, o.department_id, NULL, NULL, o.created_by))))
WITH CHECK (public.has_permission('procurement','orders.manage') AND EXISTS (
  SELECT 1 FROM public.purchase_orders o WHERE o.id = purchase_order_lines.order_id
  AND public.in_my_branch_scope(o.organization_id, o.branch_id)));

DROP POLICY IF EXISTS goods_receipts_select ON public.goods_receipts;
CREATE POLICY goods_receipts_select ON public.goods_receipts FOR SELECT TO authenticated
USING (public.in_my_branch_scope(organization_id, branch_id) OR public.is_org_admin());
DROP POLICY IF EXISTS goods_receipts_write ON public.goods_receipts;
CREATE POLICY goods_receipts_write ON public.goods_receipts FOR ALL TO authenticated
USING (public.has_permission('procurement','receiving.manage') AND public.in_my_branch_scope(organization_id, branch_id))
WITH CHECK (public.has_permission('procurement','receiving.manage') AND public.in_my_branch_scope(organization_id, branch_id));

DROP POLICY IF EXISTS goods_receipt_lines_select ON public.goods_receipt_lines;
CREATE POLICY goods_receipt_lines_select ON public.goods_receipt_lines FOR SELECT TO authenticated
USING (EXISTS (SELECT 1 FROM public.goods_receipts g WHERE g.id = goods_receipt_lines.receipt_id
  AND (public.in_my_branch_scope(g.organization_id, g.branch_id) OR public.is_org_admin())));
DROP POLICY IF EXISTS goods_receipt_lines_write ON public.goods_receipt_lines;
CREATE POLICY goods_receipt_lines_write ON public.goods_receipt_lines FOR ALL TO authenticated
USING (public.has_permission('procurement','receiving.manage') AND EXISTS (
  SELECT 1 FROM public.goods_receipts g WHERE g.id = goods_receipt_lines.receipt_id
  AND public.in_my_branch_scope(g.organization_id, g.branch_id)))
WITH CHECK (public.has_permission('procurement','receiving.manage') AND EXISTS (
  SELECT 1 FROM public.goods_receipts g WHERE g.id = goods_receipt_lines.receipt_id
  AND public.in_my_branch_scope(g.organization_id, g.branch_id)));

DROP POLICY IF EXISTS supplier_invoices_select ON public.supplier_invoices;
CREATE POLICY supplier_invoices_select ON public.supplier_invoices FOR SELECT TO authenticated
USING (created_by = auth.uid() OR public.in_my_branch_scope(organization_id, branch_id) OR public.is_org_admin());
DROP POLICY IF EXISTS supplier_invoices_write ON public.supplier_invoices;
CREATE POLICY supplier_invoices_write ON public.supplier_invoices FOR ALL TO authenticated
USING (public.has_permission('procurement','invoices.manage')
  AND (created_by = auth.uid() OR public.in_my_branch_scope(organization_id, branch_id)))
WITH CHECK (public.has_permission('procurement','invoices.manage') AND public.in_my_branch_scope(organization_id, branch_id));

-- ============ FINANCE ============
DROP POLICY IF EXISTS finance_read_invoices ON public.invoices;
CREATE POLICY finance_read_invoices ON public.invoices FOR SELECT TO authenticated
USING ((public.has_permission('finance','view') OR public.is_org_admin())
  AND (public.in_my_branch_scope(organization_id, branch_id) OR public.is_org_admin() OR created_by = auth.uid()));
DROP POLICY IF EXISTS finance_update_invoices ON public.invoices;
CREATE POLICY finance_update_invoices ON public.invoices FOR UPDATE TO authenticated
USING ((public.has_permission('finance','edit') OR public.is_org_admin())
  AND (public.in_my_branch_scope(organization_id, branch_id) OR public.is_org_admin()))
WITH CHECK (organization_id = public.current_org_id()
  AND (public.in_my_branch_scope(organization_id, branch_id) OR public.is_org_admin()));

DROP POLICY IF EXISTS finance_read_invoice_lines ON public.invoice_lines;
CREATE POLICY finance_read_invoice_lines ON public.invoice_lines FOR SELECT TO authenticated
USING ((public.has_permission('finance','view') OR public.is_org_admin()) AND EXISTS (
  SELECT 1 FROM public.invoices i WHERE i.id = invoice_lines.invoice_id
  AND (public.in_my_branch_scope(i.organization_id, i.branch_id) OR public.is_org_admin() OR i.created_by = auth.uid())));

DROP POLICY IF EXISTS staff_read_payments ON public.payments;
CREATE POLICY staff_read_payments ON public.payments FOR SELECT TO authenticated
USING (public.in_my_branch_scope(organization_id, branch_id) OR public.is_org_admin());
DROP POLICY IF EXISTS staff_update_payments ON public.payments;
CREATE POLICY staff_update_payments ON public.payments FOR UPDATE TO authenticated
USING (public.has_permission('pms','write')
  AND (public.in_my_branch_scope(organization_id, branch_id) OR public.is_org_admin()))
WITH CHECK (organization_id = public.current_org_id()
  AND (public.in_my_branch_scope(organization_id, branch_id) OR public.is_org_admin()));

DROP POLICY IF EXISTS finance_read_journal_entries ON public.journal_entries;
CREATE POLICY finance_read_journal_entries ON public.journal_entries FOR SELECT TO authenticated
USING ((public.has_permission('finance','view') OR public.is_org_admin())
  AND (public.in_my_branch_scope(organization_id, branch_id) OR public.is_org_admin() OR created_by = auth.uid()));

DROP POLICY IF EXISTS finance_read_journal_entry_lines ON public.journal_entry_lines;
CREATE POLICY finance_read_journal_entry_lines ON public.journal_entry_lines FOR SELECT TO authenticated
USING ((public.has_permission('finance','view') OR public.is_org_admin())
  AND (public.in_my_branch_scope(organization_id, branch_id) OR public.is_org_admin()));

DROP POLICY IF EXISTS finance_read_budgets ON public.budgets;
CREATE POLICY finance_read_budgets ON public.budgets FOR SELECT TO authenticated
USING ((public.has_permission('finance','view') OR public.is_org_admin())
  AND (public.in_my_scope(organization_id, branch_id, department_id, NULL, NULL, created_by) OR public.is_org_admin()));
DROP POLICY IF EXISTS finance_update_budgets ON public.budgets;
CREATE POLICY finance_update_budgets ON public.budgets FOR UPDATE TO authenticated
USING ((public.has_permission('finance','edit') OR public.is_org_admin())
  AND (public.in_my_branch_scope(organization_id, branch_id) OR public.is_org_admin()))
WITH CHECK (organization_id = public.current_org_id()
  AND (public.in_my_branch_scope(organization_id, branch_id) OR public.is_org_admin()));

-- ============ POS SHIFTS ============
DROP POLICY IF EXISTS pos_shifts_update ON public.pos_shifts;
CREATE POLICY pos_shifts_update ON public.pos_shifts FOR UPDATE TO authenticated
USING ((public.has_permission('pos','shifts.close') OR public.has_permission('pos','shifts.review'))
  AND public.in_my_scope(organization_id, branch_id, NULL, station_id, cashier_id, NULL))
WITH CHECK (organization_id = public.current_org_id());