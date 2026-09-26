-- Child tables inherited no scope from their parent; add explicit parent scoping.
DROP POLICY IF EXISTS guest_laundry_items_insert ON public.guest_laundry_items;
CREATE POLICY guest_laundry_items_insert ON public.guest_laundry_items FOR INSERT TO authenticated
WITH CHECK (
  EXISTS (
    SELECT 1 FROM public.guest_laundry_orders o
     WHERE o.id = guest_laundry_items.order_id
       AND public.in_my_branch_scope(o.organization_id, o.branch_id)
  )
  AND (public.has_permission('laundry','create') OR public.has_permission('laundry','edit') OR public.is_org_admin())
);

DROP POLICY IF EXISTS guest_laundry_items_update ON public.guest_laundry_items;
CREATE POLICY guest_laundry_items_update ON public.guest_laundry_items FOR UPDATE TO authenticated
USING (
  EXISTS (
    SELECT 1 FROM public.guest_laundry_orders o
     WHERE o.id = guest_laundry_items.order_id
       AND public.in_my_branch_scope(o.organization_id, o.branch_id)
  )
  AND (public.has_permission('laundry','edit') OR public.has_permission('laundry','approve') OR public.is_org_admin())
)
WITH CHECK (
  EXISTS (
    SELECT 1 FROM public.guest_laundry_orders o
     WHERE o.id = guest_laundry_items.order_id
       AND public.in_my_branch_scope(o.organization_id, o.branch_id)
  )
);

DROP POLICY IF EXISTS housekeeping_job_results_insert ON public.housekeeping_job_results;
CREATE POLICY housekeeping_job_results_insert ON public.housekeeping_job_results FOR INSERT TO authenticated
WITH CHECK (
  EXISTS (
    SELECT 1 FROM public.housekeeping_jobs j
     WHERE j.id = housekeeping_job_results.job_id
       AND public.in_my_branch_scope(j.organization_id, j.branch_id)
  )
  AND (public.has_permission('housekeeping','create') OR public.has_permission('housekeeping','edit') OR public.is_org_admin())
);

DROP POLICY IF EXISTS housekeeping_job_results_update ON public.housekeeping_job_results;
CREATE POLICY housekeeping_job_results_update ON public.housekeeping_job_results FOR UPDATE TO authenticated
USING (
  EXISTS (
    SELECT 1 FROM public.housekeeping_jobs j
     WHERE j.id = housekeeping_job_results.job_id
       AND public.in_my_branch_scope(j.organization_id, j.branch_id)
  )
  AND (public.has_permission('housekeeping','edit') OR public.has_permission('housekeeping','approve') OR public.is_org_admin())
)
WITH CHECK (
  EXISTS (
    SELECT 1 FROM public.housekeeping_jobs j
     WHERE j.id = housekeeping_job_results.job_id
       AND public.in_my_branch_scope(j.organization_id, j.branch_id)
  )
);