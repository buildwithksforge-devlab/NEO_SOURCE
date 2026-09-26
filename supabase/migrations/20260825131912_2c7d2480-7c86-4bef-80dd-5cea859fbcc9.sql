DROP FUNCTION IF EXISTS public.neo_tmp_probe();

REVOKE ALL ON FUNCTION public.neo_audit_completeness(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.neo_notification_integrity(uuid, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.neo_audit_completeness(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.neo_notification_integrity(uuid, integer) TO authenticated;