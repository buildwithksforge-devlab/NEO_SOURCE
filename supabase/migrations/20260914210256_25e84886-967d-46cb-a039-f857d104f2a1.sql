DROP POLICY IF EXISTS purchase_orders_write ON public.purchase_orders;
CREATE POLICY purchase_orders_insert ON public.purchase_orders
FOR INSERT WITH CHECK (
  public.has_permission('procurement','orders.manage')
  AND (created_by = (SELECT auth.uid())
       OR public.in_my_scope(organization_id, branch_id, department_id, NULL::uuid, NULL::uuid, created_by))
);
CREATE POLICY purchase_orders_update ON public.purchase_orders
FOR UPDATE USING (
  public.has_permission('procurement','orders.manage')
  AND (created_by = (SELECT auth.uid())
       OR public.in_my_scope(organization_id, branch_id, department_id, NULL::uuid, NULL::uuid, created_by))
) WITH CHECK (
  public.has_permission('procurement','orders.manage')
  AND (created_by = (SELECT auth.uid())
       OR public.in_my_scope(organization_id, branch_id, department_id, NULL::uuid, NULL::uuid, created_by))
);
CREATE POLICY purchase_orders_delete ON public.purchase_orders
FOR DELETE USING (
  public.has_permission('procurement','orders.manage')
  AND (created_by = (SELECT auth.uid())
       OR public.in_my_scope(organization_id, branch_id, department_id, NULL::uuid, NULL::uuid, created_by))
);

DROP POLICY IF EXISTS goods_receipts_write ON public.goods_receipts;
CREATE POLICY goods_receipts_insert ON public.goods_receipts
FOR INSERT WITH CHECK (
  public.has_permission('procurement','receiving.manage')
  AND public.in_my_branch_scope(organization_id, branch_id)
);
CREATE POLICY goods_receipts_update ON public.goods_receipts
FOR UPDATE USING (
  public.has_permission('procurement','receiving.manage')
  AND public.in_my_branch_scope(organization_id, branch_id)
) WITH CHECK (
  public.has_permission('procurement','receiving.manage')
  AND public.in_my_branch_scope(organization_id, branch_id)
);
CREATE POLICY goods_receipts_delete ON public.goods_receipts
FOR DELETE USING (
  public.has_permission('procurement','receiving.manage')
  AND public.in_my_branch_scope(organization_id, branch_id)
);