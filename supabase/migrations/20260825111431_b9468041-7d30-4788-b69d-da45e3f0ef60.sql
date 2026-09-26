REVOKE ALL ON FUNCTION public.neo_pos_autoroute_tickets() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.neo_pos_autoroute_item() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.neo_pos_autoroute_tickets() TO service_role;
GRANT EXECUTE ON FUNCTION public.neo_pos_autoroute_item() TO service_role;