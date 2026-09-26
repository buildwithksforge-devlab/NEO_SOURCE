REVOKE ALL ON FUNCTION public.in_my_module_scope(uuid, uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.in_my_module_scope(uuid, uuid, text) TO authenticated, service_role;