REVOKE EXECUTE ON FUNCTION public.neo_guard_owner_grant() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.neo_guard_owner_grant() TO service_role;