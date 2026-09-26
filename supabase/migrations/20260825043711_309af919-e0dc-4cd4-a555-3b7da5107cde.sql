REVOKE EXECUTE ON FUNCTION public.neo_events_touch_updated_at() FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.neo_event_task_guard() FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.neo_event_assign_staff(uuid, uuid, text, text) FROM anon;
REVOKE EXECUTE ON FUNCTION public.neo_event_task_create(uuid, text, uuid, text, text, timestamptz) FROM anon;
REVOKE EXECUTE ON FUNCTION public.neo_event_task_advance(uuid, text, text) FROM anon;
REVOKE EXECUTE ON FUNCTION public.neo_event_issue_report(uuid, text, text, uuid) FROM anon;
REVOKE EXECUTE ON FUNCTION public.neo_event_issue_resolve(uuid, text, text) FROM anon;