DROP POLICY IF EXISTS purchase_orders_select ON public.purchase_orders;
CREATE POLICY purchase_orders_select ON public.purchase_orders
FOR SELECT USING (
  organization_id = (SELECT public.current_org_id())
  AND (
    created_by = (SELECT auth.uid())
    OR (SELECT public.current_access_scope()) IN ('organisation','technical')
    OR public.in_my_scope(organization_id, branch_id, department_id, NULL::uuid, NULL::uuid, created_by)
  )
);

DROP POLICY IF EXISTS goods_receipts_select ON public.goods_receipts;
CREATE POLICY goods_receipts_select ON public.goods_receipts
FOR SELECT USING (
  organization_id = (SELECT public.current_org_id())
  AND (
    (SELECT public.current_access_scope()) IN ('organisation','technical')
    OR branch_id = ANY ((SELECT public.current_branch_ids())::uuid[])
    OR public.is_org_admin_for(organization_id)
  )
);

CREATE INDEX IF NOT EXISTS idx_purchase_orders_org_created
  ON public.purchase_orders (organization_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_goods_receipts_org_received
  ON public.goods_receipts (organization_id, received_at DESC);