REVOKE ALL ON FUNCTION public.neo_event_pos_order_created() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.neo_event_station_ticket_created() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.neo_event_task_assigned() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.neo_notify_event_routed(uuid, uuid, text, uuid, jsonb, text) FROM PUBLIC, anon, authenticated;