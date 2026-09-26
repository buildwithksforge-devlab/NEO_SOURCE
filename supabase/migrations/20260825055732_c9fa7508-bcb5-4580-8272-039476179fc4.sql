REVOKE EXECUTE ON FUNCTION public.neo_public_menu_modifiers(uuid, uuid[]) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.neo_public_menu_modifiers(uuid, uuid[]) FROM anon;
GRANT EXECUTE ON FUNCTION public.neo_public_menu_modifiers(uuid, uuid[]) TO authenticated;