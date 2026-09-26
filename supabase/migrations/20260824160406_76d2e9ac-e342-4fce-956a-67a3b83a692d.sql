REVOKE ALL ON FUNCTION public.neo_my_approval_authority() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.neo_my_approval_authority() FROM anon;
GRANT EXECUTE ON FUNCTION public.neo_my_approval_authority() TO authenticated;