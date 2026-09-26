REVOKE ALL ON FUNCTION public.audit_role_permission_change() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.has_permission(text, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.has_permission(text, text, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.is_org_admin() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.has_permission(text, text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.has_permission(text, text, text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.is_org_admin() TO authenticated, service_role;