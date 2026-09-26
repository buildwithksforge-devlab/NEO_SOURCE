REVOKE EXECUTE ON FUNCTION public.can_read_journals() FROM anon, PUBLIC;
GRANT EXECUTE ON FUNCTION public.can_read_journals() TO authenticated;