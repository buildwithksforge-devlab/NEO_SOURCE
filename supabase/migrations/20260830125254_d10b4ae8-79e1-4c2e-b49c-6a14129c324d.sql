REVOKE ALL ON FUNCTION public.neo_mpesa_retry_callback(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.neo_rpc_execute_privileges(text[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.neo_mpesa_retry_callback(uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.neo_rpc_execute_privileges(text[]) TO authenticated, service_role;