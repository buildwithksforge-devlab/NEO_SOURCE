REVOKE EXECUTE ON FUNCTION public.neo_menu_catalogue(uuid, boolean) FROM anon, public;
GRANT EXECUTE ON FUNCTION public.neo_menu_catalogue(uuid, boolean) TO authenticated;