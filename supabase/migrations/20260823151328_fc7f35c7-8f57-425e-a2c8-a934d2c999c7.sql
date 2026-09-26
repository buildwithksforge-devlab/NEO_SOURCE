-- Store keepers raise requisitions; procurement managers turn them into orders.
-- The previous write policy only allowed procurement.requests.manage, so a
-- store keeper could not create or submit a purchase request at all.
DROP POLICY IF EXISTS purchase_requests_write ON public.purchase_requests;

CREATE POLICY purchase_requests_manage ON public.purchase_requests
  FOR ALL TO authenticated
  USING (
    public.has_permission('procurement', 'requests', 'manage')
    AND public.in_my_branch_scope(organization_id, branch_id)
  )
  WITH CHECK (
    public.has_permission('procurement', 'requests', 'manage')
    AND public.in_my_branch_scope(organization_id, branch_id)
  );

-- Requesters may create and edit their OWN request while it is still theirs to
-- change; approval remains procurement-only through neo_procurement_request_decide.
CREATE POLICY purchase_requests_requester_insert ON public.purchase_requests
  FOR INSERT TO authenticated
  WITH CHECK (
    public.has_permission('stores', 'requisition', 'create')
    AND requested_by = auth.uid()
    AND public.in_my_branch_scope(organization_id, branch_id)
  );

CREATE POLICY purchase_requests_requester_update ON public.purchase_requests
  FOR UPDATE TO authenticated
  USING (
    public.has_permission('stores', 'requisition', 'create')
    AND requested_by = auth.uid()
    AND status IN ('draft', 'returned')
  )
  WITH CHECK (
    requested_by = auth.uid()
    AND public.in_my_branch_scope(organization_id, branch_id)
  );

DROP POLICY IF EXISTS purchase_request_lines_write ON public.purchase_request_lines;
DROP POLICY IF EXISTS purchase_request_lines_manage ON public.purchase_request_lines;

CREATE POLICY purchase_request_lines_manage ON public.purchase_request_lines
  FOR ALL TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.purchase_requests r
     WHERE r.id = request_id
       AND (
         (public.has_permission('procurement', 'requests', 'manage')
          AND public.in_my_branch_scope(r.organization_id, r.branch_id))
         OR (public.has_permission('stores', 'requisition', 'create')
             AND r.requested_by = auth.uid())
       )
  ))
  WITH CHECK (EXISTS (
    SELECT 1 FROM public.purchase_requests r
     WHERE r.id = request_id
       AND public.in_my_branch_scope(r.organization_id, r.branch_id)
       AND (
         public.has_permission('procurement', 'requests', 'manage')
         OR (public.has_permission('stores', 'requisition', 'create')
             AND r.requested_by = auth.uid()
             AND r.status IN ('draft', 'returned'))
       )
  ));