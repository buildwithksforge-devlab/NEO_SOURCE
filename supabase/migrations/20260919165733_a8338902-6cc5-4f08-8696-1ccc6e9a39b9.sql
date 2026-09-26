REVOKE EXECUTE ON FUNCTION public.neo_assert_tenant_context(uuid) FROM anon, authenticated, public;
REVOKE EXECUTE ON FUNCTION public.neo_assert_tenant_fk() FROM anon, authenticated, public;
REVOKE EXECUTE ON FUNCTION public.neo_tenant_safety_scan() FROM anon, authenticated, public;
GRANT EXECUTE ON FUNCTION public.neo_tenant_safety_scan() TO postgres;