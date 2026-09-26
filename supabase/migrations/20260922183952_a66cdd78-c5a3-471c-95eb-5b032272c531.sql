DROP POLICY IF EXISTS "carts_customer" ON public.carts;

CREATE POLICY "carts_customer"
  ON public.carts
  FOR ALL
  TO authenticated
  USING (customer_id = public.my_customer_id())
  WITH CHECK (
    customer_id = public.my_customer_id()
    AND organization_id = public.my_customer_org_id()
  );