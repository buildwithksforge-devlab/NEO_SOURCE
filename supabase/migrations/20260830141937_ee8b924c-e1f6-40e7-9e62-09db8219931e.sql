REVOKE EXECUTE ON FUNCTION public.neo_cash_till_context(uuid) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.neo_cash_request_payment(uuid, numeric, text, text, text) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.neo_cash_confirm_receipt(uuid) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.neo_cash_cancel_request(uuid, text) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.neo_cash_settle_request(uuid) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.neo_cash_till_context(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.neo_cash_request_payment(uuid, numeric, text, text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.neo_cash_confirm_receipt(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.neo_cash_cancel_request(uuid, text) TO authenticated;