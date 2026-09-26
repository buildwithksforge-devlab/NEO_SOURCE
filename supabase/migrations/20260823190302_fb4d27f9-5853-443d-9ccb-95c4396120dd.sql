ALTER FUNCTION public.neo_assert_reporting_scope(uuid, date, date) SECURITY INVOKER;
REVOKE ALL ON FUNCTION public.neo_assert_reporting_scope(uuid, date, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.neo_assert_reporting_scope(uuid, date, date) TO authenticated, service_role;