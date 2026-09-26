
REVOKE EXECUTE ON FUNCTION public.neo_ap_match_summary(uuid) FROM anon, public;
GRANT EXECUTE ON FUNCTION public.neo_ap_match_summary(uuid) TO authenticated, service_role;
