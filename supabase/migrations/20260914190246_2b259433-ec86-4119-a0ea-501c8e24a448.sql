REVOKE EXECUTE ON FUNCTION public.neo_hr_leave_working_days(uuid, date, date, uuid) FROM anon, public;
REVOKE EXECUTE ON FUNCTION public.neo_hr_leave_sync_entitlements(uuid, integer) FROM anon, public;
REVOKE EXECUTE ON FUNCTION public.neo_hr_leave_apply(uuid, uuid, date, date, text, text, uuid, text, text) FROM anon, public;
REVOKE EXECUTE ON FUNCTION public.neo_hr_leave_decide(uuid, text, text) FROM anon, public;
REVOKE EXECUTE ON FUNCTION public.hr_touch_updated_at() FROM anon, public;
GRANT EXECUTE ON FUNCTION public.neo_hr_leave_working_days(uuid, date, date, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.neo_hr_leave_sync_entitlements(uuid, integer) TO authenticated;
GRANT EXECUTE ON FUNCTION public.neo_hr_leave_apply(uuid, uuid, date, date, text, text, uuid, text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.neo_hr_leave_decide(uuid, text, text) TO authenticated;