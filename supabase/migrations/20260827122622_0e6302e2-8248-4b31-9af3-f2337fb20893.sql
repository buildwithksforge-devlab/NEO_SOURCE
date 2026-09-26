REVOKE ALL ON FUNCTION public.neo_station_integrity(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.neo_station_integrity(uuid) TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.neo_station_assert_chain() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.neo_station_assert_chain() TO service_role;