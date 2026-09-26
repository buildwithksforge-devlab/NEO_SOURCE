REVOKE EXECUTE ON FUNCTION public.neo_pending_collections(uuid) FROM anon, PUBLIC;
REVOKE EXECUTE ON FUNCTION public.neo_night_audit_run(uuid, date, text) FROM anon, PUBLIC;
REVOKE EXECUTE ON FUNCTION public.neo_close_business_day(uuid, date, text) FROM anon, PUBLIC;
REVOKE EXECUTE ON FUNCTION public.neo_approval_route(text, numeric, numeric, uuid, uuid, uuid) FROM anon, PUBLIC;
GRANT EXECUTE ON FUNCTION public.neo_pending_collections(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.neo_night_audit_run(uuid, date, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.neo_close_business_day(uuid, date, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.neo_approval_route(text, numeric, numeric, uuid, uuid, uuid) TO authenticated;