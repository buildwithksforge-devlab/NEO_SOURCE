REVOKE EXECUTE ON FUNCTION public.pos_save_menu(text, text, uuid, text, text, uuid, text) FROM anon, public;
REVOKE EXECUTE ON FUNCTION public.neo_menu_save(uuid, text, text, uuid, text, text, date, date, integer[], time without time zone, time without time zone, text) FROM anon, public;
GRANT EXECUTE ON FUNCTION public.pos_save_menu(text, text, uuid, text, text, uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.neo_menu_save(uuid, text, text, uuid, text, text, date, date, integer[], time without time zone, time without time zone, text) TO authenticated;