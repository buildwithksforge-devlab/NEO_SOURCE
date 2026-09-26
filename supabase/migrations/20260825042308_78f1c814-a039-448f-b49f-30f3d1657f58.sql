REVOKE EXECUTE ON FUNCTION public.neo_marketing_content_guard() FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.neo_marketing_content_submit(uuid) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.neo_marketing_content_review(uuid, text, text) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.neo_marketing_content_schedule(uuid, timestamptz) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.neo_marketing_content_publish(uuid, text) FROM PUBLIC, anon;

GRANT EXECUTE ON FUNCTION public.neo_marketing_content_submit(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.neo_marketing_content_review(uuid, text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.neo_marketing_content_schedule(uuid, timestamptz) TO authenticated;
GRANT EXECUTE ON FUNCTION public.neo_marketing_content_publish(uuid, text) TO authenticated;