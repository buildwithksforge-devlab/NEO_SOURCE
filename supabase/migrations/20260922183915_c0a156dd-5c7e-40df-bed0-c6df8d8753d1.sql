DROP POLICY IF EXISTS "customer writes own addresses" ON public.customer_addresses;

CREATE POLICY "customer writes own addresses"
  ON public.customer_addresses
  FOR ALL
  TO authenticated
  USING (customer_id = public.my_customer_id())
  WITH CHECK (
    customer_id = public.my_customer_id()
    AND organization_id = public.my_customer_org_id()
  );