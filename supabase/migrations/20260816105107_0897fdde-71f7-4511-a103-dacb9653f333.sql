REVOKE EXECUTE ON FUNCTION public.customer_register_self(uuid, uuid, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.customer_register_self(uuid, uuid, text, text) TO authenticated, service_role;

REVOKE EXECUTE ON FUNCTION public.resolve_public_workspace(text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.resolve_public_workspace(text, text) TO authenticated, service_role;