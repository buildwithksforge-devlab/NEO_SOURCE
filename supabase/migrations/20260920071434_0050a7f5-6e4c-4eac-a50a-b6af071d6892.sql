DROP POLICY IF EXISTS housekeeping_job_results_select ON public.housekeeping_job_results;
CREATE POLICY housekeeping_job_results_select ON public.housekeeping_job_results
FOR SELECT TO authenticated
USING (
  organization_id = current_org_id()
  AND EXISTS (
    SELECT 1 FROM public.housekeeping_jobs j
    WHERE j.id = housekeeping_job_results.job_id
      AND in_my_branch_scope(j.organization_id, j.branch_id)
      AND (
        j.assignee_id = auth.uid()
        OR has_permission('housekeeping'::text, 'tasks'::text, 'view'::text)
        OR has_permission('housekeeping'::text, 'tasks'::text, 'edit'::text)
        OR is_org_admin_for(j.organization_id)
      )
  )
);

ALTER POLICY goods_receipts_delete ON public.goods_receipts TO authenticated;
ALTER POLICY goods_receipts_insert ON public.goods_receipts TO authenticated;
ALTER POLICY goods_receipts_select ON public.goods_receipts TO authenticated;
ALTER POLICY goods_receipts_update ON public.goods_receipts TO authenticated;
ALTER POLICY menu_categories_manage ON public.menu_categories TO authenticated;
ALTER POLICY menu_categories_select ON public.menu_categories TO authenticated;
ALTER POLICY menu_items_manage ON public.menu_items TO authenticated;
ALTER POLICY menu_items_select ON public.menu_items TO authenticated;
ALTER POLICY "notifications delete" ON public.notifications TO authenticated;
ALTER POLICY "notifications read" ON public.notifications TO authenticated;
ALTER POLICY "notifications update" ON public.notifications TO authenticated;
ALTER POLICY "org admins update settings" ON public.organization_settings TO authenticated;
ALTER POLICY "org members read settings" ON public.organization_settings TO authenticated;
ALTER POLICY purchase_orders_delete ON public.purchase_orders TO authenticated;
ALTER POLICY purchase_orders_insert ON public.purchase_orders TO authenticated;
ALTER POLICY purchase_orders_select ON public.purchase_orders TO authenticated;
ALTER POLICY purchase_orders_update ON public.purchase_orders TO authenticated;
ALTER POLICY stock_items_select ON public.stock_items TO authenticated;
ALTER POLICY stock_items_write ON public.stock_items TO authenticated;
ALTER POLICY stock_levels_select ON public.stock_levels TO authenticated;
ALTER POLICY stock_levels_write ON public.stock_levels TO authenticated;