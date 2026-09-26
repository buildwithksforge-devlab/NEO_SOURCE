
REVOKE ALL ON FUNCTION public.emit_domain_event(uuid,uuid,text,text,uuid,jsonb,text,uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.automation_touch_updated_at() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.tg_reservation_events() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.tg_payment_events() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.tg_stay_events() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.tg_folio_line_events() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.tg_task_events() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.tg_approval_events() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.tg_feedback_events() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.tg_customer_events() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.emit_domain_event(uuid,uuid,text,text,uuid,jsonb,text,uuid) TO service_role;
