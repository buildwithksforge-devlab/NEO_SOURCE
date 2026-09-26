REVOKE ALL ON FUNCTION public.neo_my_work(uuid) FROM anon, PUBLIC;
GRANT EXECUTE ON FUNCTION public.neo_my_work(uuid) TO authenticated, service_role;