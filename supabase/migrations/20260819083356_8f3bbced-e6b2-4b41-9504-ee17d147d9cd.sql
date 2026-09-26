-- Stage 2: scope-enforced RLS on priority operational tables

-- POS ORDERS -------------------------------------------------
DROP POLICY IF EXISTS pos_orders_select ON public.pos_orders;
CREATE POLICY pos_orders_select ON public.pos_orders FOR SELECT TO authenticated
USING (
  public.in_my_scope(organization_id, branch_id, department_id, station_id, waiter_id, created_by)
  OR public.is_shared_with_me('pos_order', id)
);

DROP POLICY IF EXISTS pos_orders_write ON public.pos_orders;
CREATE POLICY pos_orders_insert ON public.pos_orders FOR INSERT TO authenticated
WITH CHECK (
  organization_id = public.current_org_id()
  AND public.has_permission('pos','orders.create')
  AND (created_by IS NULL OR created_by = auth.uid())
);
CREATE POLICY pos_orders_update ON public.pos_orders FOR UPDATE TO authenticated
USING (
  public.has_permission('pos','orders.create')
  AND (
    public.in_my_scope(organization_id, branch_id, department_id, station_id, waiter_id, created_by)
    OR public.is_shared_with_me('pos_order', id)
  )
)
WITH CHECK (organization_id = public.current_org_id());
CREATE POLICY pos_orders_delete ON public.pos_orders FOR DELETE TO authenticated
USING (
  organization_id = public.current_org_id()
  AND public.is_org_admin()
);

-- POS ORDER ITEMS --------------------------------------------
DROP POLICY IF EXISTS pos_order_items_select ON public.pos_order_items;
CREATE POLICY pos_order_items_select ON public.pos_order_items FOR SELECT TO authenticated
USING (
  EXISTS (
    SELECT 1 FROM public.pos_orders o
    WHERE o.id = pos_order_items.order_id
      AND (
        public.in_my_scope(o.organization_id, o.branch_id, o.department_id, o.station_id, o.waiter_id, o.created_by)
        OR public.is_shared_with_me('pos_order', o.id)
      )
  )
);

DROP POLICY IF EXISTS pos_order_items_write ON public.pos_order_items;
CREATE POLICY pos_order_items_write ON public.pos_order_items FOR ALL TO authenticated
USING (
  (public.has_permission('pos','orders.create') OR public.has_permission('pos','kds.view'))
  AND EXISTS (
    SELECT 1 FROM public.pos_orders o
    WHERE o.id = pos_order_items.order_id
      AND (
        public.in_my_scope(o.organization_id, o.branch_id, o.department_id, o.station_id, o.waiter_id, o.created_by)
        OR public.is_shared_with_me('pos_order', o.id)
      )
  )
)
WITH CHECK (organization_id = public.current_org_id());

-- STATION TICKETS --------------------------------------------
DROP POLICY IF EXISTS station_tickets_select ON public.station_tickets;
CREATE POLICY station_tickets_select ON public.station_tickets FOR SELECT TO authenticated
USING (
  public.in_my_scope(organization_id, branch_id, department_id, station_id, assigned_chef_id, created_by)
  OR public.is_shared_with_me('station_ticket', id)
  OR EXISTS (
    SELECT 1 FROM public.pos_orders o
    WHERE o.id = station_tickets.order_id
      AND (o.waiter_id = auth.uid() OR o.created_by = auth.uid())
  )
);

DROP POLICY IF EXISTS station_tickets_write ON public.station_tickets;
CREATE POLICY station_tickets_write ON public.station_tickets FOR ALL TO authenticated
USING (
  (public.has_permission('pos','kds.view') OR public.has_permission('pos','orders.create'))
  AND (
    public.in_my_scope(organization_id, branch_id, department_id, station_id, assigned_chef_id, created_by)
    OR public.is_shared_with_me('station_ticket', id)
    OR EXISTS (
      SELECT 1 FROM public.pos_orders o
      WHERE o.id = station_tickets.order_id
        AND (o.waiter_id = auth.uid() OR o.created_by = auth.uid())
    )
  )
)
WITH CHECK (organization_id = public.current_org_id());

-- HOUSEKEEPING JOBS ------------------------------------------
DROP POLICY IF EXISTS housekeeping_jobs_select ON public.housekeeping_jobs;
CREATE POLICY housekeeping_jobs_select ON public.housekeeping_jobs FOR SELECT TO authenticated
USING (
  public.in_my_scope(organization_id, branch_id, department_id, NULL, assignee_id, created_by)
  OR public.is_shared_with_me('housekeeping_job', id)
);

DROP POLICY IF EXISTS housekeeping_jobs_update ON public.housekeeping_jobs;
CREATE POLICY housekeeping_jobs_update ON public.housekeeping_jobs FOR UPDATE TO authenticated
USING (
  (public.has_permission('housekeeping','edit') OR public.has_permission('housekeeping','approve') OR public.is_org_admin())
  AND (
    public.in_my_scope(organization_id, branch_id, department_id, NULL, assignee_id, created_by)
    OR public.is_shared_with_me('housekeeping_job', id)
  )
)
WITH CHECK (organization_id = public.current_org_id());

-- DELIVERY ORDERS --------------------------------------------
DROP POLICY IF EXISTS delivery_orders_staff_read ON public.delivery_orders;
CREATE POLICY delivery_orders_staff_read ON public.delivery_orders FOR SELECT TO authenticated
USING (
  public.is_staff()
  AND public.has_permission('delivery','orders.view')
  AND public.in_my_scope(organization_id, branch_id, NULL, NULL, rider_id, NULL)
);

DROP POLICY IF EXISTS delivery_orders_staff_update ON public.delivery_orders;
CREATE POLICY delivery_orders_staff_update ON public.delivery_orders FOR UPDATE TO authenticated
USING (
  public.has_permission('delivery','orders.update')
  AND public.in_my_scope(organization_id, branch_id, NULL, NULL, rider_id, NULL)
)
WITH CHECK (organization_id = public.current_org_id());

-- MAINTENANCE WORK ORDERS ------------------------------------
DROP POLICY IF EXISTS maintenance_work_orders_select ON public.maintenance_work_orders;
CREATE POLICY maintenance_work_orders_scoped_select ON public.maintenance_work_orders FOR SELECT TO authenticated
USING (
  public.in_my_scope(organization_id, branch_id, requesting_department_id, NULL, assigned_to, created_by)
  OR requested_by = auth.uid()
  OR public.is_shared_with_me('maintenance_work_order', id)
);

-- CASH DRAWERS -----------------------------------------------
DROP POLICY IF EXISTS finance_read_cash_drawers ON public.cash_drawers;
CREATE POLICY cash_drawers_scoped_read ON public.cash_drawers FOR SELECT TO authenticated
USING (
  public.in_my_scope(organization_id, branch_id, NULL, NULL, assigned_user_id, NULL)
);

DROP POLICY IF EXISTS finance_update_cash_drawers ON public.cash_drawers;
CREATE POLICY cash_drawers_scoped_update ON public.cash_drawers FOR UPDATE TO authenticated
USING (
  (public.has_permission('finance','edit') OR public.is_org_admin())
  AND public.in_my_scope(organization_id, branch_id, NULL, NULL, assigned_user_id, NULL)
)
WITH CHECK (organization_id = public.current_org_id());

-- POS SHIFTS -------------------------------------------------
DROP POLICY IF EXISTS pos_shifts_select ON public.pos_shifts;
CREATE POLICY pos_shifts_scoped_select ON public.pos_shifts FOR SELECT TO authenticated
USING (
  public.in_my_scope(organization_id, branch_id, NULL, station_id, cashier_id, NULL)
);