REVOKE ALL ON FUNCTION public.apply_loyalty_transaction() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.my_customer_id() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.my_customer_id() TO authenticated;