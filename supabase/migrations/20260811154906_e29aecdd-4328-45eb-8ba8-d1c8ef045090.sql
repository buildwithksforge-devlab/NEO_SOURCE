
REVOKE EXECUTE ON FUNCTION public.pms_available_rooms(uuid,date,date,uuid,integer,integer) FROM anon, public;
REVOKE EXECUTE ON FUNCTION public.pms_release_expired_holds() FROM anon, public;
REVOKE EXECUTE ON FUNCTION public.pms_assign_room(uuid,uuid,text) FROM anon, public;
REVOKE EXECUTE ON FUNCTION public.pms_check_in(uuid,integer,text) FROM anon, public;
REVOKE EXECUTE ON FUNCTION public.pms_post_room_charge(uuid,text,text,numeric,numeric,numeric,text,text,text) FROM anon, public;
REVOKE EXECUTE ON FUNCTION public.pms_record_payment(uuid,numeric,text,text,text) FROM anon, public;
REVOKE EXECUTE ON FUNCTION public.pms_post_accommodation(date) FROM anon, public;
REVOKE EXECUTE ON FUNCTION public.pms_transfer_room(uuid,uuid,text,text) FROM anon, public;
REVOKE EXECUTE ON FUNCTION public.pms_check_out(uuid,boolean,text) FROM anon, public;
REVOKE EXECUTE ON FUNCTION public.pms_front_office_metrics(uuid,date) FROM anon, public;

GRANT EXECUTE ON FUNCTION public.pms_available_rooms(uuid,date,date,uuid,integer,integer) TO authenticated;
GRANT EXECUTE ON FUNCTION public.pms_release_expired_holds() TO authenticated;
GRANT EXECUTE ON FUNCTION public.pms_assign_room(uuid,uuid,text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.pms_check_in(uuid,integer,text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.pms_post_room_charge(uuid,text,text,numeric,numeric,numeric,text,text,text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.pms_record_payment(uuid,numeric,text,text,text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.pms_post_accommodation(date) TO authenticated;
GRANT EXECUTE ON FUNCTION public.pms_transfer_room(uuid,uuid,text,text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.pms_check_out(uuid,boolean,text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.pms_front_office_metrics(uuid,date) TO authenticated;
