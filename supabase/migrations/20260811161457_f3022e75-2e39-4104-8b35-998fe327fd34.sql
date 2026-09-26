GRANT EXECUTE ON FUNCTION public.current_org_id() TO authenticated;
GRANT EXECUTE ON FUNCTION public.is_org_admin() TO authenticated;
GRANT EXECUTE ON FUNCTION public.is_staff() TO authenticated;
GRANT EXECUTE ON FUNCTION public.my_profile_org() TO authenticated;
GRANT EXECUTE ON FUNCTION public.my_profile_account_status() TO authenticated;
GRANT EXECUTE ON FUNCTION public.my_account_type() TO authenticated;
GRANT EXECUTE ON FUNCTION public.has_permission(_module text, _action text) TO authenticated;

GRANT EXECUTE ON FUNCTION public.current_org_id() TO service_role;
GRANT EXECUTE ON FUNCTION public.is_org_admin() TO service_role;
GRANT EXECUTE ON FUNCTION public.is_staff() TO service_role;
GRANT EXECUTE ON FUNCTION public.my_profile_org() TO service_role;
GRANT EXECUTE ON FUNCTION public.my_profile_account_status() TO service_role;
GRANT EXECUTE ON FUNCTION public.my_account_type() TO service_role;
GRANT EXECUTE ON FUNCTION public.has_permission(_module text, _action text) TO service_role;