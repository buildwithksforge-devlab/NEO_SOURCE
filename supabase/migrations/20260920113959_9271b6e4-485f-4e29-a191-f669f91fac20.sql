REVOKE ALL ON FUNCTION public.neo_grounds_task_create(text, text, text, uuid, text, timestamptz, uuid, uuid, uuid) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.neo_grounds_task_create(text, text, text, uuid, text, timestamptz, uuid, uuid, uuid) TO authenticated;
REVOKE ALL ON FUNCTION public.neo_landscaping_schedule_save(text, text, text, integer, date, text, uuid, uuid, uuid, boolean, uuid, uuid) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.neo_landscaping_schedule_save(text, text, text, integer, date, text, uuid, uuid, uuid, boolean, uuid, uuid) TO authenticated;
REVOKE ALL ON FUNCTION public.neo_maint_asset_service_record() FROM public, anon;