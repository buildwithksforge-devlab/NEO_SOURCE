-- Guest digital activity is CRM data: gate it behind the same capability that
-- gates the customer record itself, instead of any staff account in the org.
DROP POLICY IF EXISTS "Staff read digital activity in their organisation" ON public.customer_digital_events;

CREATE POLICY "Staff read digital activity in their organisation"
  ON public.customer_digital_events FOR SELECT
  TO authenticated
  USING (
    public.is_staff()
    AND organization_id = public.current_org_id()
    AND (
      public.is_org_admin()
      OR public.has_permission('marketing', 'customers', 'view')
      OR public.has_permission('front-office', 'guests', 'view')
    )
  );