CREATE OR REPLACE FUNCTION public.my_customer_org_id()
RETURNS uuid
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $$
  SELECT organization_id FROM public.customers WHERE auth_user_id = auth.uid() LIMIT 1;
$$;

REVOKE ALL ON FUNCTION public.my_customer_org_id() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.my_customer_org_id() FROM anon;
GRANT EXECUTE ON FUNCTION public.my_customer_org_id() TO authenticated, service_role;

DROP POLICY IF EXISTS carts_customer ON public.carts;
CREATE POLICY carts_customer ON public.carts
  FOR ALL TO authenticated
  USING (customer_id = public.my_customer_id())
  WITH CHECK (customer_id = public.my_customer_id()
              AND organization_id = coalesce(public.current_org_id(), public.my_customer_org_id()));

DROP POLICY IF EXISTS customer_favourites_customer ON public.customer_favourites;
CREATE POLICY customer_favourites_customer ON public.customer_favourites
  FOR ALL TO authenticated
  USING (customer_id = public.my_customer_id())
  WITH CHECK (customer_id = public.my_customer_id()
              AND organization_id = coalesce(public.current_org_id(), public.my_customer_org_id()));

DROP POLICY IF EXISTS "customer writes own addresses" ON public.customer_addresses;
CREATE POLICY "customer writes own addresses" ON public.customer_addresses
  FOR ALL TO authenticated
  USING (customer_id = public.my_customer_id())
  WITH CHECK (customer_id = public.my_customer_id()
              AND organization_id = coalesce(public.current_org_id(), public.my_customer_org_id()));