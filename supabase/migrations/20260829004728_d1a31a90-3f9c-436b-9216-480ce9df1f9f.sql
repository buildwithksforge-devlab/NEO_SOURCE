REVOKE ALL ON FUNCTION public.neo_kitchen_visible_station_ids() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.neo_kitchen_visible_station_ids() FROM anon;
GRANT EXECUTE ON FUNCTION public.neo_kitchen_visible_station_ids() TO authenticated;
GRANT EXECUTE ON FUNCTION public.neo_kitchen_visible_station_ids() TO service_role;