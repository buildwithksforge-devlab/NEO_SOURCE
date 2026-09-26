REVOKE ALL ON FUNCTION public.hr_apply_attendance_tolerance() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.hr_apply_attendance_tolerance() TO service_role;