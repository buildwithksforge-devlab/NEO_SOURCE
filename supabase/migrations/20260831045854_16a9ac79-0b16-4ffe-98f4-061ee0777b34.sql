REVOKE ALL ON FUNCTION public.pms_assign_room(uuid,uuid,text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.pms_assign_room(uuid,uuid,text) TO authenticated;
REVOKE ALL ON FUNCTION public.pms_transfer_room(uuid,uuid,text,text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.pms_transfer_room(uuid,uuid,text,text) TO authenticated;
REVOKE ALL ON FUNCTION public.pos_post_room_charge(uuid,uuid,text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.pos_post_room_charge(uuid,uuid,text) TO authenticated;