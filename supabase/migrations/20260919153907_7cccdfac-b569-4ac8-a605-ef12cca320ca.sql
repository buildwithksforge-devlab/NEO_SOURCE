REVOKE ALL ON FUNCTION public.role_permission_overrides_touch() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.role_permissions_view_write() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.neo_role_link_template() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.neo_role_permission_no_reclone() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.neo_rbac_model_health() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.neo_rbac_model_health() TO authenticated, service_role;