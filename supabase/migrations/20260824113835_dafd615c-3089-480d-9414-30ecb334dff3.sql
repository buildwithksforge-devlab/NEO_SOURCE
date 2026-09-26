-- Public storefront menu browsing must work for signed-out visitors.
GRANT EXECUTE ON FUNCTION public.neo_public_menu(uuid, uuid, text) TO anon;
GRANT EXECUTE ON FUNCTION public.neo_public_menu_modifiers(uuid, uuid[]) TO anon;