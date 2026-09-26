GRANT EXECUTE ON FUNCTION public.delivery_accept_order(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.delivery_reject_order(uuid, text) TO authenticated;