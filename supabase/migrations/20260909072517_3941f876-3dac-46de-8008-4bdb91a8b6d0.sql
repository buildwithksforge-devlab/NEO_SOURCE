DROP POLICY IF EXISTS staff_read_reservations ON public.reservations;
CREATE POLICY staff_read_reservations ON public.reservations
  FOR SELECT TO authenticated
  USING (
    (created_by = auth.uid())
    OR (
      public.in_my_branch_scope(organization_id, branch_id)
      AND (
        public.has_permission('pms', 'view')
        OR public.has_permission('pms', 'write')
        OR public.has_permission('front-office', 'view')
        OR public.has_permission('front-office', 'write')
      )
    )
  );