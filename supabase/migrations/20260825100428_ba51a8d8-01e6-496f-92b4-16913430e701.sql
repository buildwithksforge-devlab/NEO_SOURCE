DROP FUNCTION IF EXISTS public.neo_menu_save_item(uuid,text,text,uuid,uuid,uuid,uuid,numeric,numeric,integer,text);

REVOKE ALL ON FUNCTION public.can_manage_staff_photos() FROM anon, PUBLIC;
REVOKE ALL ON FUNCTION public.guard_staff_photo_change() FROM anon, PUBLIC;
REVOKE ALL ON FUNCTION public.neo_hr_set_staff_photo(uuid,uuid,text) FROM anon, PUBLIC;
REVOKE ALL ON FUNCTION public.neo_menu_catalogue(uuid,boolean) FROM anon, PUBLIC;
REVOKE ALL ON FUNCTION public.neo_menu_save_item(uuid,text,text,uuid,uuid,uuid,uuid,numeric,numeric,integer,text,text,text,text) FROM anon, PUBLIC;
REVOKE ALL ON FUNCTION public.pos_import_menu_drafts(uuid,uuid,text,text,text,jsonb,text,uuid) FROM anon, PUBLIC;

GRANT EXECUTE ON FUNCTION public.can_manage_staff_photos() TO authenticated;
GRANT EXECUTE ON FUNCTION public.neo_hr_set_staff_photo(uuid,uuid,text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.neo_menu_catalogue(uuid,boolean) TO authenticated;
GRANT EXECUTE ON FUNCTION public.neo_menu_save_item(uuid,text,text,uuid,uuid,uuid,uuid,numeric,numeric,integer,text,text,text,text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.pos_import_menu_drafts(uuid,uuid,text,text,text,jsonb,text,uuid) TO authenticated;