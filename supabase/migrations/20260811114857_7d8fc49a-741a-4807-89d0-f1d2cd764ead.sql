
REVOKE EXECUTE ON FUNCTION public.current_org_id() FROM anon, public;
REVOKE EXECUTE ON FUNCTION public.is_org_admin() FROM anon, public;
REVOKE EXECUTE ON FUNCTION public.has_permission(text, text) FROM anon, public;
REVOKE EXECUTE ON FUNCTION public.bootstrap_tenant(text, text) FROM anon;
REVOKE EXECUTE ON FUNCTION public.next_document_number(text) FROM anon, public;
GRANT EXECUTE ON FUNCTION public.current_org_id() TO authenticated;
GRANT EXECUTE ON FUNCTION public.is_org_admin() TO authenticated;
GRANT EXECUTE ON FUNCTION public.has_permission(text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.next_document_number(text) TO authenticated;
