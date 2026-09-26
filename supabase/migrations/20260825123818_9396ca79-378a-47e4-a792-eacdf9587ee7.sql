REVOKE ALL ON FUNCTION public.neo_requisition_supervisor_authority() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.neo_finance_post_refund(text, uuid, boolean) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.neo_pos_refund_decide(uuid, boolean, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.neo_event_confirm_build_billing() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.neo_requisition_supervisor_authority() TO authenticated;
GRANT EXECUTE ON FUNCTION public.neo_finance_post_refund(text, uuid, boolean) TO authenticated;
GRANT EXECUTE ON FUNCTION public.neo_pos_refund_decide(uuid, boolean, text) TO authenticated;