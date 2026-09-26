ALTER FUNCTION public.hk_job_status_is_active(text) SET search_path TO 'public';
ALTER FUNCTION public.hk_job_type_is_room_cleaning(text) SET search_path TO 'public';
REVOKE ALL ON FUNCTION public.hk_job_status_is_active(text) FROM anon;
REVOKE ALL ON FUNCTION public.hk_job_type_is_room_cleaning(text) FROM anon;